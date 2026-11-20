// background/adapters/deepseek.js —— DeepSeek（OpenAI 兼容 chat/completions，需用户 key）
// 照 openai.js 协议契约实现（逐段请求 / budget 0 / concurrency 2 / 响应校验）：
//   config {baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', apiKey:'',
//           temperature:0.2, systemPrompt:''}
//   POST {baseUrl}/chat/completions，headers {Content-Type, Authorization:'Bearer '+apiKey}
//   body {model, messages:[{role:'system',content:systemPrompt||默认},
//         {role:'user',content:text}], temperature}
//   systemPrompt = cfg.systemPrompt||默认模板，随后追加 cfg.termsText / cfg.contextText（非空字符串）。
//   响应校验 choices[0].message.content 为非空字符串，否则 BAD_RESPONSE。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var DEFAULT_BASE = 'https://api.deepseek.com/v1';
  var DEFAULT_MODEL = 'deepseek-chat';
  var TIMEOUT = 60000;
  var INNER_CONCURRENCY = 2;

  // 本文件自包含的语言名映射
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

  // 单段翻译：一次 chat/completions 请求
  async function deepseekOne(req, url, model, systemPrompt, temperature, text) {
    var res = await req.http.request({
      url: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + req.config.apiKey
      },
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
    var d = res.data;
    var content = d && Array.isArray(d.choices) && d.choices[0] && d.choices[0].message &&
      typeof d.choices[0].message.content === 'string' ? d.choices[0].message.content : null;
    if (content === null || !content.length) {
      throw TA.err('BAD_RESPONSE', 'DeepSeek 返回了无效的翻译响应', { service: 'deepseek' });
    }
    return content;
  }

  TA.adapters.register('deepseek', {
    needsKey: true,
    budget: 0,
    concurrency: 2,
    keyOk: function (cfg) {
      return !!(cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0);
    },
    supportsLang: function (lang) { return !!LANG_NAMES[lang]; },
    mapLang: function (lang) { return LANG_NAMES[lang] || null; },
    translate: async function (req) {
      var cfg = req.config || {};
      if (!this.keyOk(cfg)) throw TA.err('NO_KEY', 'DeepSeek 未配置 API Key', { service: 'deepseek' });
      var langName = LANG_NAMES[req.targetLang];
      if (!langName) throw TA.err('UNSUPPORTED_LANG', 'DeepSeek 不支持目标语言 ' + req.targetLang, { service: 'deepseek' });
      var systemPrompt = buildSystemPrompt(cfg, langName);
      var temperature = temperatureOf(cfg);
      var model = (typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL;
      var base = (typeof cfg.baseUrl === 'string' && cfg.baseUrl) || DEFAULT_BASE;
      var url = base.replace(/\/+$/, '') + '/chat/completions';
      // 逐段请求（并发受 req.http 信号量约束）
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return deepseekOne(req, url, model, systemPrompt, temperature, text);
      });
      return { translations: out };
    }
  });
})();
