// background/http.js —— 统一 HTTP 封装：AbortController 超时、credentials 语义、错误规范化
// 约定（协议 messageProtocol 错误表）：
//   NETWORK = fetch 抛错（断网/DNS）；TIMEOUT = 超时；AUTH_FAILED = HTTP 401/403；
//   RATE_LIMITED = HTTP 429；HTTP_ERROR = 其他非 2xx（status 字段携带状态码）；
//   BAD_RESPONSE = JSON 解析失败。所有错误抛 TAError{code,message,status?,service?}。
// 说明：headers 中 Origin/Referer/User-Agent 属 fetch 规范 forbidden headers，
// 浏览器会静默丢弃——与油猴 GM_xmlhttpRequest 的关键差异，照侦察如实保留尝试（协议定稿）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // 结构化错误对象：background 与 content 共用同一 code 表
  TA.TAError = class TAError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.name = 'TAError';
      this.code = code;
      if (extra) {
        if (extra.status !== undefined) this.status = extra.status;
        if (extra.service !== undefined) this.service = extra.service;
      }
    }
    // 转消息协议的错误信封 JSON（{code, message, status?, service?}）
    toJSON() {
      var o = { code: this.code, message: this.message };
      if (this.status !== undefined) o.status = this.status;
      if (this.service !== undefined) o.service = this.service;
      return o;
    }
  };

  TA.err = function (code, message, extra) {
    return new TA.TAError(code, message, extra);
  };

  // 适配器注册表（register/get/has/ids）。
  // 说明：协议 importScripts 定稿顺序中 adapters/*.js 先于 adapters/index.js 加载，
  // 各适配器文件顶层即调用 TA.adapters.register(...)，故注册表对象必须在此
  // （importScripts 中最早的 background 文件）创建；index.js 仅追加调度方法。
  TA.adapters = TA.adapters || {};
  if (!TA.adapters.registry) {
    var registry = new Map();
    TA.adapters.registry = registry;
    TA.adapters.register = function (id, spec) {
      spec.id = id;
      registry.set(id, spec);
    };
    TA.adapters.get = function (id) { return registry.get(id) || null; };
    TA.adapters.has = function (id) { return registry.has(id); };
    TA.adapters.ids = function () { return Array.from(registry.keys()); };
  }

  TA.http = {
    /**
     * 发起请求。成功（2xx）返回 {status, text, data?}；失败 throw TAError。
     * @param {object} opts
     *   url        目标 URL
     *   method     默认 'GET'
     *   headers    默认 {}（forbidden headers 会被浏览器静默丢弃，照写）
     *   body       string | URLSearchParams | object（object 自动 JSON.stringify）
     *   timeoutMs  默认 30000，经 AbortController 实现
     *   responseType 'json'|'text'，默认 'text'；'json' 时先 res.text() 再 JSON.parse，失败抛 BAD_RESPONSE
     *   credentials  默认 'omit'（复刻油猴 anonymous:true 语义；有道例外传 'include'）
     */
    request: async function (opts) {
      var o = opts || {};
      var method = o.method || 'GET';
      var headers = o.headers || {};
      var body = o.body;
      var timeoutMs = typeof o.timeoutMs === 'number' && o.timeoutMs > 0 ? o.timeoutMs : 30000;
      var responseType = o.responseType === 'json' ? 'json' : 'text';
      var credentials = o.credentials || 'omit';

      // body：普通对象自动 JSON 序列化；string / URLSearchParams 原样
      //（URLSearchParams 由 fetch 自动补 application/x-www-form-urlencoded Content-Type）
      var payload = body;
      if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
        payload = JSON.stringify(body);
      }

      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
      var res;
      try {
        res = await fetch(o.url, {
          method: method,
          headers: headers,
          body: payload,
          credentials: credentials,
          cache: 'no-store', // 复刻油猴 nocache:true 语义
          signal: ctrl.signal
        });
      } catch (err) {
        clearTimeout(timer);
        var name = err && err.name;
        if (name === 'AbortError' || name === 'TimeoutError') {
          throw TA.err('TIMEOUT', '请求超时（' + timeoutMs + 'ms）: ' + o.url);
        }
        throw TA.err('NETWORK', '网络请求失败: ' + ((err && err.message) || String(err)));
      }
      clearTimeout(timer);

      // 非 2xx：按协议错误表规范化
      if (!res.ok) {
        var status = res.status;
        var code = 'HTTP_ERROR';
        if (status === 429) code = 'RATE_LIMITED';
        else if (status === 401 || status === 403) code = 'AUTH_FAILED';
        // 尽量读取错误响应正文供排查（失败不覆盖错误类型）
        try { await res.text(); } catch (e) { /* 忽略正文读取失败 */ }
        throw TA.err(code, 'HTTP ' + status + ': ' + o.url, { status: status });
      }

      // 统一先取文本（res.text() 也可能因网络中断/abort 抛错）
      var text;
      try {
        text = await res.text();
      } catch (err) {
        var nm = err && err.name;
        if (nm === 'AbortError' || nm === 'TimeoutError') throw TA.err('TIMEOUT', '读取响应超时: ' + o.url);
        throw TA.err('NETWORK', '读取响应失败: ' + ((err && err.message) || String(err)));
      }

      if (responseType === 'json') {
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw TA.err('BAD_RESPONSE', '响应 JSON 解析失败: ' + o.url);
        }
        return { status: res.status, text: text, data: data };
      }
      return { status: res.status, text: text };
    }
  };
})();
