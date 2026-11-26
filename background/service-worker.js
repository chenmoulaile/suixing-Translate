// background/service-worker.js —— MV3 classic service worker 入口
// 第一条语句按固定顺序 importScripts（协议定稿顺序，禁止顶层之外的延迟初始化依赖）：
// 共享层（defaults/langmap/md5）→ 术语库（terminology）→ 基础设施（http/cache/queue）
// → 13 个适配器（含 claude/gemini/deepseek/ollama/dsh-free）→ 调度层。
importScripts('../shared/defaults.js', '../shared/langmap.js', '../shared/md5.js',
  'terminology.js', 'http.js', 'cache.js', 'queue.js',
  'adapters/deepl-free.js', 'adapters/deepl-api.js', 'adapters/google.js', 'adapters/youdao.js',
  'adapters/iflyrec.js', 'adapters/caiyun.js', 'adapters/edge.js', 'adapters/openai.js',
  'adapters/claude.js', 'adapters/gemini.js', 'adapters/deepseek.js', 'adapters/ollama.js',
  'adapters/dsh-free.js', 'adapters/index.js');

var TA = globalThis.TA;

// ==================== 内存配置缓存 ====================
// settings 经 storage.onChanged 刷新（设置变更不经 background 转发：
// content/popup/options 各自监听 storage.onChanged，SW 仅维护自身内存副本）。
var settingsCache = null;
var settingsLoading = null;

function loadSettings() {
  if (!settingsLoading) {
    settingsLoading = chrome.storage.local.get('settings')
      .then(function (obj) {
        settingsCache = TA.mergeDefaults(obj && obj.settings);
        return settingsCache;
      })
      .catch(function (e) {
        settingsLoading = null; // 允许下次重试
        settingsCache = TA.mergeDefaults(null);
        console.warn('[TA] load settings failed, using defaults:', e && e.message || e);
        return settingsCache;
      });
  }
  return settingsLoading;
}

async function getSettings() {
  await loadSettings();
  return settingsCache;
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area === 'local' && changes.settings) {
    settingsCache = TA.mergeDefaults(changes.settings.newValue);
  }
});

// ==================== 消息路由 ====================
// 协议：background onMessage 处理器必须 return true 并在异步完成后 sendResponse。
// 发送方（content/popup）对 lastError/Promise reject 的兜底注入流程在各自侧实现。
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handleMessage(msg, sender)
    .then(function (resp) {
      try { sendResponse(resp); } catch (e) { /* 消息端口已关闭 */ }
    })
    .catch(function (err) {
      // 统一错误信封兜底
      try {
        sendResponse({
          requestId: msg && msg.requestId,
          ok: false,
          error: (err && err.code)
            ? { code: err.code, message: err.message }
            : { code: 'INTERNAL', message: String((err && err.message) || err) }
        });
      } catch (e) { /* 消息端口已关闭 */ }
    });
  return true; // 异步 sendResponse
});

// ==================== 一次性设置迁移 ====================
// 旧安装把 google 存为 primaryService（或留空），导致每次请求都先失败 google→edge
// 才到实际可用的 deepl-free。按 taMigrationVersion 守门，仅首次执行；且仅在用户
// 未显式选择其它主服务（旧默认 google / 空）时改写，避免覆盖用户主动选择。
var MIGRATION_TO = 3;
async function migrateSettingsOnce() {
  try {
    var obj = await chrome.storage.local.get('taMigrationVersion');
    if (obj && obj.taMigrationVersion >= MIGRATION_TO) return;
    var s = await chrome.storage.local.get('settings');
    var cur = s && s.settings;
    if (cur && typeof cur === 'object') {
      // 仅在用户未显式选择其它主服务时迁移：旧默认 google / 空 → deepl-free
      if (!cur.primaryService || cur.primaryService === 'google') {
        cur.primaryService = 'deepl-free';
        var chain = Array.isArray(cur.serviceChain) ? cur.serviceChain.slice() : [];
        if (chain.indexOf('deepl-free') === -1) chain.unshift('deepl-free');
        else { chain = chain.filter(function(x){return x!=='deepl-free';}); chain.unshift('deepl-free'); }
        cur.serviceChain = chain;
        await chrome.storage.local.set({ settings: cur });
      }
    }
    await chrome.storage.local.set({ taMigrationVersion: MIGRATION_TO });
  } catch (e) { console.warn('[TA] migration failed', e && e.message || e); }
}

// SW 每次被事件唤醒后，首次消息处理前执行一次缓存清理（协议 batchingRules 规则 6）
var cacheBootstrapped = false;
async function bootstrapOnce() {
  if (cacheBootstrapped) return;
  cacheBootstrapped = true;
  // 迁移必须先于配置读取：迁移可能改写 storage.settings，随后重置缓存确保重读。
  await migrateSettingsOnce();
  settingsCache = null;
  settingsLoading = null;
  var settings = await getSettings();
  await TA.adapters.bootstrapCache(settings);
}

async function handleMessage(msg) {
  if (!msg || typeof msg.type !== 'string') {
    return { requestId: msg && msg.requestId, ok: false, error: { code: 'BAD_REQUEST', message: '缺少 type 字段' } };
  }
  await bootstrapOnce();
  switch (msg.type) {
    case 'TRANSLATE_BATCH': {
      var settings = await getSettings();
      var resp = await TA.adapters.translateBatch(msg, settings);
      // 回填 requestId（translateBatch 返回平铺的业务信封）
      resp.requestId = msg.requestId;
      return resp;
    }
    case 'GET_CACHE_STATS': {
      var st = await TA.cache.stats();
      return { requestId: msg.requestId, ok: true, data: st };
    }
    case 'CLEAR_CACHE': {
      var r = await TA.cache.clearAll();
      return { requestId: msg.requestId, ok: true, data: r };
    }
    case 'OPEN_OPTIONS': {
      // 悬浮球"打开设置"动作钮用（content 无权直接调 openOptionsPage，经 background 转发）
      await chrome.runtime.openOptionsPage();
      return { requestId: msg.requestId, ok: true };
    }
    case 'OPEN_DOC': {
      await chrome.tabs.create({ url: chrome.runtime.getURL('doc/doc.html') });
      return { requestId: msg.requestId, ok: true };
    }
    default:
      // 未实现/未知消息类型：明确错误而非静默忽略
      return {
        requestId: msg.requestId,
        ok: false,
        error: { code: 'UNKNOWN_MESSAGE', message: '未实现的消息类型: ' + msg.type }
      };
  }
}

// ==================== 兜底注入与 CMD 转发 ====================
// 注入文件顺序与 manifest content_scripts.js 数组完全一致（协议定稿；v0.2 新增
// formula/interactions/ball/export，顺序敏感：formula 在 walker 前、main 最后）。
// popup 的兜底注入在 popup.js 内实现（GET_PAGE_STATE reject 时，清单由 C 收尾核对）；
// background 侧兜底服务于快捷键/右键菜单的 CMD 转发。
var CONTENT_FILES = [
  'shared/defaults.js', 'content/core.js', 'content/rules.js', 'content/formula.js',
  'content/walker.js', 'content/injector.js', 'content/interactions.js', 'content/ball.js',
  'content/export.js', 'content/input-enhance.js',
  'content/subtitle.js', 'content/dictionary.js', 'content/image-translate.js',
  'content/main.js'
];

async function injectContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_FILES });
}

// tabs.sendMessage 失败（"Could not establish connection"）→ 先兜底注入再重发
async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    var m = String((err && err.message) || err);
    if (!/Could not establish connection|Receiving end does not exist/i.test(m)) throw err;
    await injectContent(tabId);
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

async function forwardCmd(tabId, cmd) {
  try {
    await sendToContent(tabId, cmd);
  } catch (e) {
    // chrome://、edge://、about:、Chrome Web Store 等禁翻页注入失败，静默记录
    console.warn('[TA] CMD 转发失败（页面可能不可注入）:', (e && e.message) || e);
  }
}

// ==================== commands.onCommand ====================
// 转发 CMD 给活动标签页；content 映射：toggle-translate=⑤（无 scope）、
// translate-full=⑤（scope:'full'）、toggle-bilingual=⑥。
chrome.commands.onCommand.addListener(function (command) {
  chrome.tabs.query({ active: true, currentWindow: true })
    .then(function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || typeof tab.id !== 'number') return;
      forwardCmd(tab.id, { type: 'CMD', name: command });
    })
    .catch(function (e) { console.warn('[TA] tabs.query failed:', e && e.message || e); });
});

// ==================== contextMenus ====================
// onInstalled 与 onStartup 各建一次菜单；重复 create 用 lastError 吞掉（协议定稿）。
// 菜单标题取 _locales 的 ctxTranslate/ctxRestore，缺失时回退中文文案。
var CTX_FALLBACK = { 'ta-ctx-translate': '翻译网页', 'ta-ctx-restore': '显示原文', 'ta-ctx-image': '翻译图片' };

function createMenus() {
  var defs = [
    { id: 'ta-ctx-translate', i18n: 'ctxTranslate' },
    { id: 'ta-ctx-restore', i18n: 'ctxRestore' },
    { id: 'ta-ctx-image', i18n: 'ctxImageTranslate' }
  ];
  defs.forEach(function (d) {
    var title;
    try {
      title = (chrome.i18n && chrome.i18n.getMessage(d.i18n)) || CTX_FALLBACK[d.id];
    } catch (e) {
      title = CTX_FALLBACK[d.id];
    }
    chrome.contextMenus.create({
      id: d.id,
      title: title,
      contexts: d.id === 'ta-ctx-image' ? ['image'] : ['page']
    }, function () {
      // 重复创建（SW 重启后 onStartup 再建）报 duplicate id，读 lastError 即视为已处理
      void chrome.runtime.lastError;
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

// 右键菜单点击处理（协议 ⑨）：
// ctxTranslate "翻译网页" / ctxRestore "显示原文" 都映射 toggle-translate（CMD 转发），
// content 侧状态机自行处理（未翻译→翻译、已翻译→还原）；
// ta-ctx-image "翻译图片" 直接把 srcUrl 以 IMAGE_TRANSLATE 发给 content（不走 CMD）。
chrome.contextMenus.onClicked.addListener(async function (info, tab) {
  if (!tab || typeof tab.id !== 'number') return;
  if (info.menuItemId === 'ta-ctx-image' && info.srcUrl) {
    // 图片翻译：直接把图片 URL 发给 content（不走 CMD 转发）
    try { await sendToContent(tab.id, { type: 'IMAGE_TRANSLATE', url: info.srcUrl }); } catch (e) { /* 页面可能不可注入 */ }
  } else {
    var name = 'toggle-translate';
    forwardCmd(tab.id, { type: 'CMD', name: name });
  }
});
