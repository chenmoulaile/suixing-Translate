// background/adapters/index.js —— 适配器注册表 + resolveChain() + 批量调度主循环
// 职责划分（协议 adapters/index.js 定稿）：适配器只负责"一组文本→一组译文"；
// 打包/切分/去重/重试/降级/缓存全部在调度层（本文件 + queue.js + cache.js）。
//
// TRANSLATE_BATCH 语义（协议 messageProtocol ①）：
//   缓存优先：key = 'cache:' + SHA-256(`${service}|${targetLang}|${text}`) 前 32 hex；
//   读取发生在打包之前，命中的下标直接回填（计入 cached），未命中集合才打包发请求；
//   写入只发生在段落完整成功后（段落原子性保证不缓存半截译文）。
//   贪心打包：按服务 budget（UTF-16 码元）顺序累计，Σlength ≤ B 并入下一段否则封包；
//   跨段不切割；单段超长单独封包（适配器内部走规则 4 切分）。
//   降级链：候选 = [primaryService, ...serviceChain 去掉 primaryService]，逐个过滤
//   enabled(在链中) ∧ !needsKey∨key已配 ∧ supportsLang(targetLang) ∧ 不在冷却期；
//   当前服务对剩余失败段落产出后仍有 null 项 → 下一候选服务只译这些下标；
//   全部候选耗尽仍有失败 → 对应项保持 null + itemErrors；若第一项都失败 → ok:false。
//   ok:true ⇔ translations 中至少一项非 null。
//   service 显式指定时只用该服务不降级（用户明确选择的失败要原样可见）。
//
// 冷却表由 queue.js 维护：RATE_LIMITED→60s、AUTH_FAILED→300s、
// HTTP_ERROR/NETWORK/TIMEOUT→30s、BAD_RESPONSE→60s；NO_KEY/UNSUPPORTED_LANG 不冷却。
// openai/deepl-api 默认不在链中，用户在 options 勾选加入（有 key 才可选）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // —— 注册表 ——
  // 说明：TA.adapters 注册表对象（register/get/has/ids + registry Map）已在 http.js 创建——
  // 协议 importScripts 定稿顺序中 adapters/*.js 先于本文件加载，各适配器顶层即调用
  // TA.adapters.register(...)，故注册表必须在更早的文件就绪；本文件只追加调度方法
  // （splitLongText / mapWithConcurrency / translateBatch / bootstrapCache）。

  var MAX_BATCH_TEXTS = 200;      // TRANSLATE_BATCH 载荷上限（段数）
  var MAX_BATCH_CHARS = 200000;   // TRANSLATE_BATCH 载荷上限（合计字符）

  // 超长切分占位符 token 正则（照侦察 16146 定稿）
  var TOKEN_RE = /(?:【\s*\d{8}\s*】|\{\s*\d{8}\s*\}|\[\s*\d{8}\s*\])/g;

  // —— 规则 4c：单句仍 >B 时的硬切（照侦察 16149-16161 算法移植）——
  // 三条件按序判定：①空白边界回退 ②占位符 token 跨界提前 ③UTF-16 代理对
  function splitHard(text, B) {
    var chunks = [];
    var start = 0;
    var half = Math.floor(B / 2);
    while (text.length - start > B) {
      var end = start + B;
      // ① 窗口内 lastIndexOf('\n') 与 lastIndexOf(' ') 的较大者 ≥ ⌊B/2⌋ → 取该处
      var nl = text.lastIndexOf('\n', end - 1);
      var sp = text.lastIndexOf(' ', end - 1);
      var boundary = Math.max(nl, sp);
      if (boundary >= half && boundary >= start) end = boundary;
      // ② 占位符 token 跨越 end 且起点在窗口内 → end 提前到 token 起始
      TOKEN_RE.lastIndex = start;
      var m;
      while ((m = TOKEN_RE.exec(text)) !== null) {
        if (m.index >= end) break;
        var tokEnd = m.index + m[0].length;
        if (tokEnd > end && m.index >= start) { end = m.index; break; }
        if (tokEnd <= end && m.index < start) continue;
      }
      // ③ end 落在 UTF-16 代理对中间 → end--
      if (end > start && end < text.length) {
        var c1 = text.charCodeAt(end - 1);
        var c2 = text.charCodeAt(end);
        if (c1 >= 0xD800 && c1 <= 0xDBFF && c2 >= 0xDC00 && c2 <= 0xDFFF) end--;
      }
      if (end <= start) end = start + B; // 防御：极端构造下保底推进
      chunks.push(text.slice(start, end));
      start = end;
    }
    if (start < text.length) chunks.push(text.slice(start));
    return chunks;
  }

  // —— 规则 4a：预切句（切出的句子片保留右边界字符，拼接 === 原文，零损耗）——
  // 切点 =【。！？；!?;】任一字符之后；或半角 ['.','!','?',';'] 后紧跟空格/行尾
  function splitSentences(text) {
    var parts = [];
    var last = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var cut = false;
      if ('。！？；'.indexOf(ch) !== -1) {
        cut = true;
      } else if ('!?;.'.indexOf(ch) !== -1) {
        var nxt = i + 1 < text.length ? text[i + 1] : '';
        cut = nxt === '' || nxt === ' ' || nxt === '\n' || nxt === '\t';
      }
      if (cut) {
        parts.push(text.slice(last, i + 1));
        last = i + 1;
      }
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  // —— 规则 4b：贪心合并句子片成 ≤B 的块（单句 >B 硬切）——
  TA.adapters.splitLongText = function (text, B) {
    if (!B || B <= 0 || text.length <= B) return [text];
    var parts = splitSentences(text);
    var chunks = [];
    var cur = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.length > B) {
        if (cur) { chunks.push(cur); cur = ''; }
        var hard = splitHard(p, B);
        for (var j = 0; j < hard.length; j++) chunks.push(hard[j]);
        continue;
      }
      if (cur && cur.length + p.length > B) { chunks.push(cur); cur = ''; }
      cur += p;
    }
    if (cur) chunks.push(cur);
    return chunks;
  };

  // —— 通用并发映射：items 并发 ≤ limit 执行 fn（按下标保序回填；fn 抛错 → 整体 reject）——
  TA.adapters.mapWithConcurrency = async function (items, limit, fn) {
    var results = new Array(items.length);
    var next = 0;
    var n = Math.max(1, Math.min(limit || 1, items.length));
    async function worker() {
      for (;;) {
        var i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }
    var workers = [];
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  };

  // —— 服务 key 是否已配置（keyRequirements 定稿：deepl-api 的 deeplx 变体可空；openai 需 apiKey）——
  function keyOk(settings, id) {
    var spec = TA.adapters.get(id);
    if (!spec) return false;
    var cfg = settings && settings.services ? settings.services[id] : undefined;
    if (spec.needsKey) {
      if (typeof spec.keyOk === 'function') return spec.keyOk(cfg);
      return !!(cfg && (cfg.authKey || cfg.apiKey));
    }
    return true;
  }

  function serviceConfig(settings, id) {
    return settings && settings.services && settings.services[id] ? settings.services[id] : {};
  }

  // —— 候选链解析（协议降级链定稿）——
  function resolveChain(settings, targetLang) {
    var chainArr = Array.isArray(settings.serviceChain) && settings.serviceChain.length
      ? settings.serviceChain
      : TA.DEFAULTS.serviceChain.slice();
    var primary = settings.primaryService;
    // 候选 = [primaryService, ...serviceChain 去掉 primaryService]
    var ordered = primary
      ? [primary].concat(chainArr.filter(function (s) { return s !== primary; }))
      : chainArr.slice();
    // 逐个过滤：enabled(在链中) ∧ key已配 ∧ supportsLang(targetLang)
    return ordered.filter(function (id) {
      return chainArr.indexOf(id) !== -1 && TA.adapters.has(id) &&
        keyOk(settings, id) && TA.langmap.supportsLang(id, targetLang);
    });
  }

  // —— 规则 2：贪心打包（保序；单段超长独立封包；budget=0 每段一包，配合"逐段请求"服务）——
  function packItems(items, budget) {
    if (!budget || budget <= 0) return items.map(function (it) { return [it]; });
    var packs = [];
    var cur = [];
    var curLen = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var len = it.text.length;
      if (len > budget) {
        // 跨段不切割：先封当前包，超长段独立成包（适配器内部走规则 4 切分）
        if (cur.length) { packs.push(cur); cur = []; curLen = 0; }
        packs.push([it]);
        continue;
      }
      // Σlength ≤ budget 则并入下一段，否则封包
      if (curLen + len > budget && cur.length) { packs.push(cur); cur = []; curLen = 0; }
      cur.push(it);
      curLen += len;
    }
    if (cur.length) packs.push(cur);
    return packs;
  }

  // 绑定服务并发配额的 http（适配器内所有单次 HTTP 请求经此发起）
  function makeBoundHttp(serviceId) {
    return {
      request: function (opts) {
        return TA.queue.withSlot(serviceId, function () {
          return TA.http.request(opts);
        });
      }
    };
  }

  // 单个请求包的派发：FIFO 队列 + 退避重试 + 返回结构校验
  async function dispatchPack(serviceId, spec, pack, req, settings) {
    var payload = pack.map(function (it) { return it.text; });
    var config = serviceConfig(settings, serviceId);
    if (typeof TA.terminology === 'object' && TA.terminology) {
      try {
        var termsText = TA.terminology.buildTermsSection(settings);
        if (typeof termsText === 'string' && termsText) config.termsText = termsText;
      } catch (e) { /* 术语库可用时增强，失败不影响翻译 */ }
    }
    if (typeof req.contextText === 'string' && req.contextText) config.contextText = req.contextText;
    var http = makeBoundHttp(serviceId);
    try {
      var resp = await TA.queue.enqueue(serviceId, function () {
        return TA.queue.withRetry(serviceId, function () {
          return spec.translate({
            texts: payload,
            targetLang: req.targetLang,
            sourceLang: req.sourceLang,
            config: config,
            http: http,
            signal: undefined // v1 预留：尚未使用外部取消信号
          });
        });
      });
      // 适配器返回结构校验：translations 数组、等长、全 string
      if (!resp || !Array.isArray(resp.translations) ||
        resp.translations.length !== payload.length ||
        resp.translations.some(function (x) { return typeof x !== 'string'; })) {
        return { ok: false, error: TA.err('BAD_RESPONSE', '适配器返回结构不合法: ' + serviceId, { service: serviceId }) };
      }
      return { ok: true, translations: resp.translations };
    } catch (err) {
      var e = err instanceof TA.TAError ? err
        : TA.err('NETWORK', String((err && err.message) || err), { service: serviceId });
      return { ok: false, error: e };
    }
  }

  // 段落成功后写缓存（返回 Promise 供调度层 await，失败不影响响应）
  function writeCache(serviceId, targetLang, text, value, settings) {
    return TA.cache.keyFor(serviceId, targetLang, text)
      .then(function (k) {
        var entries = {};
        entries[k] = { v: value, at: Date.now() };
        return TA.cache.setMany(entries, settings);
      })
      .catch(function (err) {
        console.warn('[TA] cache write failed:', err && err.message || err);
      });
  }

  // SW 启动（被事件唤醒）后首次消息处理前执行一次缓存清理
  var cacheBootstrapped = false;
  TA.adapters.bootstrapCache = async function (settings) {
    if (cacheBootstrapped) return;
    cacheBootstrapped = true;
    try {
      await TA.cache.maintain(settings);
    } catch (e) {
      console.warn('[TA] cache bootstrap failed:', e && e.message || e);
    }
  };

  // —— 批量调度主循环（TRANSLATE_BATCH 核心）——
  // req: {batchId, texts, targetLang?, sourceLang?, service?}
  // 返回协议响应信封（平铺形态，不含 requestId——由 service-worker 统一回填）。
  TA.adapters.translateBatch = async function (req, settings) {
    var batchId = req.batchId;
    var texts = req.texts;
    var targetLang = typeof req.targetLang === 'string' && req.targetLang ? req.targetLang : 'zh-CN';

    function fail(code, message, service) {
      var error = { code: code, message: message };
      if (service) error.service = service;
      return { batchId: batchId, ok: false, translations: null, usedServices: [], error: error };
    }

    // —— 载荷校验 ——
    if (!Array.isArray(texts) || texts.some(function (t) { return typeof t !== 'string'; })) {
      return fail('BAD_REQUEST', 'texts 必须为字符串数组');
    }
    if (texts.length > MAX_BATCH_TEXTS) {
      return fail('TOO_LARGE', '单批段数超限（' + texts.length + ' > ' + MAX_BATCH_TEXTS + '），content 侧应自行分包');
    }
    var totalLen = 0;
    for (var ti = 0; ti < texts.length; ti++) totalLen += texts[ti].length;
    if (totalLen > MAX_BATCH_CHARS) {
      return fail('TOO_LARGE', '单批合计字符超限（' + totalLen + ' > ' + MAX_BATCH_CHARS + '），content 侧应自行分包');
    }
    if (texts.length === 0) {
      return { batchId: batchId, ok: true, translations: [], usedServices: [], cached: 0 };
    }

    // —— 候选链 ——
    var chain;
    if (typeof req.service === 'string' && req.service) {
      // 显式指定服务：只用该服务，不降级（失败原样可见）
      if (!TA.adapters.has(req.service)) return fail('BAD_REQUEST', '未知服务: ' + req.service);
      if (!keyOk(settings, req.service)) {
        return fail('NO_KEY', '服务未配置密钥: ' + req.service, req.service);
      }
      if (!TA.langmap.supportsLang(req.service, targetLang)) {
        return fail('UNSUPPORTED_LANG', '服务 ' + req.service + ' 不支持目标语言 ' + targetLang, req.service);
      }
      chain = [req.service];
    } else {
      chain = resolveChain(settings, targetLang);
      if (!chain.length) {
        return fail('NO_USABLE_SERVICE', '没有可用的翻译服务（链为空或均不可用/不支持目标语言）');
      }
    }

    // —— 批内去重（相同下标集合只发一次，响应按 index 回填）——
    var dedup = []; // [{text, indices}]
    var byText = new Map();
    for (var i = 0; i < texts.length; i++) {
      var t = texts[i];
      var entry = byText.get(t);
      if (!entry) { entry = { text: t, indices: [] }; byText.set(t, entry); dedup.push(entry); }
      entry.indices.push(i);
    }

    var translations = new Array(texts.length).fill(null);
    var cached = 0;
    var usedSet = new Set();
    var lastErrors = new Map(); // index -> {code, message, service}
    var writePromises = []; // 缓存写入 Promise 集合，返回前统一 await 防止 MV3 SW 提前回收

    // —— 缓存优先（读取发生在打包之前；键含服务）——
    // 写入按"实际产出服务"记键（writeCache(svc,…)），故读取对链上每个候选服务
    // 逐一构造键查询（降级产出的译文下次也能命中），按链优先级取第一个命中。
    try {
      var keys = await Promise.all(dedup.map(function (e) {
        return Promise.all(chain.map(function (svc) {
          return TA.cache.keyFor(svc, targetLang, e.text);
        }));
      }));
      // dedup[i].svcKeys = 键数组（与 chain 同序）；flatKeys 一次 getMany
      var flatKeys = [];
      for (var ki = 0; ki < dedup.length; ki++) {
        dedup[ki].svcKeys = keys[ki];
        for (var kj = 0; kj < keys[ki].length; kj++) flatKeys.push(keys[ki][kj]);
      }
      var found = await TA.cache.getMany(flatKeys);
      var remaining = [];
      for (var ri = 0; ri < dedup.length; ri++) {
        var e = dedup[ri];
        var hitVal = null;
        for (var si = 0; si < e.svcKeys.length; si++) {
          var hit = found.get(e.svcKeys[si]);
          if (hit && typeof hit.v === 'string' && hit.v) { hitVal = hit.v; break; }
        }
        if (hitVal !== null) {
          e.indices.forEach(function (idx) { translations[idx] = hitVal; });
          cached++;
        } else {
          remaining.push(e);
        }
      }
      dedup = remaining;
    } catch (err) {
      // 缓存读失败不阻塞翻译
      console.warn('[TA] cache read failed:', err && err.message || err);
    }

    // —— 服务循环：失败下标集合自动交给下一个候选服务续译 ——
    for (var ci = 0; ci < chain.length && dedup.length > 0; ci++) {
      var svc = chain[ci];
      // 冷却期跳过（显式指定服务时不跳过——用户明确要求，让错误可见）
      if (!req.service && TA.queue.isCooling(svc)) continue;
      var spec = TA.adapters.get(svc);
      if (!spec) continue;

      // 贪心打包（含打包日志，验收项 3）
      var packs = packItems(dedup, spec.budget);
      for (var pi = 0; pi < packs.length; pi++) {
        var sumLen = 0;
        for (var qi = 0; qi < packs[pi].length; qi++) sumLen += packs[pi][qi].text.length;
        console.log('[TA] ' + batchId + ' svc=' + svc + ' pack ' + (pi + 1) + '/' + packs.length +
          ' texts=' + packs[pi].length + ' \u03A3len=' + sumLen + ' budget=' + spec.budget);
      }

      var results = await Promise.all(packs.map(function (pack) {
        return dispatchPack(svc, spec, pack, req, settings);
      }));

      var stillFailed = [];
      for (var pi2 = 0; pi2 < packs.length; pi2++) {
        var pack = packs[pi2];
        var r = results[pi2];
        if (r.ok) {
          for (var j = 0; j < pack.length; j++) {
            var it = pack[j];
            var val = r.translations[j];
            it.indices.forEach(function (idx) { translations[idx] = val; });
            usedSet.add(svc);
            writePromises.push(writeCache(svc, targetLang, it.text, val, settings));
          }
        } else {
          for (var k = 0; k < pack.length; k++) {
            var it2 = pack[k];
            it2.indices.forEach(function (idx) {
              lastErrors.set(idx, { code: r.error.code, message: r.error.message, service: svc });
            });
            stillFailed.push(it2);
          }
          // 服务失败 → 按错误 code 进入冷却（显式指定服务时不冷却）
          if (!req.service) TA.queue.cool(svc, r.error);
        }
      }
      dedup = stillFailed;
    }

    // —— 汇总 ——
    var anyOk = translations.some(function (x) { return x !== null; });
    if (!anyOk) {
      // 整体失败：取一个代表性错误（首个失败下标的错误）
      var rep = null;
      for (var fi = 0; fi < texts.length; fi++) {
        if (lastErrors.has(fi)) { rep = lastErrors.get(fi); break; }
      }
      var error = rep
        ? { code: rep.code, message: rep.message, service: rep.service }
        : { code: 'NO_USABLE_SERVICE', message: '没有可用的翻译服务' };
      return { batchId: batchId, ok: false, translations: null, usedServices: [], error: error };
    }

    var resp = {
      batchId: batchId,
      ok: true,
      translations: translations,
      usedServices: Array.from(usedSet),
      cached: cached
    };
    // 剩余失败下标 → itemErrors（协议：null 项由 content 显示错误态）
    if (dedup.length > 0) {
      var failedIdx = [];
      dedup.forEach(function (e) {
        e.indices.forEach(function (idx) { failedIdx.push(idx); });
      });
      failedIdx.sort(function (a, b) { return a - b; });
      resp.itemErrors = failedIdx.map(function (idx) {
        var le = lastErrors.get(idx) || { code: 'NO_USABLE_SERVICE', message: '无可用翻译服务' };
        return { index: idx, code: le.code, message: le.message };
      });
    }
    // 等待所有缓存写入落盘后再返回：MV3 service worker 会在消息处理结束、无待决任务时
    // 被强制回收，fire-and-forget 的异步写入会被中断导致缓存丢失。await 全量 Promise
    // 可保持 SW 存活直到缓存写入 flush 完成（allSettled 确保个别写入失败不影响响应）。
    await Promise.allSettled(writePromises);
    console.log('[TA] ' + batchId + ' done: cached=' + cached + ' ok=' +
      translations.filter(function (x) { return x !== null; }).length + '/' + texts.length +
      ' usedServices=[' + resp.usedServices.join(',') + ']');
    return resp;
  };
})();
