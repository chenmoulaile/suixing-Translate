// background/adapters/caiyun.js —— 彩云小译（内置公开 token，无用户 key）
// 照侦察定稿（atcoder better.txt 16577-16628）：
//   browser_id = md5(String(Math.random()))
//   步骤① POST https://api.interpreter.caiyunai.com/v1/user/jwt/generate
//     headers {content-type:'application/json', x-authorization:'token:qgemv4jr1y38jyq6vhvi'}
//     （内置公开常量，非用户密钥）body {browser_id}；jwt = JSON.parse(res).jwt
//   步骤② POST https://api.interpreter.caiyunai.com/v1/translator
//     headers 同 token + {t-authorization:jwt}
//     body {source: 原文.split('\n'), browser_id, trans_type, request_id:'web_fanyi',
//           media:'text', os_type:'web', dict:true, cached:true, replaced:true,
//           style:'formal', model:'', detect:true}
//   响应 target[] 与 source 行数对应；每行先过字符映射表（ROT13 式，源表
//   'NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm' ↔ 标准字母表，即 dic[旋转字符]=标准字符，
//   非映射字符原样保留）再 atob → Uint8Array → TextDecoder('utf-8')，行间 join('\n')。
//   漏掉 dic 替换会得到乱码（侦察 pitfalls④）。
//   origin 头无法携带（forbidden header），如实标注。
//   budget 5000；concurrency 2；timeout 15s；supportsLang 仅 zh-CN/zh-TW→auto2zh、
//   ja→auto2ja、ko→auto2ko、es→auto2es、fr→auto2fr（侦察 477 行）。
//   jwt 与 browser_id 每包现取一次，包内各段复用（侦察每次调用现取，扩展按包复用减少请求次数）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var JWT_URL = 'https://api.interpreter.caiyunai.com/v1/user/jwt/generate';
  var TRANSLATE_URL = 'https://api.interpreter.caiyunai.com/v1/translator';
  var TOKEN = 'token:qgemv4jr1y38jyq6vhvi'; // 内置公开常量（非用户密钥，侦察 16587/16623）
  var BUDGET = 5000;
  var TIMEOUT = 15000;
  var INNER_CONCURRENCY = 2;

  // ROT13 式映射表：dic[旋转字符] = 标准字符（侦察 16578-16579）
  var ROT = 'NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm';
  var STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  var DIC = {};
  for (var di = 0; di < ROT.length; di++) DIC[ROT[di]] = STD[di];

  // 每行：字符替换 → atob → Uint8Array → UTF-8 解码（侦察 16597-16602）
  function decodeLine(line) {
    var mapped = '';
    for (var i = 0; i < line.length; i++) {
      var c = DIC[line[i]];
      mapped += (c !== undefined ? c : line[i]);
    }
    var bin = atob(mapped); // 非法 Base64 抛 InvalidCharacterError，由调用方转 BAD_RESPONSE
    var bytes = new Uint8Array(bin.length);
    for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function getJwt(req, browserId) {
    var res = await req.http.request({
      url: JWT_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-authorization': TOKEN },
      body: JSON.stringify({ browser_id: browserId }),
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    var jwt = res.data && res.data.jwt;
    if (typeof jwt !== 'string' || !jwt) {
      throw TA.err('BAD_RESPONSE', '彩云 jwt 接口返回无效数据', { service: 'caiyun' });
    }
    return jwt;
  }

  // 单段翻译：按行拆 source，响应逐行解码后 join('\n')
  async function translateOne(req, text, browserId, jwt, transType) {
    var source = text.split('\n');
    var res = await req.http.request({
      url: TRANSLATE_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'x-authorization': TOKEN,
        't-authorization': jwt
      },
      body: JSON.stringify({
        source: source,
        browser_id: browserId,
        trans_type: transType,
        request_id: 'web_fanyi',
        media: 'text',
        os_type: 'web',
        dict: true,
        cached: true,
        replaced: true,
        style: 'formal',
        model: '',
        detect: true
      }),
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'omit'
    });
    var target = res.data && res.data.target;
    if (!Array.isArray(target) || target.length !== source.length) {
      throw TA.err('BAD_RESPONSE', '彩云译文行数与原文不匹配', { service: 'caiyun' });
    }
    var lines;
    try {
      lines = target.map(decodeLine);
    } catch (e) {
      throw TA.err('BAD_RESPONSE', '彩云译文解码失败: ' + ((e && e.message) || String(e)), { service: 'caiyun' });
    }
    return lines.join('\n');
  }

  // 单段 >budget：切分后逐块请求再拼回
  async function caiyunOne(req, text, browserId, jwt, transType) {
    if (text.length > BUDGET) {
      var chunks = TA.adapters.splitLongText(text, BUDGET);
      var parts = [];
      for (var i = 0; i < chunks.length; i++) {
        parts.push(await translateOne(req, chunks[i], browserId, jwt, transType));
      }
      return parts.join('');
    }
    return translateOne(req, text, browserId, jwt, transType);
  }

  TA.adapters.register('caiyun', {
    needsKey: false,
    budget: BUDGET,
    concurrency: 2,
    keyOk: function () { return true; },
    supportsLang: function (lang) { return TA.langmap.supportsLang('caiyun', lang); },
    mapLang: function (lang) { return TA.langmap.mapLang('caiyun', lang); },
    translate: async function (req) {
      var transType = TA.langmap.mapLang('caiyun', req.targetLang);
      if (!transType) throw TA.err('UNSUPPORTED_LANG', '彩云不支持目标语言 ' + req.targetLang, { service: 'caiyun' });
      var browserId = TA.md5(String(Math.random()));
      var jwt = await getJwt(req, browserId);
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return caiyunOne(req, text, browserId, jwt, transType);
      });
      return { translations: out };
    }
  });
})();
