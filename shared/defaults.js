// shared/defaults.js —— 全局命名空间与默认配置（content/background/popup/options 共用）
// 纯原生 JS 经典脚本（无模块系统），统一挂载在 globalThis.TA 命名空间下。
// content 脚本按 manifest js 数组顺序加载，本文件最先加载，负责初始化 TA 命名空间；
// background 通过 importScripts 首位加载本文件，效果相同。
//
// v0.2 schema 变更（本文件唯一写者=A 排版引擎改造员，接口冻结，B/C 按此施工）：
//   THEMES 12 档 → 24 档 + THEME_NAMES 中文映射；
//   targetStyle.loading 三档（spinner/text/none）；
//   ui 增加 ballPosition/ballOpacity/ballHoverDelay/ballBlockedSites（悬浮球增强，C）；
//   hoverTranslate 增加 trigger/holdKey/pressHoldMs（B 悬停翻译三档触发）；
//   selection 新增（B 划词翻译）；
//   inputTranslate.gapMs 默认 600 → 200（B 输入框翻译提速）；
//   export 新增（C 导出双语默认格式）；
//   ui 新增 sidebarTargetLang/sidebarWidth（随行翻译侧边栏，C）。
// v1.0 新增：ai（术语库/上下文增强）、subtitle（双语字幕）、dictionary（划词词典）、
//   imageTranslate（图片翻译）；services 增加 claude/gemini/deepseek/ollama；
//   targetStyle.layout（block|dual 双栏排版）。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // 目标语言全集（canonical 码 + 显示名，共 11 项；uiSpec 定稿）
  TA.TARGET_LANGS = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'de', name: 'Deutsch' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'pt', name: 'Português' },
    { code: 'it', name: 'Italiano' },
    { code: 'hi', name: 'हिन्दी' }
  ];

  // 译文主题 26 档（样式实现由 C 的 styles/themes.css 按 data-ta-theme / 行内 inner 选择器落地；
  // 顺序 = 官方全集顺序，options ② 区预览网格按本数组渲染）
  TA.THEMES = [
    'none', 'grey', 'dashed', 'thinDashed', 'dotted', 'underline',
    'nativeUnderline', 'nativeDashed', 'nativeDotted', 'wavy',
    'dashedBorder', 'solidBorder', 'dividingLine', 'highlight', 'marker', 'marker2',
    'background', 'opacity', 'mask', 'paper', 'blockquote', 'weakening', 'italic', 'bold',
    'doubleUnderline', 'pill'
  ];

  // 26 档主题中文名映射（options 预览网格 / popup 展示用）
  // 注：nativeUnderline/nativeDashed/nativeDotted 三档设计稿未给中文名，按语义补齐
  TA.THEME_NAMES = {
    none: '无',
    grey: '黑灰',
    dashed: '虚线下划线',
    thinDashed: '细虚线',
    dotted: '点状',
    underline: '直线',
    nativeUnderline: '原生下划线',
    nativeDashed: '原生虚线',
    nativeDotted: '原生点线',
    wavy: '波浪',
    dashedBorder: '虚线边框',
    solidBorder: '实线边框',
    dividingLine: '分割线',
    highlight: '高亮',
    marker: '马克笔',
    marker2: '马克笔2',
    background: '背景色',
    opacity: '透明',
    mask: '模糊（学习模式）',
    paper: '白纸阴影',
    blockquote: '引用',
    weakening: '弱化',
    italic: '斜体',
    bold: '加粗',
    doubleUnderline: '双下划线',
    pill: '胶囊描边'
  };

  // settings 默认值（v0.2 schema 定稿；读取时经 TA.mergeDefaults 深合并回填缺省键）
  TA.DEFAULTS = {
    version: 2,
    targetLang: 'zh-CN',
    primaryService: 'deepl-free',
    serviceChain: ['deepl-free', 'google', 'edge', 'caiyun', 'youdao'],
    translateMode: 'bilingual',
    scopeMode: 'smart',
    translationPosition: 'after',
    // 译文外观：theme=24 档之一；color/fontSize/customCss 自定义保留；
    // loading=翻译中占位形态（spinner 闪烁圈 / text 静态省略号 / none 无）
    targetStyle: { theme: 'dashed', color: '', fontSize: '', customCss: '', loading: 'spinner', layout: 'block' },
    // 悬浮球：ballPosition 左右停靠；ballOpacity=不透明度百分比（0–100，直白化语义：
    // 100 全不透明、0 全透，与官方"100=全透"反直觉定义相反，README 已注明）；
    // ballHoverDelay=悬停展开动作钮延时 ms；ballBlockedSites=站点黑名单（rules.matchUrlPattern 匹配）；
    // sidebarTargetLang=划译台目标语言（空=跟随全局 targetLang）；sidebarWidth=划译台面板宽 px
    ui: { showFloatBall: true, ballPosition: 'right', ballOpacity: 70, ballHoverDelay: 200, ballBlockedSites: [], sidebarTargetLang: '', sidebarWidth: 380 },
    thresholds: { paragraphMinTextCount: 4, paragraphMinWordCount: 1 },
    // 输入框三连空格：间隔默认 200ms（v0.1 为 600；options 可调 150–1000，B 负责 UI）
    inputTranslate: { enabled: true, gapMs: 200 },
    // 悬停翻译（B）：trigger 三档 holdKey（按住修饰键悬停）/ pressHold（按住不动）/ hover（纯悬停）；
    // holdKey ∈ ctrl|alt|shift|meta；pressHoldMs=pressHold 档按住时长阈值
    hoverTranslate: { enabled: true, trigger: 'holdKey', holdKey: 'ctrl', pressHoldMs: 800 },
    // 划词翻译（B）：trigger 三档 mini（小圆点）/ icon（logo 圆钮）/ direct（mouseup 即弹）；
    // triggerAction 二级（仅 mini/icon 生效）hover|click；showOriginal=单词查询是否回显原文；
    // service 非空时划词走指定服务且后台不降级；disabledSites=本站禁用名单
    selection: { enabled: true, trigger: 'mini', triggerAction: 'hover', showOriginal: true, service: '', disabledSites: [] },
    // 导出双语（C）：默认格式 html | markdown | txt
    export: { format: 'html' },
    // AI 增强：术语库（enableTerms/termsPreset/customTerms）与上下文（enableContext）
    ai: { enableTerms: false, termsPreset: '', customTerms: '', enableContext: false },
    // 双语字幕（subtitle.js）：enabled 开关；autoBilingual 自动双语；fontSize 字号；
    // showBackground 字幕背景；targetLang 目标语言（空则跟随全局 targetLang）
    subtitle: { enabled: false, autoBilingual: true, fontSize: 18, showBackground: true, targetLang: '' },
    // 划词词典（dictionary.js）：enabled 开关；service 查询服务；showExamples 例句；autoSpeak 自动朗读
    dictionary: { enabled: false, service: '', showExamples: true, autoSpeak: false },
    // 图片翻译（image-translate.js）：enabled 开关；trigger 触发方式；service OCR 服务；targetLang 目标语言
    imageTranslate: { enabled: false, trigger: 'both', service: '', targetLang: '' },
    cache: { maxAgeDay: 30, maxEntries: 2000 },
    urlPattern: { includedUrls: [], excludedUrls: [] },
    langPattern: { includedLangs: [], excludedLangs: [] },
    services: {
      'deepl-api': { genre: 'api-free', authKey: '', proxy: '', splitSentences: true },
      'openai': { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', temperature: 0.2, systemPrompt: '' },
      'claude':   { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest', apiKey: '', temperature: 0.2, maxTokens: 2048 },
      'gemini':   { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash', apiKey: '', temperature: 0.2 },
      'deepseek': { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', temperature: 0.2, systemPrompt: '' },
      'ollama':   { baseUrl: 'http://localhost:11434', model: 'llama3.1:8b', temperature: 0.2, systemPrompt: '' }
    },
    userRules: []
  };

  // 深合并：对象递归合并、数组整体替换、缺省键回填（协议 shared/defaults.js 定稿语义）
  TA.mergeDefaults = function (stored) {
    // 以默认值的深拷贝为底，避免修改 TA.DEFAULTS 本体
    var base = JSON.parse(JSON.stringify(TA.DEFAULTS));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
    mergeInto(base, stored);
    return base;
  };

  function mergeInto(target, src) {
    Object.keys(src).forEach(function (k) {
      var sv = src[k];
      if (sv === undefined) return;
      // 数组：整体替换，不做逐项合并
      if (Array.isArray(sv)) { target[k] = sv.slice(); return; }
      // 双方都是普通对象：递归深合并
      if (sv && typeof sv === 'object' && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        mergeInto(target[k], sv);
        return;
      }
      // 标量或类型不同：直接以存储值覆盖
      target[k] = sv;
    });
  }
})();
