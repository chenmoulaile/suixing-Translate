// background/adapters/deepl-api.js —— DeepL 官方 API 与 DeepLX 三变体（需配置）
// 照侦察定稿（atcoder better.txt 16219-16301）：
//   api-free → POST https://api-free.deepl.com/v2/translate
//   api-pro  → POST https://api.deepl.com/v2/translate
//     headers {Content-Type, Authorization:'DeepL-Auth-Key '+authKey}
//     body {text: texts 数组, target_lang: 大写码, split_sentences:'1'}（多段一次请求）
//   deeplx   → POST https://api.deeplx.org/translate
//     headers {Content-Type, ...(authKey ? {Authorization:'Bearer '+authKey} : {})}（key 非空才带）
//     body {text: 单段字符串, target_lang: 大写码} 逐段顺序请求（deeplx 不收数组）
//     响应校验 code===200 && typeof data==='string' && data
//     不传 source_lang 让服务端自动检测——侦察显示原脚本写死 source_lang:'EN'（16284），
//     对非英文页面是错误行为，此处为有意修正。
//   config {genre:'api-free'|'api-pro'|'deeplx', authKey, proxy, splitSentences}
//   proxy 非空时整体替换请求 URL（侦察 16229/16259/16281 语义）。
//   key 规则：genre=deeplx 时 authKey 可空（仅作可选 Bearer）；api-free/api-pro 必需（NO_KEY）。
//   target_lang 大写码照侦察 473 行表：zh-TW 与 hi 不在表内 → UNSUPPORTED_LANG 走降级。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var DEFAULT_URLS = {
    'api-free': 'https://api-free.deepl.com/v2/translate',
    'api-pro': 'https://api.deepl.com/v2/translate',
    'deeplx': 'https://api.deeplx.org/translate'
  };
  var BUDGET = 5000;
  var TIMEOUT = 30000;

  function badResponse(msg) {
    return TA.err('BAD_RESPONSE', msg, { service: 'deepl-api' });
  }

  function officialExtract(data, count) {
    if (!data || !Array.isArray(data.translations)) throw badResponse('DeepL API 返回了无效的翻译响应');
    if (data.translations.length !== count) throw badResponse('DeepL API 译文数量不匹配: ' + data.translations.length + '/' + count);
    var out = [];
    for (var i = 0; i < data.translations.length; i++) {
      var t = data.translations[i] && data.translations[i].text;
      if (typeof t !== 'string' || !t) throw badResponse('DeepL API 译文存在空段（下标 ' + i + '）');
      out.push(t);
    }
    return out;
  }

  async function postOfficial(req, url, headers, textsArr, targetLang, cfg) {
    var body = { text: textsArr, target_lang: targetLang };
    // split_sentences 开关（uiSpec 卡片开关；默认 true → '1'，用户显式关闭时 '0'）
    body.split_sentences = cfg.splitSentences === false ? '0' : '1';
    var res = await req.http.request({
      url: url, method: 'POST', headers: headers,
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT, responseType: 'json', credentials: 'omit'
    });
    return res.data;
  }

  TA.adapters.register('deepl-api', {
    needsKey: true,
    budget: BUDGET,
    concurrency: 1, // 顺序请求
    // genre=deeplx 时 authKey 可空（仅作可选 Bearer）
    keyOk: function (cfg) {
      if (!cfg) return false;
      if (cfg.genre === 'deeplx') return true;
      return typeof cfg.authKey === 'string' && cfg.authKey.length > 0;
    },
    supportsLang: function (lang) { return TA.langmap.supportsLang('deepl-api', lang); },
    mapLang: function (lang) { return TA.langmap.mapLang('deepl-api', lang); },
    translate: async function (req) {
      var cfg = req.config || {};
      var genre = DEFAULT_URLS[cfg.genre] ? cfg.genre : 'api-free';
      var targetLang = TA.langmap.mapLang('deepl-api', req.targetLang);
      if (!targetLang) throw TA.err('UNSUPPORTED_LANG', 'DeepL API 不支持目标语言 ' + req.targetLang, { service: 'deepl-api' });
      var url = (typeof cfg.proxy === 'string' && cfg.proxy) || DEFAULT_URLS[genre];

      if (genre === 'deeplx') return translateDeeplx(req, url, targetLang, cfg);
      return translateOfficial(req, url, targetLang, cfg);
    }
  });

  // api-free / api-pro：多段 texts 数组一次请求（协议定稿 body {text: texts数组}）；
  // 单段 >budget（调度层独立封包）时切分后逐块请求再拼回
  async function translateOfficial(req, url, targetLang, cfg) {
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.authKey) headers['Authorization'] = 'DeepL-Auth-Key ' + cfg.authKey;
    var texts = req.texts;
    // 调度层打包不变式：多段包内每段 ≤budget，单段超长恒为独立包
    if (texts.length === 1 && texts[0].length > BUDGET) {
      // 单段超长：切分后逐块请求，任一块最终失败 → 整段失败
      var chunks = TA.adapters.splitLongText(texts[0], BUDGET);
      var parts = [];
      for (var j = 0; j < chunks.length; j++) {
        var d1 = await postOfficial(req, url, headers, [chunks[j]], targetLang, cfg);
        parts.push(officialExtract(d1, 1)[0]);
      }
      return { translations: [parts.join('')] };
    }
    // 多段数组一次请求（含单段 ≤budget 的独立包）
    var data = await postOfficial(req, url, headers, texts, targetLang, cfg);
    return { translations: officialExtract(data, texts.length) };
  }

  // deeplx：body 为单段字符串，逐段顺序请求（侦察 16282-16286）
  async function translateDeeplx(req, url, targetLang, cfg) {
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.authKey) headers['Authorization'] = 'Bearer ' + cfg.authKey;
    var out = [];
    for (var i = 0; i < req.texts.length; i++) {
      out.push(await deeplxOne(req, url, headers, req.texts[i], targetLang));
    }
    return { translations: out };
  }

  async function deeplxOne(req, url, headers, text, targetLang) {
    // 单段超长：切分后逐块请求再拼回（任一块失败 → 整段失败）
    var chunks = text.length > BUDGET ? TA.adapters.splitLongText(text, BUDGET) : [text];
    var result = '';
    for (var i = 0; i < chunks.length; i++) {
      // 不传 source_lang：让服务端自动检测（有意修正侦察中写死 source_lang:'EN' 的行为）
      var res = await req.http.request({
        url: url, method: 'POST', headers: headers,
        body: JSON.stringify({ text: chunks[i], target_lang: targetLang }),
        timeoutMs: TIMEOUT, responseType: 'json', credentials: 'omit'
      });
      var d = res.data;
      if (!d || d.code !== 200 || typeof d.data !== 'string' || !d.data) {
        throw badResponse('DeepLX 返回了无效的翻译响应');
      }
      result += d.data;
    }
    return result;
  }
})();
