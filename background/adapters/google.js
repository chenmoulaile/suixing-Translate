// background/adapters/google.js —— 谷歌 gtx 免费接口（无 key）
// 照侦察定稿（atcoder better.txt 16539-16570）：
//   GET https://translate.googleapis.com/translate_a/single?{client=gtx, sl=auto, tl=<mapLang>, dt=t, q=<单段>}
//   q 是单值，不支持数组 → 包内逐段请求（侦察 16539-16548）；
//   响应 data[0] 为分段数组，segments.map(s=>s[0]).join('') 拼接（16550-16568）；
//   结构校验照侦察 16552-16559：非数组/空/段非数组/段首非字符串 → BAD_RESPONSE；
//   mapLang：zh-CN→zh-CN、zh-TW→zh-TW、其余小写码（侦察 476 行）。
//   budget 5000（UTF-16 码元）；concurrency 2；timeout 15s。
//   并发说明：包内逐段请求经 mapWithConcurrency(2)，实际 HTTP 并发仍受
//   req.http（TA.queue.withSlot）约束，全服务总并发恒 ≤ 2。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
  var BUDGET = 5000;
  var TIMEOUT = 15000;
  var INNER_CONCURRENCY = 2;

  function gtxUrl(text, tl) {
    var params = new URLSearchParams();
    params.set('client', 'gtx');
    params.set('sl', 'auto');
    params.set('tl', tl);
    params.set('dt', 't');
    params.set('q', text);
    return ENDPOINT + '?' + params.toString();
  }

  // 结构校验（侦察 16552-16559）
  function extract(data) {
    if (!Array.isArray(data) || !data.length || !Array.isArray(data[0])) {
      throw TA.err('BAD_RESPONSE', '谷歌翻译返回了无效的翻译响应', { service: 'google' });
    }
    var segments = data[0];
    if (!segments.length) {
      throw TA.err('BAD_RESPONSE', '谷歌翻译返回空结果', { service: 'google' });
    }
    var out = '';
    for (var i = 0; i < segments.length; i++) {
      if (!Array.isArray(segments[i]) || typeof segments[i][0] !== 'string') {
        throw TA.err('BAD_RESPONSE', '谷歌翻译返回了无效的翻译响应', { service: 'google' });
      }
      out += segments[i][0];
    }
    return out;
  }

  async function requestGtx(req, text, tl) {
    var res = await req.http.request({
      url: gtxUrl(text, tl),
      method: 'GET',
      headers: {},
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    return extract(res.data);
  }

  // 单段翻译：>budget 先切分再逐块请求，全部成功拼回（任一块失败 → 整段失败）
  async function translateOne(req, text, tl) {
    if (text.length > BUDGET) {
      var chunks = TA.adapters.splitLongText(text, BUDGET);
      var parts = [];
      for (var i = 0; i < chunks.length; i++) {
        parts.push(await requestGtx(req, chunks[i], tl));
      }
      return parts.join('');
    }
    return requestGtx(req, text, tl);
  }

  TA.adapters.register('google', {
    needsKey: false,
    budget: BUDGET,
    concurrency: 2,
    keyOk: function () { return true; },
    supportsLang: function (lang) { return TA.langmap.supportsLang('google', lang); },
    mapLang: function (lang) { return TA.langmap.mapLang('google', lang); },
    translate: async function (req) {
      var tl = TA.langmap.mapLang('google', req.targetLang);
      if (!tl) throw TA.err('UNSUPPORTED_LANG', '谷歌翻译不支持目标语言 ' + req.targetLang, { service: 'google' });
      // gtx 接口 q 为单值，不支持数组 → 包内逐段请求（并发受 req.http 信号量约束）
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return translateOne(req, text, tl);
      });
      return { translations: out };
    }
  });
})();
