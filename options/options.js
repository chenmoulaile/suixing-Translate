/* options.js —— 设置页逻辑（MV3 经典脚本，无依赖）
 *
 * 职责（协议 uiSpec）：
 *  - 按 settings schema 渲染全部表单并回填 chrome.storage.local 的当前值；
 *  - 保存：收集表单 → 逐项校验（JSON / URL / 数字范围）→ chrome.storage.local.set({settings})；
 *  - 密钥字段 password 掩码：UI 永远显示 *** 不回显明文，留空保持已存值；
 *  - OpenAI 兼容端点域名授权：chrome.permissions.request（用户手势）；
 *  - 缓存统计/清除走 background（GET_CACHE_STATS / CLEAR_CACHE）。
 */
(function () {
  'use strict';

  /* ================= 兜底常量 =================
   * shared/defaults.js 就位后优先使用 TA.*；以下兜底仅在 defaults.js 缺失时生效，
   * 内容与协议 settings schema / TARGET_LANGS / THEMES 定稿一致。 */

  const DEFAULTS_FALLBACK = {
    version: 2,
    targetLang: 'zh-CN',
    primaryService: 'deepl-free',
    serviceChain: ['deepl-free', 'google', 'edge', 'caiyun', 'youdao'],
    translateMode: 'bilingual',
    scopeMode: 'smart',
    translationPosition: 'after',
    targetStyle: { theme: 'dashed', color: '', fontSize: '', customCss: '', loading: 'spinner', layout: 'block' },
    ui: {
      showFloatBall: true,
      ballPosition: 'right',      // 'right' | 'left'
      ballOpacity: 70,            // 0-100，语义=不透明度百分比
      ballHoverDelay: 200,        // 悬停展开菜单延迟 ms
      ballBlockedSites: [],       // 悬浮球站点黑名单
      sidebarTargetLang: '',      // 划译台目标语言（空=跟随全局 targetLang）
      sidebarWidth: 380           // 划译台面板宽 px
    },
    thresholds: { paragraphMinTextCount: 4, paragraphMinWordCount: 1 },
    inputTranslate: { enabled: true, gapMs: 200 },
    hoverTranslate: { enabled: true, trigger: 'holdKey', holdKey: 'ctrl', pressHoldMs: 800 },
    selection: {
      enabled: true, trigger: 'mini', triggerAction: 'hover',
      showOriginal: true, service: null, disabledSites: []
    },
    export: { format: 'html' },
    cache: { maxAgeDay: 30, maxEntries: 2000 },
    urlPattern: { includedUrls: [], excludedUrls: [] },
    langPattern: { includedLangs: [], excludedLangs: [] },
    services: {
      'deepl-api': { genre: 'api-free', authKey: '', proxy: '', splitSentences: true },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', temperature: 0.2, systemPrompt: '' },
      claude: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest', apiKey: '', temperature: 0.2, maxTokens: 2048 },
      gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKey: '', temperature: 0.2 },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', temperature: 0.2, systemPrompt: '' },
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.1:8b', temperature: 0.2, systemPrompt: '' }
    },
    // AI 术语库与上下文（仅对 AI 服务生效）
    ai: { enableTerms: false, termsPreset: '', customTerms: '', enableContext: false },
    // 双语字幕（YouTube / WebVTT 网页字幕）
    subtitle: { enabled: false, autoBilingual: true, fontSize: 18, showBackground: true, targetLang: '' },
    // AI 词典卡
    dictionary: { enabled: false, service: '', showExamples: true, autoSpeak: false },
    // 图片翻译（OCR）
    imageTranslate: { enabled: false, trigger: 'both', service: '', targetLang: '' },
    userRules: []
  };

  const LANGS_FALLBACK = [
    ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en', 'English'],
    ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'],
    ['es', 'Español'], ['pt', 'Português'], ['it', 'Italiano'], ['hi', 'हिन्दी']
  ];

  // 译文主题 24 档 fallback（与 shared/defaults.js 的 TA.THEMES/TA.THEME_NAMES 定稿一致；
  // defaults.js v2 就位后自动切换到 TA.*）
  const THEMES_FALLBACK = ['none', 'grey', 'dashed', 'thinDashed', 'dotted', 'underline',
    'nativeUnderline', 'nativeDashed', 'nativeDotted', 'wavy', 'dashedBorder', 'solidBorder',
    'dividingLine', 'highlight', 'marker', 'marker2', 'background', 'opacity', 'mask',
    'paper', 'blockquote', 'weakening', 'italic', 'bold'];
  const THEME_NAMES_FALLBACK = {
    none: '无', grey: '黑灰', dashed: '虚线下划线', thinDashed: '细虚线', dotted: '点状',
    underline: '直线', nativeUnderline: '原生下划线', nativeDashed: '原生虚线',
    nativeDotted: '原生点线', wavy: '波浪', dashedBorder: '虚线边框', solidBorder: '实线边框',
    dividingLine: '分割线', highlight: '高亮', marker: '马克笔', marker2: '马克笔2',
    background: '背景色', opacity: '透明', mask: '模糊(学习)', paper: '白纸阴影',
    blockquote: '引用', weakening: '弱化', italic: '斜体', bold: '加粗'
  };
  // 内置站点规则表（只读展示用，与 content/rules.js 的 BUILTIN_RULES 保持一致；
  // 运行时以 content 端为准，此处仅用于展示与骨架生成）
  const BUILTIN_RULES_VIEW = [
    { pattern: 'twitter.com', selectors: ['[data-testid="tweetText"]'], excludeSelectors: ['header', 'time', '[data-testid="User-Name"]'] },
    { pattern: 'x.com', selectors: ['[data-testid="tweetText"]'], excludeSelectors: ['header', 'time', '[data-testid="User-Name"]'] },
    { pattern: 'github.com', excludeSelectors: ['.js-file-line', '.blob-code'] },
    { pattern: 'news.ycombinator.com', selectors: ['.titleline', '.commtext', '.toptext'] },
    {
      pattern: 'codeforces.com', selectors: ['.ttypography'],
      excludeSelectors: ['div.sample-test', '.header .time-limit', '.header .memory-limit', '.header .input-file', '.header .output-file'],
      theme: ''
    }
  ];

  // 深合并兜底：对象深合并、数组整体替换、缺省键回填（与 TA.mergeDefaults 语义一致）
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

  function mergeDefaults(stored) {
    const TA = globalThis.TA;
    if (TA && typeof TA.mergeDefaults === 'function') return TA.mergeDefaults(stored);
    return fallbackMerge(JSON.parse(JSON.stringify(DEFAULTS_FALLBACK)), stored || {});
  }

  function getLangs() {
    const TA = globalThis.TA;
    if (TA && TA.TARGET_LANGS) {
      const raw = TA.TARGET_LANGS;
      if (Array.isArray(raw) && raw.length) {
        return raw.map(function (x) {
          if (Array.isArray(x)) return [String(x[0]), String(x[1])];
          if (x && typeof x === 'object') return [String(x.code || x.lang || x.id), String(x.name || x.label || x.code || x.lang || x.id)];
          return [String(x), String(x)];
        });
      }
      if (raw && typeof raw === 'object') return Object.keys(raw).map(function (k) { return [k, String(raw[k])]; });
    }
    return LANGS_FALLBACK;
  }

  function getThemes() {
    const TA = globalThis.TA;
    if (TA && TA.THEMES) {
      const raw = TA.THEMES;
      const names = TA.THEME_NAMES || {};
      if (Array.isArray(raw) && raw.length) {
        return raw.map(function (x) {
          if (Array.isArray(x)) return [String(x[0]), String(x[1])];
          if (typeof x === 'string') return [x, names[x] || x];
          if (x && typeof x === 'object') return [String(x.id || x.theme || x.key), String(x.name || x.label || names[x.id] || x.id || x.theme || x.key)];
          return [String(x), String(x)];
        });
      }
      if (raw && typeof raw === 'object') return Object.keys(raw).map(function (k) { return [k, names[k] || String(raw[k])]; });
    }
    return THEMES_FALLBACK.map(function (id) { return [id, THEME_NAMES_FALLBACK[id] || id]; });
  }

  /* ================= 服务元数据 ================= */

  const SVC_NAMES = {
    google: '谷歌翻译',
    'deepl-free': 'DeepL（免费）',
    edge: '微软翻译',
    caiyun: '彩云小译',
    youdao: '有道翻译',
    iflyrec: '讯飞翻译',
    'deepl-api': 'DeepL API',
    openai: 'OpenAI',
    claude: 'Claude',
    gemini: 'Google Gemini',
    deepseek: 'DeepSeek',
    ollama: '本地 Ollama（无需密钥）'
  };
  const SVC_NEEDS_KEY = {
    'deepl-api': true, openai: true,
    claude: true, gemini: true, deepseek: true, ollama: false
  };
  // 新服务密钥字段名映射（ollama 不需要密钥，但其 baseUrl 存在即视为已配置）
  const KEY_FIELDS = {
    'deepl-api': 'deeplAuthKey',
    openai: 'openaiApiKey',
    claude: 'claudeApiKey',
    gemini: 'geminiApiKey',
    deepseek: 'deepseekApiKey'
  };

  /* ================= DOM 引用 ================= */

  const $ = function (id) { return document.getElementById(id); };
  const optLang = $('optLang');
  const themeGrid = $('themeGrid');
  const optColor = $('optColor');
  const optColorText = $('optColorText');
  const optFontSize = $('optFontSize');
  const optCustomCss = $('optCustomCss');
  const optPrimary = $('optPrimary');
  const chainListEl = $('chainList');
  const deeplGenre = $('deeplGenre');
  const deeplAuthKey = $('deeplAuthKey');
  const deeplProxy = $('deeplProxy');
  const deeplSplit = $('deeplSplit');
  const deeplKeyBadge = $('deeplKeyBadge');
  const openaiBaseUrl = $('openaiBaseUrl');
  const openaiModel = $('openaiModel');
  const openaiApiKey = $('openaiApiKey');
  const openaiTemp = $('openaiTemp');
  const openaiPrompt = $('openaiPrompt');
  const openaiKeyBadge = $('openaiKeyBadge');
  const btnOpenaiAuth = $('btnOpenaiAuth');
  const openaiAuthTip = $('openaiAuthTip');
  // 新 AI 服务配置控件
  const claudeBaseUrl = $('claudeBaseUrl');
  const claudeModel = $('claudeModel');
  const claudeApiKey = $('claudeApiKey');
  const claudeTemp = $('claudeTemp');
  const claudeMaxTokens = $('claudeMaxTokens');
  const claudeKeyBadge = $('claudeKeyBadge');
  const btnClaudeAuth = $('btnClaudeAuth');
  const claudeAuthTip = $('claudeAuthTip');
  const geminiBaseUrl = $('geminiBaseUrl');
  const geminiModel = $('geminiModel');
  const geminiApiKey = $('geminiApiKey');
  const geminiTemp = $('geminiTemp');
  const geminiKeyBadge = $('geminiKeyBadge');
  const btnGeminiAuth = $('btnGeminiAuth');
  const geminiAuthTip = $('geminiAuthTip');
  const deepseekBaseUrl = $('deepseekBaseUrl');
  const deepseekModel = $('deepseekModel');
  const deepseekApiKey = $('deepseekApiKey');
  const deepseekTemp = $('deepseekTemp');
  const deepseekPrompt = $('deepseekPrompt');
  const deepseekKeyBadge = $('deepseekKeyBadge');
  const btnDeepseekAuth = $('btnDeepseekAuth');
  const deepseekAuthTip = $('deepseekAuthTip');
  const ollamaBaseUrl = $('ollamaBaseUrl');
  const ollamaModel = $('ollamaModel');
  const ollamaTemp = $('ollamaTemp');
  const ollamaPrompt = $('ollamaPrompt');
  const btnOllamaAuth = $('btnOllamaAuth');
  const ollamaAuthTip = $('ollamaAuthTip');
  // ⑦ AI 与扩展场景
  const aiEnableTerms = $('aiEnableTerms');
  const aiTermsPreset = $('aiTermsPreset');
  const aiCustomTerms = $('aiCustomTerms');
  const aiEnableContext = $('aiEnableContext');
  const layoutSelect = $('layoutSelect');
  const subEnabled = $('subEnabled');
  const subAutoBilingual = $('subAutoBilingual');
  const subFontSize = $('subFontSize');
  const subShowBg = $('subShowBg');
  const subTargetLang = $('subTargetLang');
  const dictEnabled = $('dictEnabled');
  const dictService = $('dictService');
  const dictExamples = $('dictExamples');
  const dictAutoSpeak = $('dictAutoSpeak');
  const imgEnabled = $('imgEnabled');
  const imgTrigger = $('imgTrigger');
  const imgService = $('imgService');
  const imgTargetLang = $('imgTargetLang');
  const btnDocPage = $('btnDocPage');
  const optExcluded = $('optExcluded');
  const optIncluded = $('optIncluded');
  const langExcGroup = $('langExcGroup');
  const langIncGroup = $('langIncGroup');
  const optUserRules = $('optUserRules');
  const userRulesMsg = $('userRulesMsg');
  const optMinText = $('optMinText');
  const optMinWord = $('optMinWord');
  const optInputEnabled = $('optInputEnabled');
  const optGapMs = $('optGapMs');
  const optFloatBall = $('optFloatBall');
  const optHover = $('optHover');
  // v0.2 新增控件
  const btnPreviewThemes = $('btnPreviewThemes');
  const themePreview = $('themePreview');
  const builtinRulesView = $('builtinRulesView');
  const btnRuleSkeleton = $('btnRuleSkeleton');
  const btnRulesExport = $('btnRulesExport');
  const optHoverTrigger = $('optHoverTrigger');
  const optHoldKey = $('optHoldKey');
  const optPressHoldMs = $('optPressHoldMs');
  const holdKeyLbl = $('holdKeyLbl');
  const optSelEnabled = $('optSelEnabled');
  const optSelTrigger = $('optSelTrigger');
  const optSelAction = $('optSelAction');
  const optSelShowOriginal = $('optSelShowOriginal');
  const optSelDisabled = $('optSelDisabled');
  const optBallPos = $('optBallPos');
  const optBallOpacity = $('optBallOpacity');
  const optBallHoverDelay = $('optBallHoverDelay');
  const optBallBlocked = $('optBallBlocked');
  const optExportFmt = $('optExportFmt');
  const optCacheDays = $('optCacheDays');
  const optCacheEntries = $('optCacheEntries');
  const btnClearCache = $('btnClearCache');
  const cacheMsg = $('cacheMsg');
  const btnSave = $('btnSave');
  const saveMsg = $('saveMsg');
  const toastEl = $('toast');
  // ⑨ 设置页翻译
  const optPageTranslateLang = $('optPageTranslateLang');
  const btnTranslatePage = $('btnTranslatePage');
  const btnRestorePage = $('btnRestorePage');
  const pageTranslateMsg = $('pageTranslateMsg');
  const btnQuickTranslatePage = $('btnQuickTranslatePage');

  /* ================= 运行状态 ================= */

  let S = null;                            // 当前设置（mergeDefaults 后）
  let storedKeys = {
    'deepl-api': '', openai: '', claude: '', gemini: '', deepseek: ''
  }; // 已存密钥的影子（UI 永不回显；ollama 无密钥不在此列）
  let chainList = [];                      // 降级链有序 id 列表
  let dirty = false;                       // 有未保存修改
  let toastTimer = null;
  // ⑨ 设置页翻译的运行时状态（不写入 settings，避免持久化键冲突）
  var pageTranslate = { active: false, nodes: [], originals: new Map(), spans: [] };

  /* ================= 基础工具 ================= */

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2000);
  }

  function makeRequestId() {
    return 'op-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function sendRuntime(req) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(req, function (resp) {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: { message: err.message } });
          else resolve(resp || { ok: false, error: { message: '空响应' } });
        });
      } catch (e) {
        resolve({ ok: false, error: { message: String(e && e.message || e) } });
      }
    });
  }

  function isValidUrl(s) {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }

  function lines(text) {
    return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function radioVal(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function setRadio(name, value) {
    const el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function markErr(input) {
    input.classList.add('err-text');
    setTimeout(function () { input.classList.remove('err-text'); }, 4000);
  }

  /* ================= 服务可用性 ================= */

  // 密钥生效值：优先输入框新输入，其次已存值（ollama 无密钥字段，返回 ''）
  function effectiveKey(id) {
    const field = KEY_FIELDS[id] ? $(KEY_FIELDS[id]) : null;
    const typed = field ? String(field.value || '').trim() : '';
    return typed || storedKeys[id] || '';
  }

  function isServiceConfigured(id) {
    // ollama 为本地服务，无需密钥；baseUrl 存在（或字段缺省）即视为已配置
    if (id === 'ollama') return true;
    if (!SVC_NEEDS_KEY[id]) return true;
    if (id === 'deepl-api') {
      const genre = deeplGenre.value || 'api-free';
      return genre === 'deeplx' || !!effectiveKey(id);
    }
    return !!effectiveKey(id);
  }

  function availableServices() {
    return Object.keys(SVC_NAMES).filter(function (id) { return isServiceConfigured(id); });
  }

  /* ================= 渲染 ================= */

  function renderBasics() {
    // 目标语言下拉
    optLang.textContent = '';
    for (const [code, name] of getLangs()) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      optLang.appendChild(o);
    }
    optLang.value = S.targetLang || 'zh-CN';

    setRadio('optMode', S.translateMode || 'bilingual');
    setRadio('optScope', S.scopeMode || 'smart');
    setRadio('optPosition', S.translationPosition || 'after');
  }

  function renderStyle() {
    renderThemeGrid();
    setRadio('optLoading', (S.targetStyle && S.targetStyle.loading) || 'spinner');
    const color = S.targetStyle.color || '';
    optColorText.value = color;
    optColor.value = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#999999';
    optFontSize.value = S.targetStyle.fontSize != null && S.targetStyle.fontSize !== '' ? String(S.targetStyle.fontSize) : '';
    optCustomCss.value = S.targetStyle.customCss || '';
    if (layoutSelect) layoutSelect.value = S.targetStyle.layout === 'dual' ? 'dual' : 'block';
  }

  /* ---------- 24 档主题真实预览（② 区「预览全部样式」） ---------- */

  let previewOpen = false;

  function renderThemePreview() {
    themePreview.textContent = '';
    for (const [id, name] of getThemes()) {
      const line = document.createElement('div');
      line.className = 'tp-line';
      const tag = document.createElement('span');
      tag.className = 'tp-tag';
      tag.textContent = name + '（' + id + '）';
      // 用与页面译文完全相同的 DOM 结构渲染（content.css 基础结构 + themes.css 主题档）
      const holder = document.createElement('span');
      holder.className = 'ta-target-wrapper';
      holder.setAttribute('data-ta-theme', id);
      holder.setAttribute('dir', 'auto');
      const inner = document.createElement('span');
      inner.className = 'ta-target-inner';
      inner.textContent = 'The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过了懒狗。';
      holder.appendChild(inner);
      line.appendChild(tag);
      line.appendChild(holder);
      themePreview.appendChild(line);
    }
  }

  btnPreviewThemes.addEventListener('click', function () {
    previewOpen = !previewOpen;
    if (previewOpen && !themePreview.childNodes.length) renderThemePreview();
    themePreview.hidden = !previewOpen;
    btnPreviewThemes.textContent = previewOpen ? '收起预览' : '预览全部样式';
  });

  function renderThemeGrid() {
    themeGrid.textContent = '';
    for (const [id, name] of getThemes()) {
      const lab = document.createElement('label');
      lab.className = 'theme-item' + (S.targetStyle.theme === id ? ' checked' : '');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'taTheme';
      input.value = id;
      if (S.targetStyle.theme === id) input.checked = true;
      const demo = document.createElement('span');
      demo.className = 'tp';
      demo.dataset.theme = id;
      demo.textContent = '译文样式预览';
      const cap = document.createElement('span');
      cap.className = 'tp-name';
      cap.textContent = name;
      lab.appendChild(input);
      lab.appendChild(demo);
      lab.appendChild(cap);
      themeGrid.appendChild(lab);
    }
  }

  themeGrid.addEventListener('change', function () {
    const items = themeGrid.querySelectorAll('.theme-item');
    for (const it of items) {
      it.classList.toggle('checked', it.querySelector('input').checked);
    }
  });

  function renderServices() {
    // 先回填 deepl-api 的 genre，再构建主服务下拉（isServiceConfigured 依赖它判断可用性）
    deeplGenre.value = (S.services && S.services['deepl-api'] && S.services['deepl-api'].genre) || 'api-free';

    // 主服务下拉
    optPrimary.textContent = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动（默认链）';
    optPrimary.appendChild(auto);
    for (const id of Object.keys(SVC_NAMES)) {
      const o = document.createElement('option');
      o.value = id;
      const ok = !SVC_NEEDS_KEY[id] || isServiceConfigured(id);
      o.textContent = SVC_NAMES[id] + (ok ? '' : '（未配置）');
      optPrimary.appendChild(o);
    }
    optPrimary.value = S.primaryService || '';

    // 密钥徽标与输入框（password 掩码：值恒为空，*** 放占位符）
    const dConfigured = isServiceConfigured('deepl-api');
    deeplAuthKey.value = '';
    deeplAuthKey.placeholder = dConfigured ? '***' : '未配置';
    deeplKeyBadge.textContent = dConfigured ? '已配置' : '未配置';
    deeplKeyBadge.classList.toggle('ok', dConfigured);
    deeplProxy.value = (S.services['deepl-api'] && S.services['deepl-api'].proxy) || '';
    deeplSplit.checked = !!(S.services['deepl-api'] && S.services['deepl-api'].splitSentences);

    const oConfigured = !!effectiveKey('openai');
    openaiApiKey.value = '';
    openaiApiKey.placeholder = oConfigured ? '***' : '未配置';
    openaiKeyBadge.textContent = oConfigured ? '已配置' : '未配置';
    openaiKeyBadge.classList.toggle('ok', oConfigured);
    openaiBaseUrl.value = (S.services.openai && S.services.openai.baseUrl) || 'https://api.openai.com/v1';
    openaiModel.value = (S.services.openai && S.services.openai.model) || 'gpt-4o-mini';
    openaiTemp.value = String(S.services.openai && S.services.openai.temperature != null ? S.services.openai.temperature : 0.2);
    openaiPrompt.value = (S.services.openai && S.services.openai.systemPrompt) || '';

    // 新 AI 服务：Claude / Gemini / DeepSeek（密钥掩码）+ Ollama（无密钥）
    const svc = function (id) { return (S.services && S.services[id]) || {}; };
    const c = svc('claude'), g = svc('gemini'), d = svc('deepseek'), o = svc('ollama');
    if (claudeBaseUrl) claudeBaseUrl.value = c.baseUrl || 'https://api.anthropic.com/v1';
    if (claudeModel) claudeModel.value = c.model || 'claude-3-5-sonnet-latest';
    if (claudeTemp) claudeTemp.value = String(c.temperature != null ? c.temperature : 0.2);
    if (claudeMaxTokens) claudeMaxTokens.value = String(c.maxTokens != null ? c.maxTokens : 2048);
    if (geminiBaseUrl) geminiBaseUrl.value = g.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    if (geminiModel) geminiModel.value = g.model || 'gemini-2.0-flash';
    if (geminiTemp) geminiTemp.value = String(g.temperature != null ? g.temperature : 0.2);
    if (deepseekBaseUrl) deepseekBaseUrl.value = d.baseUrl || 'https://api.deepseek.com/v1';
    if (deepseekModel) deepseekModel.value = d.model || 'deepseek-chat';
    if (deepseekTemp) deepseekTemp.value = String(d.temperature != null ? d.temperature : 0.2);
    if (deepseekPrompt) deepseekPrompt.value = d.systemPrompt || '';
    if (ollamaBaseUrl) ollamaBaseUrl.value = o.baseUrl || 'http://localhost:11434';
    if (ollamaModel) ollamaModel.value = o.model || 'llama3.1:8b';
    if (ollamaTemp) ollamaTemp.value = String(o.temperature != null ? o.temperature : 0.2);
    if (ollamaPrompt) ollamaPrompt.value = o.systemPrompt || '';
    // 密钥输入框永远显示空值 + *** 占位符（仅内存影子保存明文）
    [['claude', claudeApiKey, claudeKeyBadge], ['gemini', geminiApiKey, geminiKeyBadge],
     ['deepseek', deepseekApiKey, deepseekKeyBadge]].forEach(function (tuple) {
      const configured = !!storedKeys[tuple[0]];
      if (tuple[1]) { tuple[1].value = ''; tuple[1].placeholder = configured ? '***' : '未配置'; }
      if (tuple[2]) {
        tuple[2].textContent = configured ? '已配置' : '未配置';
        tuple[2].classList.toggle('ok', configured);
      }
    });
    updateAuthBtn();

    renderChain();
  }

  /* ---------- 降级链编辑器 ---------- */

  function renderChain() {
    chainListEl.textContent = '';
    const avail = availableServices();
    chainList = chainList.filter(function (id) { return avail.indexOf(id) !== -1; });
    const rest = avail.filter(function (id) { return chainList.indexOf(id) === -1; });
    const rows = [];
    chainList.forEach(function (id) { rows.push({ id: id, inChain: true }); });
    rest.forEach(function (id) { rows.push({ id: id, inChain: false }); });

    rows.forEach(function (r, i) {
      const row = document.createElement('div');
      row.className = 'chain-row' + (r.inChain ? ' in-chain' : '');

      const idx = document.createElement('span');
      idx.className = 'chain-idx';
      idx.textContent = r.inChain ? String(chainList.indexOf(r.id) + 1) : '—';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = r.inChain;
      cb.title = r.inChain ? '点击移出降级链' : '点击加入降级链';
      cb.addEventListener('change', function () {
        if (cb.checked) chainList.push(r.id);
        else chainList = chainList.filter(function (x) { return x !== r.id; });
        renderChain();
      });

      const name = document.createElement('span');
      name.className = 'chain-name';
      name.textContent = SVC_NAMES[r.id];

      const hint = document.createElement('span');
      hint.className = 'chain-hint';
      hint.textContent = r.inChain ? (chainList.indexOf(r.id) === 0 ? '（最先尝试）' : '') : '（未加入）';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'arrow';
      up.textContent = '↑';
      up.disabled = !r.inChain || chainList.indexOf(r.id) === 0;
      up.addEventListener('click', function () {
        const j = chainList.indexOf(r.id);
        if (j > 0) {
          const t = chainList[j - 1];
          chainList[j - 1] = chainList[j];
          chainList[j] = t;
          renderChain();
        }
      });

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'arrow';
      down.textContent = '↓';
      down.disabled = !r.inChain || chainList.indexOf(r.id) === chainList.length - 1;
      down.addEventListener('click', function () {
        const j = chainList.indexOf(r.id);
        if (j !== -1 && j < chainList.length - 1) {
          const t = chainList[j + 1];
          chainList[j + 1] = chainList[j];
          chainList[j] = t;
          renderChain();
        }
      });

      row.appendChild(idx);
      row.appendChild(cb);
      row.appendChild(name);
      row.appendChild(hint);
      row.appendChild(up);
      row.appendChild(down);
      chainListEl.appendChild(row);
    });
  }

  /* ---------- 非官方域名授权（OpenAI 兼容端点 + 新 AI 服务） ---------- */

  const AUTH_PAIRS = [
    { input: openaiBaseUrl, btn: btnOpenaiAuth, tip: openaiAuthTip, official: /(^|\.)api\.openai\.com$/i },
    { input: claudeBaseUrl, btn: btnClaudeAuth, tip: claudeAuthTip, official: /(^|\.)api\.anthropic\.com$/i },
    { input: geminiBaseUrl, btn: btnGeminiAuth, tip: geminiAuthTip, official: /(^|\.)generativelanguage\.googleapis\.com$/i },
    { input: deepseekBaseUrl, btn: btnDeepseekAuth, tip: deepseekAuthTip, official: /(^|\.)api\.deepseek\.com$/i },
    { input: ollamaBaseUrl, btn: btnOllamaAuth, tip: ollamaAuthTip, official: /^(localhost|127\.0\.0\.1)$/i }
  ];

  function updateAuthBtn() {
    for (const cfg of AUTH_PAIRS) {
      if (!cfg.input || !cfg.btn) continue;
      let origin = '';
      let host = '';
      try {
        const u = new URL(cfg.input.value.trim());
        origin = u.origin;
        host = u.hostname;
      } catch (e) { origin = ''; host = ''; }
      const isOfficial = cfg.official.test(host) || (cfg.input === ollamaBaseUrl && !host);
      cfg.btn.hidden = !origin || isOfficial;
      if (cfg.tip) {
        cfg.tip.textContent = cfg.btn.hidden
          ? (isOfficial ? '官方域名无需授权' : '请先填写合法的 Base URL')
          : '将请求授权访问：' + origin + '/*';
      }
    }
  }

  AUTH_PAIRS.forEach(function (cfg) {
    if (cfg.input) cfg.input.addEventListener('input', updateAuthBtn);
    if (cfg.btn) cfg.btn.addEventListener('click', async function () {
      let origin;
      try { origin = new URL(cfg.input.value.trim()).origin; } catch (e) {
        toast('Base URL 不合法，无法授权');
        return;
      }
      try {
        const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
        toast(granted ? '已授权 ' + origin : '未授权，该服务将无法访问');
      } catch (e) {
        toast('授权失败：' + (e && e.message || e));
      }
    });
  });

  /* ---------- 网站规则 ---------- */

  function renderSites() {
    optExcluded.value = (S.urlPattern.excludedUrls || []).join('\n');
    optIncluded.value = (S.urlPattern.includedUrls || []).join('\n');
    renderLangGroup(langExcGroup, S.langPattern.excludedLangs || []);
    renderLangGroup(langIncGroup, S.langPattern.includedLangs || []);
    renderBuiltinRules();
    optUserRules.value = (S.userRules && S.userRules.length) ? JSON.stringify(S.userRules, null, 2) : '';
    userRulesMsg.textContent = '';
    userRulesMsg.classList.remove('err');
  }

  function renderLangGroup(container, selected) {
    container.textContent = '';
    for (const [code, name] of getLangs()) {
      const lab = document.createElement('label');
      lab.className = 'check';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = code;
      cb.checked = selected.indexOf(code) !== -1;
      lab.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = name;
      lab.appendChild(span);
      container.appendChild(lab);
    }
  }

  function checkedVals(container) {
    const out = [];
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(function (cb) { out.push(cb.value); });
    return out;
  }

  /* ---------- 高级 ---------- */

  function renderAdvanced() {
    optMinText.value = String(S.thresholds.paragraphMinTextCount);
    optMinWord.value = String(S.thresholds.paragraphMinWordCount);
    // 输入框翻译（v0.2：gapMs 默认 200，可调 150-1000）
    optInputEnabled.checked = !!S.inputTranslate.enabled;
    optGapMs.value = String(S.inputTranslate.gapMs);
    // 悬停翻译三件套
    optHover.checked = !!S.hoverTranslate.enabled;
    optHoverTrigger.value = S.hoverTranslate.trigger || 'holdKey';
    optHoldKey.value = S.hoverTranslate.holdKey || 'ctrl';
    optPressHoldMs.value = String(S.hoverTranslate.pressHoldMs != null ? S.hoverTranslate.pressHoldMs : 800);
    syncHoverFields();
    // 划词翻译
    const sel = S.selection || {};
    optSelEnabled.checked = !!sel.enabled;
    optSelTrigger.value = sel.trigger || 'mini';
    optSelAction.value = sel.triggerAction || 'hover';
    optSelShowOriginal.checked = sel.showOriginal !== false;
    optSelDisabled.value = Array.isArray(sel.disabledSites) ? sel.disabledSites.join('\n') : '';
    // 悬浮球增强
    const ui = S.ui || {};
    optFloatBall.checked = ui.showFloatBall !== false;
    optBallPos.value = ui.ballPosition === 'left' ? 'left' : 'right';
    optBallOpacity.value = String(ui.ballOpacity != null ? ui.ballOpacity : 70);
    optBallHoverDelay.value = String(ui.ballHoverDelay != null ? ui.ballHoverDelay : 200);
    optBallBlocked.value = Array.isArray(ui.ballBlockedSites) ? ui.ballBlockedSites.join('\n') : '';
    // 导出双语
    optExportFmt.value = (S.export && S.export.format) || 'html';
    optCacheDays.value = String(S.cache.maxAgeDay);
    optCacheEntries.value = String(S.cache.maxEntries);
  }

  // 悬停翻译触发方式联动：按住停留模式才需要「按住时长」；holdKey 模式才需要「修饰键」
  function syncHoverFields() {
    const trig = optHoverTrigger.value;
    optPressHoldMs.parentElement.style.display = trig === 'pressHold' ? '' : 'none';
    optHoldKey.style.display = trig === 'holdKey' ? '' : 'none';
    holdKeyLbl.style.display = trig === 'holdKey' ? '' : 'none';
  }
  optHoverTrigger.addEventListener('change', syncHoverFields);

  /* ---------- 内置规则展示 / 骨架插入 / 规则导出（④ 区） ---------- */

  function renderBuiltinRules() {
    builtinRulesView.value = JSON.stringify(BUILTIN_RULES_VIEW, null, 2);
  }

  // 尽力取当前活动标签页域名（options 页无 tabs 权限时回退占位符）
  async function currentHost() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const u = tabs && tabs[0] && tabs[0].url;
      if (u) return new URL(u).hostname;
    } catch (e) { /* 无权限/无法解析：用占位符 */ }
    return null;
  }

  btnRuleSkeleton.addEventListener('click', async function () {
    const host = await currentHost();
    const skeleton = {
      pattern: host || 'example.com',
      selectors: [],
      excludeSelectors: [],
      'selectors.add': [],
      'selectors.remove': [],
      additionalExcludeSelectors: []
    };
    let arr = [];
    try { arr = JSON.parse(optUserRules.value.trim() || '[]'); } catch (e) {
      toast('用户规则不是合法 JSON，请先修正');
      return;
    }
    if (!Array.isArray(arr)) { toast('用户规则必须是 JSON 数组'); return; }
    arr.push(skeleton);
    optUserRules.value = JSON.stringify(arr, null, 2);
    toast(host ? '已插入 ' + host + ' 规则骨架' : '已插入骨架（pattern 请改成站点域名）');
  });

  btnRulesExport.addEventListener('click', function () {
    const payload = JSON.stringify({ builtin: BUILTIN_RULES_VIEW, userRules: S.userRules || [] }, null, 2);
    const blob = new Blob(['\ufeff' + payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'translate-anywhere-rules.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('已导出规则 JSON');
  });

  btnClearCache.addEventListener('click', async function () {
    // 协议：点击先 GET_CACHE_STATS 显示「当前 n 条」，再清除并显示结果
    cacheMsg.textContent = '查询中…';
    const st = await sendRuntime({ type: 'GET_CACHE_STATS', requestId: makeRequestId() });
    if (!(st && st.ok && st.data)) {
      cacheMsg.textContent = '缓存统计查询失败';
      return;
    }
    cacheMsg.textContent = '当前 ' + st.data.entries + ' 条，正在清除…';
    const resp = await sendRuntime({ type: 'CLEAR_CACHE', requestId: makeRequestId() });
    if (resp && resp.ok && resp.data) {
      cacheMsg.textContent = '已清除 ' + resp.data.removed + ' 条缓存';
      toast('缓存已清除');
    } else {
      cacheMsg.textContent = '清除失败';
    }
  });

  /* ---------- 密钥清除按钮（立即写库生效） ---------- */

  $('btnDeeplClear').addEventListener('click', async function () {
    const cur = await loadSettingsRaw();
    cur.services['deepl-api'].authKey = '';
    await chrome.storage.local.set({ settings: cur });
    S = cur;
    storedKeys['deepl-api'] = '';
    renderServices();
    toast('已清除 DeepL API 密钥');
  });

  $('btnOpenaiClear').addEventListener('click', async function () {
    const cur = await loadSettingsRaw();
    cur.services.openai.apiKey = '';
    await chrome.storage.local.set({ settings: cur });
    S = cur;
    storedKeys.openai = '';
    renderServices();
    toast('已清除 OpenAI 密钥');
  });

  /* ---------- ⑦ AI 与扩展场景 ---------- */

  const AI_SERVICE_IDS = ['openai', 'claude', 'gemini', 'deepseek', 'ollama'];
  const PRESET_FALLBACK = ['legal', 'medical', 'ecommerce', 'education', 'gaming', 'novel', 'finance', 'tech'];

  function renderAiSection(S) {
    // 术语预设：优先取后台术语库的预设领域名，缺失时用内置兜底
    if (aiTermsPreset) {
      aiTermsPreset.textContent = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '不使用';
      aiTermsPreset.appendChild(none);
      let names = PRESET_FALLBACK;
      try {
        const TA = globalThis.TA;
        if (TA && TA.terminology && typeof TA.terminology.getPresetNames === 'function') {
          const got = TA.terminology.getPresetNames();
          if (Array.isArray(got) && got.length) names = got;
        }
      } catch (e) { /* 术语库未就绪：用兜底 */ }
      for (const name of names) {
        const o = document.createElement('option');
        o.value = String(name);
        o.textContent = String(name);
        aiTermsPreset.appendChild(o);
      }
      aiTermsPreset.value = (S.ai && S.ai.termsPreset) || '';
    }

    // 词典服务：AI 服务 id + 默认链（''）
    if (dictService) {
      dictService.textContent = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = '默认链';
      dictService.appendChild(auto);
      for (const id of AI_SERVICE_IDS) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = SVC_NAMES[id] || id;
        dictService.appendChild(o);
      }
      dictService.value = (S.dictionary && S.dictionary.service) || '';
    }

    const ai = S.ai || {};
    if (aiEnableTerms) aiEnableTerms.checked = !!ai.enableTerms;
    if (aiCustomTerms) aiCustomTerms.value = ai.customTerms || '';
    if (aiEnableContext) aiEnableContext.checked = !!ai.enableContext;

    const sub = S.subtitle || {};
    if (subEnabled) subEnabled.checked = !!sub.enabled;
    if (subAutoBilingual) subAutoBilingual.checked = sub.autoBilingual !== false;
    if (subFontSize) subFontSize.value = String(sub.fontSize != null ? sub.fontSize : 18);
    if (subShowBg) subShowBg.checked = sub.showBackground !== false;
    if (subTargetLang) subTargetLang.value = sub.targetLang || '';

    const dict = S.dictionary || {};
    if (dictEnabled) dictEnabled.checked = !!dict.enabled;
    if (dictExamples) dictExamples.checked = dict.showExamples !== false;
    if (dictAutoSpeak) dictAutoSpeak.checked = !!dict.autoSpeak;

    const img = S.imageTranslate || {};
    if (imgEnabled) imgEnabled.checked = !!img.enabled;
    if (imgTrigger) imgTrigger.value = ['click', 'hover', 'both'].indexOf(img.trigger) !== -1 ? img.trigger : 'both';
    if (imgService) imgService.value = img.service || '';
    if (imgTargetLang) imgTargetLang.value = img.targetLang || '';
  }

  /* ---------- ⑨ 设置页翻译（自翻译工具，不修改任何表单控件的值） ---------- */

  function renderPageTranslate() {
    if (!optPageTranslateLang) return;
    optPageTranslateLang.textContent = '';
    const langs = getLangs();
    for (const [code, name] of langs) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = name;
      optPageTranslateLang.appendChild(o);
    }
    let chosen = '';
    try { chosen = sessionStorage.getItem('ta-opt-page-lang') || ''; } catch (e) { chosen = ''; }
    if (!chosen || !langs.some(function (x) { return x[0] === chosen; })) {
      chosen = (S && S.targetLang) || 'zh-CN';
    }
    if (!langs.some(function (x) { return x[0] === chosen; })) chosen = 'zh-CN';
    optPageTranslateLang.value = chosen;
  }

  // 收集主内容区可翻译文本节点：跳过表单控件/脚本等标签与翻译器自身 UI
  function collectTranslatableNodes() {
    const root = document.querySelector('main.content');
    if (!root) return [];
    const SKIP = {
      SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, OPTION: 1,
      INPUT: 1, BUTTON: 1, SELECT: 1, CODE: 1, PRE: 1
    };
    function blocked(node) {
      let el = node.parentElement;
      while (el) {
        if (SKIP[el.tagName]) return true;
        if (el.hasAttribute && el.hasAttribute('data-ta-opt-translated')) return true;
        if (el.id === 'sec-page-translate') return true;
        el = el.parentElement;
      }
      return false;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (blocked(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const out = [];
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  function setPageTranslateBusy(busy) {
    [btnTranslatePage, btnRestorePage, btnQuickTranslatePage].forEach(function (b) {
      if (b) b.disabled = busy;
    });
    if (optPageTranslateLang) optPageTranslateLang.disabled = busy;
  }

  function sendPageBatch(texts, targetLang, seq) {
    return sendRuntime({
      type: 'TRANSLATE_BATCH',
      requestId: makeRequestId(),
      batchId: Date.now().toString(36) + '-optpg' + seq,
      texts: texts,
      targetLang: targetLang,
      sourceLang: 'auto',
      service: null
    });
  }

  // 单批发送：失败时拆半重试一次（depth < 1），与 doc.js / content 主流程一致
  function sendPageChunk(texts, targetLang, seq, depth) {
    return sendPageBatch(texts, targetLang, seq).then(function (res) {
      const ok = res && res.ok && Array.isArray(res.translations) &&
        res.translations.every(function (v) { return typeof v === 'string' && v; });
      if (ok) return { translations: res.translations, error: '' };
      if (depth < 1 && texts.length > 1) {
        const mid = Math.ceil(texts.length / 2);
        return sendPageChunk(texts.slice(0, mid), targetLang, seq + 'a', depth + 1)
          .then(function (a) {
            return sendPageChunk(texts.slice(mid), targetLang, seq + 'b', depth + 1)
              .then(function (b) {
                return { translations: a.translations.concat(b.translations), error: a.error || b.error };
              });
          });
      }
      const partial = (res && Array.isArray(res.translations)) ? res.translations : [];
      const errObj = res && res.error;
      const msg = errObj ? (errObj.message || errObj.code || '翻译失败')
        : (typeof res === 'string' ? res : '翻译失败');
      return {
        translations: texts.map(function (_, i) {
          const v = partial[i];
          return (typeof v === 'string' && v) ? v : null;
        }),
        error: msg
      };
    });
  }

  async function translateOptionsPage() {
    if (pageTranslate.active) return;
    const targetLang = (optPageTranslateLang && optPageTranslateLang.value) || (S && S.targetLang) || 'zh-CN';
    try { sessionStorage.setItem('ta-opt-page-lang', targetLang); } catch (e) { /* 无 sessionStorage：忽略 */ }

    const nodes = collectTranslatableNodes();
    if (!nodes.length) {
      pageTranslateMsg.textContent = '本页没有可翻译的文本';
      return;
    }

    pageTranslate.active = true;
    pageTranslate.nodes = nodes;
    setPageTranslateBusy(true);
    if (btnTranslatePage) btnTranslatePage.hidden = true;
    if (btnRestorePage) btnRestorePage.hidden = true;
    pageTranslateMsg.textContent = '正在收集文本…';

    // 相同文本去重：string -> 文本节点下标数组
    const byText = new Map();
    nodes.forEach(function (node, i) {
      const key = node.nodeValue;
      if (!byText.has(key)) byText.set(key, []);
      byText.get(key).push(i);
    });
    const uniqueTexts = Array.from(byText.keys());

    // 分包：≤200 段且 ≤200000 字符；记录每包在 uniqueTexts 中的起始下标
    const chunks = [];
    let start = 0, curTexts = [], curChars = 0;
    uniqueTexts.forEach(function (text, i) {
      const len = text.length;
      if (curTexts.length && (curTexts.length >= 200 || curChars + len > 200000)) {
        chunks.push({ texts: curTexts, start: start });
        curTexts = []; curChars = 0; start = i;
      }
      curTexts.push(text); curChars += len;
    });
    if (curTexts.length) chunks.push({ texts: curTexts, start: start });

    const translations = new Array(uniqueTexts.length).fill(null);
    const errors = [];
    for (let ci = 0; ci < chunks.length; ci++) {
      pageTranslateMsg.textContent = '翻译中 ' + (ci + 1) + '/' + chunks.length + ' 批…';
      const chunk = chunks[ci];
      const res = await sendPageChunk(chunk.texts, targetLang, ci + 1, 0);
      res.translations.forEach(function (tr, j) {
        translations[chunk.start + j] = tr;
      });
      if (res.error) errors.push(res.error);
    }

    // 插入译文 span：保留原文文本节点，仅在其后追加兄弟节点（不触碰 .value/.checked）
    let done = 0;
    uniqueTexts.forEach(function (text, ui) {
      const tr = translations[ui];
      if (typeof tr !== 'string' || !tr || tr === text) return;
      byText.get(text).forEach(function (nodeIdx) {
        const node = nodes[nodeIdx];
        if (!node || !node.parentNode) return;
        const span = document.createElement('span');
        span.className = 'ta-opt-translation';
        span.setAttribute('lang', targetLang);
        span.setAttribute('data-ta-opt-translated', '1');
        span.textContent = tr;
        node.parentNode.insertBefore(span, node.nextSibling);
        pageTranslate.spans.push(span);
        pageTranslate.originals.set(node, span);
        done++;
      });
    });

    setPageTranslateBusy(false);
    if (btnRestorePage) btnRestorePage.hidden = false;
    if (errors.length) {
      pageTranslateMsg.textContent = '部分翻译失败：' + errors[0] + (done ? '（已保留完成的 ' + done + ' 处）' : '');
    } else {
      pageTranslateMsg.textContent = '完成，已翻译 ' + done + ' 处';
    }
  }

  function restoreOptionsPage() {
    pageTranslate.spans.forEach(function (span) {
      if (span.parentNode) span.parentNode.removeChild(span);
    });
    pageTranslate.spans = [];
    pageTranslate.nodes = [];
    pageTranslate.originals.clear();
    pageTranslate.active = false;
    if (btnTranslatePage) btnTranslatePage.hidden = false;
    if (btnRestorePage) btnRestorePage.hidden = true;
    pageTranslateMsg.textContent = '已还原';
  }

  if (btnTranslatePage) btnTranslatePage.addEventListener('click', translateOptionsPage);
  if (btnRestorePage) btnRestorePage.addEventListener('click', restoreOptionsPage);
  if (btnQuickTranslatePage) btnQuickTranslatePage.addEventListener('click', function () {
    const sec = document.getElementById('sec-page-translate');
    if (sec && sec.scrollIntoView) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    translateOptionsPage();
  });

  // 文档翻译页：由 background 打开 chrome-extension://.../doc/doc.html
  if (btnDocPage) btnDocPage.addEventListener('click', async function () {
    const resp = await sendRuntime({ type: 'OPEN_DOC' });
    if (resp && resp.ok === false) toast('打开文档页失败：' + (resp.error && resp.error.message || '未知错误'));
  });

  // 新服务密钥清除（立即写库生效，与既有 deepl/openai 清除按钮同构）
  const NEW_KEY_SERVICES = [
    ['claude', btnClaudeClear], ['gemini', btnGeminiClear], ['deepseek', btnDeepseekClear]
  ];
  NEW_KEY_SERVICES.forEach(function (tuple) {
    const id = tuple[0], btn = tuple[1];
    if (!btn) return;
    btn.addEventListener('click', async function () {
      const cur = await loadSettingsRaw();
      if (!cur.services) cur.services = {};
      if (!cur.services[id]) cur.services[id] = {};
      cur.services[id].apiKey = '';
      await chrome.storage.local.set({ settings: cur });
      S = cur;
      storedKeys[id] = '';
      renderServices();
      toast('已清除 ' + (SVC_NAMES[id] || id) + ' 密钥');
    });
  });

  /* ================= 读取设置 ================= */

  function loadSettingsRaw() {
    return chrome.storage.local.get('settings').then(function (stored) {
      return mergeDefaults(stored && stored.settings);
    });
  }

  async function loadAndRender() {
    S = await loadSettingsRaw();
    // 密钥影子：只存于内存，UI 永不回显明文
    storedKeys['deepl-api'] = (S.services['deepl-api'] && S.services['deepl-api'].authKey) || '';
    storedKeys.openai = (S.services.openai && S.services.openai.apiKey) || '';
    storedKeys.claude = (S.services.claude && S.services.claude.apiKey) || '';
    storedKeys.gemini = (S.services.gemini && S.services.gemini.apiKey) || '';
    storedKeys.deepseek = (S.services.deepseek && S.services.deepseek.apiKey) || '';
    chainList = (S.serviceChain || []).filter(function (id) { return !!SVC_NAMES[id]; });

    renderBasics();
    renderStyle();
    renderServices();
    renderSites();
    renderAdvanced();
    renderAiSection(S);
    renderPageTranslate();
    dirty = false;
  }

  /* ================= 保存 ================= */

  function numOrKeep(input, cur, min, max, label, errs) {
    const raw = String(input.value).trim();
    if (raw === '') return cur; // 留空保持原值
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      errs.push(label + ' 必须在 ' + min + ' ~ ' + max + ' 之间');
      markErr(input);
      return cur;
    }
    return n;
  }

  function collectAndValidate() {
    const errs = [];
    const out = JSON.parse(JSON.stringify(S)); // 深拷贝，未涉及的键原样保留

    // ① 基础
    out.targetLang = optLang.value || 'zh-CN';
    out.translateMode = radioVal('optMode') || 'bilingual';
    out.scopeMode = radioVal('optScope') || 'smart';
    out.translationPosition = radioVal('optPosition') || 'after';

    // ② 译文样式
    const themeInput = document.querySelector('input[name="taTheme"]:checked');
    out.targetStyle.theme = themeInput ? themeInput.value : 'dashed';
    const loadingInput = document.querySelector('input[name="optLoading"]:checked');
    out.targetStyle.loading = loadingInput ? loadingInput.value : 'spinner';
    const color = optColorText.value.trim();
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      errs.push('自定义颜色必须是 #RRGGBB 格式（或留空）');
      markErr(optColorText);
    }
    out.targetStyle.color = color;
    const fsRaw = String(optFontSize.value).trim();
    if (fsRaw === '') out.targetStyle.fontSize = '';
    else {
      const fs = Number(fsRaw);
      if (!Number.isInteger(fs) || fs < 1 || fs > 96) {
        errs.push('自定义字号必须是 1~96 的整数（或留空）');
        markErr(optFontSize);
      } else out.targetStyle.fontSize = String(fs);
    }
    out.targetStyle.customCss = optCustomCss.value;
    out.targetStyle.layout = (layoutSelect && layoutSelect.value === 'dual') ? 'dual' : 'block';

    // ③ 服务与密钥
    out.primaryService = optPrimary.value || null; // 「自动」对应 null 值行为
    out.serviceChain = chainList.slice();

    const dProxy = deeplProxy.value.trim();
    if (dProxy && !isValidUrl(dProxy)) {
      errs.push('DeepL 代理地址不是合法的 http(s) URL');
      markErr(deeplProxy);
    }
    out.services['deepl-api'] = {
      genre: deeplGenre.value,
      authKey: effectiveKey('deepl-api'), // 输入框留空 = 保持已存值
      proxy: dProxy,
      splitSentences: deeplSplit.checked
    };

    const oBase = openaiBaseUrl.value.trim() || 'https://api.openai.com/v1';
    if (!isValidUrl(oBase)) {
      errs.push('OpenAI Base URL 不是合法的 http(s) URL');
      markErr(openaiBaseUrl);
    }
    let oTemp = (S.services.openai && S.services.openai.temperature) != null ? S.services.openai.temperature : 0.2;
    const tempRaw = String(openaiTemp.value).trim();
    if (tempRaw !== '') {
      oTemp = Number(tempRaw);
      if (!Number.isFinite(oTemp) || oTemp < 0 || oTemp > 2) {
        errs.push('temperature 必须在 0 ~ 2 之间');
        markErr(openaiTemp);
      }
    }
    out.services.openai = {
      baseUrl: oBase,
      model: openaiModel.value.trim() || 'gpt-4o-mini',
      apiKey: effectiveKey('openai'),
      temperature: oTemp,
      systemPrompt: openaiPrompt.value
    };

    // 新 AI 服务：合并进 out.services（out 已深拷贝 S，未涉及的既有服务密钥原样保留）
    out.services = out.services || {};
    const svcUrl = function (input, fallback, label) {
      const v = (input && String(input.value).trim()) || fallback;
      if (!isValidUrl(v)) {
        errs.push(label + ' Base URL 不是合法的 http(s) URL');
        if (input) markErr(input);
      }
      return v;
    };
    const svcTemp = function (input, fallback, label) {
      if (!input) return fallback;
      const raw = String(input.value).trim();
      if (raw === '') return fallback;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 2) {
        errs.push(label + ' temperature 必须在 0 ~ 2 之间');
        markErr(input);
        return fallback;
      }
      return n;
    };
    const svcInt = function (input, fallback, min, max, label) {
      if (!input) return fallback;
      const raw = String(input.value).trim();
      if (raw === '') return fallback;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < min || n > max) {
        errs.push(label + ' 必须介于 ' + min + ' ~ ' + max);
        markErr(input);
        return fallback;
      }
      return n;
    };
    out.services.claude = {
      baseUrl: svcUrl(claudeBaseUrl, 'https://api.anthropic.com/v1', 'Claude'),
      model: (claudeModel && claudeModel.value.trim()) || 'claude-3-5-sonnet-latest',
      apiKey: effectiveKey('claude'),
      temperature: svcTemp(claudeTemp, 0.2, 'Claude'),
      maxTokens: svcInt(claudeMaxTokens, (S.services.claude && S.services.claude.maxTokens) || 2048, 1, 1000000, 'Claude maxTokens')
    };
    out.services.gemini = {
      baseUrl: svcUrl(geminiBaseUrl, 'https://generativelanguage.googleapis.com/v1beta', 'Gemini'),
      model: (geminiModel && geminiModel.value.trim()) || 'gemini-2.0-flash',
      apiKey: effectiveKey('gemini'),
      temperature: svcTemp(geminiTemp, 0.2, 'Gemini')
    };
    out.services.deepseek = {
      baseUrl: svcUrl(deepseekBaseUrl, 'https://api.deepseek.com/v1', 'DeepSeek'),
      model: (deepseekModel && deepseekModel.value.trim()) || 'deepseek-chat',
      apiKey: effectiveKey('deepseek'),
      temperature: svcTemp(deepseekTemp, 0.2, 'DeepSeek'),
      systemPrompt: deepseekPrompt ? deepseekPrompt.value : ''
    };
    out.services.ollama = {
      baseUrl: svcUrl(ollamaBaseUrl, 'http://localhost:11434', 'Ollama'),
      model: (ollamaModel && ollamaModel.value.trim()) || 'llama3.1:8b',
      temperature: svcTemp(ollamaTemp, 0.2, 'Ollama'),
      systemPrompt: ollamaPrompt ? ollamaPrompt.value : ''
    };

    // ④ 网站规则
    out.urlPattern = {
      excludedUrls: lines(optExcluded.value),
      includedUrls: lines(optIncluded.value)
    };
    out.langPattern = {
      excludedLangs: checkedVals(langExcGroup),
      includedLangs: checkedVals(langIncGroup)
    };
    const rawRules = optUserRules.value.trim();
    if (rawRules === '') {
      out.userRules = [];
    } else {
      try {
        const v = JSON.parse(rawRules);
        if (!Array.isArray(v)) {
          errs.push('用户规则必须是 JSON 数组');
          markErr(optUserRules);
        } else if (v.some(function (x) { return typeof x !== 'object' || x === null || Array.isArray(x); })) {
          errs.push('用户规则数组的每一项都必须是对象');
          markErr(optUserRules);
        } else {
          out.userRules = v;
        }
      } catch (e) {
        errs.push('用户规则 JSON 解析失败：' + e.message);
        markErr(optUserRules);
      }
    }

    // ⑤ 高级
    out.thresholds = {
      paragraphMinTextCount: numOrKeep(optMinText, S.thresholds.paragraphMinTextCount, 0, 100000, '段落最短字符数', errs),
      paragraphMinWordCount: numOrKeep(optMinWord, S.thresholds.paragraphMinWordCount, 1, 100000, '段落最短词数', errs)
    };
    out.inputTranslate = {
      enabled: optInputEnabled.checked,
      gapMs: numOrKeep(optGapMs, S.inputTranslate.gapMs, 150, 1000, '三连空格间隔阈值', errs)
    };
    out.hoverTranslate = {
      enabled: optHover.checked,
      trigger: optHoverTrigger.value,
      holdKey: optHoldKey.value,
      pressHoldMs: numOrKeep(optPressHoldMs, (S.hoverTranslate && S.hoverTranslate.pressHoldMs) != null ? S.hoverTranslate.pressHoldMs : 800, 200, 3000, '悬停按住时长', errs)
    };
    const prevSel = S.selection || {};
    out.selection = {
      enabled: optSelEnabled.checked,
      trigger: optSelTrigger.value,
      triggerAction: optSelAction.value,
      showOriginal: optSelShowOriginal.checked,
      service: prevSel.service || '', // 与 shared/defaults.js v2 schema 对齐（'' = 走默认链）
      disabledSites: lines(optSelDisabled.value)
    };
    out.ui = {
      showFloatBall: optFloatBall.checked,
      ballPosition: optBallPos.value === 'left' ? 'left' : 'right',
      ballOpacity: numOrKeep(optBallOpacity, (S.ui && S.ui.ballOpacity) != null ? S.ui.ballOpacity : 70, 0, 100, '悬浮球不透明度', errs),
      ballHoverDelay: numOrKeep(optBallHoverDelay, (S.ui && S.ui.ballHoverDelay) != null ? S.ui.ballHoverDelay : 200, 0, 2000, '悬浮球悬停展开延迟', errs),
      ballBlockedSites: lines(optBallBlocked.value)
    };
    out.export = { format: optExportFmt.value };
    out.cache = {
      maxAgeDay: numOrKeep(optCacheDays, S.cache.maxAgeDay, 1, 3650, '缓存保留天数', errs),
      maxEntries: numOrKeep(optCacheEntries, S.cache.maxEntries, 1, 1000000, '缓存条数上限', errs)
    };

    // ⑦ AI 与扩展场景
    out.ai = {
      enableTerms: !!(aiEnableTerms && aiEnableTerms.checked),
      termsPreset: (aiTermsPreset && aiTermsPreset.value) || '',
      customTerms: aiCustomTerms ? aiCustomTerms.value : '',
      enableContext: !!(aiEnableContext && aiEnableContext.checked)
    };
    out.subtitle = {
      enabled: !!(subEnabled && subEnabled.checked),
      autoBilingual: subAutoBilingual ? subAutoBilingual.checked : true,
      fontSize: numOrKeep(subFontSize, (S.subtitle && S.subtitle.fontSize) != null ? S.subtitle.fontSize : 18, 8, 96, '字幕字号', errs),
      showBackground: subShowBg ? subShowBg.checked : true,
      targetLang: (subTargetLang && subTargetLang.value.trim()) || ''
    };
    out.dictionary = {
      enabled: !!(dictEnabled && dictEnabled.checked),
      service: (dictService && dictService.value) || '',
      showExamples: dictExamples ? dictExamples.checked : true,
      autoSpeak: !!(dictAutoSpeak && dictAutoSpeak.checked)
    };
    out.imageTranslate = {
      enabled: !!(imgEnabled && imgEnabled.checked),
      trigger: (imgTrigger && ['click', 'hover', 'both'].indexOf(imgTrigger.value) !== -1) ? imgTrigger.value : 'both',
      service: (imgService && imgService.value) || '',
      targetLang: (imgTargetLang && imgTargetLang.value.trim()) || ''
    };

    return { out: out, errs: errs };
  }

  btnSave.addEventListener('click', async function () {
    const r = collectAndValidate();
    if (r.errs.length) {
      saveMsg.textContent = '保存失败：' + r.errs[0] + (r.errs.length > 1 ? '（共 ' + r.errs.length + ' 处问题）' : '');
      saveMsg.className = 'save-msg err';
      toast(r.errs[0]);
      return;
    }
    try {
      await chrome.storage.local.set({ settings: r.out });
      S = r.out;
      storedKeys['deepl-api'] = r.out.services['deepl-api'].authKey || '';
      storedKeys.openai = r.out.services.openai.apiKey || '';
      storedKeys.claude = r.out.services.claude.apiKey || '';
      storedKeys.gemini = r.out.services.gemini.apiKey || '';
      storedKeys.deepseek = r.out.services.deepseek.apiKey || '';
      dirty = false;
      renderServices(); // 刷新「(未配置)」后缀 / 徽标 / 降级链可用项
      saveMsg.textContent = '已保存 ' + new Date().toLocaleTimeString();
      saveMsg.className = 'save-msg ok';
      toast('已保存');
    } catch (e) {
      saveMsg.textContent = '保存失败：' + (e && e.message || e);
      saveMsg.className = 'save-msg err';
    }
  });

  /* ================= 其它 ================= */

  // 表单变动标记（保存前若有别处改动，不自动覆盖用户正在编辑的内容）
  document.querySelector('main').addEventListener('input', function () { dirty = true; }, true);
  document.querySelector('main').addEventListener('change', function () { dirty = true; }, true);

  // 设置在别处被修改且本页无未保存修改时，自动重渲染
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.settings) return;
    if (!dirty) loadAndRender();
  });

  // 左侧导航高亮（IntersectionObserver 不可用时退化为仅点击跳转）
  (function setupNav() {
    const links = Array.prototype.slice.call(document.querySelectorAll('#nav a'));
    links.forEach(function (a) {
      a.addEventListener('click', function () {
        links.forEach(function (x) { x.classList.remove('active'); });
        a.classList.add('active');
      });
    });
    try {
      const sections = Array.prototype.slice.call(document.querySelectorAll('main section[id]'));
      const map = {};
      links.forEach(function (a) {
        map[a.getAttribute('href').slice(1)] = a;
      });
      const io = new IntersectionObserver(function (entries) {
        for (const en of entries) {
          if (en.isIntersecting && map[en.target.id]) {
            links.forEach(function (x) { x.classList.remove('active'); });
            map[en.target.id].classList.add('active');
          }
        }
      }, { rootMargin: '-20% 0px -70% 0px' });
      sections.forEach(function (sec) { io.observe(sec); });
    } catch (e) { /* 老内核无 IntersectionObserver：忽略 */ }
  })();

  /* ================= 启动 ================= */

  async function init() {
    let ver = '';
    try { ver = chrome.runtime.getManifest().version; } catch (e) { /* 无清单上下文 */ }
    $('verBadge').textContent = ver ? 'v' + ver : '';
    $('aboutVer').textContent = '随行翻译（ParaTranslate）v' + ver + ' · MV3 · 纯原生 JavaScript，无构建无依赖';

    await loadAndRender();
  }

  init();
})();
