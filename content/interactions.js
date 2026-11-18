// content/interactions.js —— 交互三件套之悬停翻译 + 划词翻译（v0.2 需求 9）
// 挂载方式（接口冻结）：TA.features.register（core.js 注册表；main.js 统一 init 与分发）。
// 注册表就绪时仍立即自初始化一次（init 幂等），保证在 A 的 main.js 联调前后均可独立工作。
// 依赖（v0.2 设计 threeInteractions 节冻结的签名）：
//   TA.pipeline.translateUnits(units, settings) → Promise<{done,total}>     —— 可缺省（降级直发）
//   TA.pipeline.translateText(text, {service,targetLang}) → Promise<string> —— 可缺省（降级直发）
//   TA.walker.BLOCK_SEL / makeCtx / buildUnit（walker 排除管线与单元构建复用）
//   TA.injector.injectLoading / applyTranslation / setError / restoreUnit
//   TA.rules.resolve / matchUrlPattern；TA.lang.detectParagraphLang；TA.errorText
//
// 【A. 悬停翻译】settings.hoverTranslate
//   enabled 默认 false；trigger 三档：
//     holdKey（默认）——按住 holdKey（ctrl|alt|shift|meta，默认 ctrl）悬停触发；
//       再按住同键悬停已翻译段 → 还原（官方"翻译/还原该段"语义）
//     pressHold —— mousedown 起计时 pressHoldMs（默认 800ms）内位移 <6px 且无按键 → 触发
//     hover —— 纯悬停 300ms 防抖（elementFromPoint 复核防扫过误触）
//   译文形态：内嵌双语对照（走 injector.injectLoading，与本轮排版修复一致，
//   译文出现在该段原文正下方）；块宿主文本 >1500 字符时降级为"悬停处的行内单元"
//   （unit.el 为行内宿主 → injector 行内形态 data-ta-inline，A 的 injector 接管还原）。
//   快捷键 toggleMouseHoverTranslateDirectly 不做（临时会话态，范围外）。
//
// 【B. 划词翻译】settings.selection
//   enabled 默认 false（仅桌面端，无 UA 嗅探，移动端行为不做）；trigger 三档：
//     mini（默认，选区右下 12px 小圆点）| icon（32px logo 圆钮）| direct（mouseup 即弹）
//   triggerAction 二级 hover|click（默认 hover，仅 mini/icon 生效）。
//   气泡卡：复制 / 发音（speechSynthesis 本地 TTS）/ 重试 / ⋯三档禁用（本次·本站·永久）/
//   固定 / 关闭；整句仅译文、单词可回显原文（showOriginal 切换持久化）。
//   AI 词典卡/音标/例句不做（无 LLM 结构化输出通道，范围外）。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || !TA.util || TA.__interactionsLoaded) {
    if (TA && !TA.__interactionsLoaded && !TA.util) {
      console.error('[TA] content/interactions.js: 前置文件 content/core.js 未加载');
    }
    return;
  }
  TA.__interactionsLoaded = true;

  /* ==================== 常量 ==================== */

  var HOVER_TRIGGERS = ['holdKey', 'pressHold', 'hover'];
  var HOLD_KEYS = { ctrl: 'control', alt: 'alt', shift: 'shift', meta: 'meta' };
  var SEL_TRIGGERS = ['mini', 'icon', 'direct'];
  var SEL_ACTIONS = ['hover', 'click'];
  // 悬停降级阈值：块宿主文本超长时改为行内单元（threeInteractions 定稿 1500）
  var INLINE_MAX_CHARS = 1500;
  var HOVER_DEBOUNCE_MS = 300;    // hover 档防扫过误触
  var HOVER_COOLDOWN_MS = 800;    // 同一元素翻译/还原双向冷却（防 mouseover 风暴振荡）
  var SEL_DEBOUNCE_MS = 150;      // selectionchange 防抖
  var UI_CLICK_GRACE_MS = 400;    // 气泡内点击后短暂忽略 selectionchange（防复制按钮触发收起）
  // 源语言检测码 → speechSynthesis BCP47
  var SPEAK_LANG = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU' };
  var DET_LABEL = { en: 'EN', zh: 'ZH', ja: 'JA', ko: 'KO', ru: 'RU' };
  // 本模块自产 UI（悬停/划词不作用于其上，也不被主翻译管线收集）
  var OWN_UI_SEL = '.ta-sel-bubble, .ta-sel-dot, .ta-sel-icon, .ta-float-ball, .ta-input-toast';

  /* ==================== 配置读取（缺省键防御回填） ==================== */

  function cfgHover(s) {
    var h = (s && s.hoverTranslate) || {};
    var ms = Number(h.pressHoldMs);
    if (!isFinite(ms) || ms <= 0) ms = 800;
    return {
      enabled: !!h.enabled,
      // 不存在"纯悬停"触发：即便设置里残留 trigger:'hover'，也强制回落到 holdKey，
      // 保证任何翻译都必须有修饰键物理按住，杜绝无修饰键的随机悬停翻译。
      trigger: h.trigger === 'hover' ? 'holdKey'
        : (HOVER_TRIGGERS.indexOf(h.trigger) !== -1 ? h.trigger : 'holdKey'),
      holdKey: HOLD_KEYS[h.holdKey] ? h.holdKey : 'ctrl',
      pressHoldMs: Math.min(Math.max(ms, 200), 3000)
    };
  }

  function cfgSel(s) {
    var c = (s && s.selection) || {};
    return {
      enabled: !!c.enabled,
      trigger: SEL_TRIGGERS.indexOf(c.trigger) !== -1 ? c.trigger : 'mini',
      triggerAction: SEL_ACTIONS.indexOf(c.triggerAction) !== -1 ? c.triggerAction : 'hover',
      showOriginal: c.showOriginal !== false,          // 缺省 true
      service: c.service || null,                      // '' = 走默认降级链
      disabledSites: Array.isArray(c.disabledSites) ? c.disabledSites : []
    };
  }

  function minTextCount(s) {
    var t = (s && s.thresholds) || {};
    return typeof t.paragraphMinTextCount === 'number' ? t.paragraphMinTextCount : 4;
  }

  function targetLangName() {
    var code = (currentSettings && currentSettings.targetLang) || 'zh-CN';
    var langs = TA.TARGET_LANGS || [];
    for (var i = 0; i < langs.length; i++) {
      if (langs[i].code === code) return langs[i].name;
    }
    return code;
  }

  function clampNum(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  /* ==================== 翻译通道（管线优先，缺省降级直发） ==================== */

  var directSeq = 0;

  // 单段直译（划词/输入框复用形状）；失败 reject {code, message}
  function translateTextChannel(text, opts) {
    if (TA.pipeline && typeof TA.pipeline.translateText === 'function') {
      try {
        var p = TA.pipeline.translateText(text, {
          service: opts.service || null,
          targetLang: opts.targetLang || 'zh-CN'
        });
        if (p && typeof p.then === 'function') return p;
      } catch (e) { /* 管线异常 → 落入降级通道 */ }
    }
    directSeq += 1;
    return chrome.runtime.sendMessage({
      type: 'TRANSLATE_BATCH',
      requestId: TA.util.genId(),
      batchId: Date.now().toString(36) + '-sel' + directSeq,
      texts: [text],
      targetLang: opts.targetLang || 'zh-CN',
      sourceLang: 'auto',
      service: opts.service || null   // 划词显式 service 时沿用"不降级"语义
    }).then(function (res) {
      if (res && res.ok && res.translations &&
          typeof res.translations[0] === 'string' && res.translations[0]) {
        return res.translations[0];
      }
      throw (res && res.error) || { code: 'UNKNOWN' };
    });
  }

  // 标准单元翻译（悬停块级/行内形态）：pipeline.translateUnits 优先（复用主流程
  // 去重/分包/缓存），未交付时降级为单段直发 + injector 回填。
  function translateUnitChannel(unit, settings) {
    if (TA.pipeline && typeof TA.pipeline.translateUnits === 'function') {
      try {
        var p = TA.pipeline.translateUnits([unit], settings);
        if (p && typeof p.then === 'function') return p;
      } catch (e) { /* 落入降级通道 */ }
    }
    directSeq += 1;
    return chrome.runtime.sendMessage({
      type: 'TRANSLATE_BATCH',
      requestId: TA.util.genId(),
      batchId: Date.now().toString(36) + '-hov' + directSeq,
      texts: [unit.text],
      targetLang: (settings && settings.targetLang) || 'zh-CN',
      sourceLang: 'auto',
      service: null
    }).then(function (res) {
      if (res && res.ok && res.translations &&
          typeof res.translations[0] === 'string' && res.translations[0]) {
        TA.injector.applyTranslation(unit, res.translations[0]);
      } else {
        TA.injector.setError(unit, (res && res.error) || { code: 'UNKNOWN' });
      }
    });
  }

  /* ==================== 悬停翻译：状态与公共判定 ==================== */

  var currentSettings = null;
  var listenersBound = false;
  var hover = {
    holdDown: false,       // holdKey 按住态（keydown/keyup 记录，blur 清除）
    press: null,           // pressHold 跟踪 {el, hit, x, y, timer}
    pending: null,         // hover 档挂起任务 {el, hit, timer}
    lastMouse: { x: 0, y: 0 }
  };
  var hoverBusy = new WeakSet();   // 在译中的元素（防重入）
  var actionAt = new WeakMap();    // 元素 → 上次触发时间戳（翻译/还原双向冷却）

  function inCooldown(el) {
    var t = actionAt.get(el);
    return typeof t === 'number' && (Date.now() - t) < HOVER_COOLDOWN_MS;
  }

  function touchCooldown(el) {
    actionAt.set(el, Date.now());
  }

  // 悬停排除上下文：悬停是显式手动动作，仅应用硬排除清单 + 站点规则，
  // 不套 SMART 正文排除（否则导航栏文字无法悬停翻译）
  function hoverCtx(settings) {
    return TA.walker.makeCtx({
      scope: 'full',
      rules: TA.rules.resolve(location.href, settings)
    });
  }

  // 沿父链排除判定（walker 的 isExcluded 不在公共接口上，此处按同语义复刻）
  function excludedDeep(el, exclSel) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      try { if (n.matches(exclSel)) return true; } catch (e) { /* 异常视为未命中 */ }
    }
    return false;
  }

  function markCandidate(el) {
    try { el.classList.add('ta-hover-candidate'); } catch (e) { /* 忽略 */ }
  }

  function unmarkCandidate(el) {
    try { el.classList.remove('ta-hover-candidate'); } catch (e) { /* 忽略 */ }
  }

  function clearAllCandidates() {
    var els = document.querySelectorAll('.ta-hover-candidate');
    for (var i = 0; i < els.length; i++) unmarkCandidate(els[i]);
  }

  function cancelPending() {
    if (hover.pending) {
      clearTimeout(hover.pending.timer);
      unmarkCandidate(hover.pending.el);
      hover.pending = null;
    }
  }

  function cancelPress() {
    if (hover.press) {
      clearTimeout(hover.press.timer);
      unmarkCandidate(hover.press.el);
      hover.press = null;
    }
  }

  function selectionActive() {
    try {
      var s = window.getSelection();
      return !!(s && !s.isCollapsed && s.rangeCount > 0);
    } catch (e) { return false; }
  }

  // 从命中点向上找第一个行内元素宿主（不越过块宿主 el）
  function inlineHostAt(node, blockEl) {
    for (var n = node; n && n.nodeType === 1 && n !== blockEl; n = n.parentElement) {
      var d = '';
      try { d = String(getComputedStyle(n).display || ''); } catch (e) { d = ''; }
      if (d === 'inline' || d === 'inline-block') return n;
    }
    return null;
  }

  // 悬停目标判定：
  //   {kind:'inline', el}   —— 悬停点落在行内形态 wrapper（data-ta-inline）内 → 还原宿主单元
  //   {kind:'translated', el} —— 已带 data-ta（含祖先）→ toggle 还原
  //   {kind:'fresh', el, unit} —— 可翻译新段（unit 已构建）
  //   null —— 无效目标
  function resolveHoverTarget(node, settings, x, y) {
    if (!node || node.nodeType !== 1 || typeof node.closest !== 'function') return null;
    if (node.closest(OWN_UI_SEL)) return null;

    // 行内形态 wrapper：span 不在 BLOCK_SEL 内，须先行识别（还原其宿主单元）
    var inlineWrap = node.closest('.ta-target-wrapper[data-ta-inline="1"]');
    if (inlineWrap) {
      var host = inlineWrap.closest('[data-ta]');
      if (host) return { kind: 'translated', el: host };
      return null;
    }

    var el = node.closest(TA.walker.BLOCK_SEL);
    if (!el) return null;

    // 已翻译段（自身或祖先已带标记）：Ctrl 悬停 → 还原
    var marked = el.closest('[data-ta]');
    if (marked) return { kind: 'translated', el: marked };

    var ctx = hoverCtx(settings);
    if (excludedDeep(el, ctx.exclSel)) return null;

    var built = null;
    try {
      built = TA.walker.buildUnit(el, { scope: 'full', rules: ctx.rules, forced: false });
    } catch (e) { return null; }
    var text = built && built.text;
    if (!text || text.length < minTextCount(settings)) return null;

    // 块宿主超长 → 降级为"悬停处的行内单元"（injector 行内形态接管注入与还原）
    if (text.length > INLINE_MAX_CHARS) {
      var ihost = inlineHostAt(node, el);
      if (!ihost) return null; // 悬停在块直属文本上且无行内宿主：放弃（保持 DOM/hash 稳定）
      try {
        built = TA.walker.buildUnit(ihost, { scope: 'full', rules: ctx.rules, forced: true });
      } catch (e2) { return null; }
      if (!built.text || built.text.length < minTextCount(settings)) return null;
      return { kind: 'fresh', el: ihost, unit: built };
    }
    return { kind: 'fresh', el: el, unit: built };
  }

  /* ==================== 悬停翻译：触发与还原 ==================== */

  function restoreHoverTarget(hit) {
    if (!hit || !hit.el || !hit.el.isConnected || inCooldown(hit.el)) return;
    try { TA.injector.restoreUnit(hit.el); } catch (e) { /* 忽略 */ }
    touchCooldown(hit.el);
  }

  function startFreshTranslate(hit, settings) {
    var el = hit.el;
    if (!el || !el.isConnected || inCooldown(el) || hoverBusy.has(el)) return;
    var ok = false;
    try { ok = TA.injector.injectLoading(hit.unit, settings); } catch (e) { ok = false; }
    if (!ok) return; // 已有 wrapper / 不可注入
    hoverBusy.add(el);
    unmarkCandidate(el);
    touchCooldown(el);
    translateUnitChannel(hit.unit, settings)
      .catch(function (err) {
        try {
          TA.injector.setError(hit.unit, (err && err.code) ? err : { code: 'UNKNOWN' });
        } catch (e2) { /* 忽略 */ }
      })
      .then(function () { hoverBusy.delete(el); });
  }

  // 统一入口：holdKey 立即触发 / pressHold 定时触发 / hover 防抖触发共用
  function actOnTarget(hit, settings) {
    if (!hit) return;
    if (hit.kind === 'translated') { restoreHoverTarget(hit); return; }
    startFreshTranslate(hit, settings);
  }

  /* ==================== 悬停翻译：事件处理 ==================== */

  function onMouseOver(e) {
    var cfg = cfgHover(currentSettings);
    if (!cfg.enabled || cfg.trigger !== 'holdKey') return;
    if (!modifierOn(e, cfg.holdKey)) return;   // 修饰键必须在 mouse 事件上物理按住
    if (selectionActive()) return;   // 拖选过程中不触发
    var hit = null;
    try { hit = resolveHoverTarget(e.target, currentSettings, e.clientX, e.clientY); } catch (e2) { hit = null; }
    if (!hit) { clearAllCandidates(); return; }
    if (hit.kind === 'fresh') markCandidate(hit.el);
    actOnTarget(hit, currentSettings); // holdKey 档：悬停即触发（候选轮廓随即移除）
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    var cfg = cfgHover(currentSettings);
    if (!cfg.enabled || cfg.trigger !== 'pressHold') return;
    if (selectionActive()) return;
    var hit = null;
    try { hit = resolveHoverTarget(e.target, currentSettings, e.clientX, e.clientY); } catch (e2) { hit = null; }
    if (!hit) return;
    cancelPress();
    if (hit.kind === 'fresh') markCandidate(hit.el);
    hover.press = {
      el: hit.kind === 'fresh' ? hit.el : e.target,
      hit: hit,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(function () {
        var p = hover.press;
        hover.press = null;
        if (!p || !p.hit || !p.hit.el || !p.hit.el.isConnected) return;
        actOnTarget(p.hit, currentSettings);
      }, cfg.pressHoldMs)
    };
  }

  function onMouseMove(e) {
    hover.lastMouse.x = e.clientX;
    hover.lastMouse.y = e.clientY;
    // pressHold：按住期间位移超 6px → 取消
    if (hover.press && (Math.abs(e.clientX - hover.press.x) > 6 ||
                        Math.abs(e.clientY - hover.press.y) > 6)) {
      cancelPress();
    }
  }

  function onMouseUp() {
    cancelPress(); // 计时未到即松开 → 取消（已触发时 press 已为 null，无副作用）
  }

  // hover 档：mouseover 进入新目标 → 取消旧挂起 → 300ms 后仍在目标上才触发
  function onHoverTriggerOver(e) {
    var cfg = cfgHover(currentSettings);
    if (!cfg.enabled || cfg.trigger !== 'hover') return;
    if (selectionActive()) return;
    hover.lastMouse.x = e.clientX;
    hover.lastMouse.y = e.clientY;
    var hit = null;
    try { hit = resolveHoverTarget(e.target, currentSettings, e.clientX, e.clientY); } catch (e2) { hit = null; }
    cancelPending();
    if (!hit) return;
    if (hit.kind === 'fresh') markCandidate(hit.el);
    hover.pending = {
      el: hit.kind === 'fresh' ? hit.el : e.target,
      hit: hit,
      timer: setTimeout(function () {
        var p = hover.pending;
        hover.pending = null;
        if (!p || !p.hit || !p.hit.el || !p.hit.el.isConnected) return;
        // 复核指针仍悬停在目标上（elementFromPoint），防扫过误触
        var under = null;
        try { under = document.elementFromPoint(hover.lastMouse.x, hover.lastMouse.y); } catch (e3) {}
        if (!under || !p.hit.el.contains(under)) { unmarkCandidate(p.hit.el); return; }
        actOnTarget(p.hit, currentSettings);
      }, HOVER_DEBOUNCE_MS)
    };
  }

  // holdKey 记录：window keydown/keyup（blur 清除），mouseout 不依赖
  function holdKeyName(cfg) {
    return HOLD_KEYS[cfg.holdKey] || 'control';
  }

  function modifierOn(e, key) {
    if (key === 'ctrl') return !!e.ctrlKey;
    if (key === 'alt') return !!e.altKey;
    if (key === 'shift') return !!e.shiftKey;
    if (key === 'meta') return !!e.metaKey;
    return false;
  }

  function onWindowKeydown(e) {
    var cfg = cfgHover(currentSettings);
    if (cfg.enabled && cfg.trigger === 'holdKey' &&
        String(e.key || '').toLowerCase() === holdKeyName(cfg)) {
      hover.holdDown = true;
    }
    cancelPress(); // 任何按键打断 pressHold（设计：期间未 keyup 才触发）
    if (e.key === 'Escape') hideSelectionUI();
  }

  function onWindowKeyup(e) {
    // 任何 keyup 都清除按住态：Ctrl+C 等组合键漏掉匹配的 keyup 也不残留 latch。
    hover.holdDown = false;
    var cfg = cfgHover(currentSettings);
    if (String(e.key || '').toLowerCase() === holdKeyName(cfg)) {
      clearAllCandidates();
    }
  }

  function onWindowBlur() {
    hover.holdDown = false;
    clearAllCandidates();
    cancelPress();
    cancelPending();
  }

  /* ==================== 划词翻译：状态与 DOM ==================== */

  var selUI = {
    trigger: null,       // 小圆点 / 图标元素
    bubble: null,        // 气泡卡元素
    current: null,       // {text, raw, rect, isWord}
    lastResult: null,    // 最近一次译文（复制/重试用）
    busy: false,
    pinned: false,
    menuOpen: false,
    sessionDisabled: false, // ⋯菜单"本次不再"（会话态，刷新失效）
    uiClickAt: 0            // 最近一次气泡内点击时间（selectionchange 宽限）
  };
  var selDebounceTimer = 0;

  function siteDisabled(settings) {
    var list = cfgSel(settings).disabledSites;
    for (var i = 0; i < list.length; i++) {
      try { if (TA.rules.matchUrlPattern(list[i], location.href)) return true; } catch (e) { /* 忽略 */ }
    }
    return false;
  }

  function selectionEnabled(settings) {
    var cfg = cfgSel(settings);
    return cfg.enabled && !selUI.sessionDisabled && !siteDisabled(settings);
  }

  function isSingleWord(text) {
    if (/\s/.test(text)) return false;
    var words = text.match(/[\p{L}\p{N}]+/gu) || [];
    return words.length <= 3;
  }

  function langLabel(text) {
    var det = null;
    try { det = TA.lang.detectParagraphLang(text); } catch (e) { det = null; }
    return ((det && DET_LABEL[det]) || 'AUTO') + ' → ' + targetLangName();
  }

  // 选区有效性（threeInteractions 定稿）：非折叠、trim≥1 字符、容器不在输入框/
  // 代码内、不落在本模块 UI 上
  function validSelection() {
    var s = null;
    try { s = window.getSelection(); } catch (e) { return null; }
    if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
    var raw = s.toString();
    var text = TA.util.stripControlChars(raw).trim();
    if (!text) return null;
    var rng = s.getRangeAt(0);
    var startEl = rng.startContainer.nodeType === 1
      ? rng.startContainer
      : rng.startContainer.parentElement;
    if (!startEl || typeof startEl.closest !== 'function') return null;
    if (startEl.closest('input, textarea, [contenteditable], pre, code')) return null;
    if (startEl.closest(OWN_UI_SEL) || startEl.closest('.ta-target-wrapper')) return null;
    var rect = rng.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      var rects = rng.getClientRects ? rng.getClientRects() : null;
      rect = (rects && rects.length) ? rects[0] : null;
      if (!rect) return null;
    }
    return { text: text, raw: raw, rect: rect, isWord: isSingleWord(text) };
  }

  function hideTrigger() {
    if (selUI.trigger) {
      selUI.trigger.remove();
      selUI.trigger = null;
    }
  }

  function showTriggerAt(rect, cfg) {
    hideTrigger();
    var el = document.createElement(cfg.trigger === 'icon' ? 'button' : 'div');
    el.className = cfg.trigger === 'icon' ? 'ta-sel-icon' : 'ta-sel-dot';
    el.setAttribute('translate', 'no');
    el.classList.add('notranslate');
    el.title = '翻译选中内容';
    if (cfg.trigger === 'icon') {
      el.type = 'button';
      el.textContent = '译';
      el.setAttribute('aria-label', '翻译选中内容');
    }
    var size = cfg.trigger === 'icon' ? 26 : 8;
    var x = clampNum(rect.right + 4, 8, window.innerWidth - size - 8);
    var y = clampNum(rect.bottom + 4, 8, window.innerHeight - size - 8);
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.addEventListener('mouseenter', function () {
      if (cfgSel(currentSettings).triggerAction === 'hover') translateCurrent();
    });
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      translateCurrent();
    });
    (document.documentElement || document.body).appendChild(el);
    selUI.trigger = el;
  }

  // 气泡卡结构（v0.2 设计 threeInteractions 定稿骨架；静态模板，译文一律 textContent 回填）
  function ensureBubble() {
    if (selUI.bubble && selUI.bubble.isConnected) return selUI.bubble;
    var b = document.createElement('div');
    b.className = 'ta-sel-bubble ta-hide';
    b.setAttribute('dir', 'auto');
    b.setAttribute('role', 'dialog');
    b.setAttribute('translate', 'no');
    b.classList.add('notranslate');
    b.innerHTML =
      '<div class="ta-sel-head">' +
        '<span class="ta-sel-lang"></span>' +
        '<button type="button" class="ta-sel-btn" data-act="copy">复制</button>' +
        '<button type="button" class="ta-sel-btn" data-act="speak" aria-label="朗读">🔊</button>' +
        '<button type="button" class="ta-sel-btn" data-act="retry">重试</button>' +
        '<button type="button" class="ta-sel-btn ta-hide" data-act="toggle-orig">隐藏原文</button>' +
        '<button type="button" class="ta-sel-btn" data-act="menu">⋯</button>' +
        '<button type="button" class="ta-sel-btn" data-act="close">×</button>' +
      '</div>' +
      '<div class="ta-sel-body"></div>' +
      '<div class="ta-sel-foot">' +
        '<button type="button" class="ta-sel-btn" data-act="pin">固定</button>' +
        '<span class="ta-sel-note"></span>' +
      '</div>' +
      '<div class="ta-sel-menu ta-hide">' +
        '<button type="button" data-menu="session">本次不再翻译</button>' +
        '<button type="button" data-menu="site">本站不再翻译</button>' +
        '<button type="button" data-menu="forever">永久关闭划词翻译</button>' +
      '</div>';
    b.addEventListener('click', onBubbleClick);
    b.addEventListener('mousedown', function () { selUI.uiClickAt = Date.now(); });
    (document.documentElement || document.body).appendChild(b);
    selUI.bubble = b;
    return b;
  }

  function setLangLabel(text) {
    var el = selUI.bubble && selUI.bubble.querySelector('.ta-sel-lang');
    if (el) el.textContent = langLabel(text);
  }

  function renderLoading() {
    var body = selUI.bubble && selUI.bubble.querySelector('.ta-sel-body');
    if (!body) return;
    body.innerHTML = '<div class="ta-sel-loading"><span class="ta-sel-spinner"></span>正在翻译…</div>';
  }

  function renderResult(t, showOriginalOverride) {
    if (!selUI.bubble || !selUI.current) return;
    var cfg = cfgSel(currentSettings);
    var showOrig = typeof showOriginalOverride === 'boolean'
      ? showOriginalOverride : cfg.showOriginal;
    var body = selUI.bubble.querySelector('.ta-sel-body');
    if (!body) return;
    body.innerHTML = '<div class="ta-sel-trans"></div><div class="ta-sel-orig ta-hide"></div>';
    body.querySelector('.ta-sel-trans').textContent = t;
    var orig = body.querySelector('.ta-sel-orig');
    orig.textContent = selUI.current.raw.trim();
    if (selUI.current.isWord && showOrig) orig.classList.remove('ta-hide');
    // 单词查询才提供原文回显切换（整句固定仅译文）
    var toggleBtn = selUI.bubble.querySelector('[data-act="toggle-orig"]');
    if (toggleBtn) {
      toggleBtn.classList.toggle('ta-hide', !selUI.current.isWord);
      toggleBtn.textContent = showOrig ? '隐藏原文' : '显示原文';
    }
    var note = selUI.bubble.querySelector('.ta-sel-note');
    if (note) {
      note.textContent = selUI.current.isWord ? '单词 · 可回显原文' : '整句 · 仅译文';
    }
    setLangLabel(selUI.current.text);
  }

  function renderError(err) {
    var body = selUI.bubble && selUI.bubble.querySelector('.ta-sel-body');
    if (!body) return;
    var msg = '';
    try { msg = TA.errorText(err); } catch (e) { msg = '翻译失败'; }
    body.innerHTML = '<div class="ta-sel-error"></div>' +
      '<button type="button" class="ta-sel-btn ta-sel-retry" data-act="retry">重试</button>';
    body.querySelector('.ta-sel-error').textContent = msg;
  }

  function positionBubble(rect) {
    var b = selUI.bubble;
    b.classList.remove('ta-hide');
    b.style.left = '0px';
    b.style.top = '0px';
    var w = b.offsetWidth;
    var h = b.offsetHeight;
    var left = rect.right + 8;
    if (left + w > window.innerWidth - 8) left = rect.right - w - 8;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    left = clampNum(left, 8, window.innerWidth - w - 8);
    var top = rect.bottom + 10;
    if (top + h > window.innerHeight - 8) top = rect.top - h - 10;
    top = clampNum(top, 8, Math.max(8, window.innerHeight - h - 8));
    b.style.left = Math.round(left) + 'px';
    b.style.top = Math.round(top) + 'px';
  }

  function showBubble() {
    ensureBubble();
    if (selUI.current) setLangLabel(selUI.current.text);
    var pin = selUI.bubble.querySelector('[data-act="pin"]');
    if (pin) pin.textContent = selUI.pinned ? '已固定' : '固定';
    positionBubble(selUI.current ? selUI.current.rect : { right: 40, bottom: 40, top: 20 });
  }

  function hideBubble() {
    closeMenu();
    if (selUI.bubble) selUI.bubble.classList.add('ta-hide');
    selUI.lastResult = null;
  }

  function hideSelectionUI() {
    hideTrigger();
    selUI.pinned = false;
    hideBubble();
  }

  function closeMenu() {
    selUI.menuOpen = false;
    var m = selUI.bubble && selUI.bubble.querySelector('.ta-sel-menu');
    if (m) m.classList.add('ta-hide');
  }

  function toggleMenu() {
    var m = selUI.bubble && selUI.bubble.querySelector('.ta-sel-menu');
    if (!m) return;
    selUI.menuOpen = !selUI.menuOpen;
    m.classList.toggle('ta-hide', !selUI.menuOpen);
  }

  /* ==================== 划词翻译：动作 ==================== */

  function translateCurrent() {
    var cur = selUI.current;
    if (!cur || selUI.busy) return;
    var cfg = cfgSel(currentSettings);
    selUI.busy = true;
    selUI.lastResult = null;
    showBubble();
    renderLoading();
    translateTextChannel(cur.text, {
      service: cfg.service,
      targetLang: (currentSettings && currentSettings.targetLang) || 'zh-CN'
    }).then(function (t) {
      if (selUI.current !== cur) return; // 选区已变，丢弃过期回包
      selUI.lastResult = t;
      renderResult(t);
      appendDictionaryCard(cur); // 短选区：在译文下方追加 AI 词典卡（失败静默）
    }).catch(function (err) {
      if (selUI.current !== cur) return;
      renderError(err);
    }).then(function () {
      selUI.busy = false;
    });
  }

  function copyTranslation(btn) {
    var text = selUI.lastResult || (selUI.current && selUI.current.text) || '';
    if (!text || !btn) return;
    var old = btn.textContent;
    var done = function (ok) {
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { btn.textContent = old; }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text)
        .then(function () { done(true); })
        .catch(function () { done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  }

  // clipboard API 不可用时的同步回退（临时 textarea + execCommand）
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function speakSelection() {
    var text = selUI.current && selUI.current.text;
    if (!text) return;
    try {
      var u = new SpeechSynthesisUtterance(text);
      var det = null;
      try { det = TA.lang.detectParagraphLang(text); } catch (e) { det = null; }
      if (det && SPEAK_LANG[det]) u.lang = SPEAK_LANG[det];
      u.rate = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { /* TTS 不可用时静默 */ }
  }

  // AI 词典卡（短选区）：在原译文下方追加富卡，不替换既有译文；
  // TA.dictionary 缺失 / 设置关闭 / 超过短选区阈值时静默跳过，失败绝不影响既有行为。
  function appendDictionaryCard(cur) {
    try {
      var dcfg = (currentSettings && currentSettings.dictionary) || {};
      var txt = (cur && cur.text) || '';
      if (!TA.dictionary || !dcfg.enabled) return;
      if (txt.length > 64 || (txt.match(/\S+/g) || []).length > 6) return;
      var tl = (currentSettings && currentSettings.targetLang) || 'zh-CN';
      var p = TA.dictionary.lookup(txt, tl);
      if (!p || typeof p.then !== 'function') return;
      p.then(function (card) {
        if (!card || selUI.current !== cur) return; // 选区已变 → 丢弃过期回包
        var body = selUI.bubble && selUI.bubble.querySelector('.ta-sel-body');
        if (!body || body.querySelector('.ta-dict-card')) return;
        body.appendChild(TA.dictionary.render(card));
      }).catch(function () { /* 词典失败不影响既有译文 */ });
    } catch (e) { /* 词典钩子异常静默 */ }
  }

  // showOriginal 切换：持久化到 settings.selection.showOriginal，并即时重渲染
  function toggleShowOriginal(btn) {
    var next = !(cfgSel(currentSettings).showOriginal);
    if (typeof TA.saveSettings === 'function') {
      TA.saveSettings({ selection: { showOriginal: next } })
        .catch(function (e) { console.warn('[TA] 保存 showOriginal 失败', e); });
    }
    if (selUI.lastResult != null) renderResult(selUI.lastResult, next);
    else if (btn) btn.textContent = next ? '隐藏原文' : '显示原文';
  }

  function disableForSession() {
    selUI.sessionDisabled = true;
    hideSelectionUI();
  }

  function disableForSite() {
    var host = location.host || location.hostname;
    if (typeof TA.saveSettings !== 'function') return;
    TA.getSettings().then(function (s) {
      var list = cfgSel(s).disabledSites.slice();
      if (list.indexOf(host) === -1) list.push(host);
      return TA.saveSettings({ selection: { disabledSites: list } });
    }).catch(function (e) {
      console.warn('[TA] 保存划词本站禁用失败', e);
    });
    hideSelectionUI();
  }

  function disableForever() {
    if (typeof TA.saveSettings === 'function') {
      TA.saveSettings({ selection: { enabled: false } })
        .catch(function (e) { console.warn('[TA] 保存划词开关失败', e); });
    }
    hideSelectionUI();
  }

  // 气泡事件委托（data-act / data-menu）
  function onBubbleClick(e) {
    var btn = e.target && typeof e.target.closest === 'function'
      ? e.target.closest('[data-act], [data-menu]') : null;
    if (!btn) { closeMenu(); return; }
    if (btn.hasAttribute('data-menu')) {
      var m = btn.getAttribute('data-menu');
      if (m === 'session') disableForSession();
      else if (m === 'site') disableForSite();
      else if (m === 'forever') disableForever();
      return;
    }
    var act = btn.getAttribute('data-act');
    if (act === 'copy') copyTranslation(btn);
    else if (act === 'speak') speakSelection();
    else if (act === 'retry') translateCurrent();
    else if (act === 'toggle-orig') toggleShowOriginal(btn);
    else if (act === 'menu') toggleMenu();
    else if (act === 'close') hideSelectionUI();
    else if (act === 'pin') {
      selUI.pinned = !selUI.pinned;
      btn.textContent = selUI.pinned ? '已固定' : '固定';
    } else {
      closeMenu();
    }
  }

  /* ==================== 划词翻译：事件处理 ==================== */

  function evaluateSelection() {
    if (!selectionEnabled(currentSettings)) { hideSelectionUI(); return; }
    var cur = validSelection();
    if (!cur) {
      // 选区折叠/失效：收起触发点与未固定气泡（固定气泡常驻直到手动关闭）
      hideTrigger();
      if (!selUI.pinned) hideBubble();
      return;
    }
    selUI.current = cur;
    selUI.lastResult = null;
    var cfg = cfgSel(currentSettings);
    if (cfg.trigger === 'direct') {
      translateCurrent(); // direct 档：mouseup 即弹即译
    } else {
      if (selUI.bubble && !selUI.pinned) hideBubble();
      showTriggerAt(cur.rect, cfg);
    }
  }

  function onSelectionChangeDebounced() {
    // 气泡内点击（如复制）引发的选区折叠：宽限期内忽略，避免气泡被误收起
    if (Date.now() - selUI.uiClickAt < UI_CLICK_GRACE_MS) return;
    evaluateSelection();
  }

  function onSelChange() {
    if (!selectionEnabled(currentSettings)) return;
    if (selDebounceTimer) clearTimeout(selDebounceTimer);
    selDebounceTimer = setTimeout(function () {
      selDebounceTimer = 0;
      onSelectionChangeDebounced();
    }, SEL_DEBOUNCE_MS);
  }

  function onSelMouseUp(e) {
    if (!selectionEnabled(currentSettings)) return;
    // 本模块 UI 上的 mouseup 不评估（复制按钮点击等不收起气泡）
    if (e && e.target && typeof e.target.closest === 'function' &&
        e.target.closest('.ta-sel-bubble, .ta-sel-dot, .ta-sel-icon')) return;
    evaluateSelection();
  }

  function onDocMouseDown(e) {
    var t = e.target;
    var inOwnUI = !!(t && typeof t.closest === 'function' &&
      t.closest('.ta-sel-bubble, .ta-sel-dot, .ta-sel-icon'));
    // 触发点/气泡内的按下不收起 UI：触发点若在 mousedown 时被移除，
    // 随后的 click 事件将不再派发到它（click 激活路径会失效）
    if (inOwnUI) return;
    closeMenu();
    cancelPending(); // 悬停挂起被新的按下打断
    // 气泡外按下：未固定气泡收起 + 触发点收起（新选择即将开始）
    if (selUI.bubble && !selUI.bubble.classList.contains('ta-hide') && !selUI.pinned) {
      hideBubble();
    }
    hideTrigger();
  }

  function onScrollOrResize() {
    // 滚动/缩放：触发点与未固定气泡隐藏（不做持续跟随）；固定气泡常驻
    hideTrigger();
    if (selUI.bubble && !selUI.pinned) hideBubble();
    cancelPress();
  }

  /* ==================== 悬停：hover 档监听分流 ==================== */

  function onDocMouseOver(e) {
    var cfg = cfgHover(currentSettings);
    if (!cfg.enabled) return;
    if (cfg.trigger === 'holdKey') onMouseOver(e);
    else if (cfg.trigger === 'hover') onHoverTriggerOver(e);
    // pressHold 档不走 mouseover
  }

  /* ==================== 生命周期：init / settings 变更 ==================== */

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener('mouseover', onDocMouseOver, true);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('mouseup', onSelMouseUp, true);
    document.addEventListener('selectionchange', onSelChange, true);
    document.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onWindowKeydown, true);
    window.addEventListener('keyup', onWindowKeyup, true);
    window.addEventListener('blur', onWindowBlur);
  }

  // 设置变更 → 运行时启用/停用（不重载监听器，仅按配置门控各 handler）
  function applySettings(s) {
    currentSettings = s;
    var hc = cfgHover(s);
    if (!hc.enabled) {
      hover.holdDown = false;
      clearAllCandidates();
      cancelPress();
      cancelPending();
    }
    var sc = cfgSel(s);
    if (!sc.enabled || siteDisabled(s)) hideSelectionUI();
  }

  function initAll(settings) {
    currentSettings = settings || currentSettings;
    bindListeners();
  }

  // 全页还原兜底协同：A 的 injector.restoreAll（v0.2）已接管行内形态还原，
  // 本模块不再持有自有行内结构；此处无需补丁，仅保留对 injector 可用性的防御。
  function ensureInjectorReady() {
    if (!TA.injector || typeof TA.injector.restoreUnit !== 'function') {
      console.warn('[TA] interactions: TA.injector 未就绪，悬停还原不可用');
    }
  }

  /* ==================== 注册表挂载 ==================== */

  // 注册到 TA.features（core.js 注册表；main.js 统一 init/分发）。
  // init 幂等（监听器只绑一次），注册后立即自初始化，保证 A 的 main.js
  // 联调前后（或未升级的 v0.1 骨架上）均可独立工作。
  TA.features.register({
    name: 'hover-selection',
    init: function (settings) { initAll(settings); },
    onSettingsChanged: function (s) { try { applySettings(s); } catch (e) { /* 忽略 */ } },
    messages: {},   // 本模块不新增 content 消息类型（GET_FEATURES 由 main.js 汇总）
    cmds: {}        // 本模块无快捷键命令
  });

  // 注册表尚未由 main.js 驱动时（v0.1 骨架联调期）：立即自初始化。
  // main.js 就绪后再次调用 init(settings) 为幂等空转。
  if (typeof TA.getSettings === 'function') {
    TA.getSettings().then(function (s) { initAll(s); })
      .catch(function () { /* 读取失败按默认行为运行 */ });
  }
  if (typeof TA.onSettingsChanged === 'function') {
    TA.onSettingsChanged(function (s) { applySettings(s); });
  }
  ensureInjectorReady();
})();
