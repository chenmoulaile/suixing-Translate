// background/adapters/dsh-free.js —— 本地免费模型（dsh-free，Local Free Model）
// 照 openai.js 协议形态（OpenAI 兼容 chat/completions，无密钥）+ 速度探测自动选最快模型：
//   基准 URL：cfg.dshBaseUrl（settings.services['dsh-free'].dshBaseUrl，可配置），
//     默认 http://127.0.0.1:19281/v1（或用户实际指向的本地基准）。
//   模型列表 GET {base}/models，响应兼容 {data:[...]} / {models:[...]} / [...] 形态（有 data 数组）。
//   模型选择缓存 chrome.storage.local：'dshFree.model' + 'dshFree.modelAt'，有效期 ~10 分钟，复用；
//   否则拉模型列表，再对前 N 个候选模型发一个最小 chat 请求（max_tokens:1，"OK"），
//   记录响应耗时，选最快者作 selectedModel（全部失败回退第一个模型）。
//   翻译：逐段 POST {base}/chat/completions（systemPrompt 默认模板参考 openai.js，11 种语言英文名），
//     temperature 0.2，响应解析 choices[0].message.content（空→BAD_RESPONSE），
//     timeoutMs 60000，逐段并发 2（TA.adapters.mapWithConcurrency）。
//   用户配置 cfg.model 时优先，未配置则自动选最快。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var DEFAULT_BASE = 'http://127.0.0.1:19281/v1';
  var TIMEOUT = 60000;
  var INNER_CONCURRENCY = 2;
  var MODEL_TTL_MS = 10 * 60 * 1000;
  var MODEL_KEY = 'dshFree.model';
  var MODEL_AT_KEY = 'dshFree.modelAt';
  var MODELS_PATH = '/models';
  var CHAT_PATH = '/chat/completions';
  var MODEL_PROBE_COUNT = 4;      // 测速候选数（前 N 个模型）
  var PROBE_TIMEOUT = 15000;
  var PROBE_MAX_TOKENS = 1;       // 探测最小输出
  var PROBE_MARK = 'OK';

  // 本文件自包含的语言名映射（照 openai.js/deepseek.js）
  var LANG_NAMES = {
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    'en': 'English',
    'ja': 'Japanese',
    'ko': 'Korean',
    'de': 'German',
    'fr': 'French',
    'es': 'Spanish',
    'pt': 'Portuguese',
    'it': 'Italian',
    'hi': 'Hindi'
  };

  function defaultPrompt(langName) {
    return 'You are a translation engine. Translate the user message into ' + langName +
      '. Output ONLY the translation, preserving original line breaks, numbering, HTML tags and placeholders like 【12345678】 and ⟪m0⟫. Do not add explanations.';
  }

  // 基准 URL：cfg.dshBaseUrl > 默认 http://127.0.0.1:19281/v1
  function baseUrlOf(cfg) {
    var v = cfg && typeof cfg.dshBaseUrl === 'string' ? cfg.dshBaseUrl.trim() : '';
    return v || DEFAULT_BASE;
  }

  // 拼接 baseUrl + 路径（容忍尾部斜杠）
  function urlWithPath(base, path) {
    return String(base).replace(/\/+$/, '') + path;
  }

  // 构建 system prompt：cfg.systemPrompt 覆盖默认模板，再追加术语/上下文（仅非空字符串）
  function buildSystemPrompt(cfg, langName) {
    var base = (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt) || defaultPrompt(langName);
    if (typeof cfg.termsText === 'string' && cfg.termsText) base += '\n\n' + cfg.termsText;
    if (typeof cfg.contextText === 'string' && cfg.contextText) base += '\n\n' + cfg.contextText;
    return base;
  }

  function temperatureOf(cfg) {
    return typeof cfg.temperature === 'number' && isFinite(cfg.temperature)
      ? Math.max(0, Math.min(2, cfg.temperature)) : 0.2;
  }

  // —— 模型列表：GET {base}/models；兼容 data 数组 / models 数组 / 元素为字符串的数组 ——
  function extractModelIds(data) {
    var arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && typeof data === 'object') {
      if (Array.isArray(data.data)) arr = data.data;
      else if (Array.isArray(data.models)) arr = data.models;
    }
    if (!arr) return [];
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var m = arr[i];
      var id = typeof m === 'string' ? m : (m && typeof m.id === 'string' ? m.id : null);
      if (id) out.push(id);
    }
    return out;
  }

  async function loadModels(req, base) {
    var res = await req.http.request({
      url: urlWithPath(base, MODELS_PATH),
      method: 'GET',
      timeoutMs: 30000,
      responseType: 'json',
      credentials: 'omit'
    });
    return extractModelIds(res && res.data);
  }

  // —— 模型选择缓存（chrome.storage.local 'dshFree.model' + 'dshFree.modelAt'，有效期 ~10 分钟）——
  async function readModelCache() {
    try {
      var st = await chrome.storage.local.get([MODEL_KEY, MODEL_AT_KEY]);
      var id = st && st[MODEL_KEY];
      var at = st && st[MODEL_AT_KEY];
      if (typeof id === 'string' && id && typeof at === 'number' && Date.now() - at < MODEL_TTL_MS) {
        return id;
      }
    } catch (e) { /* 忽略缓存读失败 */ }
    return null;
  }

  async function writeModelCache(id) {
    try {
      var o = {};
      o[MODEL_KEY] = id;
      o[MODEL_AT_KEY] = Date.now();
      await chrome.storage.local.set(o);
    } catch (e) { /* 缓存写失败不影响翻译 */ }
  }

  // —— 测速：对前 N 个候选模型发最小 chat/completions，记录响应耗时，返回最快者（失败为 null）——
  async function probeOnce(req, base, modelId) {
    var t0 = Date.now();
    try {
      await req.http.request({
        url: urlWithPath(base, CHAT_PATH),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          model: modelId,
          messages: [{ role: 'user', content: PROBE_MARK }],
          temperature: 0.2,
          max_tokens: PROBE_MAX_TOKENS
        },
        timeoutMs: PROBE_TIMEOUT,
        responseType: 'json',
        credentials: 'omit'
      });
      var ms = Date.now() - t0;
      console.log('[TA] dsh-free speed probe: ' + modelId + ' -> ' + ms + 'ms');
      return ms;
    } catch (e) {
      return Infinity;
    }
  }

  async function probeFastest(req, base, ids) {
    var best = null, bestMs = Infinity;
    for (var i = 0; i < ids.length && i < MODEL_PROBE_COUNT; i++) {
      var ms = await probeOnce(req, base, ids[i]);
      if (ms < bestMs) { bestMs = ms; best = ids[i]; }
    }
    return best;
  }

  // —— 模型自动选择：缓存复用 → 测速最快（全部失败回退第一个模型）——
  async function resolveModel(req, base) {
    var cached = await readModelCache();
    if (cached) return cached;
    var ids = await loadModels(req, base);
    var best = ids.length ? (await probeFastest(req, base, ids)) : null;
    if (!best && ids.length) best = ids[0];
    if (!best) {
      throw TA.err('BAD_RESPONSE', '本地 OpenAI 兼容服务模型列表为空: ' + base, { service: 'dsh-free' });
    }
    await writeModelCache(best);
    console.log('[TA] dsh-free selected model: ' + best + ' (base: ' + base + ')');
    return best;
  }

  // —— 单段翻译：一次 chat/completions，解析 choices[0].message.content ——
  async function dshFreeOne(req, base, model, systemPrompt, temperature, text) {
    var res = await req.http.request({
      url: urlWithPath(base, CHAT_PATH),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: temperature
      },
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    var d = res && res.data;
    var content = d && Array.isArray(d.choices) && d.choices[0] && d.choices[0].message &&
      typeof d.choices[0].message.content === 'string' ? d.choices[0].message.content : null;
    if (content === null || !content.length) {
      throw TA.err('BAD_RESPONSE', '本地 OpenAI 兼容服务返回了无效的翻译响应', { service: 'dsh-free' });
    }
    return content;
  }

  TA.adapters.register('dsh-free', {
    needsKey: false,
    budget: 0,
    concurrency: INNER_CONCURRENCY,
    keyOk: function () { return true; },
    supportsLang: function (lang) { return !!LANG_NAMES[lang]; },
    mapLang: function (lang) { return LANG_NAMES[lang] || null; },
    translate: async function (req) {
      var cfg = req.config || {};
      var langName = LANG_NAMES[req.targetLang];
      if (!langName) {
        throw TA.err('UNSUPPORTED_LANG', '本地免费模型不支持目标语言 ' + req.targetLang, { service: 'dsh-free' });
      }
      var base = baseUrlOf(cfg);
      var systemPrompt = buildSystemPrompt(cfg, langName);
      var temperature = temperatureOf(cfg);
      var model = (typeof cfg.model === 'string' && cfg.model) || await resolveModel(req, base);
      // 逐段请求（并发受 req.http 信号量约束）
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return dshFreeOne(req, base, model, systemPrompt, temperature, text);
      });
      return { translations: out };
    }
  });
})();
