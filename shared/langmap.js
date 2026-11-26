// shared/langmap.js —— 每服务目标语言映射表 + supportsLang/mapLang
// 映射表严格照侦察 atcoder better.txt 471-480 行 translationSupport 定稿：
//   deepl 系 zh→ZH 大写系；youdao zh-CN→zh-CHS / zh-TW→zh-CHT；
//   google zh-CN→zh-CN / zh-TW→zh-TW；caiyun 仅五种 auto2xx；
//   edge zh-CN→zh-Hans / zh-TW→zh-Hant；openai 用语言英文名；iflyrec 仅 zh→'1'。
(function () {
  'use strict';
  var TA = globalThis.TA = globalThis.TA || {};

  // canonical 目标语言 → 各服务语言码（不在表内 = 该服务不支持该语言，supportsLang 返回 false）
  var TABLES = {
    // 侦察 476 行：zh→zh-CN、zh-Hant→zh-TW、其余小写码；11 种 canonical 全支持
    'google': {
      'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', 'en': 'en', 'ja': 'ja', 'ko': 'ko',
      'de': 'de', 'fr': 'fr', 'es': 'es', 'pt': 'pt', 'it': 'it', 'hi': 'hi'
    },
    // 侦察 473 行：zh→ZH、de/fr/ko/pt/ja/es/it 大写码；zh-TW 与 hi 不在表内（不支持，触发降级）
    'deepl-free': {
      'zh-CN': 'ZH', 'de': 'DE', 'fr': 'FR', 'ko': 'KO', 'pt': 'PT', 'ja': 'JA', 'es': 'ES', 'it': 'IT'
    },
    // 官方 API 与 oneshot 共用同一大写码表（deepl_api 请求体 target_lang 用大写）
    'deepl-api': {
      'zh-CN': 'ZH', 'de': 'DE', 'fr': 'FR', 'ko': 'KO', 'pt': 'PT', 'ja': 'JA', 'es': 'ES', 'it': 'IT'
    },
    // 侦察 475 行：zh→zh-CHS、zh-Hant→zh-CHT、其余小写码；11 种全支持
    'youdao': {
      'zh-CN': 'zh-CHS', 'zh-TW': 'zh-CHT', 'en': 'en', 'ja': 'ja', 'ko': 'ko',
      'de': 'de', 'fr': 'fr', 'es': 'es', 'pt': 'pt', 'it': 'it', 'hi': 'hi'
    },
    // 侦察 474 行：仅 zh→'1'，即只支持译入简体中文
    'iflyrec': {
      'zh-CN': '1'
    },
    // 侦察 477 行：仅 auto2zh/auto2ja/auto2ko/auto2es/auto2fr；zh-CN 与 zh-TW 都映射 auto2zh（协议定稿）
    'caiyun': {
      'zh-CN': 'auto2zh', 'zh-TW': 'auto2zh', 'ja': 'auto2ja', 'ko': 'auto2ko', 'es': 'auto2es', 'fr': 'auto2fr'
    },
    // 侦察 478 行：zh→zh-Hans、zh-Hant→zh-Hant、其余小写码；11 种全支持
    'edge': {
      'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'en': 'en', 'ja': 'ja', 'ko': 'ko',
      'de': 'de', 'fr': 'fr', 'es': 'es', 'pt': 'pt', 'it': 'it', 'hi': 'hi'
    },
    // 侦察 479 行：openai 的值是语言英文名而非语言码，直接嵌入 prompt；11 种全支持
    'openai': {
      'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English',
      'ja': 'Japanese', 'ko': 'Korean', 'de': 'German', 'fr': 'French',
      'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian', 'hi': 'Hindi'
    },
    // claude/gemini/deepseek/ollama 与 openai 同样把语言英文名嵌入 prompt；
    // 各适配器另有 supportsLang 实现，此处仅为保持 langmap 一致供测试/工具使用。
    'claude': {
      'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English',
      'ja': 'Japanese', 'ko': 'Korean', 'de': 'German', 'fr': 'French',
      'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian', 'hi': 'Hindi'
    },
    'gemini': {
      'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English',
      'ja': 'Japanese', 'ko': 'Korean', 'de': 'German', 'fr': 'French',
      'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian', 'hi': 'Hindi'
    },
    'deepseek': {
      'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English',
      'ja': 'Japanese', 'ko': 'Korean', 'de': 'German', 'fr': 'French',
      'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian', 'hi': 'Hindi'
    },
    // DeepSeek Harness 免费（dsh-free）：照 openai/deepseek 的语言英文名嵌入 prompt；11 种全支持
    'dsh-free': {
      'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English',
      'ja': 'Japanese', 'ko': 'Korean', 'de': 'German', 'fr': 'French',
      'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian', 'hi': 'Hindi'
    },
    'ollama': {
      'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese', 'en': 'English',
      'ja': 'Japanese', 'ko': 'Korean', 'de': 'German', 'fr': 'French',
      'es': 'Spanish', 'pt': 'Portuguese', 'it': 'Italian', 'hi': 'Hindi'
    }
  };

  TA.langmap = {
    // canonical → 服务语言码；不支持或未知服务返回 null
    mapLang: function (service, lang) {
      var t = TABLES[service];
      if (!t) return null;
      var v = t[lang];
      return v === undefined ? null : v;
    },
    // 该服务是否支持该 canonical 目标语言
    supportsLang: function (service, lang) {
      return TA.langmap.mapLang(service, lang) !== null;
    }
  };
})();
