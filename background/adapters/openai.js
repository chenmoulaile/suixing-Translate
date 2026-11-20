// background/adapters/openai.js —— OpenAI 兼容 chat/completions（需用户 key）
// 照协议定稿（侦察 17044-17056 / 17103-17135 的 Chat 形态，非其默认的 /v1/responses 端点）：
//   config {baseUrl:'https://api.openai.com/v1', model:'gpt-4o-mini', apiKey:'',
//           temperature:0.2, systemPrompt:''}
//   POST {baseUrl}/chat/completions，headers {Content-Type, Authorization:'Bearer '+apiKey}
//   body {model, messages:[{role:'system', content: systemPrompt||默认模板},
//         {role:'user', content: text}], temperature}
//   非流式（v1 不实现 SSE 流式）。
//   默认模板：'You are a translation engine. Translate the user message into <LanguageName>.
//   Output ONLY the translation, preserving original line breaks, numbering, HTML tags and
//   placeholders like 【12345678】 and ⟪m0⟫. Do not add explanations.'（systemPrompt 非空整体替换默认模板）
//   语言名映射（侦察 479 行语义）：zh-CN→Simplified Chinese、zh-TW→Traditional Chinese……
//   响应校验 choices[0].message.content 为字符串，否则 BAD_RESPONSE。
//   逐段请求（不做多段拼包，规避回填错位）；budget 0 = 不限（调度层每段独立封包）；
//   concurrency 2；timeout 60s。
//   baseUrl 主机非 api.openai.com 时（DeepSeek/中转等兼容端点），options 页负责
//   chrome.permissions.request 授权该域名（本适配器不处理授权）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var DEFAULT_BASE = 'https://api.openai.com/v1';
  var DEFAULT_MODEL = 'gpt-4o-mini';
  var TIMEOUT = 60000;
  var INNER_CONCURRENCY = 2;

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

  // 单段翻译：一次 chat/completions 请求（budget=0 不切分；占位符保护交给 prompt 约定）
  async function openaiOne(req, url, model, systemPrompt, temperature, text) {
    var res = await req.http.request({
      url: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (req.config && req.config.apiKey)
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: temperature
      }),
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    var d = res.data;
    var content = d && Array.isArray(d.choices) && d.choices[0] && d.choices[0].message &&
      typeof d.choices[0].message.content === 'string' ? d.choices[0].message.content : null;
    if (content === null) {
      throw TA.err('BAD_RESPONSE', 'OpenAI 返回了无效的翻译响应', { service: 'openai' });
    }
    return content;
  }

  TA.adapters.register('openai', {
    needsKey: true,
    budget: 0, // 不限（侦察 translationLimits 表不含 openai）
    concurrency: 2,
    keyOk: function (cfg) {
      return !!(cfg && typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0);
    },
    supportsLang: function (lang) { return !!LANG_NAMES[lang]; },
    mapLang: function (lang) { return LANG_NAMES[lang] || null; },
    translate: async function (req) {
      var cfg = req.config || {};
      if (!this.keyOk(cfg)) throw TA.err('NO_KEY', 'OpenAI 未配置 API Key', { service: 'openai' });
      var langName = LANG_NAMES[req.targetLang];
      if (!langName) throw TA.err('UNSUPPORTED_LANG', 'OpenAI 不支持目标语言 ' + req.targetLang, { service: 'openai' });
      var systemPrompt = (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt) || defaultPrompt(langName);
      // 追加术语表 / AI 上下文（仅非空字符串），供术语一致性功能使用；不改动其它行为
      if (typeof cfg.termsText === 'string' && cfg.termsText) systemPrompt += '\n\n' + cfg.termsText;
      if (typeof cfg.contextText === 'string' && cfg.contextText) systemPrompt += '\n\n' + cfg.contextText;
      var temperature = typeof cfg.temperature === 'number' && isFinite(cfg.temperature)
        ? Math.max(0, Math.min(2, cfg.temperature)) : 0.2;
      var model = (typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL;
      var base = (typeof cfg.baseUrl === 'string' && cfg.baseUrl) || DEFAULT_BASE;
      var url = base.replace(/\/+$/, '') + '/chat/completions';
      // 逐段请求（不做多段拼包，规避回填错位）；包内并发受 req.http 信号量约束
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return openaiOne(req, url, model, systemPrompt, temperature, text);
      });
      return { translations: out };
    }
  });
})();
