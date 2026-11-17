// content/dictionary.js —— AI 词典卡（划词气泡内的富卡，D 所有）
// 挂载协议：TA.features.register({name:'dictionary', init, onSettingsChanged,
//   messages:{'DICTIONARY_LOOKUP'}, cmds:{}}) —— 与 core.js 注册表 / main.js 调度一致。
// 公共 API：
//   TA.dictionary.lookup(text, targetLang) → Promise<card|null>
//     card = {word, phonetic, pos, meaning, examples:[{foreign,translated}], lang, raw}
//   TA.dictionary.render(card) → HTMLElement（class="ta-dict-card"）
//   TA.dictionary.speak(text, lang?) —— speechSynthesis 本地 TTS
// 数据源：复用 TA.pipeline.translateText 走 AI 翻译引擎做结构化 JSON 输出；
//   机器翻译链返回的非 JSON 内容会优雅降级（lookup → null，由调用方回退纯译文）。
// 设置（settings.dictionary，缺省键防御回填；defaults/options 由他人补齐）：
//   enabled:boolean（默认 false） service:''|openai|claude|gemini|deepseek|ollama
//   showExamples:boolean（默认 true） autoSpeak:boolean（默认 false）
// 设计约束：任何异常都不得抛出到宿主；统一 console.debug('[TA][dict]', ...)。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || TA.__dictionaryLoaded) return;
  TA.__dictionaryLoaded = true;

  /* ==================== 常量 ==================== */

  var LOG = '[TA][dict]';
  var DICT_PROMPT = 'You are a bilingual dictionary. For the given word/phrase, ' +
    'output ONLY a JSON object (no markdown) with keys: word, phonetic (IPA or reading), ' +
    'pos (part of speech), meaning (concise Chinese explanation), ' +
    'examples (array of 2 objects {foreign, translated}), lang (BCP-47 of the source language).';
  var SPEAK_LANG = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU' };

  /* ==================== 状态 ==================== */

  var settings = null;        // 最近一次设置（init / onSettingsChanged / getSettings 回填）
  var currentCfg = null;      // 由 settings 计算的词典配置快照
  var cache = new Map();      // key = 小写 text + targetLang → card（含失败则不缓存）

  /* ==================== 配置读取（缺省键防御） ==================== */

  function dictCfg(s) {
    var c = (s && s.dictionary) || {};
    return {
      enabled: !!c.enabled,
      service: c.service || '',
      showExamples: c.showExamples !== false,   // 缺省 true
      autoSpeak: !!c.autoSpeak
    };
  }

  // 优先用已同步的配置快照；否则从 core.js 的设置缓存兜底读取
  function cfgNow() {
    if (currentCfg) return currentCfg;
    var s = null;
    try { s = (typeof TA.getCachedSettings === 'function') ? TA.getCachedSettings() : null; }
    catch (e) { s = null; }
    return dictCfg(s);
  }

  function cacheKey(text, targetLang) {
    return String(text || '').toLowerCase() + '\u0000' + (targetLang || '');
  }

  /* ==================== JSON 解析（robust） ==================== */

  function parseCard(text) {
    if (typeof text !== 'string') return null;
    var s = text;
    // 去 ```json ... ``` / ``` ... ``` 代码围栏
    var fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence && fence[1]) s = fence[1];
    var a = s.indexOf('{');
    var b = s.lastIndexOf('}');
    if (a === -1 || b === -1 || b <= a) return null;
    var obj = null;
    try { obj = JSON.parse(s.slice(a, b + 1)); }
    catch (e) { console.debug(LOG, 'JSON.parse 失败', e); return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    var card = {
      word: typeof obj.word === 'string' ? obj.word : '',
      phonetic: typeof obj.phonetic === 'string' ? obj.phonetic : '',
      pos: typeof obj.pos === 'string' ? obj.pos : '',
      meaning: typeof obj.meaning === 'string' ? obj.meaning : '',
      examples: [],
      lang: typeof obj.lang === 'string' ? obj.lang : '',
      raw: obj
    };
    if (Array.isArray(obj.examples)) {
      for (var i = 0; i < obj.examples.length; i++) {
        var ex = obj.examples[i];
        if (ex && typeof ex === 'object') {
          card.examples.push({
            foreign: typeof ex.foreign === 'string' ? ex.foreign : '',
            translated: typeof ex.translated === 'string' ? ex.translated : ''
          });
        }
      }
    }
    if (!card.word) card.word = String(text || '').trim();
    return card;
  }

  /* ==================== 公共 API：lookup ==================== */

  function lookup(text, targetLang) {
    try {
      var t = String(text == null ? '' : text).trim();
      if (!t) return Promise.resolve(null);
      var cfg = cfgNow();
      var lang = targetLang || (settings && settings.targetLang) || 'zh-CN';
      var key = cacheKey(t, lang);
      if (cache.has(key)) {
        console.debug(LOG, 'cache hit', key);
        return Promise.resolve(cache.get(key));
      }
      if (!TA.pipeline || typeof TA.pipeline.translateText !== 'function') {
        console.debug(LOG, 'pipeline.translateText 不可用');
        return Promise.resolve(null);
      }
      // 用"翻译任务"包装：把 JSON 指令放在用户文本内（translateText 自带译文导向
      // 的 system prompt）。AI 服务可返回结构化 JSON；机器翻译链则解析失败 → null。
      var input = 'Dictionary task. Output JSON only.\n' + DICT_PROMPT + '\n\nWORD: ' + t;
      var p = TA.pipeline.translateText(input, {
        service: cfg.service || undefined,
        targetLang: targetLang || undefined
      });
      if (!p || typeof p.then !== 'function') return Promise.resolve(null);
      return p.then(function (out) {
        var card = parseCard(out);
        if (card) cache.set(key, card);   // 仅缓存成功结果，失败不缓存以便后续重试
        return card || null;
      }).catch(function (e) {
        console.debug(LOG, 'lookup 失败', e);
        return null;
      });
    } catch (e) {
      console.debug(LOG, 'lookup 异常', e);
      return Promise.resolve(null);
    }
  }

  /* ==================== 公共 API：speak / render ==================== */

  function detectSpeakLang(text) {
    var det = null;
    try {
      det = (TA.lang && typeof TA.lang.detectParagraphLang === 'function')
        ? TA.lang.detectParagraphLang(String(text || '')) : null;
    } catch (e) { det = null; }
    return (det && SPEAK_LANG[det]) || '';
  }

  function speak(text, lang) {
    if (!text) return;
    try {
      if (!window.speechSynthesis || typeof SpeechSynthesisUtterance !== 'function') return;
      var u = new SpeechSynthesisUtterance(String(text));
      u.lang = lang || detectSpeakLang(text) || 'en-US';
      u.rate = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {
      console.debug(LOG, 'speak 失败', e);
    }
  }

  // 由 card 生成富卡 DOM；全部 textContent 回填，不解析 HTML。
  function render(card) {
    var cfg = cfgNow();
    var el = document.createElement('div');
    el.className = 'ta-dict-card';
    el.setAttribute('translate', 'no');
    el.classList.add('notranslate');

    // header：word（粗大）+ phonetic（弱）+ pos 徽标 + 🔊 按钮
    var head = document.createElement('div');
    head.className = 'ta-dict-head';

    var wordSpan = document.createElement('span');
    wordSpan.className = 'ta-dict-word';
    wordSpan.textContent = (card && card.word) || '';
    head.appendChild(wordSpan);

    if (card && card.phonetic) {
      var ph = document.createElement('span');
      ph.className = 'ta-dict-phonetic';
      ph.textContent = card.phonetic;
      head.appendChild(ph);
    }
    if (card && card.pos) {
      var pos = document.createElement('span');
      pos.className = 'ta-dict-pos';
      pos.textContent = card.pos;
      head.appendChild(pos);
    }
    var speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'ta-dict-speak';
    speakBtn.setAttribute('aria-label', '朗读');
    speakBtn.title = '朗读';
    speakBtn.textContent = '🔊';
    speakBtn.addEventListener('click', function (ev) {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      speak((card && card.word) || '', card && card.lang);
    });
    head.appendChild(speakBtn);
    el.appendChild(head);

    // 中文释义
    if (card && card.meaning) {
      var mean = document.createElement('div');
      mean.className = 'ta-dict-meaning';
      mean.textContent = card.meaning;
      el.appendChild(mean);
    }

    // 例句：每例两行（外文斜体 / 中文译文弱显），showExamples=false 时不渲染
    if (cfg.showExamples && card && Array.isArray(card.examples) && card.examples.length) {
      var exWrap = document.createElement('div');
      exWrap.className = 'ta-dict-examples';
      for (var i = 0; i < card.examples.length; i++) {
        var ex = card.examples[i] || {};
        var row = document.createElement('div');
        row.className = 'ta-dict-ex';
        var foreign = document.createElement('div');
        foreign.className = 'ta-dict-ex-foreign';
        foreign.textContent = ex.foreign || '';
        var translated = document.createElement('div');
        translated.className = 'ta-dict-ex-translated';
        translated.textContent = ex.translated || '';
        row.appendChild(foreign);
        row.appendChild(translated);
        exWrap.appendChild(row);
      }
      el.appendChild(exWrap);
    }

    // 设置开启时进入气泡即朗读一次（默认 false）
    if (cfg.autoSpeak && card && card.word) speak(card.word, card.lang);
    return el;
  }

  /* ==================== 生命周期 / features 挂载 ==================== */

  function init(s) {
    settings = s || settings;
    currentCfg = dictCfg(settings);
  }

  function onSettingsChanged(s) {
    settings = s;
    var next = dictCfg(s);
    // service 变更 → 旧结果可能来自不同引擎，清空缓存
    if (currentCfg && currentCfg.service !== next.service) cache.clear();
    currentCfg = next;
  }

  function registerFeature() {
    if (!TA.features || typeof TA.features.register !== 'function') return;
    try {
      TA.features.register({
        name: 'dictionary',
        init: init,
        onSettingsChanged: onSettingsChanged,
        messages: {
          'DICTIONARY_LOOKUP': function (msg) {
            var m = msg || {};
            return lookup(m.text, m.targetLang).then(function (card) {
              return { ok: !!card, card: card || null };
            }).catch(function (e) {
              return {
                ok: false,
                card: null,
                error: { code: 'INTERNAL', message: String((e && e.message) || e) }
              };
            });
          }
        },
        cmds: {}
      });
    } catch (e) {
      console.warn(LOG, '注册 TA.features 失败（以独立模式运行）', e);
    }
  }

  /* ==================== 公共命名空间 / 启动 ==================== */

  TA.dictionary = {
    lookup: lookup,
    render: render,
    speak: speak
  };

  registerFeature();
  if (typeof TA.getSettings === 'function') {
    TA.getSettings().then(function (s) { init(s); })
      .catch(function () { currentCfg = dictCfg(null); });
  } else {
    currentCfg = dictCfg(null);
  }
})();
