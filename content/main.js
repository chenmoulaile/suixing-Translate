// content/main.js —— 总管线（v0.2 重构：功能注册表 + 公共翻译管线）
// 开关状态机（idle/translating/translated）、消息处理、
// MutationObserver（防抖 300ms）+ SPA URL 轮询（800ms）、快捷键/右键菜单/popup 消息。
// 缓存/打包/重试/降级在后台调度层（协议 batchingRules）；content 侧负责：
//   页面级 90% 主导率跳过 → 公式时机（settle→protect）→ 段落收集 → 相同文本去重 →
//   分包（≤200 段且 ≤200000 字符）→ TRANSLATE_BATCH → 回填注入 → 公式还原（restore）。
// v0.2 新增：
//   TA.features —— interactions/ball/export 等模块经 register 挂载（core.js 定义注册表），
//     main.js 负责 init 调度 / onSettingsChanged 广播 / 未知消息与 CMD 分发；
//   TA.pipeline.translateUnits / translateText —— 公共翻译入口（B 悬停/划词复用），
//     独立于全局 state.progress，尊重 runSeq 代际作废；
//   TA.subscribeState / TA.getState —— 页面状态快照推送/拉取（悬浮球等功能模块消费）；
//   新消息：TRANSLATE_PAGE（幂等测试钩子）/ GET_FEATURES / SET_THEME；
//   EXPORT_BILINGUAL 经 features.messages 分发（export.js 注册）。
// 悬浮球 DOM 已剥离至 C 的 content/ball.js（经 TA.features 注册挂载）。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || !TA.walker || !TA.injector || !TA.rules || !TA.lang || !TA.util || !TA.formula) {
    console.error('[TA] content/main.js: 前置文件（core/rules/formula/walker/injector）未加载完成');
    return;
  }
  if (TA.__mainLoaded) return; // 兜底注入防双跑
  TA.__mainLoaded = true;

  /* ==================== 状态 ==================== */

  var state = {
    phase: 'idle',        // idle | translating | translated
    mode: 'bilingual',    // bilingual | translation-only（运行时显隐，初值取设置默认）
    scope: 'smart',       // smart | full
    progress: null,       // {done, total} | null
    error: null,          // 供 popup 显示的中文错误/提示
    sameLangPage: false,  // 页面 90%+ 已是目标语言（页面级跳过）
    sameLangPageReason: null, // 跳过原因：'pageDominance'（v0.2 唯一来源）
    lastStats: null       // 最近一次整页翻译统计 {count, seconds, emaMs}（球 tooltip 用）
  };
  var runSeq = 0;         // 运行代际：还原/新一轮开始时自增，作废在途回填
  var batchSeq = 0;       // batchId 序号
  var pipeSeq = 0;        // 管线单段请求序号
  var lastUrl = location.href;
  var observer = null;
  var observerConnected = false;
  var rewalkTimer = 0;
  var rewalkBusy = false; // rewalk 含异步 settle，防重入
  var stateListeners = [];

  /* ==================== 后台消息封装 ==================== */

  TA.msg = {
    // TRANSLATE_BATCH：texts 为去重后的字符串数组（调用方保证 ≤200 段 / ≤200000 字符）；
    // service=null 走后台降级链（primaryService 为链首），显式指定时后台不降级。
    requestBatch: function (texts, settings) {
      batchSeq += 1;
      var contextText = '';
      if (settings && settings.ai && settings.ai.enableContext) {
        try {
          var meta = document.querySelector('meta[name="description"]');
          var heads = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).slice(0, 4).map(function (h){return h.textContent.trim();}).filter(Boolean);
          contextText = [document.title, meta && meta.content, heads.join(' / '), (document.body && document.body.innerText || '').slice(0, 400)].filter(Boolean).join('\n').slice(0, 1200);
        } catch (e) { contextText = ''; }
      }
      var req = {
        type: 'TRANSLATE_BATCH',
        requestId: TA.util.genId(),
        batchId: Date.now().toString(36) + '-' + batchSeq,
        texts: texts,
        targetLang: (settings && settings.targetLang) || 'zh-CN',
        sourceLang: 'auto',
        service: null,
        contextText: contextText
      };
      return chrome.runtime.sendMessage(req)
        .then(function (res) {
          if (!res || typeof res !== 'object') {
            throw { code: 'BAD_RESPONSE', message: '后台服务响应为空' };
          }
          return res;
        })
        .catch(function (e) {
          if (e && e.code) throw e;
          // "Could not establish connection" / 扩展重载等 → 归一为 NETWORK
          throw { code: 'NETWORK', message: '无法连接后台服务：' + ((e && e.message) || String(e)) };
        });
    }
  };

  /* ==================== 翻译主流程 ==================== */

  function collectOpts(settings) {
    var rules = TA.rules.resolve(location.href, settings);
    // 站点规则 theme 字段（C 的 rules.js 合并）非空 → 覆盖页面主题（opts.effectiveTheme
    // 为接口冻结约定，injector.themeName 优先读取）
    var ts = (settings && settings.targetStyle) || {};
    var theme = ts.theme || 'dashed';
    if (rules && typeof rules.theme === 'string' && rules.theme) theme = rules.theme;
    return {
      scope: state.scope,
      rules: rules,
      targetLang: settings.targetLang || 'zh-CN',
      settings: settings,
      effectiveTheme: theme
    };
  }

  function startTranslate(scopeOverride) {
    if (state.phase === 'translating') return Promise.resolve();
    return TA.getSettings().then(function (settings) {
      if (state.phase === 'translating') return;
      if (scopeOverride === 'smart' || scopeOverride === 'full') state.scope = scopeOverride;
      state.error = null;
      state.sameLangPage = false;
      state.sameLangPageReason = null;

      // URL 黑白名单（settings.urlPattern）
      var block = TA.rules.isBlocked(location.href, settings);
      if (block.blocked) {
        state.error = block.reason === 'excluded'
          ? '此站点已在设置中禁止翻译'
          : '此站点不在允许翻译的网址列表中';
        notifyState();
        return;
      }

      // 页面级语言跳过（v0.2 定稿：两模式统一，唯一判据 = 正文 90% 主导率；
      // html[lang] 不再参与判定，"切到全文模式可强制"的旧行为废除）
      var root = document.body || document.documentElement;
      var dom = TA.lang.pageDominance(root, settings.targetLang);
      if (dom.skip) {
        state.sameLangPage = true;
        state.sameLangPageReason = 'pageDominance';
        state.error = '页面 90% 以上已是目标语言，未翻译';
        notifyState();
        return;
      }

      state.phase = 'translating';
      state.progress = null; // 公式等待期不定总数，收集完成后回填（避免 popup 显示 0/0）
      notifyState();

      var run = ++runSeq; // 公式等待期即占用代际：期间还原/重开会作废后续步骤

      // 公式时机 ①：等 MathJax/KaTeX 渲染稳定（最长 8s，超时强行进入提取）
      return TA.formula.settle(root, 8000).then(function () {
        if (run !== runSeq) return; // 等待期间被还原/重开，作废
        // 公式时机 ②：公式节点摘出换 ⟪mN⟫ 占位符（token 随句送 MT）
        TA.formula.protect(root);
        var opts = collectOpts(settings);
        var units = TA.walker.collectUnits(root, opts);
        if (!units.length) {
          // 提前退出：token 不能留在正文里，公式先回归原位
          TA.formula.restoreAll();
          state.phase = 'idle';
          state.progress = null;
          state.error = '未找到可翻译的段落';
          notifyState();
          return;
        }
        state.progress = { done: 0, total: units.length };
        notifyState();
        disconnectObserver(); // 自身批量注入前断开，完成后重连（双保险）
        for (var i = 0; i < units.length; i++) TA.injector.injectLoading(units[i], settings, opts);
        connectObserver();
        return runUnits(run, units, settings);
      });
    }).catch(function (e) {
      console.error('[TA] 翻译启动失败', e);
      TA.formula.restoreAll(); // 异常路径兜底：已 protect 的公式回归原位
      state.phase = 'idle';
      state.progress = null;
      state.error = TA.errorText(e);
      notifyState();
    });
  }

  // 去重 + 分包（协议 TOO_LARGE 上限 200 段 / 200000 字符），runUnits 与管线共用
  function buildBatches(units) {
    var byText = new Map();   // 文本 → unit 下标集合
    var unique = [];
    for (var i = 0; i < units.length; i++) {
      var t = units[i].text;
      if (!byText.has(t)) { byText.set(t, []); unique.push(t); }
      byText.get(t).push(i);
    }
    var chunks = [];
    var cur = [];
    var curLen = 0;
    for (var u = 0; u < unique.length; u++) {
      var txt = unique[u];
      // 仅当当前包非空时封包，避免单段超 200000 字符时推出空批次（texts=[]）
      if (cur.length && (cur.length >= 200 || (curLen + txt.length) > 200000)) {
        chunks.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(txt);
      curLen += txt.length;
    }
    if (cur.length) chunks.push(cur);
    return { byText: byText, unique: unique, chunks: chunks };
  }

  // 逐包请求 + 回填（管线 translateUnits 使用；主流程 runUnits 因要逐包计时统计
  // EMA 耗时，自行展开同样的串行链，回填/错误处理复用同一对函数）：
  //   run=代际（!== runSeq 时静默中止）；progress=回填进度对象（null 不计数）
  function sendChunks(chunks, byText, units, settings, run, progress) {
    var chain = Promise.resolve();
    chunks.forEach(function (texts) {
      chain = chain.then(function () {
        if (run !== runSeq) return; // 已被还原/新一轮作废
        return TA.msg.requestBatch(texts, settings).then(function (resp) {
          if (run !== runSeq) return;
          fillChunk(resp, texts, byText, units, progress);
        }).catch(function (err) {
          if (run !== runSeq) return;
          markChunkError(err, texts, byText, units, progress);
        });
      });
    });
    return chain;
  }

  // 整页翻译：分包串行发送 → 完成后公式还原 → hash 刷新 → 状态收尾。
  // 回填进度记录到 state.progress（popup 显示），管线入口（translateUnits）不经过本函数。
  function runUnits(run, units, settings) {
    var built = buildBatches(units);
    // EMA 段耗时统计（easysub 借鉴轻量版）：逐包计时后指数滑动平均，
    // 完成时写入 state.lastStats，悬浮球 tooltip 显示"N 段 · X.Xs"
    var t0 = Date.now();
    var ema = 0;
    var chain = Promise.resolve();
    built.chunks.forEach(function (texts) {
      chain = chain.then(function () {
        if (run !== runSeq) return;
        var c0 = Date.now();
        return TA.msg.requestBatch(texts, settings).then(function (resp) {
          if (run !== runSeq) return;
          ema = ema ? (ema * 0.7 + (Date.now() - c0) * 0.3) : (Date.now() - c0);
          fillChunk(resp, texts, built.byText, units, state.progress);
        }).catch(function (err) {
          if (run !== runSeq) return;
          ema = ema ? (ema * 0.7 + (Date.now() - c0) * 0.3) : (Date.now() - c0);
          markChunkError(err, texts, built.byText, units, state.progress);
        });
      });
    });

    return chain.then(function () {
      if (run !== runSeq) return;
      // 公式时机 ③：token → 公式节点原位还原（覆盖原文与译文 wrapper 内的 token）
      TA.formula.restore(document);
      // 公式还原改变原文 DOM（token 消失）：刷新受影响单元的 data-ta-hash，
      // 否则 rewalk 的 hash 对比会把"公式还原"误判为内容变化 → 还原重译死循环
      refreshTouchedHashes(settings);
      // 公式时机 ④：未消费公式兜底回归（MT 丢 token 等场景），随后登记表清空
      TA.formula.restoreAll();
      state.progress = null;
      state.lastStats = {
        count: units.length,
        seconds: Math.max(0, (Date.now() - t0) / 1000),
        emaMs: Math.round(ema)
      };
      if (state.phase === 'translating') state.phase = 'translated';
      notifyState();
      applyMode(state.mode); // 仅译文模式下立即隐藏原文（不发新请求）
      notifyState();
    });
  }

  // 单包回填：translations[i] 与 texts[i] 等长同序；null/空串 = 该段失败。
  // 错误来源优先级：段级 itemErrors[i] → 批级 resp.error（ok:false 时后台给出的
  // 整体失败原因，如 NETWORK/TIMEOUT/RATE_LIMITED/NO_KEY）→ NO_USABLE_SERVICE 兜底。
  // progress：主流程传 state.progress，管线传局部对象（互不干扰）；null 不计数。
  function fillChunk(resp, texts, byText, units, progress) {
    var itemErrMap = new Map();
    if (resp && Array.isArray(resp.itemErrors)) {
      for (var k = 0; k < resp.itemErrors.length; k++) {
        itemErrMap.set(resp.itemErrors[k].index, resp.itemErrors[k]);
      }
    }
    var batchErr = (resp && resp.ok !== true && resp.error && resp.error.code) ? resp.error : null;
    for (var i = 0; i < texts.length; i++) {
      var tr = (resp && resp.ok && resp.translations) ? resp.translations[i] : null;
      var okText = typeof tr === 'string' && tr.length > 0;
      var idxs = byText.get(texts[i]) || [];
      for (var j = 0; j < idxs.length; j++) {
        var unit = units[idxs[j]];
        if (okText) TA.injector.applyTranslation(unit, tr);
        else TA.injector.setError(unit, itemErrMap.get(i) || batchErr || { code: 'NO_USABLE_SERVICE' });
        if (progress) progress.done += 1;
      }
    }
  }

  // 整包失败（ok:false / 发送异常）：包内全部段落进入错误态
  function markChunkError(err, texts, byText, units, progress) {
    var e = (err && err.code) ? err : { code: 'NO_USABLE_SERVICE' };
    for (var i = 0; i < texts.length; i++) {
      var idxs = byText.get(texts[i]) || [];
      for (var j = 0; j < idxs.length; j++) {
        TA.injector.setError(units[idxs[j]], e);
        if (progress) progress.done += 1;
      }
    }
  }

  // 公式还原后的 hash 刷新：对 restore 触碰过的 [data-ta] 单元按当前 DOM 重建文本
  // 并回写 data-ta-hash（buildUnit 用的 scope/rules 必须与当初收集时一致）
  function refreshTouchedHashes(settings) {
    var touched = TA.formula.takeTouchedUnits();
    if (!touched.length) return;
    var opts = collectOpts(settings);
    for (var i = 0; i < touched.length; i++) {
      var el = touched[i];
      if (!el || !el.isConnected || !el.hasAttribute('data-ta')) continue;
      try {
        var built = TA.walker.buildUnit(el, {
          scope: opts.scope,
          rules: opts.rules,
          targetLang: opts.targetLang,
          settings: opts.settings,
          forced: el.hasAttribute('data-ta-forced')
        });
        if (built && built.text) el.setAttribute('data-ta-hash', built.hash);
      } catch (e) { /* 单点失败不影响整体 */ }
    }
  }

  /* ==================== 公共翻译管线（TA.pipeline，B 复用入口） ==================== */

  TA.pipeline = {
    // translateUnits(units, settings) → Promise<{done, total}>：
    // 与主流程相同的去重→分包→TRANSLATE_BATCH→fillChunk 回填，但独立于全局
    // state.progress（不打扰主进度），供悬停翻译等少段任务复用。
    // 调用方需先自行注入 loading（injector.injectLoading）——回填只写 unit.wrapper/inner。
    // 尊重 runSeq 代际：整页还原/重开发生时在途任务静默中止（返回已完成计数）。
    translateUnits: function (units, settings) {
      if (!units || !units.length || !Array.isArray(units)) {
        return Promise.resolve({ done: 0, total: 0 });
      }
      var run = runSeq;
      var progress = { done: 0, total: units.length };
      var built = buildBatches(units);
      return sendChunks(built.chunks, built.byText, units, settings, run, progress)
        .then(function () { return { done: progress.done, total: progress.total }; });
    },

    // translateText(text, opts) → Promise<string>：单段直译（划词/输入框复用）。
    // opts.service 非空走指定服务（后台不降级）；opts.targetLang 缺省用全局设置。
    // 失败 reject {code, message}；尊重 runSeq 代际（页面还原/重开 → CANCELLED）。
    translateText: function (text, opts) {
      opts = opts || {};
      var run = runSeq;
      return TA.getSettings().then(function (settings) {
        pipeSeq += 1;
        var req = {
          type: 'TRANSLATE_BATCH',
          requestId: TA.util.genId(),
          batchId: Date.now().toString(36) + '-pipe' + pipeSeq,
          texts: [String(text == null ? '' : text)],
          targetLang: opts.targetLang || settings.targetLang || 'zh-CN',
          sourceLang: 'auto',
          service: opts.service || null // 走后台缓存；同文本重复查询免费
        };
        return chrome.runtime.sendMessage(req).then(function (res) {
          if (run !== runSeq) throw { code: 'CANCELLED', message: '翻译已被页面操作取消' };
          var t = res && res.ok && res.translations && res.translations[0];
          if (typeof t === 'string' && t.length) return t;
          var err = (res && res.error) ||
            (res && Array.isArray(res.itemErrors) && res.itemErrors[0]) ||
            { code: 'NO_USABLE_SERVICE', message: TA.errorText({ code: 'NO_USABLE_SERVICE' }) };
          if (!err.message) err.message = TA.errorText(err);
          throw err;
        });
      }).catch(function (e) {
        if (e && e.code) throw { code: e.code, message: e.message || TA.errorText(e) };
        // "Could not establish connection" / 扩展重载等 → 归一为 NETWORK
        throw { code: 'NETWORK', message: '无法连接后台服务：' + ((e && e.message) || String(e)) };
      });
    }
  };

  /* ==================== 开关 / 模式 / 还原 ==================== */

  function toggle(scope) {
    if (state.phase === 'translating') return;
    if (state.phase === 'translated') {
      if ((scope === 'smart' || scope === 'full') && scope !== state.scope) {
        restoreAll();
        startTranslate(scope); // 已翻译且指定了不同 scope → 以新 scope 重新收集并翻译
        return;
      }
      restoreAll();
      return;
    }
    startTranslate(scope);
  }

  function restoreAll() {
    runSeq += 1; // 作废在途回填（含管线任务）
    disconnectObserver();
    // 公式先回归原位（未消费的 protect 登记全部还原并清空登记表）——
    // 必须在 injector.restoreAll 之前，否则显示原文/翻页时公式丢失
    TA.formula.restoreAll();
    TA.injector.restoreAll(document);
    connectObserver();
    state.phase = 'idle';
    state.progress = null;
    state.error = null;
    state.sameLangPage = false;
    state.sameLangPageReason = null;
    notifyState();
  }

  // SET_MODE：已翻译页面即时切换显隐，不发新请求
  function applyMode(mode) {
    state.mode = (mode === 'translation-only') ? 'translation-only' : 'bilingual';
    TA.getSettings().then(function (settings) {
      TA.injector.applyMode(state.mode, collectOpts(settings));
    }).catch(function () {
      TA.injector.applyMode(state.mode, null);
    });
  }

  // SET_SCOPE：未翻译仅记录；已翻译以新 scope 重新收集并翻译
  function setScope(scope) {
    state.scope = scope;
    if (state.phase === 'translated') {
      restoreAll();
      startTranslate();
    }
  }

  /* ==================== 页面状态快照（功能模块消费） ==================== */

  function getStateSnapshot() {
    return {
      phase: state.phase,
      mode: state.mode,
      scope: state.scope,
      progress: state.progress ? { done: state.progress.done, total: state.progress.total } : null,
      error: state.error,
      sameLangPage: state.sameLangPage,
      sameLangPageReason: state.sameLangPageReason,
      lastStats: state.lastStats
    };
  }

  // 拉取当前页面状态快照（悬浮球等功能模块用）
  TA.getState = getStateSnapshot;
  // 订阅状态变化推送（phase/progress/error 变化点均触发）；返回解绑函数
  TA.subscribeState = function (fn) {
    if (typeof fn !== 'function') return function () {};
    stateListeners.push(fn);
    return function off() {
      var i = stateListeners.indexOf(fn);
      if (i !== -1) stateListeners.splice(i, 1);
    };
  };

  // 由全面还原实现员补充：悬浮球动作通道（原属 A 的 main.js，A 已交付，
  // 此两行经整合工程师核准追加）——content 内部无消息环回通道
  // （runtime.sendMessage 不达同页 content script），球菜单的
  // 「翻译本页/显示原文」「仅译文/双语对照」需直接复用主流程 toggle/applyMode。
  TA.toggle = toggle;
  TA.setMode = applyMode;

  function notifyState() {
    var snap = getStateSnapshot();
    for (var i = 0; i < stateListeners.length; i++) {
      try { stateListeners[i](snap); }
      catch (e) { console.error('[TA] 状态订阅者执行失败', e); }
    }
  }

  /* ==================== 功能注册表调度 ==================== */

  function initFeatures(settings) {
    for (var i = 0; i < TA.features.list.length; i++) {
      var f = TA.features.list[i];
      if (f && typeof f.init === 'function') {
        try { f.init(settings); }
        catch (e) { console.error('[TA] 功能 ' + f.name + ' init 失败', e); }
      }
    }
  }

  function broadcastSettingsChanged(settings) {
    for (var i = 0; i < TA.features.list.length; i++) {
      var f = TA.features.list[i];
      if (f && typeof f.onSettingsChanged === 'function') {
        try { f.onSettingsChanged(settings); }
        catch (e) { console.error('[TA] 功能 ' + f.name + ' onSettingsChanged 失败', e); }
      }
    }
  }

  // 未知消息类型 → features.messages 依次分发；命中即接管响应。
  // 处理函数可返回值或 Promise：Promise → then 后 sendResponse（监听器 return true 保持通道）。
  function dispatchFeatureMessage(msg, sendResponse) {
    for (var i = 0; i < TA.features.list.length; i++) {
      var f = TA.features.list[i];
      if (f && f.messages && typeof f.messages[msg.type] === 'function') {
        var ret;
        try { ret = f.messages[msg.type](msg); }
        catch (e) {
          sendResponse({ ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } });
          return true;
        }
        if (ret && typeof ret.then === 'function') {
          ret.then(function (r) {
            sendResponse(r && typeof r === 'object' ? r : { ok: true, data: r });
          }, function (e) {
            sendResponse({
              ok: false,
              error: (e && e.code) ? { code: e.code, message: e.message || TA.errorText(e) }
                                   : { code: 'INTERNAL', message: String((e && e.message) || e) }
            });
          });
          return true; // 异步响应
        }
        sendResponse(ret && typeof ret === 'object' ? ret : { ok: true, data: ret });
        return true;
      }
    }
    sendResponse({ ok: false, error: { code: 'UNKNOWN_MESSAGE', message: '未实现的消息类型: ' + msg.type } });
    return true;
  }

  /* ==================== 消息处理（popup / options / background CMD / 测试钩子） ==================== */

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg !== 'object') return undefined;
    // 容错：background CMD 一定带 type，但防御缺 type 只带 name 的旧形状
    var type = (typeof msg.type === 'string') ? msg.type
      : (typeof msg.name === 'string' ? 'CMD' : '');
    switch (type) {
      case 'GET_PAGE_STATE':
        sendResponse(buildPageState());
        return undefined;
      case 'GET_FEATURES':
        sendResponse(buildFeaturesState());
        return undefined;
      case 'TRANSLATE_PAGE':
        // ★测试钩子（popup 与无头测试共用）：幂等语义——
        //   idle/error → 启动翻译返回 started:true；translating/translated → 不重入不翻转
        if (state.phase === 'translating') {
          sendResponse({ ok: true, started: false, phase: 'translating' });
        } else if (state.phase === 'translated') {
          sendResponse({ ok: true, started: false, phase: 'translated', translated: true });
        } else {
          startTranslate(msg.scope); // scope 可选（smart/full），非法值保持当前 scope
          sendResponse({ ok: true, started: true, phase: 'translating' });
        }
        return undefined;
      case 'TOGGLE_TRANSLATE':
        toggle(msg.scope);
        // 立即返回：翻译异步进行，popup 靠 800ms 轮询 GET_PAGE_STATE 显示进度
        sendResponse({ ok: true, translated: state.phase === 'translated' });
        return undefined;
      case 'SET_MODE':
        if (msg.mode === 'bilingual' || msg.mode === 'translation-only') applyMode(msg.mode);
        sendResponse({ ok: true });
        return undefined;
      case 'SET_SCOPE':
        if (msg.scope === 'smart' || msg.scope === 'full') setScope(msg.scope);
        sendResponse({ ok: true });
        return undefined;
      case 'RESTORE_PAGE':
        restoreAll();
        sendResponse({ ok: true, translated: false });
        return undefined;
      case 'SET_THEME': {
        // 页面级主题即时切换（测试用）：校验 ∈ TA.THEMES → 应用到已渲染节点，不改持久设置
        if (typeof msg.theme === 'string' && TA.injector.setTheme(msg.theme)) {
          sendResponse({ ok: true, theme: msg.theme });
        } else {
          sendResponse({ ok: false, error: { code: 'BAD_REQUEST', message: '未知主题: ' + msg.theme } });
        }
        return undefined;
      }
      case 'CMD':
        handleCmd(msg.name);
        sendResponse({ ok: true });
        return undefined;
      case 'EXPORT_BILINGUAL':
        // 导出双语由 C 的 export.js 经 features.messages 注册处理；
        // 未注册时 dispatchFeatureMessage 统一回 UNKNOWN_MESSAGE
        return dispatchFeatureMessage(msg, sendResponse);
      default:
        // 未知类型 → features.messages 分发（B/C 模块自有消息）
        return dispatchFeatureMessage(msg, sendResponse);
    }
  });

  // GET_PAGE_STATE 响应：v0.1 字段全部保留（向后兼容），v0.2 扩展 features/theme/
  // sameLangPageReason/formula
  function buildPageState() {
    var s = TA.getCachedSettings();
    return {
      ok: true,
      supported: true,
      translated: state.phase === 'translated',
      mode: state.mode,
      scope: state.scope,
      progress: state.progress ? { done: state.progress.done, total: state.progress.total } : null,
      sameLangPage: state.sameLangPage,
      sameLangPageReason: state.sameLangPage ? (state.sameLangPageReason || 'pageDominance') : null,
      error: state.error,
      features: featureBits(s),
      theme: effectiveTheme(s),
      formula: TA.formula.getStats()
    };
  }

  // GET_FEATURES 响应：能力自检（无头测试断言用）
  function buildFeaturesState() {
    var s = TA.getCachedSettings();
    return {
      ok: true,
      features: featureBits(s),
      themes: (TA.THEMES || []).slice(),
      pageLang: pageLangSnapshot(s),
      formula: TA.formula.getStats()
    };
  }

  function featureBits(s) {
    s = s || {};
    return {
      hoverEnabled: !!(s.hoverTranslate && s.hoverTranslate.enabled),
      selectionEnabled: !!(s.selection && s.selection.enabled),
      inputEnabled: !!(s.inputTranslate && s.inputTranslate.enabled),
      floatBall: !!(s.ui && s.ui.showFloatBall) && !!TA.features.get('ball')
    };
  }

  function pageLangSnapshot(s) {
    var target = (s && s.targetLang) || 'zh-CN';
    var root = document.body || document.documentElement;
    var dom = TA.lang.pageDominance(root, target);
    return { skip: dom.skip, ratio: dom.ratio };
  }

  function effectiveTheme(s) {
    if (!s) s = TA.getCachedSettings();
    var theme = (s && s.targetStyle && s.targetStyle.theme) || 'dashed';
    try {
      var rules = TA.rules.resolve(location.href, s);
      if (rules && typeof rules.theme === 'string' && rules.theme) theme = rules.theme;
    } catch (e) { /* 忽略 */ }
    return theme;
  }

  // 快捷键/右键菜单（background 转发）映射：
  // toggle-translate=⑤（无 scope）、translate-full=⑤（scope:'full'）、toggle-bilingual=⑥、
  // toggle-mask=遮罩学习模式全页开关（v0.2 新增，无默认键）；
  // 内置未命中的 name → features.cmds 依次分发（如 translate-input-box）。
  function handleCmd(name) {
    if (name === 'toggle-translate') toggle();
    else if (name === 'translate-full') toggle('full');
    else if (name === 'toggle-bilingual') applyMode(state.mode === 'bilingual' ? 'translation-only' : 'bilingual');
    else if (name === 'toggle-mask') TA.injector.toggleMaskTheme();
    else dispatchFeatureCmd(name);
  }

  function dispatchFeatureCmd(name) {
    for (var i = 0; i < TA.features.list.length; i++) {
      var f = TA.features.list[i];
      if (f && f.cmds && typeof f.cmds[name] === 'function') {
        try { f.cmds[name](); }
        catch (e) { console.error('[TA] 功能 ' + f.name + ' cmd ' + name + ' 执行失败', e); }
        return;
      }
    }
    console.warn('[TA] 未实现的 CMD: ' + name);
  }

  /* ==================== MutationObserver（防抖 300ms） ==================== */

  // 说明：协议 F 节要求"忽略与自身相关的 mutation"。这里只跳过可明确归因于自身产物的
  // mutation（新增节点是 wrapper/original/original-inline/悬浮球/自定义样式、目标在
  // wrapper 内）；站点对已翻译 unit 内部的编辑视为相关，交给 hash 对比决定是否重译——
  // 若按字面跳过所有 target ∈ [data-ta] 的 mutation，F 节的"hash 变化 → 重译"将永远不触发。
  function onMutations(muts) {
    if (state.phase !== 'translated') return;
    var relevant = false;
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'childList') {
        var selfAdded = false;
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType !== 1) continue;
          var cl = n.classList;
          if (cl && (cl.contains('ta-target-wrapper') || cl.contains('ta-original') ||
                     cl.contains('ta-original-inline') || cl.contains('ta-float-ball'))) {
            selfAdded = true; break;
          }
          if (n.id === 'ta-user-css') { selfAdded = true; break; }
        }
        if (selfAdded) continue;
      }
      var t = m.target;
      if (t && t.nodeType === 1) {
        if (t.closest('.ta-target-wrapper') || t.closest('.ta-float-ball') || t.id === 'ta-user-css') continue;
        relevant = true;
      } else if (m.type === 'characterData' && t && t.parentElement) {
        var pe = t.parentElement;
        if (pe.closest('.ta-target-wrapper') || pe.closest('.ta-float-ball') || pe.id === 'ta-user-css') continue;
        relevant = true;
      }
    }
    if (relevant) scheduleRewalk();
  }

  function scheduleRewalk() {
    if (rewalkTimer) clearTimeout(rewalkTimer);
    rewalkTimer = setTimeout(function () { rewalkTimer = 0; rewalk(); }, 300);
  }

  // 补译：已翻译 unit 的 hash 变化 → 先还原再按新段落重译；新块级内容 → 正常收集。
  // v0.2：收集前先等公式稳定（3s 上限）并对新增范围做公式保护（跳过已翻译单元内的
  // 公式，避免其 token 一直留在原文里）；含异步 settle，用 rewalkBusy 防重入。
  function rewalk() {
    if (state.phase !== 'translated' || rewalkBusy) return;
    rewalkBusy = true;
    TA.getSettings().then(function (settings) {
      if (state.phase !== 'translated') { rewalkBusy = false; return; }
      var root = document.body || document.documentElement;
      var opts = collectOpts(settings);

      disconnectObserver();
      // ① hash 变化的已翻译 unit：还原（去掉 data-ta 标记，随后会被重新收集）
      // 注意：重建文本必须与当初收集时用同一套 scope/rules（opts 已含），否则排除集
      // 不同会导致 hash 误判变化
      var doneEls = root.querySelectorAll('[data-ta="done"]');
      for (var i = 0; i < doneEls.length; i++) {
        var el = doneEls[i];
        var built = null;
        try {
          built = TA.walker.buildUnit(el, {
            scope: opts.scope,
            rules: opts.rules,
            targetLang: opts.targetLang,
            settings: opts.settings,
            forced: el.hasAttribute('data-ta-forced')
          });
        } catch (e) { continue; }
        if (built && built.text && TA.walker.unitHash(built.text) !== el.getAttribute('data-ta-hash')) {
          TA.injector.restoreUnit(el);
        }
      }
      // ② 公式时机（增量）：等新公式渲染稳定（SPA/翻页后插入的 MathJax/KaTeX）
      return TA.formula.settle(root, 3000).then(function () {
        if (state.phase !== 'translated') { rewalkBusy = false; return; }
        // ③ 对新增范围保护公式：skipInside 已翻译单元——已翻译单元内的公式不动，
        //    只有本轮将被重新收集/翻译的内容才会出现 token
        TA.formula.protect(root, { skipInside: '[data-ta]' });
        // ④ 收集新段落（已标记 data-ta 的会被跳过）
        var units = TA.walker.collectUnits(root, opts);
        if (!units.length) {
          TA.formula.restoreAll(); // token 不留正文
          connectObserver();
          rewalkBusy = false;
          return;
        }
        var run = ++runSeq;
        state.phase = 'translating';
        state.progress = { done: 0, total: units.length };
        notifyState();
        for (var j = 0; j < units.length; j++) TA.injector.injectLoading(units[j], settings, opts);
        connectObserver();
        rewalkBusy = false;
        return runUnits(run, units, settings);
      });
    }).catch(function (e) {
      console.error('[TA] 动态内容补译失败', e);
      TA.formula.restoreAll();
      connectObserver();
      rewalkBusy = false;
    });
  }

  function setupObserver() {
    observer = new MutationObserver(onMutations);
    connectObserver();
  }

  function connectObserver() {
    if (observer && !observerConnected) {
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      observerConnected = true;
    }
  }

  function disconnectObserver() {
    if (observer && observerConnected) {
      observer.disconnect();
      observerConnected = false;
    }
  }

  /* ==================== SPA URL 轮询（800ms） ==================== */

  function setupUrlPolling() {
    lastUrl = location.href;
    setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      var wasTranslated = state.phase === 'translated';
      restoreAll(); // DOM 残留 wrapper 时先全页还原（含公式兜底回归）
      if (wasTranslated) startTranslate(); // 变化即清状态重算
    }, 800);
  }

  /* ==================== 设置变更（不经 background 转发） ==================== */

  // 只应用到已渲染节点：主题类、内联颜色字号、loading 档、自定义 CSS；
  // 并广播给全部注册功能（悬浮球/导出/三件套各自消费）；不自动重译
  // （协议：设置变更即时生效于已渲染节点）。
  function onSettingsChanged(settings) {
    TA.injector.applyThemeSettings(settings, collectOpts(settings));
    broadcastSettingsChanged(settings);
    notifyState();
  }

  /* ==================== 初始化 ==================== */

  function init() {
    TA.getSettings().then(function (settings) {
      state.mode = settings.translateMode === 'translation-only' ? 'translation-only' : 'bilingual';
      state.scope = settings.scopeMode === 'full' ? 'full' : 'smart';
      applyMode(state.mode);                    // 同步 injector 当前显隐模式
      TA.injector.applyThemeSettings(settings, collectOpts(settings)); // 主题/loading/自定义 CSS（如配置）
      initFeatures(settings);                   // 按注册序初始化 B/C 模块（悬停/划词/球/导出）
      TA.onSettingsChanged(onSettingsChanged);
      setupObserver();
      setupUrlPolling();
    }).catch(function (e) {
      console.error('[TA] content/main.js 初始化失败', e);
    });
  }

  init();
})();
