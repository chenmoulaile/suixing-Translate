// background/adapters/deepl-free.js —— DeepL oneshot 匿名免费接口（无 key）
// 照侦察定稿（atcoder better.txt 16143-16209）：
//   POST https://oneshot-free.www.deepl.com/v1/translate
//   headers {Content-Type:'application/json', Authorization:'None'}（Authorization 字面值即字符串 'None'）
//   credentials:'omit'（复刻 anonymous:true + nocache 语义）
//   body {text:[...texts], target_lang}；不传 timestamp/id/source_lang——
//   侦察实证本地脚本无 jsonrpc 外壳、无 id 生成（getTimeStamp 为 0 调用死代码）。
//   二级语言映射（侦察 16163）：{ZH:'zh-Hans', EN:'en-US', PT:'pt-BR'}[language] || language
//   → zh-CN 最终发 'zh-Hans'。
//   budget 1500（UTF-16 码元，侦察 16144-16145）；429 → RATE_LIMITED 不重试（queue.js 处理）。
//   多段数组形态未经网络实测 → 首试失败（BAD_RESPONSE）时适配器内自动降级为逐段顺序请求；
//   单段 >1500 走超长切分：各块剥首尾空白只翻核心、译后按 leading+译文+trailing 原样恢复，
//   纯空白块直接拼回不请求（协议 batchingRules 规则 5）。
//   zh-TW 不在 deepl 表内：supportsLang 返回 false → UNSUPPORTED_LANG 走降级，
//   有意不学原脚本静默回退 ZH——避免繁体请求产出简体译文。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var ENDPOINT = 'https://oneshot-free.www.deepl.com/v1/translate';
  var BUDGET = 1500;
  var TIMEOUT = 30000; // 侦察 GM_xmlhttpRequest timeout:30000
  // oneshot 二级语言映射（侦察 16163 定稿；EN 分支照协议保留）
  var ONESHOT_LANG = { ZH: 'zh-Hans', EN: 'en-US', PT: 'pt-BR' };

  function targetLangOf(req) {
    var mapped = TA.langmap.mapLang('deepl-free', req.targetLang);
    if (!mapped) throw TA.err('UNSUPPORTED_LANG', 'DeepL 免费接口不支持目标语言 ' + req.targetLang, { service: 'deepl-free' });
    return ONESHOT_LANG[mapped] || mapped;
  }

  // 严格校验（侦察 16186-16196 的校验精神，按多段形态放宽长度===1 的单段限制）：
  // translations 必须是数组、长度 === count、每项 text 为非空字符串
  function extractTranslations(data, count) {
    if (!data || !Array.isArray(data.translations)) {
      throw TA.err('BAD_RESPONSE', 'DeepL 返回了无效的翻译响应', { service: 'deepl-free' });
    }
    if (data.translations.length !== count) {
      throw TA.err('BAD_RESPONSE', 'DeepL 译文数量不匹配: ' + data.translations.length + '/' + count, { service: 'deepl-free' });
    }
    var out = [];
    for (var i = 0; i < data.translations.length; i++) {
      var t = data.translations[i] && data.translations[i].text;
      if (typeof t !== 'string' || !t) {
        throw TA.err('BAD_RESPONSE', 'DeepL 译文存在空段（下标 ' + i + '）', { service: 'deepl-free' });
      }
      out.push(t);
    }
    return out;
  }

  // 单次 POST：textsArr 为文本数组
  async function postOnce(req, textsArr, targetLang) {
    var res = await req.http.request({
      url: ENDPOINT,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'None' },
      body: JSON.stringify({ text: textsArr, target_lang: targetLang }),
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    return res.data;
  }

  // 单段翻译（≤BUDGET 直接发；>BUDGET 切分 + 空白恢复）
  async function translateOne(req, text, targetLang) {
    if (text.length <= BUDGET) {
      // 与原脚本已验证形态完全一致：单段包成单元素数组
      var data = await postOnce(req, [text], targetLang);
      return extractTranslations(data, 1)[0];
    }
    // 超长切分（规则 4/5）：各块剥首尾空白只翻核心，译后原样恢复空白
    var chunks = TA.adapters.splitLongText(text, BUDGET);
    var result = '';
    for (var i = 0; i < chunks.length; i++) {
      var chunk = chunks[i];
      var leadLen = chunk.length - chunk.replace(/^\s+/, '').length;
      var trailLen = chunk.length - chunk.replace(/\s+$/, '').length;
      var core = chunk.slice(leadLen, chunk.length - trailLen);
      if (!core) {
        // 纯空白块直接拼回，不请求
        result += chunk;
        continue;
      }
      var d = await postOnce(req, [core], targetLang);
      var t = extractTranslations(d, 1)[0];
      result += chunk.slice(0, leadLen) + t + chunk.slice(chunk.length - trailLen);
    }
    return result;
  }

  TA.adapters.register('deepl-free', {
    needsKey: false,
    budget: BUDGET,
    concurrency: 1, // 严格顺序（侦察 16164："顺序发送，避免长段落产生并发请求"）
    keyOk: function () { return true; },
    supportsLang: function (lang) { return TA.langmap.supportsLang('deepl-free', lang); },
    mapLang: function (lang) { return TA.langmap.mapLang('deepl-free', lang); },
    // req: {texts, targetLang, sourceLang, config, http, signal}
    // 成功返回 {translations:[...]}（长度 === texts.length）；失败 throw TAError
    translate: async function (req) {
      var targetLang = targetLangOf(req);
      var texts = req.texts;
      // ① 多段数组形态（未实测）：失败（仅 BAD_RESPONSE）时自动降级为逐段顺序请求
      if (texts.length > 1) {
        try {
          var data = await postOnce(req, texts, targetLang);
          return { translations: extractTranslations(data, texts.length) };
        } catch (err) {
          if (!(err && err.code === 'BAD_RESPONSE')) throw err;
          // 其余错误（429/超时/网络等）原样抛出，走队列重试或调度层降级
        }
      }
      // ② 逐段顺序请求（concurrency=1，包内亦保持严格顺序）
      var out = [];
      for (var i = 0; i < texts.length; i++) {
        out.push(await translateOne(req, texts[i], targetLang));
      }
      return { translations: out };
    }
  });
})();
