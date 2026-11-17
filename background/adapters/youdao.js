// background/adapters/youdao.js —— 有道 webfanyi 两步签名（无用户 key）
// 照侦察定稿（atcoder better.txt 16346-16532）：
//   步骤① GET https://dict.youdao.com/webtranslate/key?{urlData}
//     sign = md5('client=fanyideskweb&mysticTime='+t+'&product=webfanyi&key=asdjnjfenknafdfsdfsd')（固定盐，16487）
//     响应 JSON.parse(res).data 得 {secretKey, aesKey, aesIv}（16423-16424）
//   步骤② POST https://dict.youdao.com/webtranslate（application/x-www-form-urlencoded）
//     sign = md5('client=fanyideskweb&mysticTime='+t+'&product=webfanyi&key='+secretKey)
//     mysticTime 两步用同一个 t（侦察 16486）
//   响应为 URL-safe Base64 密文：'-'→'+'、'_'→'/' 还原后 atob → Uint8Array；
//   WebCrypto subtle AES-CBC 解密（默认 PKCS#7）：
//     key = md5hex(aesKey) 的 UTF-8 字节（32 字节 → AES-256）
//     iv  = md5hex(aesIv) 前 16 个 hex 字符的 UTF-8 字节
//     （CryptoJS 对超长 IV 仅取前 16 字节语义，侦察 16439-16459；md5hex 为 ASCII，前 16 字符
//      与其 UTF-8 前 16 字节等价，故仅此一式——协议回退变体与主式字面相同，见实现 notes）
//   解密结果截到最后一个 '}' 再 JSON.parse（16465-16469）；
//   data.translateResult.flat().map(x=>x.tgt).join('') 后 .replace(/\n/g,'\n\n')（16472-16481、16530）。
//   Cookie 差异（如实标注）：侦察的伪造 cookie 在 MV3 fetch 不可行（Cookie 是 forbidden header）；
//   改用 credentials:'include' 借用用户浏览器已有的 dict.youdao.com cookie；
//   若服务端风控拒绝则报 AUTH_FAILED/HTTP_ERROR 走降级链。
//   Origin/Referer 为 forbidden header，浏览器静默丢弃，如实保留尝试。
//   budget 5000；concurrency 1（顺序）；timeout 15s。密钥每包现取（侦察未缓存），
//   同包内各段复用同一 t 与密钥。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var KEY_URL = 'https://dict.youdao.com/webtranslate/key';
  var TRANSLATE_URL = 'https://dict.youdao.com/webtranslate';
  var FIXED_SALT = 'asdjnjfenknafdfsdfsd'; // 脚本内置公开常量（非用户密钥）
  var BUDGET = 5000;
  var TIMEOUT = 15000;

  function sign(t, salt) {
    return TA.md5('client=fanyideskweb&mysticTime=' + t + '&product=webfanyi&key=' + salt);
  }

  // urlData（侦察 16390-16406）
  function buildKeyQuery(t) {
    var p = new URLSearchParams();
    p.set('keyid', 'webfanyi-key-getter');
    p.set('sign', sign(t, FIXED_SALT));
    p.set('client', 'fanyideskweb');
    p.set('product', 'webfanyi');
    p.set('appVersion', '1.0.0');
    p.set('vendor', 'web');
    p.set('pointParam', 'client,mysticTime,product');
    p.set('mysticTime', String(t));
    p.set('keyfrom', 'fanyi.web');
    p.set('mid', '1');
    p.set('screen', '1');
    p.set('model', '1');
    p.set('network', 'wifi');
    p.set('abtest', '0');
    p.set('yduuid', 'abcdefg');
    return p.toString();
  }

  // 步骤①：换取 {secretKey, aesKey, aesIv}
  async function getKey(req, t) {
    var res = await req.http.request({
      url: KEY_URL + '?' + buildKeyQuery(t),
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://fanyi.youdao.com',   // forbidden header，浏览器静默丢弃
        'Referer': 'https://fanyi.youdao.com/'  // forbidden header，浏览器静默丢弃
      },
      timeoutMs: TIMEOUT,
      responseType: 'json',
      credentials: 'include' // 借用浏览器已有 dict.youdao.com cookie
    });
    var d = res.data && res.data.data;
    if (!d || typeof d.secretKey !== 'string' || typeof d.aesKey !== 'string' || typeof d.aesIv !== 'string') {
      throw TA.err('BAD_RESPONSE', '有道密钥接口返回无效数据', { service: 'youdao' });
    }
    return d;
  }

  // URL-safe Base64 → AES-256-CBC 解密 → 截到最后一个 '}' 返回明文字符串
  async function decryptPayload(payload, keys) {
    var b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    var bin;
    try {
      bin = atob(b64);
    } catch (e) {
      throw TA.err('BAD_RESPONSE', '有道响应 Base64 解码失败', { service: 'youdao' });
    }
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    // key = md5hex(aesKey) 32 字符的 UTF-8 字节（AES-256）；iv = md5hex(aesIv) 前 16 hex 字符的 UTF-8 字节
    var keyBytes = new TextEncoder().encode(TA.md5(keys.aesKey));
    var ivBytes = new TextEncoder().encode(TA.md5(keys.aesIv).slice(0, 16));
    var key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    var plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, bytes);
    } catch (e) {
      // WebCrypto padding 错误等 → BAD_RESPONSE（可重试），服务不可用则走降级链
      throw TA.err('BAD_RESPONSE', '有道响应 AES 解密失败: ' + ((e && e.message) || String(e)), { service: 'youdao' });
    }
    var text = new TextDecoder('utf-8').decode(new Uint8Array(plain));
    var end = text.lastIndexOf('}');
    if (end === -1) throw TA.err('BAD_RESPONSE', '有道解密结果无效', { service: 'youdao' });
    return text.slice(0, end + 1);
  }

  // translateResult.flat().map(x=>x.tgt).join('')，\n → \n\n（侦察 16472-16481、16530）
  function extractResult(jsonStr) {
    var obj;
    try {
      obj = JSON.parse(jsonStr);
    } catch (e) {
      throw TA.err('BAD_RESPONSE', '有道解密结果 JSON 解析失败', { service: 'youdao' });
    }
    var tr = obj && obj.data && obj.data.translateResult;
    if (!Array.isArray(tr)) throw TA.err('BAD_RESPONSE', '有道响应缺少 translateResult', { service: 'youdao' });
    var flat = typeof tr.flat === 'function' ? tr.flat() : [].concat.apply([], tr);
    var out = flat.map(function (item) {
      return item && typeof item.tgt === 'string' ? item.tgt : '';
    }).join('');
    return out.replace(/\n/g, '\n\n');
  }

  // 步骤②：表单翻译请求，返回解密后的译文
  async function translateForm(req, t, keys, text, to) {
    var p = new URLSearchParams();
    p.set('i', text);
    p.set('from', 'auto');
    p.set('to', to);
    p.set('useTerm', 'false');
    p.set('domain', '0');
    p.set('dictResult', 'true');
    p.set('keyid', 'webfanyi');
    p.set('sign', sign(t, keys.secretKey)); // 盐换成返回的 secretKey（侦察 16499）
    p.set('client', 'fanyideskweb');
    p.set('product', 'webfanyi');
    p.set('appVersion', '1.0.0');
    p.set('vendor', 'web');
    p.set('pointParam', 'client,mysticTime,product');
    p.set('mysticTime', String(t)); // 与步骤①同一个 t（侦察 16486）
    p.set('keyfrom', 'fanyi.web');
    p.set('mid', '1');
    p.set('screen', '1');
    p.set('model', '1');
    p.set('network', 'wifi');
    p.set('abtest', '0');
    p.set('yduuid', 'abcdefg');
    var res = await req.http.request({
      url: TRANSLATE_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://fanyi.youdao.com',  // forbidden header，浏览器静默丢弃
        'Referer': 'https://fanyi.youdao.com/' // forbidden header，浏览器静默丢弃
      },
      body: p.toString(),
      timeoutMs: TIMEOUT,
      responseType: 'text', // 响应是密文而非 JSON
      credentials: 'include'
    });
    var payload = String(res.text || '').trim();
    if (!payload) throw TA.err('BAD_RESPONSE', '有道返回空响应', { service: 'youdao' });
    var jsonStr = await decryptPayload(payload, keys);
    return extractResult(jsonStr);
  }

  // 单段翻译：>budget 切分后逐块顺序请求再拼回
  async function youdaoOne(req, t, keys, text, to) {
    if (text.length > BUDGET) {
      var chunks = TA.adapters.splitLongText(text, BUDGET);
      var parts = [];
      for (var i = 0; i < chunks.length; i++) {
        parts.push(await translateForm(req, t, keys, chunks[i], to));
      }
      return parts.join('');
    }
    return translateForm(req, t, keys, text, to);
  }

  TA.adapters.register('youdao', {
    needsKey: false,
    budget: BUDGET,
    concurrency: 1, // 严格顺序
    keyOk: function () { return true; },
    supportsLang: function (lang) { return TA.langmap.supportsLang('youdao', lang); },
    mapLang: function (lang) { return TA.langmap.mapLang('youdao', lang); },
    translate: async function (req) {
      var to = TA.langmap.mapLang('youdao', req.targetLang);
      if (!to) throw TA.err('UNSUPPORTED_LANG', '有道翻译不支持目标语言 ' + req.targetLang, { service: 'youdao' });
      var t = Date.now();
      var keys = await getKey(req, t); // 密钥每包现取；同包各段复用同一 t（侦察 16486 语义）
      var out = await TA.adapters.mapWithConcurrency(req.texts, 1, function (text) {
        return youdaoOne(req, t, keys, text, to);
      });
      return { translations: out };
    }
  });
})();
