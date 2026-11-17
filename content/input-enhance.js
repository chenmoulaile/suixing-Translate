// content/input-enhance.js —— 输入框三连空格翻译（招牌交互，v0.2 升级）
// 交互定义（协议 H 节 + threeInteractions C 节定稿）：
//   目标元素 = input[type=text|search|url|tel|email] / textarea / [contenteditable]
//   （排除 [type=password]、number 类、IME 组合态 isComposing）
//   gapMs（默认 200ms，options 可调 150–1000）内连续 3 次 Space 且其间无其他按键
//   → 第 3 次 preventDefault，解析斜杠命令后把待译内容作为单段文本走 TRANSLATE_BATCH 回填。
//
// 斜杠命令（threeInteractions 定稿）：
//   '/ja 你好'   → 仅翻译空格后的内容，目标语言 ja（码经 TA.TARGET_LANGS / TA.langmap 校验，
//                  非法码回落默认目标语言）
//   '//你好'     → 仅翻译 // 后的内容，目标 = 默认（容忍紧贴内容）；'// 你好' 同
//   '/etc/hosts' → 语言码后无空白，视为普通文本，整框直译（防误吃 URL 路径）
//   '/' 单杠无语言码 → 不是命令
//   替换时只替换命令后的部分（前缀原样保留在输入框内）。
//
// 回填与撤销（上一版评审结论：setRangeText 不进撤销栈，必须走 execCommand）：
//   input/textarea 用 select() + execCommand('insertText')（写入浏览器原生撤销栈，
//   Ctrl+Z 可撤销恢复原文）；execCommand 被拒绝时回退 setRangeText + 手动 input 事件。
//   contenteditable 用 selectAll + execCommand('insertText')。
//
// 撤销浮条（ta-input-toast）：回填成功后在输入框下方 fixed 显示 2.5s
//   "已翻译为 X · 撤销"，点撤销恢复原文并补发 input 事件；
//   译文与原文 trim 全等 → 浮条改提示 "译文与原文相同，请检查目标语言设置"（不替换）。
//
// CMD 'translate-input-box'（manifest commands，Alt+I 可绑定、无默认键）：
//   经 TA.features.cmds 注册，由 main.js 分发；翻译 document.activeElement（isTarget 校验）。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || !TA.util || TA.__inputEnhanceLoaded) {
    if (TA && !TA.__inputEnhanceLoaded && !TA.util) {
      console.error('[TA] content/input-enhance.js: 前置文件 content/core.js 未加载');
    }
    return;
  }
  TA.__inputEnhanceLoaded = true;

  var OK_INPUT_TYPES = ['text', 'search', 'url', 'tel', 'email'];
  // 语言码段（斜杠命令）：2–10 个小写字母，可带 - 变体后缀（threeInteractions 定稿正则）
  var LANG_CODE_RE = /^[a-z]{2,10}(?:-[A-Za-z]{2,8})?/;
  var TOAST_MS = 2500; // 撤销浮条显示时长（定稿 2.5s）
  var streak = { el: null, times: [] }; // 三连空格连击记录
  var busy = new WeakSet();             // 在译中的输入框（防重入）
  var seq = 0;                          // batchId 序号
  var currentSettings = null;
  var toast = null;                     // { root, msg, undoBtn, undo, timer }

  function isTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      var t = String(el.getAttribute('type') || 'text').toLowerCase();
      return OK_INPUT_TYPES.indexOf(t) !== -1;
    }
    return !!el.isContentEditable;
  }

  function reset() { streak = { el: null, times: [] }; }

  function onKeydown(e) {
    // IME 组合态（isComposing / keyCode 229）不触发
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== ' ') {
      // 其间出现其他按键 → 连击中断
      if (streak.times.length) reset();
      return;
    }
    var el = e.target;
    if (!isTarget(el)) return;
    var st = currentSettings;
    if (!st || !st.inputTranslate || !st.inputTranslate.enabled) return;
    // 间隔：默认 200ms（v0.2），options 可调 150–1000；运行时仅做合理性钳制
    var gap = Number(st.inputTranslate.gapMs);
    if (!isFinite(gap) || gap <= 0) gap = 200;
    gap = Math.min(Math.max(gap, 100), 2000);
    var now = Date.now();
    if (streak.el !== el) { streak = { el: el, times: [now] }; return; }
    var last = streak.times[streak.times.length - 1];
    if (now - last > gap) { streak.times = [now]; return; } // 间隔超时，重新起算
    streak.times.push(now);
    if (streak.times.length >= 3) {
      e.preventDefault(); // 第 3 个空格不落入输入框
      reset();
      translateField(el, st);
    }
  }

  /* ==================== 斜杠命令解析 ==================== */

  // 解析 '/lang 内容' 与 '//（空格?）内容' 前缀。
  // 返回 { prefix, lang, content }：prefix=原样保留的前缀文本；lang=规范语言码或 ''；
  // content=待译内容。无命令前缀返回 null。
  // 规则（threeInteractions 定稿 + 侦察示例）：
  //   '/ja 你好' → prefix='/ja '，lang='ja'；语言码后必须紧跟空白，否则视为普通文本；
  //   '//你好'   → prefix='//'，lang=''（容忍紧贴）；'// 你好' → prefix='// '；
  //   '/etc/hosts' → 'etc' 后无空白 → null（普通文本）；'/' 单杠无语言码 → null。
  function parseCmdPrefix(value) {
    var v = String(value == null ? '' : value);
    if (v.charAt(0) !== '/') return null;
    var markerLen = (v.charAt(1) === '/') ? 2 : 1; // '//' = 省略语言码命令
    var pos = markerLen;
    var m = LANG_CODE_RE.exec(v.slice(pos));
    if (m) {
      var after = v.slice(pos + m[0].length);
      // 语言码后必须紧跟空白（或恰好在结尾），否则视为普通文本
      if (after === '' || /^[ \t]/.test(after)) {
        var rest = after;
        var sp = /^[ \t]+/.exec(rest);
        var prefixLen = pos + m[0].length + (sp ? sp[0].length : 0);
        return { prefix: v.slice(0, prefixLen), lang: m[0], content: v.slice(prefixLen) };
      }
      return null; // '/etc/hosts' 等路径形态
    }
    // 无语言码：仅 '//' 是命令（容忍紧贴内容）；'/' 单杠不是命令
    if (markerLen === 2) {
      var content = v.slice(2).replace(/^[ \t]+/, '');
      return { prefix: v.slice(0, v.length - content.length), lang: '', content: content };
    }
    return null;
  }

  // 目标语言码校验：TA.TARGET_LANGS canonical 码优先，任一服务映射表收录亦可（langmap 校验）
  function isValidTargetLang(code) {
    var c = String(code || '');
    if (!c) return false;
    var langs = TA.TARGET_LANGS || [];
    for (var i = 0; i < langs.length; i++) {
      if (langs[i].code === c) return true;
    }
    if (TA.langmap) {
      var services = ['google', 'deepl-free', 'deepl-api', 'youdao', 'iflyrec', 'caiyun', 'edge', 'openai'];
      for (var j = 0; j < services.length; j++) {
        try { if (TA.langmap.supportsLang(services[j], c)) return true; } catch (e) { /* 忽略 */ }
      }
    }
    return false;
  }

  function langName(code) {
    var langs = TA.TARGET_LANGS || [];
    for (var i = 0; i < langs.length; i++) {
      if (langs[i].code === code) return langs[i].name;
    }
    return code;
  }

  /* ==================== 值回填（execCommand 进原生撤销栈） ==================== */

  // 补发 input 事件：站点自身监听可见变更（setRangeText 回退路径/撤销恢复共用）
  function fireInput(el) {
    try { el.dispatchEvent(new InputEvent('input', { bubbles: true })); }
    catch (e) { el.dispatchEvent(new Event('input', { bubbles: true })); }
  }

  // 把整个输入框内容替换为 nextValue（含原样保留的命令前缀）。
  // 主路径 execCommand('insertText')：写入浏览器原生撤销栈，Ctrl+Z 可恢复原文；
  // 仅当 execCommand 被拒绝时回退 setRangeText（程序化修改、不进撤销栈，补发 input 事件）。
  function replaceValue(el, isCE, nextValue) {
    el.focus();
    if (isCE) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, nextValue);
      return;
    }
    el.select();
    var replaced = false;
    try { replaced = document.execCommand('insertText', false, nextValue); }
    catch (e2) { replaced = false; }
    if (!replaced) {
      el.setRangeText(nextValue, 0, el.value.length, 'end');
      fireInput(el);
    }
  }

  /* ==================== 撤销浮条（ta-input-toast） ==================== */

  function hideToast() {
    if (!toast) return;
    if (toast.timer) clearTimeout(toast.timer);
    if (toast.root && toast.root.parentNode) toast.root.parentNode.removeChild(toast.root);
    toast = null;
  }

  function undoReplace() {
    var rec = toast && toast.undo;
    if (!rec) { hideToast(); return; }
    var el = rec.el;
    hideToast();
    if (!el || !el.isConnected) return;
    el.focus();
    var restored = false;
    if (rec.isCE) {
      try {
        document.execCommand('selectAll', false, null);
        restored = document.execCommand('insertText', false, rec.original);
      } catch (e) { restored = false; }
    } else {
      try { el.select(); restored = document.execCommand('insertText', false, rec.original); }
      catch (e2) { restored = false; }
      if (!restored) {
        try { el.setRangeText(rec.original, 0, el.value.length, 'end'); fireInput(el); }
        catch (e3) { try { el.value = rec.original; fireInput(el); } catch (e4) { /* 放弃 */ } }
      }
    }
    if (restored) fireInput(el);
  }

  // 浮条：kind='ok' → "已翻译为 X · 撤销"；kind='same' → 译文=原文提示（无撤销钮）
  function showToast(el, opts) {
    hideToast();
    var root = document.createElement('div');
    root.className = 'ta-input-toast';
    root.setAttribute('translate', 'no');
    root.classList.add('notranslate');
    var msg = document.createElement('span');
    msg.className = 'ta-input-toast-msg';
    root.appendChild(msg);
    if (opts && opts.kind === 'ok') {
      msg.textContent = '已翻译为 ' + (opts.targetName || '');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ta-input-toast-undo';
      btn.textContent = '撤销';
      btn.addEventListener('click', undoReplace);
      root.appendChild(btn);
    } else {
      msg.textContent = (opts && opts.kind === 'same')
        ? '译文与原文相同，请检查目标语言设置'
        : '';
    }
    (document.documentElement || document.body).appendChild(root);
    // 定位：输入框正下方（getBoundingClientRect + fixed），越界钳制在视口内
    var rect = el.getBoundingClientRect();
    var w = root.offsetWidth;
    var h = root.offsetHeight;
    var left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - w - 8));
    var top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    root.style.left = Math.round(left) + 'px';
    root.style.top = Math.round(top) + 'px';
    toast = {
      root: root,
      undo: (opts && opts.undo) || null,
      timer: setTimeout(hideToast, TOAST_MS)
    };
  }

  /* ==================== 翻译主流程 ==================== */

  // 单段翻译：texts 长度 1；service=null 走后台降级链
  function translateField(el, st) {
    if (busy.has(el)) return;
    var isCE = !!el.isContentEditable;
    var raw = isCE ? (el.innerText || '') : String(el.value == null ? '' : el.value);
    var full = TA.util.stripControlChars(raw);
    // 斜杠命令解析：'/ja 你好' / '//你好' → 仅命令后内容；无前缀 → 整框
    var cmd = parseCmdPrefix(full);
    var prefix = cmd ? cmd.prefix : '';
    var content = (cmd ? cmd.content : full).trim();
    if (!content) return;
    var targetLang = (st && st.targetLang) || 'zh-CN';
    if (cmd && cmd.lang && isValidTargetLang(cmd.lang)) targetLang = cmd.lang;
    // 非法语言码 → 回落默认目标语言（仍按命令处理，仅替换命令后内容）

    busy.add(el);
    seq += 1;
    var req = {
      type: 'TRANSLATE_BATCH',
      requestId: TA.util.genId(),
      batchId: Date.now().toString(36) + '-in' + seq,
      texts: [content],
      targetLang: targetLang,
      sourceLang: 'auto',
      service: null
    };
    chrome.runtime.sendMessage(req)
      .then(function (res) {
        var t = res && res.ok && res.translations && res.translations[0];
        if (typeof t !== 'string' || !t) return; // 失败：保持原值不动
        if (content === t.trim()) {
          // 译文与原文全等：提示检查目标语言设置，不替换
          showToast(el, { kind: 'same' });
          return;
        }
        // 前缀原样保留：仅替换命令后的部分（回填值为 前缀+译文）
        replaceValue(el, isCE, prefix + t);
        showToast(el, {
          kind: 'ok',
          targetName: langName(targetLang),
          undo: { el: el, original: raw, isCE: isCE }
        });
      })
      .catch(function (err) {
        console.warn('[TA] 输入框翻译失败，保持原文', err);
      })
      .then(function () { busy.delete(el); });
  }

  // CMD 'translate-input-box'：翻译当前聚焦输入框（isTarget 校验）
  function translateActiveField() {
    var el = document.activeElement;
    if (!isTarget(el)) return;
    var st = currentSettings;
    if (st) { translateField(el, st); return; }
    if (typeof TA.getSettings === 'function') {
      TA.getSettings().then(function (s) { translateField(el, s); })
        .catch(function () { /* 忽略 */ });
    }
  }

  document.addEventListener('keydown', onKeydown, true);

  /* ==================== 注册表挂载 ==================== */

  // 注册到 TA.features（core.js 注册表）：CMD 'translate-input-box' 由 main.js
  // 分发（未知 CMD 名遍历 features.cmds）；messages 为空（不新增 content 消息类型）。
  TA.features.register({
    name: 'input',
    init: function (settings) { currentSettings = settings; },
    onSettingsChanged: function (s) { currentSettings = s; },
    messages: {},
    cmds: { 'translate-input-box': translateActiveField }
  });

  // 设置预热与变更同步（keydown 内只读缓存，避免异步等待）。
  // 注册表未由 main.js 驱动时（v0.1 骨架联调期）本段仍保证功能可用。
  if (typeof TA.getSettings === 'function') {
    TA.getSettings().then(function (s) { currentSettings = s; }).catch(function () { /* 忽略 */ });
  }
  if (typeof TA.onSettingsChanged === 'function') {
    TA.onSettingsChanged(function (s) { currentSettings = s; });
  }
})();
