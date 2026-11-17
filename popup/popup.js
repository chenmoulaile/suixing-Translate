/* popup.js —— 「随行翻译」弹出面板逻辑（MV3 经典脚本，无依赖）
 *
 * 协议要点（见 messageProtocol）：
 *  - 每 800ms 向活动标签页轮询 GET_PAGE_STATE，驱动主按钮三态 / 分段开关 / 进度与错误行；
 *  - TOGGLE_TRANSLATE / SET_MODE / SET_SCOPE 发往内容脚本；未注入时用
 *    chrome.scripting.executeScript 按 manifest js 数组顺序兜底注入后重发；
 *  - GET_CACHE_STATS / CLEAR_CACHE 发往 background（runtime.sendMessage）；
 *  - 「永不翻译此站点」直接写 chrome.storage.local 的 settings.urlPattern.excludedUrls；
 *  - 设置变更不经 background 转发：popup 直接写 settings，content 自己监听 onChanged。
 */
(function () {
  'use strict';

  /* ================= 常量 ================= */

  // 兜底注入文件清单：与 manifest.content_scripts.js 数组严格一致（顺序敏感），
  // v0.2 定稿 11 项（formula/interactions/ball/export 为 v0.2 新增；main.js 依赖
  // TA.formula，缺任一文件整条管线都不初始化，故不做子集重试——注入失败如实上报）。
  const INJECT_FILES = [
    'shared/defaults.js',
    'content/core.js',
    'content/rules.js',
    'content/formula.js',
    'content/walker.js',
    'content/injector.js',
    'content/interactions.js',
    'content/ball.js',
    'content/export.js',
    'content/input-enhance.js',
    'content/subtitle.js',
    'content/dictionary.js',
    'content/image-translate.js',
    'content/main.js'
  ];

  // 弹窗内可选服务：[id, 显示名, 是否需要密钥]
  const SERVICES = [
    ['google', '谷歌翻译', false],
    ['deepl-free', 'DeepL（免费）', false],
    ['edge', '微软翻译', false],
    ['caiyun', '彩云小译', false],
    ['youdao', '有道翻译', false],
    ['iflyrec', '讯飞翻译', false],
    ['deepl-api', 'DeepL API', true],
    ['openai', 'OpenAI', true],
    ['claude', 'Claude', true],
    ['gemini', 'Google Gemini', true],
    ['deepseek', 'DeepSeek', true],
    ['ollama', '本地 Ollama（无需密钥）', false]
  ];

  // 目标语言兜底表（shared/defaults.js 的 TA.TARGET_LANGS 就绪后自动切换到它）
  const LANGS_FALLBACK = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'],
    ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'],
    ['es', 'Español'], ['pt', 'Português'], ['it', 'Italiano'], ['hi', 'हिन्दी']
  ];

  // 禁止注入的页面：协议规定 chrome://、edge://、about:、扩展页与 Chrome Web Store
  const BLOCKED_URL_PREFIXES = [
    'chrome://', 'edge://', 'about:', 'chrome-extension://', 'moz-extension://',
    'view-source:', 'devtools:', 'chrome-untrusted://', 'data:', 'javascript:', 'file://'
  ];
  const BLOCKED_URLS = [
    'https://chrome.google.com/webstore',
    'https://chromewebstore.google.com'
  ];

  const POLL_MS = 800; // GET_PAGE_STATE 轮询间隔（协议定稿值）

  /* ================= 兜底工具 ================= */

  // 规范化目标语言表：兼容 [code,name] 对、{code,name} 对象数组、{code:name} 映射三种形态
  function normalizeLangs(raw) {
    if (Array.isArray(raw) && raw.length) {
      return raw.map(function (x) {
        if (Array.isArray(x)) return [String(x[0]), String(x[1])];
        if (x && typeof x === 'object') {
          return [String(x.code || x.lang || x.id), String(x.name || x.label || x.code || x.lang || x.id)];
        }
        return [String(x), String(x)];
      });
    }
    if (raw && typeof raw === 'object') {
      return Object.keys(raw).map(function (k) { return [k, String(raw[k])]; });
    }
    return LANGS_FALLBACK;
  }

  function getLangs() {
    const TA = globalThis.TA;
    if (TA && TA.TARGET_LANGS) return normalizeLangs(TA.TARGET_LANGS);
    return LANGS_FALLBACK;
  }

  // 深合并兜底：仅当 shared/defaults.js 未就位时使用（语义与 TA.mergeDefaults 一致：
  // 对象深合并、数组整体替换、缺省键回填）
  function fallbackMerge(dst, src) {
    for (const k of Object.keys(src || {})) {
      const v = src[k];
      if (v === undefined) continue;
      if (Array.isArray(v)) { dst[k] = v.slice(); continue; }
      if (v && typeof v === 'object') {
        if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {};
        fallbackMerge(dst[k], v);
      } else {
        dst[k] = v;
      }
    }
    return dst;
  }

  const MINIMAL_DEFAULTS = {
    targetLang: 'zh-CN',
    primaryService: 'deepl-free',
    translateMode: 'bilingual',
    scopeMode: 'smart',
    urlPattern: { includedUrls: [], excludedUrls: [] },
    targetStyle: { theme: 'dashed', color: '', fontSize: '', customCss: '', loading: 'spinner', layout: 'block' },
    ai: { enableTerms: false, termsPreset: '', customTerms: '', enableContext: false },
    subtitle: { enabled: false, autoBilingual: true, fontSize: 18, showBackground: true, targetLang: '' },
    dictionary: { enabled: false, service: '', showExamples: true, autoSpeak: false },
    imageTranslate: { enabled: false, trigger: 'both', service: '', targetLang: '' },
    services: {
      'deepl-api': { genre: 'api-free', authKey: '', proxy: '', splitSentences: true },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', temperature: 0.2, systemPrompt: '' },
      claude: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest', apiKey: '', temperature: 0.2, maxTokens: 2048 },
      gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKey: '', temperature: 0.2 },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', temperature: 0.2, systemPrompt: '' },
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.1:8b', temperature: 0.2, systemPrompt: '' }
    }
  };

  function mergeDefaults(stored) {
    const TA = globalThis.TA;
    if (TA && typeof TA.mergeDefaults === 'function') return TA.mergeDefaults(stored);
    return fallbackMerge(JSON.parse(JSON.stringify(MINIMAL_DEFAULTS)), stored || {});
  }

  /* ================= DOM 引用 ================= */

  const $ = function (id) { return document.getElementById(id); };
  const appEl = $('app');
  const unsupportedEl = $('unsupported');
  const mainBtn = $('mainBtn');
  const modeSeg = $('modeSeg');
  const scopeSeg = $('scopeSeg');
  const serviceSel = $('serviceSel');
  const langSel = $('langSel');
  const progressRow = $('progressRow');
  const hintRow = $('hintRow');
  const errorRow = $('errorRow');
  const featRow = $('featRow');
  const moreBtn = $('moreBtn');
  const morePanel = $('morePanel');
  const cacheText = $('cacheText');
  const toastEl = $('toast');
  // 新功能按钮（更多面板）
  const btnDoc = $('btnDoc');
  const btnSubtitle = $('btnSubtitle');
  const btnImageTrans = $('btnImageTrans');
  const btnLayout = $('btnLayout');
  const btnSidebar = $('btnSidebar');

  /* ================= 运行状态 ================= */

  let tabId = null;          // 活动标签页 id
  let tabUrl = '';           // 活动标签页 URL（activeTab 授予后可用）
  let settings = null;       // 当前设置（mergeDefaults 后）
  let unsupported = false;   // 是否禁翻页
  let injectedTried = false; // 本会话是否已尝试过兜底注入（只试一次，避免循环）
  let pollInFlight = false;  // 轮询防重入
  let lastState = null;      // 最近一次 GET_PAGE_STATE 结果

  /* ================= 基础工具 ================= */

  function sendRuntime(req) {
    // 向 background 发消息：统一回调形式，避免未捕获的 Promise rejection
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(req, function (resp) {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: { code: 'SEND_FAILED', message: err.message } });
          else resolve(resp || { ok: false, error: { code: 'EMPTY_RESPONSE', message: '空响应' } });
        });
      } catch (e) {
        resolve({ ok: false, error: { code: 'SEND_FAILED', message: String(e && e.message || e) } });
      }
    });
  }

  function sendToTab(id, req) {
    // 向内容脚本发消息；「Could not establish connection」等失败统一返回 {__fail:true}
    return new Promise(function (resolve) {
      try {
        chrome.tabs.sendMessage(id, req, function (resp) {
          const err = chrome.runtime.lastError;
          if (err) resolve({ __fail: true, message: err.message });
          else resolve(resp || { __fail: true, message: '空响应' });
        });
      } catch (e) {
        resolve({ __fail: true, message: String(e && e.message || e) });
      }
    });
  }

  function isBlockedUrl(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    for (const p of BLOCKED_URL_PREFIXES) {
      if (lower.startsWith(p)) return true;
    }
    for (const u of BLOCKED_URLS) {
      if (lower.startsWith(u)) return true;
    }
    return false;
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2200);
  }

  function makeRequestId() {
    return 'pp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ================= 设置读写 ================= */

  async function loadSettings() {
    const stored = await chrome.storage.local.get('settings');
    return mergeDefaults(stored && stored.settings);
  }

  async function saveSettings(patch) {
    // 读-改-写整个 settings 对象（storage.set 整体覆盖 settings 键）
    const cur = await loadSettings();
    const next = Object.assign({}, cur, patch || {});
    await chrome.storage.local.set({ settings: next });
    settings = next;
  }

  // 服务是否已配置密钥（与协议 needsKey 汇总一致）
  function isServiceConfigured(id) {
    if (!settings) return true;
    const conf = (settings.services && settings.services[id]) || {};
    if (id === 'deepl-api') {
      // genre=deeplx 时 key 可空（仅作可选 Bearer）；api-free/api-pro 必须有 authKey
      return conf.genre === 'deeplx' || !!conf.authKey;
    }
    if (id === 'openai' || id === 'claude' || id === 'gemini' || id === 'deepseek') return !!conf.apiKey;
    if (id === 'ollama') return true; // 本地服务，无需密钥
    return true; // 其余免 key 服务
  }

  /* ================= 注入兜底 ================= */

  async function ensureInjected() {
    // 每个弹窗会话只注入一次；成功与否都记录，防止 GET_PAGE_STATE 失败循环注入
    if (injectedTried || tabId == null) return false;
    injectedTried = true;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: INJECT_FILES });
      return true;
    } catch (e) {
      // chrome:// 等页面 executeScript 直接抛错；清单文件缺失时重试子集只会得到
      // 一个无法初始化的半挂载管线（main.js 缺 TA.formula 即静默退出），如实返回失败
      return false;
    }
  }

  async function getPageState() {
    if (tabId == null) return null;
    let resp = await sendToTab(tabId, { type: 'GET_PAGE_STATE', requestId: makeRequestId() });
    if (resp && resp.__fail) {
      // 未注入 → 兜底注入后重发一次
      const ok = await ensureInjected();
      if (!ok) return null; // 注入失败 = 禁翻页
      resp = await sendToTab(tabId, { type: 'GET_PAGE_STATE', requestId: makeRequestId() });
      if (resp && resp.__fail) return null;
    }
    if (!resp || resp.ok === false) return null;
    if (resp.supported === false) return null;
    return resp;
  }

  /* ================= 轮询与渲染 ================= */

  function setSeg(seg, value) {
    const btns = seg.querySelectorAll('button[data-v]');
    for (const b of btns) b.classList.toggle('on', b.dataset.v === value);
  }

  function applyState(st) {
    lastState = st;
    if (!st) { setUnsupported(); return; }

    // 主按钮三态：progress 非空 = 翻译中
    const busy = st.progress != null && typeof st.progress.total === 'number' && st.progress.total > 0;
    if (busy) {
      mainBtn.textContent = '翻译中…';
      mainBtn.className = 'main-btn busy';
      mainBtn.disabled = true;
      progressRow.textContent = '翻译中 ' + st.progress.done + '/' + st.progress.total;
      progressRow.hidden = false;
    } else {
      mainBtn.disabled = false;
      if (st.translated) {
        mainBtn.textContent = '显示原文';
        mainBtn.className = 'main-btn restore';
      } else {
        mainBtn.textContent = '翻译';
        mainBtn.className = 'main-btn';
      }
      progressRow.hidden = true;
    }

    // 分段开关反映页面实际状态（未翻译时用设置默认值兜底）
    const mode = st.mode || (settings && settings.translateMode) || 'bilingual';
    const scope = st.scope || (settings && settings.scopeMode) || 'smart';
    setSeg(modeSeg, mode);
    setSeg(scopeSeg, scope);

    // 提示行：页面级 90% 语言跳过（v0.2：智能/全文模式同样遵守正文统计，
    // 不再提供"切全文强制翻译"的路径）
    if (st.sameLangPage && !st.translated && !busy) {
      hintRow.textContent = st.sameLangPageReason === 'pageDominance'
        ? '页面 90% 以上已是目标语言，未翻译（智能与全文模式同样遵守）；如需翻译请更换目标语言'
        : '页面基本已是目标语言，未翻译；如需翻译请更换目标语言';
      hintRow.hidden = false;
    } else {
      hintRow.hidden = true;
    }

    // 能力状态行（v0.2 GET_PAGE_STATE 扩展字段；content 未升级时隐藏）
    const f = st.features;
    if (f && typeof f === 'object') {
      const parts = [
        '悬停' + (f.hoverEnabled ? '开' : '关'),
        '划词' + (f.selectionEnabled ? '开' : '关'),
        '输入框' + (f.inputEnabled ? '开' : '关'),
        '悬浮球' + (f.floatBall ? '开' : '关')
      ];
      if (st.theme) parts.push('主题 ' + st.theme);
      featRow.textContent = parts.join(' · ');
      featRow.hidden = false;
    } else {
      featRow.hidden = true;
    }

    // 错误行
    if (st.error) {
      errorRow.textContent = String(st.error);
      errorRow.hidden = false;
    } else {
      errorRow.hidden = true;
    }
  }

  function setUnsupported() {
    unsupported = true;
    appEl.hidden = true;
    unsupportedEl.hidden = false;
  }

  async function poll() {
    if (unsupported || pollInFlight || tabId == null) return;
    pollInFlight = true;
    try {
      const st = await getPageState();
      if (st) applyState(st);
      else if (!unsupported) setUnsupported();
    } finally {
      pollInFlight = false;
    }
  }

  /* ================= 控件初始化 ================= */

  function buildLangSel() {
    const langs = getLangs();
    langSel.textContent = '';
    for (const [code, name] of langs) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = name;
      langSel.appendChild(opt);
    }
  }

  function buildServiceSel() {
    serviceSel.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动（默认链）';
    serviceSel.appendChild(auto);
    for (const [id, name, needsKey] of SERVICES) {
      const opt = document.createElement('option');
      opt.value = id;
      // 需 key 的服务未配置时项后缀「(未配置)」（协议 uiSpec 第 4 条）
      const ok = !needsKey || isServiceConfigured(id);
      opt.textContent = name + (ok ? '' : '（未配置）');
      serviceSel.appendChild(opt);
    }
  }

  function syncControlsFromSettings() {
    if (!settings) return;
    langSel.value = settings.targetLang || 'zh-CN';
    serviceSel.value = settings.primaryService || '';
    // 重新计算「(未配置)」后缀
    buildServiceSel();
    serviceSel.value = settings.primaryService || '';
    syncFeatureButtons();
  }

  // 新功能按钮的开关文案（saveSettings 为浅合并，toggle 时传完整子对象）
  function syncFeatureButtons() {
    if (btnSubtitle) {
      const on = !!(settings && settings.subtitle && settings.subtitle.enabled);
      btnSubtitle.textContent = '双语字幕：' + (on ? '开' : '关');
      btnSubtitle.classList.toggle('on', on);
    }
    if (btnImageTrans) {
      const on = !!(settings && settings.imageTranslate && settings.imageTranslate.enabled);
      btnImageTrans.textContent = '图片翻译：' + (on ? '开' : '关');
      btnImageTrans.classList.toggle('on', on);
    }
    if (btnLayout) {
      const dual = !!(settings && settings.targetStyle && settings.targetStyle.layout === 'dual');
      btnLayout.textContent = '并排双语：' + (dual ? '开' : '关');
      btnLayout.classList.toggle('on', dual);
    }
  }

  /* ================= 事件接线 ================= */

  // 主按钮（协议 v0.2 第 6 条）：未翻译态发 TRANSLATE_PAGE（幂等测试钩子，与无头测试
  // 共用路径），已翻译态发 RESTORE_PAGE —— 显式两消息，去 toggle 歧义。
  // TRANSLATE_PAGE 未被 content 识别（v0.1 过渡期）时退化 TOGGLE_TRANSLATE。
  mainBtn.addEventListener('click', async function () {
    if (mainBtn.disabled || tabId == null) return;
    mainBtn.textContent = '翻译中…';
    mainBtn.className = 'main-btn busy';
    mainBtn.disabled = true;
    const translated = !!(lastState && lastState.translated);
    if (translated) {
      await sendToTab(tabId, { type: 'RESTORE_PAGE', requestId: makeRequestId() });
      poll();
      return;
    }
    let resp = await sendToTab(tabId, { type: 'TRANSLATE_PAGE', scope: null, requestId: makeRequestId() });
    if (resp && resp.__fail) {
      const ok = await ensureInjected();
      if (ok) resp = await sendToTab(tabId, { type: 'TRANSLATE_PAGE', scope: null, requestId: makeRequestId() });
    }
    if (!resp || resp.__fail) {
      // v0.1 content 无 TRANSLATE_PAGE 路由 → 退化 toggle 语义
      await sendToTab(tabId, { type: 'TOGGLE_TRANSLATE', requestId: makeRequestId() });
    }
    poll();
  });

  // [双语对照|仅译文] = SET_MODE（协议⑥：已翻译页即时切换显隐，不发新请求）
  modeSeg.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-v]');
    if (!btn || tabId == null) return;
    const mode = btn.dataset.v;
    setSeg(modeSeg, mode);
    sendToTab(tabId, { type: 'SET_MODE', requestId: makeRequestId(), mode: mode });
  });

  // [智能|全文] = SET_SCOPE（协议⑦：已翻译时以新 scope 重新收集并翻译）
  scopeSeg.addEventListener('click', function (e) {
    const btn = e.target.closest('button[data-v]');
    if (!btn || tabId == null) return;
    const scope = btn.dataset.v;
    setSeg(scopeSeg, scope);
    sendToTab(tabId, { type: 'SET_SCOPE', requestId: makeRequestId(), scope: scope });
  });

  // 服务下拉：写 settings.primaryService；未配置的需 key 服务选中时提示
  serviceSel.addEventListener('change', async function () {
    const v = serviceSel.value;
    await saveSettings({ primaryService: v || null }); // 「自动」对应 null 值行为
    if (v && !isServiceConfigured(v)) {
      hintRow.textContent = '该服务需要密钥，请先到设置页配置，否则翻译会直接失败（显式指定的服务不降级）';
      hintRow.hidden = false;
      toast('服务未配置密钥');
    }
  });

  // 目标语言下拉：写 settings.targetLang
  langSel.addEventListener('change', async function () {
    await saveSettings({ targetLang: langSel.value });
    toast('目标语言：' + langSel.value);
  });

  // 更多面板折叠
  moreBtn.addEventListener('click', async function () {
    morePanel.hidden = !morePanel.hidden;
    moreBtn.textContent = morePanel.hidden ? '更多 ▾' : '收起 ▴';
    if (!morePanel.hidden) refreshCacheStats();
  });

  async function refreshCacheStats() {
    // 协议②：GET_CACHE_STATS → {ok, data:{entries, oldestAt}}
    const resp = await sendRuntime({ type: 'GET_CACHE_STATS', requestId: makeRequestId() });
    if (resp && resp.ok && resp.data) {
      cacheText.textContent = '缓存：' + resp.data.entries + ' 条';
    } else {
      cacheText.textContent = '缓存：- 条';
    }
  }

  $('clearCacheBtn').addEventListener('click', async function () {
    // 协议③：CLEAR_CACHE → {ok, data:{removed}}
    const resp = await sendRuntime({ type: 'CLEAR_CACHE', requestId: makeRequestId() });
    if (resp && resp.ok && resp.data) {
      cacheText.textContent = '缓存：0 条';
      toast('已清除 ' + resp.data.removed + ' 条缓存');
    } else {
      toast('清除失败');
    }
  });

  $('openOptionsBtn').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  // 导出双语三格式（协议 v0.2 消息 4：EXPORT_BILINGUAL → content export.js，
  // 经 TA.features.messages 分发；content 未升级时明确提示而非静默失败）
  async function exportBilingual(format) {
    if (tabId == null) { toast('无法访问当前标签页'); return; }
    const resp = await sendToTab(tabId, { type: 'EXPORT_BILINGUAL', format: format, download: true, requestId: makeRequestId() });
    if (resp && resp.__fail) {
      const ok = await ensureInjected();
      if (!ok) { toast('此页面无法注入，不能导出'); return; }
      const r2 = await sendToTab(tabId, { type: 'EXPORT_BILINGUAL', format: format, download: true, requestId: makeRequestId() });
      if (r2 && r2.__fail) { toast('导出模块未就绪（需 v0.2 content 脚本）'); return; }
      handleExportResp(r2);
      return;
    }
    handleExportResp(resp);
  }
  function handleExportResp(resp) {
    if (resp && resp.ok && resp.filename) toast('已导出 ' + resp.filename);
    else if (resp && resp.error && resp.error.code === 'NOT_TRANSLATED') toast('请先翻译本页');
    else toast('导出失败');
  }
  $('exportHtmlBtn').addEventListener('click', function () { exportBilingual('html'); });
  $('exportMdBtn').addEventListener('click', function () { exportBilingual('markdown'); });
  $('exportTxtBtn').addEventListener('click', function () { exportBilingual('txt'); });

  /* ---- 新功能：文档翻译 / 双语字幕 / 图片翻译 / 并排双语 ---- */

  // 文档翻译页：由 background 打开（OPEN_DOC）
  if (btnDoc) btnDoc.addEventListener('click', async function () {
    const resp = await sendRuntime({ type: 'OPEN_DOC', requestId: makeRequestId() });
    if (resp && resp.ok === false) toast('打开文档页失败：' + (resp.error && resp.error.message || '未知错误'));
  });

  // 双语字幕开关：内容脚本 feature 消息（返回 {ok, enabled}），随后刷新状态
  if (btnSubtitle) btnSubtitle.addEventListener('click', async function () {
    if (tabId == null) { toast('无法访问当前标签页'); return; }
    let resp = await sendToTab(tabId, { type: 'SUBTITLE_TOGGLE', requestId: makeRequestId() });
    if (resp && resp.__fail) {
      const ok = await ensureInjected();
      if (ok) resp = await sendToTab(tabId, { type: 'SUBTITLE_TOGGLE', requestId: makeRequestId() });
    }
    if (!resp || resp.__fail) { toast('字幕模块在此页面不可用'); return; }
    if (resp.ok === false) { toast('字幕切换失败'); return; }
    // setEnabled 内部已持久化 subtitle.enabled；同步本弹窗状态
    settings = await loadSettings();
    syncFeatureButtons();
    toast('双语字幕已' + (resp.enabled ? '开启（刷新视频页生效）' : '关闭'));
    poll();
  });

  // 翻译侧边栏：通知悬浮球内容脚本打开浮层侧边栏（BALL_OPEN_SIDEBAR 由 content/ball.js 处理）
  if (btnSidebar) btnSidebar.addEventListener('click', async function () {
    if (tabId == null) { toast('无法访问当前标签页'); return; }
    let resp = await sendToTab(tabId, { type: 'BALL_OPEN_SIDEBAR', requestId: makeRequestId() });
    if (resp && resp.__fail) {
      const ok = await ensureInjected();
      if (ok) resp = await sendToTab(tabId, { type: 'BALL_OPEN_SIDEBAR', requestId: makeRequestId() });
    }
    if (!resp || resp.__fail) { toast('侧边栏在此页面不可用'); return; }
    if (resp.ok === false) { toast('打开侧边栏失败'); return; }
    toast('已打开翻译侧边栏');
  });

  // 图片翻译开关：saveSettings 为浅合并，传完整 imageTranslate 子对象避免覆盖其它键
  if (btnImageTrans) btnImageTrans.addEventListener('click', async function () {
    const cur = settings && settings.imageTranslate ? settings.imageTranslate : {};
    const next = !cur.enabled;
    await saveSettings({ imageTranslate: Object.assign({}, cur, { enabled: next }) });
    syncFeatureButtons();
    toast('图片翻译已' + (next ? '开启' : '关闭'));
    poll();
  });

  // 并排双语：toggle targetStyle.layout（保存完整 targetStyle 子对象）
  if (btnLayout) btnLayout.addEventListener('click', async function () {
    const cur = settings && settings.targetStyle ? settings.targetStyle : {};
    const next = cur.layout === 'dual' ? 'block' : 'dual';
    await saveSettings({ targetStyle: Object.assign({}, cur, { layout: next }) });
    syncFeatureButtons();
    toast(next === 'dual' ? '并排双语已开启（对新翻译生效）' : '已切回块级上下布局');
    poll();
  });

  // 永不翻译此站点：把 "*://<hostname>/*" 追加进 urlPattern.excludedUrls
  $('neverBtn').addEventListener('click', async function () {
    if (!tabUrl) { toast('无法获取当前网址'); return; }
    let host;
    try { host = new URL(tabUrl).hostname; } catch (e) { toast('无法解析当前网址'); return; }
    if (!host) { toast('无法解析当前网址'); return; }
    const pattern = '*://' + host + '/*';
    const cur = await loadSettings();
    const list = (cur.urlPattern && cur.urlPattern.excludedUrls) || [];
    if (list.indexOf(pattern) === -1) list.push(pattern);
    cur.urlPattern = Object.assign({}, cur.urlPattern, { excludedUrls: list });
    await chrome.storage.local.set({ settings: cur });
    settings = cur;
    toast('已加入永不翻译：' + host);
  });

  // 设置在别处（options/其他弹窗实例）被修改 → 同步控件
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.settings) return;
    settings = mergeDefaults(changes.settings.newValue);
    syncControlsFromSettings();
  });

  /* ================= 启动 ================= */

  async function init() {
    try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* 版本号失败不阻塞 */ }

    // 「更多」面板默认展开，「打开设置」始终可见（HTML 已移除 hidden，这里再做一次状态同步）
    if (moreBtn && morePanel) { morePanel.hidden = false; moreBtn.textContent = '收起 ▴'; refreshCacheStats(); }

    settings = await loadSettings();
    buildLangSel();
    buildServiceSel();
    syncControlsFromSettings();

    // 取活动标签页（协议：无需 tabs 权限也可拿到 tab.id；activeTab 授予后有 url）
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs.length && typeof tabs[0].id === 'number') {
        tabId = tabs[0].id;
        tabUrl = tabs[0].url || '';
      }
    } catch (e) { /* 查不到标签页按禁翻页处理 */ }

    // 禁翻页快速路径：浏览器内置页 / 商店页直接显示兜底，不发消息
    if (tabId == null || isBlockedUrl(tabUrl)) {
      setUnsupported();
      return;
    }

    poll();
    setInterval(poll, POLL_MS);
  }

  init();
})();
