// background/adapters/ollama.js —— 本地 Ollama /api/generate（无需 key）
// 照 openai.js 协议契约实现（逐段请求 / budget 0 / concurrency 2 / 响应校验）：
//   config {baseUrl:'http://localhost:11434', model:'llama3.1:8b', temperature:0.2, systemPrompt:''}
//   POST {baseUrl}/api/generate
//   body {model, prompt: (systemPrompt?systemPrompt+'\n\n':'')+text, stream:false, options:{temperature}}
//   systemPrompt = cfg.systemPrompt||默认模板，随后追加 cfg.termsText / cfg.contextText（非空字符串）。
//   本地服务无 key 要求 → needsKey:false、keyOk 恒 true。
//   响应校验 response 为非空字符串，否则 BAD_RESPONSE。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var DEFAULT_BASE = 'http://localhost:11434';
  var DEFAULT_MODEL = 'llama3.1:8b';
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
      '. Output ONLY the translation, preserving original line breaks, numbering, HTML tags and placeholders like 【12345678】. Do not add explanations.';
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

  // 单段翻译：一次 /api/generate 请求（关闭流式）
  async function ollamaOne(req, url, model, systemPrompt, temperature, text) {
    var res = await req.http.request({
      url: url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model: model,
        prompt: systemPrompt + '\n\n' + text,
        stream: false,
        options: { temperature: temperature }
      },
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    var d = res.data;
    var content = d && typeof d.response === 'string' ? d.response : null;
    if (content === null || !content.length) {
      throw TA.err('BAD_RESPONSE', 'Ollama 返回了无效的翻译响应', { service: 'ollama' });
    }
    return content;
  }

  TA.adapters.register('ollama', {
    needsKey: false,
    budget: 0,
    concurrency: 2,
    keyOk: function () { return true; },
    supportsLang: function (lang) { return !!LANG_NAMES[lang]; },
    mapLang: function (lang) { return LANG_NAMES[lang] || null; },
    translate: async function (req) {
      var cfg = req.config || {};
      var langName = LANG_NAMES[req.targetLang];
      if (!langName) throw TA.err('UNSUPPORTED_LANG', 'Ollama 不支持目标语言 ' + req.targetLang, { service: 'ollama' });
      var systemPrompt = buildSystemPrompt(cfg, langName);
      var temperature = temperatureOf(cfg);
      var model = (typeof cfg.model === 'string' && cfg.model) || DEFAULT_MODEL;
      var base = (typeof cfg.baseUrl === 'string' && cfg.baseUrl) || DEFAULT_BASE;
      var url = base.replace(/\/+$/, '') + '/api/generate';
      // 逐段请求（并发受 req.http 信号量约束）
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return ollamaOne(req, url, model, systemPrompt, temperature, text);
      });
      return { translations: out };
    }
  });
})();
