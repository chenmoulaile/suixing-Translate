// background/adapters/edge.js —— 微软 Edge 匿名接口（无用户 key）
// 照侦察定稿（class EdgeTranslator，atcoder better.txt 16633-16781）：
//   token：GET https://edge.microsoft.com/translate/auth（timeout 10s），响应正文 trim 即 token
//   （纯文本非 JSON）；非 200 或空 → AUTH_FAILED；SW 内存缓存 9 分钟（16659-16661，tokenExpireTime=Date.now()+540000）。
//   翻译：POST https://api-edge.cognitive.microsofttranslator.com/translate?from=&to=<mapLang>&api-version=3.0&textType=html
//     headers {Content-Type:'application/json', Authorization:'Bearer '+token,
//              User-Agent:'Mozilla/5.0 ... Edg/120.0.0.0'}（侦察 16733 要求的 Edge 120 UA 在 MV3 fetch 中
//              会被丢弃，保留写法但标注）；body JSON.stringify([{Text: raw}])（16730，textType=html 语义照发）
//   响应 data[0].translations[0].text（16714）；data.error 存在 → error.code===401000 或 HTTP 401：
//   清 token 缓存 → 重取 token → 整个请求只重试一次（16667-16719）。
//   mapLang：zh-CN→zh-Hans、zh-TW→zh-Hant、其余小写码（侦察 478 行）。
//   budget 5000；concurrency 2；timeout 15s（token 10s）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var AUTH_URL = 'https://edge.microsoft.com/translate/auth';
  var TRANSLATE_URL = 'https://api-edge.cognitive.microsofttranslator.com/translate';
  var BUDGET = 5000;
  var TIMEOUT = 15000;
  var AUTH_TIMEOUT = 10000;
  var TOKEN_TTL = 540000; // 9 分钟（侦察 16660）
  var INNER_CONCURRENCY = 2;

  // token SW 内存缓存
  var mem = { token: null, expireAt: 0 };

  async function fetchToken(req) {
    var res = await req.http.request({
      url: AUTH_URL,
      method: 'GET',
      headers: {},
      timeoutMs: AUTH_TIMEOUT,
      responseType: 'text',
      credentials: 'omit'
    });
    var token = String(res.text || '').trim();
    if (!token) throw TA.err('AUTH_FAILED', '获取 Edge Token 失败（响应为空）', { service: 'edge' });
    mem.token = token;
    mem.expireAt = Date.now() + TOKEN_TTL;
    return token;
  }

  async function ensureToken(req) {
    if (mem.token && Date.now() < mem.expireAt) return mem.token;
    return fetchToken(req);
  }
  function clearToken() { mem.token = null; mem.expireAt = 0; }

  // 单块翻译：401 / error.code=401000 时清 token 重取后整个请求只重试一次（侦察 16667-16719）
  async function translateChunk(req, text, tl) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var token = await ensureToken(req);
      try {
        var res = await req.http.request({
          url: TRANSLATE_URL + '?from=&to=' + encodeURIComponent(tl) + '&api-version=3.0&textType=html',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
            // User-Agent 在 MV3 fetch 中会被浏览器丢弃，保留写法但标注（协议定稿）
          },
          body: JSON.stringify([{ Text: text }]),
          timeoutMs: TIMEOUT,
          responseType: 'json',
          credentials: 'omit'
        });
        var data = res.data;
        // HTTP 200 但 body 带 error 对象
        if (data && data.error) {
          if (String(data.error.code) === '401000') {
            clearToken();
            if (attempt === 0) continue; // 只重试一次
            throw TA.err('AUTH_FAILED', 'Edge 认证失败（401000，重取 token 后仍失败）', { service: 'edge' });
          }
          throw TA.err('BAD_RESPONSE', 'Edge API 返回错误: ' + JSON.stringify(data.error), { service: 'edge' });
        }
        var t = data && Array.isArray(data) && data[0] && data[0].translations &&
          data[0].translations[0] && data[0].translations[0].text;
        if (typeof t !== 'string') {
          throw TA.err('BAD_RESPONSE', 'Edge API 返回了无效的翻译结果', { service: 'edge' });
        }
        return t;
      } catch (err) {
        // HTTP 401（http 层抛 AUTH_FAILED）：清 token 缓存以便重取，整个请求只重试一次
        if (err && err.code === 'AUTH_FAILED' && attempt === 0) {
          clearToken();
          continue;
        }
        throw err;
      }
    }
    // 防御性兜底（正常流程不可达）
    throw TA.err('AUTH_FAILED', 'Edge 认证失败', { service: 'edge' });
  }

  // 单段翻译：>budget 切分后逐块顺序请求再拼回
  async function edgeOne(req, text, tl) {
    if (text.length > BUDGET) {
      var chunks = TA.adapters.splitLongText(text, BUDGET);
      var parts = [];
      for (var i = 0; i < chunks.length; i++) {
        parts.push(await translateChunk(req, chunks[i], tl));
      }
      return parts.join('');
    }
    return translateChunk(req, text, tl);
  }

  TA.adapters.register('edge', {
    needsKey: false,
    budget: BUDGET,
    concurrency: 2,
    keyOk: function () { return true; },
    supportsLang: function (lang) { return TA.langmap.supportsLang('edge', lang); },
    mapLang: function (lang) { return TA.langmap.mapLang('edge', lang); },
    translate: async function (req) {
      var tl = TA.langmap.mapLang('edge', req.targetLang);
      if (!tl) throw TA.err('UNSUPPORTED_LANG', 'Edge 翻译不支持目标语言 ' + req.targetLang, { service: 'edge' });
      var out = await TA.adapters.mapWithConcurrency(req.texts, INNER_CONCURRENCY, function (text) {
        return edgeOne(req, text, tl);
      });
      return { translations: out };
    }
  });
})();
