// content/injector.js —— 译文 wrapper 注入 / 回填 / 还原
// 职责（协议 injectionRules D 节 + v0.2 排版修复定稿）：
//   注入位置（after 模式默认）：anchor 算法——wrapper 插到最后一个直属文本流节点之后，
//     保证"译文在原文正下方"：<li>Text<ul>…</ul></li> 译文落在 Text 行与子列表之间，
//     <p>foo <a>link</a></p> 译文落在 </a> 之后（v0.1 固定 appendChild 到末尾的错位已修复）；
//   flex/grid 容器：wrapper 外插为兄弟块（data-ta-sibling + data-ta-for 关联），
//     避免 wrapper 成为 flex item 被挤压/横排；
//   行内形态（data-ta-inline）：unit.el 本身为行内元素时，原文行（.ta-original-inline）
//     与译文行（.ta-target-inner）同入 wrapper 上下两块，行内语义下仍上下排；
//   replace 模式：先把直属文本节点原位包进 .ta-original（移动不改文本）再加标记；
//   仅译文模式：.ta-original 加 .ta-hide-original 隐藏（不隐藏图片等非文本子元素）；
//   主题：data-ta-theme（24 档，样式在 C 的 styles/themes.css）+ --ta-c 自定义色 +
//     font-size 自定义字号 + ta-user-css 自定义样式；站点规则 theme 字段可覆盖页面主题；
//   loading / error 态：ta-loading（spinner 闪烁 / text 静态"…" / none 三档）/
//     ta-error（i18n 错误文案）。
//   双栏排版（settings.targetStyle.layout==='dual'，opt-in）：NORMAL/FORCED 分支把原文
//     收进 wrapper 内 .ta-original 列，与 .ta-target-inner 构成左右两列（样式见
//     styles/dual-column.css）；el 记 data-ta-dual、wrapper 记 data-ta-layout='dual'。
//     缺省（block）不写任何新属性，DOM 与旧版逐字一致。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || !TA.walker || !TA.errorText || TA.__injectorLoaded) {
    if (TA && !TA.__injectorLoaded && !TA.walker) {
      console.error('[TA] content/injector.js: 前置文件 content/walker.js 未加载');
    }
    return;
  }
  TA.__injectorLoaded = true;

  var PLACEHOLDER_RE = /【\s*(\d{8})\s*】/g;
  var unitSeq = 0;              // 页内 wrapper 序号（data-ta-id）
  var currentMode = 'bilingual'; // 当前显隐模式（由 main.js 经 applyMode 同步）
  var userCssEl = null;
  var currentLayout = 'block'; // 当前生效排版：block（默认，旧行为）| dual（双栏）；由 settings 缓存供 getLayout

  // 生效排版解析：settings.targetStyle.layout ∈ 'block'（默认/旧行为）| 'dual'（双栏并排）。
  // 缺省或无 layout 键时一律 'block'——保证默认行为逐字不变（22 项现有测试不受影响）。
  // 顺带缓存到 currentLayout，供 TA.injector.getLayout() 读取最近一次生效值。
  function resolveLayout(settings) {
    var ts = (settings && settings.targetStyle) || {};
    var layout = ts.layout || 'block';
    currentLayout = (layout === 'dual') ? 'dual' : 'block';
    return currentLayout;
  }

  // TA.THEMES 兼容性校验（字符串数组或 {id/value} 对象数组均可）
  function isValidTheme(theme) {
    var th = TA.THEMES;
    if (!th || !th.length) return true;
    for (var i = 0; i < th.length; i++) {
      var t = th[i];
      if (typeof t === 'string' && t === theme) return true;
      if (t && typeof t === 'object' && (t.id === theme || t.value === theme || t.key === theme)) return true;
    }
    return false;
  }

  // 生效主题解析：opts.effectiveTheme（main.js collectOpts 传入，站点规则 theme 优先）
  // > settings.targetStyle.theme。无 opts 时兜底自查站点规则（B 的悬停路径只传 settings）。
  function themeName(settings, opts) {
    if (opts && opts.effectiveTheme && isValidTheme(opts.effectiveTheme)) return opts.effectiveTheme;
    try {
      if (TA.rules && typeof TA.rules.resolve === 'function') {
        var r = TA.rules.resolve(location.href, settings);
        if (r && typeof r.theme === 'string' && r.theme && isValidTheme(r.theme)) return r.theme;
      }
    } catch (e) { /* 规则解析失败按无规则处理 */ }
    var ts = (settings && settings.targetStyle) || {};
    var t = ts.theme || 'dashed';
    return isValidTheme(t) ? t : 'dashed';
  }

  // loading 三档（spinner|text|none，默认 spinner）：挂 documentElement 根属性，
  // CSS 按根属性切占位形态，避免逐 wrapper 写属性
  function applyLoadingStyle(settings) {
    var ts = (settings && settings.targetStyle) || {};
    var loading = ts.loading;
    var root = document.documentElement;
    if (loading !== 'text' && loading !== 'none') {
      root.removeAttribute('data-ta-loading'); // spinner=默认形态
    } else {
      root.setAttribute('data-ta-loading', loading);
    }
  }

  // 自定义颜色 / 字号（空值 = 移除，回落到 CSS 默认）
  function applyInlineStyle(wrapper, settings) {
    var ts = (settings && settings.targetStyle) || {};
    if (ts.color) wrapper.style.setProperty('--ta-c', String(ts.color));
    else wrapper.style.removeProperty('--ta-c');
    var fs = parseFloat(ts.fontSize);
    if (fs > 0) wrapper.style.fontSize = fs + 'px';
    else wrapper.style.removeProperty('font-size');
  }

  function createWrapper(settings, opts) {
    var w = document.createElement('span');
    w.className = 'ta-target-wrapper ta-loading';
    unitSeq += 1;
    w.setAttribute('data-ta-id', 'u-' + unitSeq);
    w.setAttribute('data-ta-theme', themeName(settings, opts));
    w.setAttribute('dir', 'auto');
    // 双栏排版标记：仅在 layout==='dual' 时写入，CSS 依此切换为左右两列网格。
    // 默认（block）不写该属性，DOM 与旧版逐字一致。
    if (resolveLayout(settings) === 'dual') w.setAttribute('data-ta-layout', 'dual');
    var inner = document.createElement('span');
    inner.className = 'ta-target-inner';
    w.appendChild(inner);
    applyInlineStyle(w, settings);
    return { wrapper: w, inner: inner };
  }

  // anchor 算法：找 el 的"最后一个直属文本流节点"（el 的直接子节点）。
  // 从收集到的最后一个文本节点沿父链向上爬到 el 的直接子层：
  //   <li>Text<ul>…</ul></li>       → 锚点 = Text 文本节点本身
  //   <p>foo <a>link</a></p>        → 锚点 = <a>（link 文本在 a 内）
  //   外层 div 散落直属文本 + 子块  → 锚点 = 最后一段直属文本所在的最深直属子节点
  // v0.2 端到端实测补录（2026-11-15 第 1 轮修复，验收 2a）：buildUnitText 会把
  // </ul> 之后的纯空白直属文本节点也收进 textNodes——以其为锚点时
  // insertBefore(wrapper, anchor.nextSibling) 因 nextSibling 为 null 等效 appendChild
  // 到 li 末尾（验收 1 明令禁止的错位形态）。故倒序查找时跳过纯空白节点
  // （/\S/ 判定；pre 等空白敏感上下文里跳过的只是尾随空白，视觉无差）。
  // 异常（文本节点父链越出 el 等）回落 null → 调用方 appendChild 到末尾。
  function findInsertAnchor(el, textNodes) {
    var last = null;
    var recs = textNodes || [];
    for (var i = recs.length - 1; i >= 0; i--) {
      var n = recs[i] && recs[i].node;
      if (!n || !n.parentNode) continue;
      if (!/\S/.test(n.nodeValue || '')) continue; // 纯空白节点不作锚点
      last = n;
      break;
    }
    if (!last) return null;
    var p = last.parentNode, child = last;
    while (p && p !== el && el.contains(p)) { child = p; p = p.parentNode; }
    return (p === el) ? child : null; // el 的直接子节点；异常回落 null
  }

  // 把 unit 的直属文本节点原位包进 .ta-original（含内联元素内部的文本，
  // 否则仅译文模式隐藏不掉 <b>xx</b> 里的 xx）
  function wrapTextNodes(unit) {
    var recs = (unit && unit.textNodes) || [];
    for (var i = 0; i < recs.length; i++) {
      var n = recs[i].node;
      if (!n || !n.parentNode) continue;
      var p = n.parentNode;
      if (p.classList && (p.classList.contains('ta-original') ||
          p.classList.contains('ta-original-inline'))) continue;
      var span = document.createElement('span');
      span.className = 'ta-original';
      p.insertBefore(span, n);
      span.appendChild(n);
    }
  }

  // 双栏（layout==='dual'）专用：把 el 的原文内容收进 wrapper 内的 .ta-original 列，
  // 与 .ta-target-inner 构成 CSS grid 的左右两列（样式在 styles/dual-column.css）。
  // 仅用于 NORMAL / FORCED 分支（行内 / flex-grid 分支保持旧行为，不调用本函数）。
  // .ta-original 同时带 ta-original-inline 类：walker 对 wrapper 内原文的穿透
  // （:scope > .ta-original-inline）与 restoreUnit 步骤①的原文回流都据此命中，
  // 保证 hash 稳定、还原干净。原文节点整体 move（appendChild 不改文本归属）。
  function setupDualColumn(el, made) {
    if (!el || !made || !made.wrapper || !made.inner) return;
    var col = document.createElement('span');
    col.className = 'ta-original ta-original-inline';
    made.wrapper.insertBefore(col, made.inner);
    // 把 el 的全部原有子节点（即原文流，含内联元素）移入原文列；wrapper 本身留在 el。
    while (el.firstChild && el.firstChild !== made.wrapper) {
      col.appendChild(el.firstChild);
    }
    el.setAttribute('data-ta-dual', '1');
  }

  function setOriginalHidden(el, hide) {
    // .ta-original：replace/仅译文的原文包裹；.ta-original-inline：行内形态原文行
    var spans = el.querySelectorAll('.ta-original, .ta-original-inline');
    for (var i = 0; i < spans.length; i++) {
      if (hide) spans[i].classList.add('ta-hide-original');
      else spans[i].classList.remove('ta-hide-original');
    }
  }

  // 深克隆内联元素供译文回填：剥除 id（防 DOM id 重复）、还原克隆体内的
  // .ta-original / .ta-original-inline 包裹（避免把隐藏类一并克隆进译文导致内容不可见）
  function cloneClean(el) {
    var c = el.cloneNode(true);
    if (c.nodeType !== 1) return c;
    if (c.hasAttribute('id')) c.removeAttribute('id');
    var withIds = c.querySelectorAll('[id]');
    for (var i = 0; i < withIds.length; i++) withIds[i].removeAttribute('id');
    var originals = c.querySelectorAll('.ta-original, .ta-original-inline');
    for (var j = 0; j < originals.length; j++) {
      var s = originals[j];
      var parent = s.parentNode;
      if (!parent) continue;
      while (s.firstChild) parent.insertBefore(s.firstChild, s);
      s.remove();
    }
    return c;
  }

  TA.injector = {
    getMode: function () { return currentMode; },
    // 当前生效排版（'block' 默认 / 'dual' 双栏），取自最近一次 settings 缓存
    getLayout: function () { return currentLayout; },
    // 主题合法性校验复用入口（main.js SET_THEME 用）
    isValidTheme: isValidTheme,

    // 注入 loading 态 wrapper 并给 unit 打防重复标记。
    // opts（可选）：collectOpts 产物，effectiveTheme 参与主题解析。
    // 插入位置优先级（v0.2 排版定稿）：
    //   ① unit.el 为行内元素（display inline/inline-block）→ 行内形态
    //     （含"强制根命中行内选择器"场景）；
    //   ② forced unit（站点规则强制根）→ el.appendChild（容器整体成段，译文在容器末尾合理）；
    //   ③ el 为 flex/grid 容器（含 inline- 变体）→ wrapper 外插为兄弟块；
    //   ④ 其余 → anchor 算法，异常回落 appendChild。
    injectLoading: function (unit, settings, opts) {
      var el = unit && unit.el;
      if (!el || !el.isConnected || el.hasAttribute('data-ta')) return false;
      if (el.querySelector(':scope > .ta-target-wrapper')) return false;
      var made = createWrapper(settings, opts);
      unit.wrapper = made.wrapper;
      unit.inner = made.inner;
      var disp = '';
      try { disp = String(getComputedStyle(el).display || ''); } catch (e) { disp = ''; }
      var isInlineEl = (disp === 'inline' || disp === 'inline-block');
      var isFlexGrid = /flex|grid/.test(disp);
      // 双栏排版：仅 NORMAL / FORCED 分支参与；行内与 flex-grid 分支保持旧行为（回落）。
      var isDual = (resolveLayout(settings) === 'dual') && !isInlineEl && !isFlexGrid;

      if (isInlineEl) {
        // —— 行内形态：wrapper 进 el，el 的全部子节点移入 .ta-original-inline（原文行），
        // 译文行 .ta-target-inner 与之同入 wrapper 上下两块（CSS display:block）。
        // 还原时 restoreUnit 先把原文行内容移回 wrapper 原占位再删 wrapper，结构无损。
        made.wrapper.setAttribute('data-ta-inline', '1');
        var origLine = document.createElement('span');
        origLine.className = 'ta-original-inline';
        made.wrapper.insertBefore(origLine, made.inner);
        el.appendChild(made.wrapper);
        while (el.firstChild !== made.wrapper) {
          origLine.appendChild(el.firstChild); // appendChild 移动节点（不改文本）
        }
      } else if (unit.forced) {
        // —— 强制根：容器整体成段
        el.appendChild(made.wrapper);
      } else if (isFlexGrid) {
        // —— flex/grid 容器：wrapper 外插为兄弟块，双方以同一 id 关联
        //（el 记 data-ta-id，wrapper 记 data-ta-for=<id> + data-ta-sibling 标记）
        var sid = made.wrapper.getAttribute('data-ta-id');
        made.wrapper.setAttribute('data-ta-sibling', '1');
        made.wrapper.setAttribute('data-ta-for', sid);
        el.setAttribute('data-ta-id', sid);
        el.insertAdjacentElement('afterend', made.wrapper);
      } else {
        // —— 常规：anchor 算法，译文紧贴该段直属文本流之后
        var anchor = findInsertAnchor(el, unit.textNodes);
        if (anchor) el.insertBefore(made.wrapper, anchor.nextSibling);
        else el.appendChild(made.wrapper);
      }

      // 双栏：把原文收进 wrapper 内的 .ta-original 列（与译文列并排），并标记 el。
      // 行内 / flex-grid 分支 isDual 为 false，此处不执行，DOM 与旧版逐字一致。
      if (isDual) setupDualColumn(el, made);

      el.setAttribute('data-ta', 'done');
      el.setAttribute('data-ta-hash', unit.hash);
      if (unit.forced) el.setAttribute('data-ta-forced', '1');
      var ts = settings || {};
      var replace = ts.translationPosition === 'replace';
      var needHide = currentMode === 'translation-only';
      // 行内形态原文已在 .ta-original-inline 内；双栏原文已在 wrapper 内 .ta-original 列，
      // 二者均无需再逐文本节点包 .ta-original（避免多余嵌套包裹）。
      if (!isInlineEl && !isDual && (replace || needHide)) wrapTextNodes(unit);
      // replace 语义与双栏（原文/译文始终并排）冲突，双栏下不写 data-ta-replaced。
      if (replace && !isDual) el.setAttribute('data-ta-replaced', '1');
      // replace 模式默认隐藏原文；仅译文模式同样隐藏（含行内形态原文行、双栏原文列）。
      // 双栏下仅按"仅译文"显隐：双语两列都显示，仅译文隐藏原文列。
      setOriginalHidden(el, isDual ? needHide : (replace || needHide));
      return true;
    },

    // 译文回填：按 token 切分译文，文本段 → text node，token → 内联元素深克隆
    applyTranslation: function (unit, translation) {
      var wrapper = unit && unit.wrapper;
      var inner = unit && unit.inner;
      if (!wrapper || !inner || !wrapper.isConnected) return;
      inner.textContent = '';
      var map = unit.map || new Map();
      var used = new Set();
      var last = 0;
      var m;
      PLACEHOLDER_RE.lastIndex = 0;
      while ((m = PLACEHOLDER_RE.exec(translation)) !== null) {
        if (m.index > last) inner.appendChild(document.createTextNode(translation.slice(last, m.index)));
        var src = map.get(m[1]);
        if (src) {
          used.add(m[1]);
          inner.appendChild(cloneClean(src));
        } else {
          // 未知 id 的 token 直接删除
          console.warn('[TA] 译文中出现未知占位符，已丢弃：' + m[0]);
        }
        last = m.index + m[0].length;
      }
      if (last < translation.length) inner.appendChild(document.createTextNode(translation.slice(last)));
      // 译文丢失的 token 静默告警（链接在译文中缺失可接受，不阻塞）
      map.forEach(function (val, id) {
        if (!used.has(id)) console.warn('[TA] 译文缺少占位符 ' + id + '，对应内联元素未在译文中保留');
      });
      wrapper.classList.remove('ta-loading');
      wrapper.classList.remove('ta-error');
    },

    // 错误态：inner 文案 = 错误码映射（chrome.i18n / 内置中文回退）
    setError: function (unit, err) {
      var wrapper = unit && unit.wrapper;
      var inner = unit && unit.inner;
      if (!wrapper || !inner || !wrapper.isConnected) return;
      inner.textContent = TA.errorText(err);
      wrapper.classList.remove('ta-loading');
      wrapper.classList.add('ta-error');
    },

    // 还原单个 unit：行内原文行移回原位 → 兄弟 wrapper 清理 → 子树 wrapper 摘除 →
    // .ta-original 解包 → 标记清除
    restoreUnit: function (el) {
      if (!el || el.nodeType !== 1) return;
      // ① 行内形态：原文行内容移回 wrapper 原占位（保持文本归属与顺序），再删 wrapper。
      //    不先移回会导致原文随 wrapper 一起被删除（v0.2 行内形态新增的还原路径）。
      var inlineLines = el.querySelectorAll('.ta-original-inline');
      for (var k = 0; k < inlineLines.length; k++) {
        var line = inlineLines[k];
        var w = line.closest('.ta-target-wrapper');
        var host = (w && w.parentNode) || el;
        while (line.firstChild) host.insertBefore(line.firstChild, w);
        line.remove();
      }
      // ①b 双栏兜底：wrapper 内残留的 .ta-original 原文列（未带 ta-original-inline 类时
      //    步骤①不命中）先回流到 wrapper 占位处，避免随 wrapper 一起被删除。
      //    常规双栏列同时带两个类、已由步骤①处理，此处无匹配节点，属安全空操作。
      if (el.hasAttribute('data-ta-dual')) {
        var dualCols = el.querySelectorAll('.ta-target-wrapper > .ta-original');
        for (var d = 0; d < dualCols.length; d++) {
          var dc = dualCols[d];
          var dw = dc.closest('.ta-target-wrapper');
          var dh = (dw && dw.parentNode) || el;
          while (dc.firstChild) dh.insertBefore(dc.firstChild, dw);
          dc.remove();
        }
      }
      // ② flex/grid 外插的兄弟 wrapper：按 data-ta-for 关联清理
      //    （v0.1 只查子树，外插兄弟后会漏删，此处补齐）
      var elId = el.getAttribute('data-ta-id');
      if (elId && el.parentElement) {
        try {
          var sib = el.parentElement.querySelector(
            ':scope > .ta-target-wrapper[data-ta-for="' + elId + '"]');
          if (sib) sib.remove();
        } catch (e) { /* 选择器异常忽略 */ }
      }
      // ③ 子树内常规 wrapper
      var wrappers = el.querySelectorAll('.ta-target-wrapper');
      for (var i = 0; i < wrappers.length; i++) wrappers[i].remove();
      // ④ 解开 .ta-original 包裹（文本节点移回原位）
      var originals = el.querySelectorAll('.ta-original');
      for (var j = 0; j < originals.length; j++) {
        var s = originals[j];
        var parent = s.parentNode;
        if (!parent) continue;
        while (s.firstChild) parent.insertBefore(s.firstChild, s);
        s.remove();
      }
      // ⑤ 标记清除（含 flex/grid 分支写入 el 的 data-ta-id、双栏分支的 data-ta-dual）
      el.removeAttribute('data-ta');
      el.removeAttribute('data-ta-hash');
      el.removeAttribute('data-ta-replaced');
      el.removeAttribute('data-ta-forced');
      el.removeAttribute('data-ta-id');
      el.removeAttribute('data-ta-dual');
    },

    // 全页还原（含游离 wrapper 兜底清理）
    restoreAll: function (root) {
      var doc = root || document;
      var els = doc.querySelectorAll('[data-ta]');
      for (var i = 0; i < els.length; i++) TA.injector.restoreUnit(els[i]);
      var strays = doc.querySelectorAll('.ta-target-wrapper');
      for (var j = 0; j < strays.length; j++) {
        if (!strays[j].closest('[data-ta]')) strays[j].remove();
      }
    },

    // 显隐模式切换（双语对照 / 仅译文）：
    //   仅译文 → 所有已翻译 unit 原位包裹 .ta-original 并加 ta-hide-original；
    //   双语 → 移除 ta-hide-original，但 replace 模式单元保持隐藏（"替换原文"语义）。
    applyMode: function (mode, opts) {
      currentMode = (mode === 'translation-only') ? 'translation-only' : 'bilingual';
      if (currentMode === 'translation-only') {
        var els = document.querySelectorAll('[data-ta]');
        for (var i = 0; i < els.length; i++) {
          var el = els[i];
          // 常规/行内单元的 wrapper 在子树内；flex/grid 外插的兄弟 wrapper 不在
          //（以 el 的 data-ta-id 判别），两类都要进入隐藏流程
          if (!el.querySelector('.ta-target-wrapper') && !el.hasAttribute('data-ta-id')) continue;
          TA.injector.ensureOriginalWrapped(el, opts);
          setOriginalHidden(el, true);
        }
      } else {
        // 双语：移除隐藏类（含行内形态原文行）；replace 模式单元保持隐藏
        var spans = document.querySelectorAll('.ta-original, .ta-original-inline');
        for (var j = 0; j < spans.length; j++) {
          var unitEl = spans[j].closest('[data-ta]');
          if (unitEl && unitEl.getAttribute('data-ta-replaced') === '1') continue;
          spans[j].classList.remove('ta-hide-original');
        }
      }
    },

    // 对已注入（after 模式）的 unit 惰性补包裹：新直属文本节点包进 .ta-original
    ensureOriginalWrapped: function (el, opts) {
      var o = opts || {};
      o.forced = el.hasAttribute('data-ta-forced');
      var built = null;
      try { built = TA.walker.buildUnit(el, o); } catch (e) { return; }
      var recs = (built && built.textNodes) || [];
      for (var i = 0; i < recs.length; i++) {
        var n = recs[i].node;
        if (!n || !n.parentNode) continue;
        var p = n.parentNode;
        if (p.classList && (p.classList.contains('ta-original') ||
            p.classList.contains('ta-original-inline'))) continue;
        var span = document.createElement('span');
        span.className = 'ta-original';
        p.insertBefore(span, n);
        span.appendChild(n);
      }
    },

    // 设置变更 → 已渲染节点重应用主题类 / 内联颜色字号 / 自定义 CSS / loading 档
    applyThemeSettings: function (settings, opts) {
      var theme = themeName(settings, opts);
      resolveLayout(settings); // 刷新 getLayout() 缓存（layout 与主题独立，仅更新缓存值）
      var wrappers = document.querySelectorAll('.ta-target-wrapper');
      for (var i = 0; i < wrappers.length; i++) {
        wrappers[i].setAttribute('data-ta-theme', theme);
        applyInlineStyle(wrappers[i], settings);
      }
      applyLoadingStyle(settings);
      TA.injector.applyUserCss(settings);
    },

    // 页面级主题即时切换（SET_THEME 消息路径）：只改已渲染节点的 data-ta-theme，
    // 不读写持久设置；新注入单元的取值链不受影响（仍走 themeName）
    setTheme: function (theme) {
      if (!isValidTheme(theme)) return false;
      var wrappers = document.querySelectorAll('.ta-target-wrapper');
      for (var i = 0; i < wrappers.length; i++) wrappers[i].setAttribute('data-ta-theme', theme);
      return true;
    },

    // 遮罩学习模式全页开关（toggle-mask 快捷键路径）：documentElement 根属性切换，
    // 即时生效不发请求（样式由 C 的 themes.css 按 [data-ta-root-theme="mask"] 提供）
    toggleMaskTheme: function () {
      var root = document.documentElement;
      if (root.getAttribute('data-ta-root-theme') === 'mask') {
        root.removeAttribute('data-ta-root-theme');
        return false;
      }
      root.setAttribute('data-ta-root-theme', 'mask');
      return true;
    },

    // settings.targetStyle.customCss → <style id="ta-user-css">
    applyUserCss: function (settings) {
      var css = (settings && settings.targetStyle && settings.targetStyle.customCss) || '';
      if (!css) {
        if (userCssEl) { userCssEl.remove(); userCssEl = null; }
        return;
      }
      if (!userCssEl || !userCssEl.isConnected) {
        userCssEl = document.createElement('style');
        userCssEl.id = 'ta-user-css';
        (document.head || document.documentElement).appendChild(userCssEl);
      }
      userCssEl.textContent = String(css);
    }
  };
})();
