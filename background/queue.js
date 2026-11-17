// background/queue.js —— 每服务并发队列、冷却表、可重试错误退避重试
// 设计（协议 batchingRules 规则 3 + 错误表）：
//   1) 包级 FIFO：同一 TRANSLATE_BATCH 的多个请求包按序进入该服务的队列，不同 batchId 共享同一队列（SW 单例）；
//      同时执行的包数上限 = adapter.concurrency。
//   2) 请求级信号量：该服务"SW 内最大并发请求数"同样受 adapter.concurrency 约束——
//      适配器内部逐段请求必须经 TA.queue.withSlot 包裹（由 adapters/index.js 构造的 req.http 自动完成），
//      因此包内并发 + 多包并行的总 HTTP 并发数恒 ≤ adapter.concurrency。
//      deepl-free/deepl-api/youdao/iflyrec concurrency=1 → 全链严格顺序（侦察 16164 注释语义）。
//   3) 冷却表（SW 内存 Map，SW 重启清零）：RATE_LIMITED→60s、AUTH_FAILED→300s、
//      HTTP_ERROR/NETWORK/TIMEOUT→30s、BAD_RESPONSE→60s。
//   4) 重试（针对单个 HTTP 请求，段落原子性不变）：deepl-free 的 429 不重试直接失败（侦察 pitfalls①）；
//      其余服务 429 附加 2 次退避重试（1s、2s）；NETWORK/TIMEOUT/HTTP 5xx/BAD_RESPONSE 每请求至多 3 次尝试，
//      退避 500ms×2^n。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // —— 冷却表 ——
  var COOL_MS = {
    RATE_LIMITED: 60000,
    AUTH_FAILED: 300000,
    HTTP_ERROR: 30000,
    NETWORK: 30000,
    TIMEOUT: 30000,
    BAD_RESPONSE: 60000
  };
  var coolUntil = new Map(); // serviceId -> epoch ms

  function cool(serviceId, err) {
    var code = err && err.code;
    var ms = COOL_MS[code];
    if (!ms) return false;
    coolUntil.set(serviceId, Date.now() + ms);
    return true;
  }
  function isCooling(serviceId) {
    var until = coolUntil.get(serviceId);
    return typeof until === 'number' && until > Date.now();
  }

  function concurrencyOf(serviceId) {
    var spec = TA.adapters && TA.adapters.get(serviceId);
    return spec && spec.concurrency > 0 ? spec.concurrency : 1;
  }

  // —— 请求级信号量：单服务最大并发 HTTP 请求数 = adapter.concurrency ——
  var slots = new Map(); // serviceId -> {active, waiters}
  function getSlot(serviceId) {
    var s = slots.get(serviceId);
    if (!s) { s = { active: 0, waiters: [] }; slots.set(serviceId, s); }
    return s;
  }
  // 将单次 HTTP 请求限制在该服务的并发配额内
  async function withSlot(serviceId, fn) {
    var s = getSlot(serviceId);
    var limit = concurrencyOf(serviceId);
    while (s.active >= limit) {
      await new Promise(function (resolve) { s.waiters.push(resolve); });
    }
    s.active++;
    try {
      return await fn();
    } finally {
      s.active--;
      var next = s.waiters.shift();
      if (next) next();
    }
  }

  // —— 包级 FIFO 队列：同时执行包数上限 = adapter.concurrency ——
  var queues = new Map(); // serviceId -> {running, tasks}
  function enqueue(serviceId, task) {
    return new Promise(function (resolve, reject) {
      var q = queues.get(serviceId);
      if (!q) { q = { running: 0, tasks: [] }; queues.set(serviceId, q); }
      q.tasks.push({ task: task, resolve: resolve, reject: reject });
      pump(serviceId);
    });
  }
  function pump(serviceId) {
    var q = queues.get(serviceId);
    if (!q) return;
    var limit = concurrencyOf(serviceId);
    while (q.running < limit && q.tasks.length) {
      var item = q.tasks.shift();
      q.running++;
      item.task()
        .then(item.resolve, item.reject)
        .then(function () { // resolve/reject 已被调用，此处仅收尾
          q.running--;
          pump(serviceId);
        });
    }
  }

  // —— 重试判定与退避 ——
  function isRetryable(serviceId, err) {
    var code = err && err.code;
    // 侦察 pitfalls①：deepl-free 的 429 不自动重试
    if (code === 'RATE_LIMITED') return serviceId !== 'deepl-free';
    if (code === 'BAD_RESPONSE' || code === 'NETWORK' || code === 'TIMEOUT') return true;
    if (code === 'HTTP_ERROR') return typeof err.status === 'number' && err.status >= 500;
    // AUTH_FAILED / NO_KEY / UNSUPPORTED_LANG / TOO_LARGE / NO_USABLE_SERVICE 等不重试
    //（edge 的 401 先重取 token 再试一次的逻辑在 edge 适配器内部实现）
    return false;
  }
  function delayFor(err, attempt) {
    // 429 退避 1s、2s；其余 500ms×2^n（第 1 次重试 500ms、第 2 次 1000ms）
    if (err && err.code === 'RATE_LIMITED') return attempt * 1000;
    return 500 * Math.pow(2, attempt - 1);
  }
  // 可重试错误至多 maxAttempts 次尝试（默认 3 = 1 原始 + 2 重试）
  async function withRetry(serviceId, fn, maxAttempts) {
    var attempts = typeof maxAttempts === 'number' && maxAttempts > 0 ? maxAttempts : 3;
    for (var attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= attempts || !isRetryable(serviceId, err)) throw err;
        var delay = delayFor(err, attempt);
        await new Promise(function (resolve) { setTimeout(resolve, delay); });
      }
    }
  }

  TA.queue = {
    enqueue: enqueue,       // 包级 FIFO
    withSlot: withSlot,     // 请求级并发信号量
    withRetry: withRetry,   // 退避重试
    cool: cool,             // 按错误 code 进入冷却
    isCooling: isCooling,
    coolUntil: coolUntil    // 暴露便于诊断
  };
})();
