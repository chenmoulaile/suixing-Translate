// content/core.js —— 内容脚本命名空间与公共设施
// 依赖：shared/defaults.js 必须先于本文件加载（manifest content_scripts js 数组顺序）。
// 提供：
//   TA.getSettings / TA.saveSettings / TA.getCachedSettings / TA.onSettingsChanged
//   TA.features —— 功能注册表（B/C 模块挂载点：interactions/ball/export 顶层 register）
//   TA.lang   —— 页面级与段落级语言检测（Unicode 区段统计）+ 页面文本主导率（90% 跳过）
//   TA.util   —— 通用工具（控制字符清洗 / FNV-1a 哈希 / id 生成 / 防抖）
//   TA.errorText —— 错误码 → 中文文案（优先 chrome.i18n，缺失时回退内置表）
(function () {
  'use strict';
  if (!globalThis.TA) globalThis.TA = {};
  var TA = globalThis.TA;

  // defaults.js 缺失时放弃初始化：宁可显式报错，也不带错误默认值继续运行
  if (typeof TA.mergeDefaults !== 'function' || !TA.DEFAULTS) {
    console.error('[TA] content/core.js: 未检测到 shared/defaults.js（TA.mergeDefaults / TA.DEFAULTS），内容脚本不初始化');
    return;
  }
  if (TA.__coreLoaded) return;
  TA.__coreLoaded = true;

  /* ==================== 设置读写与变更分发 ==================== */

  var settingsCache = null;
  var settingsListeners = [];

  // 读取设置：chrome.storage.local 直读 + mergeDefaults 回填缺省键；带内存缓存
  TA.getSettings = function () {
    if (settingsCache) return Promise.resolve(settingsCache);
    var stored = null;
    return chrome.storage.local.get('settings')
      .then(function (obj) {
        stored = obj && obj.settings;
        settingsCache = TA.mergeDefaults(stored || {});
        return settingsCache;
      })
      .catch(function (e) {
        console.error('[TA] 读取设置失败，使用默认值', e);
        settingsCache = TA.mergeDefaults(null);
        return settingsCache;
      });
  };

  // 同步取最近一次缓存（未加载过时返回 null，调用方需自行兜底）
  TA.getCachedSettings = function () { return settingsCache; };

  // 保存设置：patch 深合并进当前值后整体写回 storage.local
  TA.saveSettings = function (patch) {
    return TA.getSettings().then(function (cur) {
      var merged = TA.mergeDefaults(deepMerge(cur, patch || {}));
      settingsCache = merged;
      return chrome.storage.local.set({ settings: merged }).then(function () {
        return merged;
      }).catch(function (e) {
        console.error('[TA] 保存设置失败', e);
        throw e;
      });
    });
  };

  // 注册设置变更监听器，返回解绑函数
  TA.onSettingsChanged = function (fn) {
    settingsListeners.push(fn);
    return function off() {
      var i = settingsListeners.indexOf(fn);
      if (i !== -1) settingsListeners.splice(i, 1);
    };
  };

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes || !changes.settings) return;
      settingsCache = TA.mergeDefaults(changes.settings.newValue || {});
      for (var i = 0; i < settingsListeners.length; i++) {
        try { settingsListeners[i](settingsCache); }
        catch (e) { console.error('[TA] settings 监听器执行失败', e); }
      }
    });
  } catch (e) {
    console.error('[TA] 注册 storage.onChanged 失败', e);
  }

  // 局部深合并（对象递归、数组整体替换），供 saveSettings 使用
  function deepMerge(base, patch) {
    if (!patch || typeof patch !== 'object') return base;
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var pv = patch[k];
      var bv = out[k];
      if (Array.isArray(pv)) { out[k] = pv.slice(); continue; }
      if (pv && typeof pv === 'object' && bv && typeof bv === 'object' && !Array.isArray(bv)) {
        out[k] = deepMerge(bv, pv);
        continue;
      }
      if (pv && typeof pv === 'object') { out[k] = deepMerge({}, pv); continue; }
      out[k] = pv;
    }
    return out;
  }

  /* ==================== 功能注册表（B/C 模块挂载点） ==================== */
  // 挂载方式（接口冻结）：各模块文件顶层
  //   TA.features.register({
  //     name: 'hover-selection' | 'ball' | 'export' | ...,
  //     init: function (settings) {},            // main.js 初始化时按注册序调用一次
  //     onSettingsChanged: function (s) {},      // 设置变更时按注册序调用
  //     messages: { MSG_TYPE: function (msg) {} },  // 未知消息类型依次分发（可返回 Promise）
  //     cmds: { 'cmd-name': function () {} }     // 未知 CMD 名依次分发
  //   });
  // 本文件只定义注册表本体；init/分发的执行方在 content/main.js（A 维护）。
  TA.features = {
    list: [],
    register: function (feature) {
      if (!feature || typeof feature !== 'object' || !feature.name) return;
      // 同名重复注册（兜底注入防双跑）：后注册者覆盖前者
      for (var i = 0; i < this.list.length; i++) {
        if (this.list[i].name === feature.name) { this.list[i] = feature; return; }
      }
      this.list.push(feature);
    },
    get: function (name) {
      for (var i = 0; i < this.list.length; i++) {
        if (this.list[i].name === name) return this.list[i];
      }
      return null;
    }
  };

  /* ==================== 语言检测（协议 E 节 + v0.2 混合语言策略） ==================== */

  TA.lang = {
    // 归一为基础语言组：zh-CN/zh-TW/zh-Hans/zh → 'zh'；其余取主子标签
    baseLang: function (code) {
      var c = String(code || '').toLowerCase().trim();
      if (!c) return '';
      if (c === 'zh' || c.indexOf('zh-') === 0) return 'zh';
      return c.split('-')[0];
    },

    // 文本语言画像：统计 \p{L} 字符的区段原始计数
    // 返回 {han, kana, hangul, cyrillic, latin, total}——detectParagraphLang 与
    // pageDominance 共用同一套计数（v0.2 混合语言策略的唯一事实来源）
    textProfile: function (text) {
      var s = String(text || '');
      var profile = { han: 0, kana: 0, hangul: 0, cyrillic: 0, latin: 0, deva: 0, total: 0 };
      // 按码点遍历，代理对字符作为一个整体参与 \p{L} 判断
      for (var i = 0; i < s.length; ) {
        var cp = s.codePointAt(i);
        var ch = String.fromCodePoint(cp);
        i += ch.length;
        if (!/\p{L}/u.test(ch)) continue;
        profile.total++;
        if (cp >= 0x3040 && cp <= 0x30FF) profile.kana++;
        else if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x1100 && cp <= 0x11FF)) profile.hangul++;
        else if ((cp >= 0x2E80 && cp <= 0x2EFF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
                 (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF)) profile.han++;
        else if (cp >= 0x0400 && cp <= 0x04FF) profile.cyrillic++;
        else if (cp >= 0x0900 && cp <= 0x097F) profile.deva++; // 天城文（印地语 hi，U+0900–U+097F）
        else if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) ||
                 (cp >= 0xC0 && cp <= 0x24F)) profile.latin++;
      }
      return profile;
    },

    // 页面级文本主导率（v0.2 定稿：唯一页面级跳过判据，与翻译模式无关）：
    // 正文采样（innerText 前 20000 字符）中目标语言文字占比 ≥90% → skip=true。
    // 替代 v0.1 "仅凭 html[lang] 同组即跳过"——html[lang] 不再参与页面级判定，
    // 由正文统计兜底；段落级判定见 walker.collectUnits（默认直翻，无任何开关）。
    pageDominance: function (bodyEl, targetLang) {
      if (!bodyEl) return { skip: false, ratio: 0 };
      var text = '';
      try { text = String(bodyEl.innerText || '').slice(0, 20000); }
      catch (e) { return { skip: false, ratio: 0 }; } // innerText 不可得时不跳过
      var p = this.textProfile(text);
      if (!p.total) return { skip: false, ratio: 0 };
      var base = this.baseLang(targetLang);
      var n;
      if (base === 'zh') n = p.han;
      else if (base === 'ja') n = p.kana + (p.kana ? p.han : 0); // 日语页汉字假名混排
      else if (base === 'ko') n = p.hangul;
      else if (base === 'hi') n = p.deva; // 天城文单列（2026-11-15 评审修复）：hi 为 11 档
      // 可选目标语言之一，此前并入 latin 近似导致拉丁字母主导页面对目标 hi 误判 90% 跳过
      else n = p.latin; // en/de/fr/es/pt/it 近似 latin
      var ratio = n / p.total;
      return { skip: ratio >= 0.9, ratio: ratio }; // 唯一阈值 0.9
    },

    // 段落级语言检测：基于 textProfile 的区段占比
    // 判定顺序（协议定稿）：kana>0→ja；hangul≥20%→ko；han≥20% 且无 kana→zh；
    // cyrillic≥20%→ru；latin≥20%→en；否则 null（不跳过，交给阈值过滤）
    detectParagraphLang: function (text) {
      var p = this.textProfile(text);
      if (!p.total) return null;
      if (p.kana > 0) return 'ja';
      var pct = function (n) { return n / p.total >= 0.2; };
      if (pct(p.hangul)) return 'ko';
      if (pct(p.han) && p.kana === 0) return 'zh';
      if (pct(p.cyrillic)) return 'ru';
      if (pct(p.latin)) return 'en';
      return null;
    }
  };

  /* ==================== 通用工具 ==================== */

  TA.util = {
    // 剔除 C0 控制字符（保留 \n \t\r —— 与协议正则完全一致）
    stripControlChars: function (s) {
      return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    },

    // FNV-1a 32bit 哈希 → 8 位十六进制（段落 data-ta-hash 用，按 UTF-16 码元迭代）
    fnv1a32: function (str) {
      var s = String(str || '');
      var h = 0x811c9dc5 | 0;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) | 0;
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    },

    // 消息 requestId（batchId 由调用方按 Date.now().toString(36)-序号另行生成）
    genId: function () {
      return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    },

    // 简单防抖
    debounce: function (fn, ms) {
      var t = 0;
      return function () {
        var args = arguments, self = this;
        clearTimeout(t);
        t = setTimeout(function () { fn.apply(self, args); }, ms);
      };
    }
  };

  /* ==================== 错误文案映射 ==================== */

  // 内置中文回退表（_locales 目前只定义 extName/ctx 等少数键；
  // 若后续 messages.json 补充 err<CODE> 键，chrome.i18n 结果优先生效）
  var FALLBACK_ERRORS = {
    NO_KEY: '该服务未配置密钥，请在扩展设置中填写',
    UNSUPPORTED_LANG: '该服务不支持当前目标语言',
    RATE_LIMITED: '请求过于频繁（429）',
    AUTH_FAILED: '服务鉴权失败',
    HTTP_ERROR: '翻译服务返回错误',
    BAD_RESPONSE: '翻译服务响应异常',
    NETWORK: '网络请求失败，请检查网络连接',
    TIMEOUT: '翻译请求超时',
    TOO_LARGE: '文本过长，已超出单次请求上限',
    NO_USABLE_SERVICE: '没有可用的翻译服务',
    DISABLED: '该服务已被禁用',
    BAD_REQUEST: '请求参数错误',
    INTERNAL: '内部错误',
    CANCELLED: '翻译已被取消',
    UNKNOWN_MESSAGE: '未实现的消息类型',
    UNKNOWN: '翻译失败'
  };

  TA.errorText = function (err) {
    var code = (err && err.code) || 'UNKNOWN';
    var msg = '';
    try {
      if (chrome.i18n && chrome.i18n.getMessage) msg = chrome.i18n.getMessage('err' + code) || '';
    } catch (e) { msg = ''; }
    return msg || FALLBACK_ERRORS[code] || FALLBACK_ERRORS.UNKNOWN;
  };
})();
