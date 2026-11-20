// content/walker.js —— 翻译单元（unit）收集
// 职责（协议 injectionRules A/B/C 节）：
//   1. 候选块级元素遍历（BLOCK_TAGS）+ 排除选择器管线（硬排除 / SMART 追加 / 站点规则）
//   2. 可见性过滤（getClientRects + hidden + computed display/visibility）
//   3. 直属文本收集与内联占位符映射（【8 位数字】token ↔ 内联元素深克隆源）
//   4. 阈值过滤（paragraphMinTextCount / 含字母）与段落级语言跳过
// 站点规则 selectors 存在时改为"强制根"模式：匹配容器整体作为一个翻译单元。
(function () {
  'use strict';
  var TA = globalThis.TA;
  // 依赖 core.js 的 TA.util / TA.lang
  if (!TA || !TA.util || !TA.lang || TA.__walkerLoaded) {
    if (TA && !TA.__walkerLoaded && (!TA.util || !TA.lang)) {
      console.error('[TA] content/walker.js: 前置文件 content/core.js 未加载');
    }
    return;
  }
  TA.__walkerLoaded = true;

  // 协议定稿的块级标签集。
  // v0.2 端到端实测补录 ul/ol（2026-11-15 第 1 轮修复，验收 2a）：缺列时 buildUnitText
  // 的 visit() 把嵌套 <ul>/<ol> 当"内联元素"处理（visit(child, inlineEl||child)），
  // 其直属空白文本节点触发占位符登记 → 整棵子列表进 unit.map → 回填时被 cloneClean
  // 整树克隆进译文行（与活体子列表并存造成内容重复）。列为本扩展产物排除项之外的
  // 显式块级标签后，嵌套列表的文本由其自身 li 成段。
  var BLOCK_TAGS = ['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'td', 'th', 'dt', 'dd', 'figcaption', 'blockquote', 'summary', 'caption', 'label',
    'ul', 'ol'];
  var BLOCK_SEL = BLOCK_TAGS.join(',');
  var BLOCK_SET = new Set(BLOCK_TAGS.map(function (t) { return t.toUpperCase(); }));

  // 硬排除清单（任何模式都生效，永不收集、永不注入）。
  // 例外：单元子树内命中的 code/kbd/samp/var 不整棵丢弃，而是按占位符原样保留
  // （见 buildUnitText 的 INLINE_CODE_SEL 分支），避免散文段落译文缺码。
  // 注：额外追加了 '.ta-target-wrapper'（本扩展自身产物）——否则对已注入单元重建
  // 文本时会把译文也算进原文，造成 hash 抖动与误重译（协议排除清单不含此项，属必要补充）。
  // 与公式保护（content/formula.js）的协同：TA.formula.protect 在收集前把公式节点
  // 摘出换成 ⟪mN⟫ token，本清单里的 .katex/.MathJax/mjx-container/math/script 等
  // 公式选择器兜底处理"protect 之后才渲染出来"的漏网公式（如 SPA 翻译后增量渲染），
  // 两道防线不冲突：protect 先行移除，排除清单处理残余。
  var BASE_EXCLUDE = [
    'pre', 'code', 'kbd', 'samp', 'var', 'plaintext', 'listing', 'xmp',
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'button',
    'math', 'svg', 'canvas', 'iframe', 'frame', 'object', 'embed', 'applet',
    'audio', 'video', 'picture', 'source', 'track', 'map',
    '[contenteditable]', '[translate="no"]', '[notranslate]', '.notranslate',
    '.katex', '.MathJax', '.mathjax', '.math', 'mjx-container',
    '[class^="MathJax"]', '[id^="MathJax"]',
    '[aria-hidden="true"]', '[role="presentation"]',
    '.ta-target-wrapper'
  ];

  // SMART 模式追加排除（正文识别：导航栏、页眉页脚等非核心部分）
  var SMART_EXCLUDE = [
    'nav', 'header', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[role="search"]', '[role="menubar"]', '[aria-modal="true"]',
    '.nav', '.navbar', '.navigation', '.menu', '#menu',
    '.sidebar', '#sidebar', '.sidenav',
    '.breadcrumb', '.breadcrumbs', '.pagination', '.pager',
    '.footer', '#footer', '.header', '#header',
    '.topbar', '.toolbar', '.copyright', '.legal',
    '.social-share', '.share-buttons', 'ins.adsbygoogle',
    '.advert', '.advertisement', '.skip-link', '.sr-only', '.visually-hidden'
  ];

  // 渲染时切分译文的 token 正则（协议 C 节）
  var PLACEHOLDER_RE = /【\s*(\d{8})\s*】/g;
  // hash 归一化：把占位符 id 归并成同一形态，避免 id 漂移引发误重译
  var PLACEHOLDER_NORM = /【\s*\d{8}\s*】/g;
  // 公式 token（TA.formula.protect 生成）归一：⟪m3⟫ / ⟪ m 12 ⟫ 等变体 → ⟪#⟫，
  // 防止重新 protect 时序号漂移引发 hash 误判重译
  var FORMULA_TOKEN_NORM = /⟪\s*m\s*\d+\s*⟫/g;
  // 内联代码类：在硬排除清单中（文本不译），但单元子树内命中时按占位符
  // 原样保留进原文与译文（防止 "Run `npm install` to install" 译文缺码）
  var INLINE_CODE_SEL = 'code, kbd, samp, var';

  // —— AtCoder 混合策略：纯公式/纯符号单元跳过 ——
  // 不能"含公式就整段跳过"（AtCoder 题面几乎每段都有 <var>，整段跳过等于全篇不翻）。
  // 只在 AtCoder（或测试钩子）下启用：formula.js 的 protect/protectInlineMath 已把
  // 公式换成 ⟪mN⟫ token、内联元素换成 【N】 token，本判定把 token 与数学符号/数字/
  // 标点/空白全部剔除，剩余内容若没有足够的可翻译字母，说明整段只有公式，保留原文。
  var FORMULA_TOKEN_STRIP_RE = /⟪\s*m\s*\d+\s*⟫|【\s*\d{8}\s*】/g;
  var MATH_NOISE_RE = /[\s\d≤≥<>≠≈≡⊕⊗⊙∈∉∋∑∏∫√∞±×÷→←↔⇒⇔\^_{}\[\]()（）,，;；:：=\|\/\\+*·…、。．'"“”‘’`~%#&@⟪⟫【】\-]/gu;

  function pureFormulaSkipEnabled() {
    return /(^|\.)atcoder\.jp$/i.test(location.hostname) || !!window.__TA_ATCODER_MATH_TEST__;
  }

  function isPureFormulaUnit(text) {
    var s = String(text || '')
      .replace(FORMULA_TOKEN_STRIP_RE, '')
      .replace(MATH_NOISE_RE, '');
    var letters = (s.match(/\p{L}/gu) || []).length;
    return letters < 2 || s.length < 3;
  }

  // 从 el 起沿父链检查排除选择器（到 stopAt 为止；stopAt 为 null 时查到文档根）
  function isExcluded(el, exclSel, stopAt) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      try { if (n.matches(exclSel)) return true; } catch (e) { /* 选择器异常视为未命中 */ }
      if (n === stopAt) break;
    }
    return false;
  }

  // 构造排除上下文：合并后的选择器串 + 占位符计数器
  function makeCtx(opts) {
    var scope = (opts && opts.scope) || 'smart';
    var rules = (opts && opts.rules) || { selectors: [], excludeSelectors: [] };
    var parts = BASE_EXCLUDE.slice();
    if (scope === 'smart') parts = parts.concat(SMART_EXCLUDE);
    if (Array.isArray(rules.excludeSelectors)) {
      for (var i = 0; i < rules.excludeSelectors.length; i++) {
        if (rules.excludeSelectors[i]) parts.push(rules.excludeSelectors[i]);
      }
    }
    // 计数器从 10000000 起自增，首个占位符为【10000001】，恒为 8 位十进制
    return { exclSel: parts.join(','), counter: { n: 10000000 } };
  }

  // 收集 unit 的直属文本 + 内联占位符映射：
  //   直属文本 = 子树中不属于更深块元素、也不属于排除子树的文本节点；
  //   内联包裹元素的文本以 token 代替（同一元素的多个文本节点复用同一 id）；
  //   直属 <br> → '\n'；.ta-original 透明穿透（本扩展自己的原文包裹，还原时保持文本归属不变）。
  function buildUnitText(el, ctx, forced) {
    var map = new Map();        // 占位符 id（字符串）→ 内联元素
    var elToId = new Map();     // 元素 → 已分配 id
    var textNodes = [];         // {node, inline} —— 供 replace/仅译文模式原位包裹
    var out = '';
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) { /* 取不到样式时按折叠处理 */ }
    var collapse = !(cs && (cs.whiteSpace === 'pre' || cs.whiteSpace === 'pre-wrap'));

    var visit = function (node, inlineEl) {
      var children = node.childNodes;
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        if (child.nodeType === 3) { // 文本节点
          if (inlineEl) {
            var id = elToId.get(inlineEl);
            if (!id) {
              ctx.counter.n += 1;
              id = String(ctx.counter.n);
              elToId.set(inlineEl, id);
              map.set(id, inlineEl);
              out += '【' + id + '】';
              // 同一内联元素只在首个文本节点处输出占位符：渲染端对每个 token
              // 深克隆整个元素，多 token 会克隆重复（code > span 高亮等常见形态）
            }
            textNodes.push({ node: child, inline: true });
          } else {
            var t = child.nodeValue;
            if (collapse) t = t.replace(/\s+/g, ' ');
            out += t;
            textNodes.push({ node: child, inline: false });
          }
        } else if (child.nodeType === 1) { // 元素
          // 本扩展译文容器：译文不算原文，整体跳过。但行内形态（data-ta-inline，
          // 见 injector）的原文行 .ta-original-inline 在 wrapper 内部——需穿透取出，
          // 保证注入后重建文本与注入前一致（hash 稳定，防 rewalk 误重译）。
          if (child.classList && child.classList.contains('ta-target-wrapper')) {
            var origLine = null;
            try { origLine = child.querySelector(':scope > .ta-original-inline'); }
            catch (eW) { origLine = null; }
            if (origLine) visit(origLine, inlineEl);
            continue;
          }
          if (isExcluded(child, ctx.exclSel, el)) {
            // 内联代码（code/kbd/samp/var）：文本不译，但作为占位符元素原样保留——
            // child 自身为内联包裹元素，其子树文本全部记到该元素名下（同一元素
            // 复用同一 id），渲染时由 injector 深克隆回填进译文。
            var inlineCode = false;
            try { inlineCode = child.matches(INLINE_CODE_SEL); } catch (e0) { inlineCode = false; }
            if (!inlineCode) continue;
            visit(child, inlineEl || child);
            continue;
          }
          // .ta-original / .ta-original-inline 是本扩展的原位/行内原文包裹，穿透处理
          // （文本仍是"原文"）
          if (child.classList && (child.classList.contains('ta-original') ||
              child.classList.contains('ta-original-inline'))) {
            visit(child, inlineEl);
            continue;
          }
          var tag = child.tagName;
          if (tag === 'BR') {
            // 直属 br 换行；内联元素内部的 br 由克隆元素带回，不重复表示
            if (!inlineEl) out += '\n';
            continue;
          }
          // 更深块元素的文本由其自身成段；强制根模式下块元素穿透（容器整体成段）。
          // forced 分支修复（2026-11-15 独立评审）：块级子元素按容器穿透时 inlineEl
          // 必须保持不变（传 inlineEl 而非 inlineEl || child）——原实现把块级子元素
          // 当内联元素登记占位符，.ttypography 整棵子树文本坍缩成【…】【…】占位符串
          // （无自然语言字母），collectUnits 以 noLetter 拒收 → 题面 0 单元、
          // 报"未找到可翻译的段落"。真正的行内子元素仍走 visit(child, inlineEl || child)
          // 登记占位符（深克隆回填路径不变）。
          if (BLOCK_SET.has(tag)) {
            if (!forced) continue;
            visit(child, inlineEl);
          } else {
            visit(child, inlineEl || child);
          }
        }
        // 注释等其他节点跳过
      }
    };
    visit(el, null);

    var text = TA.util.stripControlChars(out).trim();
    return { text: text, map: map, textNodes: textNodes };
  }

  TA.walker = {
    BLOCK_SEL: BLOCK_SEL,
    PLACEHOLDER_RE: PLACEHOLDER_RE,
    makeCtx: makeCtx,

    // 段落 hash：文本中占位符 id 与公式 token 归一后做 FNV-1a 32bit
    unitHash: function (text) {
      var s = String(text || '')
        .replace(FORMULA_TOKEN_NORM, '⟪#⟫')  // 公式 token 序号归一（v0.2 公式保护协同）
        .replace(PLACEHOLDER_NORM, '【#】'); // 内联元素占位符 id 归一
      return TA.util.fnv1a32(s);
    },

    // 对单个元素构建 unit 记录（不做阈值/语言/可见性过滤），供 hash 对比与原位包裹复用
    buildUnit: function (el, opts) {
      var ctx = makeCtx(opts);
      var built = buildUnitText(el, ctx, !!(opts && opts.forced));
      return {
        el: el,
        text: built.text,
        map: built.map,
        textNodes: built.textNodes,
        hash: this.unitHash(built.text),
        forced: !!(opts && opts.forced)
      };
    },

    // 收集 root 下全部待翻译单元（已按阈值/可见性/语言过滤，DOM 顺序返回）
    collectUnits: function (root, opts) {
      if (!root || root.nodeType !== 1) return [];
      var settings = (opts && opts.settings) || {};
      var scope = (opts && opts.scope) || 'smart';
      var rules = (opts && opts.rules) || { selectors: [], excludeSelectors: [] };
      var targetLang = (opts && opts.targetLang) || 'zh-CN';
      var ctx = makeCtx(opts);
      var thresholds = settings.thresholds || {};
      var minCount = typeof thresholds.paragraphMinTextCount === 'number' ? thresholds.paragraphMinTextCount : 4;
      var minWords = Number(thresholds.paragraphMinWordCount);
      var excludedLangs = (settings.langPattern && Array.isArray(settings.langPattern.excludedLangs))
        ? settings.langPattern.excludedLangs : [];
      var units = [];

      // —— 候选收集 ——
      var candidates = [];
      if (Array.isArray(rules.selectors) && rules.selectors.length) {
        // 强制根模式：站点规则指定 selectors 时只在匹配容器内收集
        var roots = [];
        var seen = new Set();
        for (var si = 0; si < rules.selectors.length; si++) {
          var sel = rules.selectors[si];
          if (!sel) continue;
          var els = null;
          try { els = root.querySelectorAll(String(sel)); } catch (e) { continue; }
          for (var ei = 0; ei < els.length; ei++) {
            if (seen.has(els[ei])) continue;
            seen.add(els[ei]);
            roots.push(els[ei]);
          }
        }
        // 去嵌套：被其他 root 包含的内层 root 跳过，避免同文重复成段
        for (var a = 0; a < roots.length; a++) {
          var nested = false;
          for (var b = 0; b < roots.length; b++) {
            if (a !== b && roots[b].contains(roots[a])) { nested = true; break; }
          }
          if (!nested) candidates.push({ el: roots[a], forced: true });
        }
      } else {
        var blocks = root.querySelectorAll(BLOCK_SEL);
        for (var bi = 0; bi < blocks.length; bi++) {
          candidates.push({ el: blocks[bi], forced: false });
        }
      }

      // —— 逐候选过滤 ——
      for (var ci = 0; ci < candidates.length; ci++) {
        var cand = candidates[ci];
        var el = cand.el;
        if (el.hasAttribute('data-ta')) continue;            // 已翻译/已标记段落
        if (isExcluded(el, ctx.exclSel, null)) continue;      // 排除管线（含祖先链）
        // 可见性：有布局盒且未被隐藏
        if (el.hidden) continue;
        var rects = null;
        try { rects = el.getClientRects(); } catch (e) { /* 忽略 */ }
        if (!rects || rects.length === 0) continue;
        var cs = null;
        try { cs = getComputedStyle(el); } catch (e) { /* 忽略 */ }
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden') continue;
        // 直属文本 + 占位符
        var built = buildUnitText(el, ctx, cand.forced);
        var text = built.text;
        // AtCoder 混合策略：纯公式/纯符号单元（如 <li><var>1 ≤ N ≤ 3000</var></li>）
        // 保留原文不翻译；其余含公式段落仍正常收集（去掉公式 token 后仍有散文）。
        if (pureFormulaSkipEnabled() && isPureFormulaUnit(text)) continue;
        if (text.length < minCount) continue;                 // trim 已在构建时完成
        if (!/\p{L}/u.test(text)) continue;                   // 纯数字/符号段跳过
        if (minWords > 1) {
          var words = (text.match(/[\p{L}\p{N}]+/gu) || []).length;
          if (words < minWords) continue;
        }
        // 段落级语言跳过：与目标语言同基础语言、或在 excludedLangs 中
        var det = TA.lang.detectParagraphLang(text);
        if (det) {
          if (excludedLangs.indexOf(det) !== -1) continue;
          if (TA.lang.baseLang(det) === TA.lang.baseLang(targetLang)) continue;
        }
        units.push({
          el: el,
          text: text,
          map: built.map,
          textNodes: built.textNodes,
          hash: this.unitHash(text),
          forced: cand.forced
        });
      }
      return units;
    }
  };
})();
