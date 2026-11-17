// background/cache.js —— 译文缓存（chrome.storage.local，键名前缀 cache:）
// 键 `cache:<32hex>` = SHA-256(`${service}|${targetLang}|${text}`) 的前 32 个 hex 字符（128bit）；
// 值 {v:译文, at:Date.now()}。独立键设计让 storage.set 只写变更条目，清理时 get(null) 扫前缀。
// 过期/淘汰由 settings.cache.maxAgeDay（默认 30 天）/ maxEntries（默认 2000）控制：
//   SW 启动后首次消息处理前清一次（由 adapters/index.js 的 bootstrapCache 调 maintain），
//   之后每 100 次写惰性触发一次同逻辑（协议 batchingRules 规则 6）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  var PREFIX = 'cache:';
  var LAZY_EVERY = 100; // 每累计 100 次写缓存惰性清理一次
  var writeCount = 0;
  var encoder = new TextEncoder();

  // SHA-256 前 16 字节的小写 hex（32 字符）
  async function sha32(str) {
    var digest = await crypto.subtle.digest('SHA-256', encoder.encode(str));
    var bytes = new Uint8Array(digest);
    var hex = '';
    for (var i = 0; i < 16; i++) {
      hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return hex;
  }

  // 列出全部 cache: 键及其值（get(null) 全量扫描）
  async function scanAll() {
    var all = await chrome.storage.local.get(null);
    var entries = [];
    for (var k in all) {
      if (k.lastIndexOf(PREFIX, 0) === 0 && all[k] && typeof all[k] === 'object') {
        entries.push({ key: k, v: all[k].v, at: typeof all[k].at === 'number' ? all[k].at : 0 });
      }
    }
    return entries;
  }

  TA.cache = {
    PREFIX: PREFIX,

    // 缓存键（含 service——不同服务译文不混用，用户显式指定服务时天然隔离）
    keyFor: async function (service, targetLang, text) {
      return PREFIX + (await sha32(service + '|' + targetLang + '|' + text));
    },

    // 批量读取：keys 为完整键数组；返回 Map<key, value>
    getMany: async function (keys) {
      var map = new Map();
      if (!keys || !keys.length) return map;
      var obj = await chrome.storage.local.get(keys);
      keys.forEach(function (k) {
        if (obj && obj[k] !== undefined && obj[k] !== null) map.set(k, obj[k]);
      });
      return map;
    },

    // 批量写入：entries 形如 { '<cache:..>': {v, at} }；settings 用于惰性清理参数
    setMany: async function (entries, settings) {
      if (!entries) return;
      var n = Object.keys(entries).length;
      if (!n) return;
      await chrome.storage.local.set(entries);
      writeCount += n;
      if (settings && writeCount >= LAZY_EVERY) {
        writeCount = 0;
        try {
          await this.maintain(settings);
        } catch (e) {
          console.warn('[TA] lazy cache maintain failed:', e);
        }
      }
    },

    // 一次性维护：清过期 + 淘汰超量（SW 启动后首次消息处理前 / 每 100 次写惰性）
    maintain: async function (settings) {
      var cacheCfg = settings && settings.cache ? settings.cache : {};
      var maxAgeDay = typeof cacheCfg.maxAgeDay === 'number' && cacheCfg.maxAgeDay > 0 ? cacheCfg.maxAgeDay : 30;
      var maxEntries = typeof cacheCfg.maxEntries === 'number' && cacheCfg.maxEntries > 0 ? cacheCfg.maxEntries : 2000;
      await this.purgeExpired(maxAgeDay);
      await this.evictTo(maxEntries);
    },

    // 删除 at 早于 now - maxAgeDay*86400000 的条目，返回删除数
    purgeExpired: async function (maxAgeDay) {
      var entries = await scanAll();
      var deadline = Date.now() - maxAgeDay * 86400000;
      var expired = entries.filter(function (e) { return e.at < deadline; }).map(function (e) { return e.key; });
      if (expired.length) await chrome.storage.local.remove(expired);
      return expired.length;
    },

    // 条目数超 maxEntries 时按 at 最旧淘汰，返回删除数
    evictTo: async function (maxEntries) {
      var entries = await scanAll();
      if (entries.length <= maxEntries) return 0;
      entries.sort(function (a, b) { return a.at - b.at; }); // at 最旧在前
      var toRemove = entries.slice(0, entries.length - maxEntries).map(function (e) { return e.key; });
      if (toRemove.length) await chrome.storage.local.remove(toRemove);
      return toRemove.length;
    },

    // GET_CACHE_STATS：{entries, oldestAt}（无条目时 oldestAt=null）
    stats: async function () {
      var entries = await scanAll();
      var oldestAt = null;
      for (var i = 0; i < entries.length; i++) {
        if (oldestAt === null || entries[i].at < oldestAt) oldestAt = entries[i].at;
      }
      return { entries: entries.length, oldestAt: oldestAt };
    },

    // CLEAR_CACHE：删除全部 cache: 条目，返回 {removed}
    clearAll: async function () {
      var entries = await scanAll();
      var keys = entries.map(function (e) { return e.key; });
      if (keys.length) await chrome.storage.local.remove(keys);
      return { removed: keys.length };
    }
  };
})();
