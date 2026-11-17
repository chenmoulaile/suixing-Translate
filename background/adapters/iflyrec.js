// background/adapters/iflyrec.js —— 讯飞免费接口（无 key，仅 zh-CN）
// 照侦察定稿（atcoder better.txt 16319-16339）：
//   POST https://www.iflyrec.com/TranslationService/v1/textTranslation
//   body {from:'2', to:'1', contents:[{text, frontBlankLine:0}]}（to 仅 zh→'1'，侦察 474 行）
//   响应 JSON.parse(res).biz[0].translateResult.replace(/\\n/g,'\n\n')（16338，字面 \n 序列转双换行）
//   侦察要求的 Origin: https://www.iflyrec.com 头 MV3 fetch 无法携带（forbidden header）→
//   服务端可能拒绝，如实标注、靠降级链兜底。
//   budget 2000（侦察 11309，各服务最小）；concurrency 1（顺序）；timeout 15s；仅支持目标语言 zh-CN。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var ENDPOINT = 'https://www.iflyrec.com/TranslationService/v1/textTranslation';
  var BUDGET = 2000;
  var TIMEOUT = 15000;

  async function requestIfly(req, text) {
    var res = await req.http.request({
      url: ENDPOINT,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.iflyrec.com' // forbidden header，浏览器静默丢弃（如实保留尝试）
      },
      body: JSON.stringify({ from: '2', to: '1', contents: [{ text: text, frontBlankLine: 0 }] }),
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    var d = res.data;
    var r = d && Array.isArray(d.biz) && d.biz[0] && typeof d.biz[0].translateResult === 'string'
      ? d.biz[0].translateResult
      : null;
    if (r === null) throw TA.err('BAD_RESPONSE', '讯飞返回了无效的翻译响应', { service: 'iflyrec' });
    // 侦察 16338：把响应中的字面 \n 序列替换为两个真实换行
    return r.replace(/\\n/g, '\n\n');
  }

  // 单段翻译：>budget 切分后逐块顺序请求再拼回
  async function translateOne(req, text) {
    if (text.length > BUDGET) {
      var chunks = TA.adapters.splitLongText(text, BUDGET);
      var parts = [];
      for (var i = 0; i < chunks.length; i++) {
        parts.push(await requestIfly(req, chunks[i]));
      }
      return parts.join('');
    }
    return requestIfly(req, text);
  }

  TA.adapters.register('iflyrec', {
    needsKey: false,
    budget: BUDGET,
    concurrency: 1, // 严格顺序
    keyOk: function () { return true; },
    // 侦察 474 行映射表只有 zh→'1'，即仅支持译入简体中文
    supportsLang: function (lang) { return lang === 'zh-CN'; },
    mapLang: function (lang) { return lang === 'zh-CN' ? '1' : null; },
    translate: async function (req) {
      if (req.targetLang !== 'zh-CN') {
        throw TA.err('UNSUPPORTED_LANG', '讯飞仅支持译入简体中文（zh-CN）', { service: 'iflyrec' });
      }
      var out = await TA.adapters.mapWithConcurrency(req.texts, 1, function (text) {
        return translateOne(req, text);
      });
      return { translations: out };
    }
  });
})();
