// content/formula.js —— 公式保护引擎（v0.2 新增，A 排版引擎改造员）
// 职责（formulaProtection 定稿）：
//   settle   —— 等待 MathJax/KaTeX 异步渲染稳定（稳定轮询为主方案 + 库信号加速 + 超时兜底）
//   protect  —— 翻译前：公式节点摘出，原位换成 ⟪mN⟫ 占位符 token 随句送 MT
//   restore  —— 翻译后：token（含 MT 改写变体）模糊匹配，公式节点原位回归
//   restoreAll —— 兜底：未消费公式全部回归原位（显示原文/翻页/中途取消时调用）
//   rerender —— v2/KaTeX 重渲染 best-effort（v3 DOM 不留源码，必须靠占位符保护）
// 加载顺序：manifest js 数组中排在 walker.js 之前（仅依赖 TA 命名空间存在）。
// 与 walker 的协同：BASE_EXCLUDE 中的 .katex/.MathJax/mjx-container/math 等是 protect
// 漏网公式（如 SPA 翻译后才渲染出的公式）的第二道防线；protect 先行移除公式节点，
// 排除清单处理残余，二者不冲突。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || TA.__formulaLoaded) return;
  TA.__formulaLoaded = true;

  // 选择器清单（照需求实证 dump 逐字采纳）：v2 源码兜底在 script[type^=math/tex]，
  // v3/v4 DOM 不留源码（mjx-container），KaTeX 源码在 .katex-mathml annotation，
  // 原生 MathML 放最后靠祖先去重；.notranslate/[translate=no] 是站点自标。
  var FORMULA_SELECTORS = [
    'span.MathJax', 'span.MathJax_Preview', 'div.MathJax_Display',
    'script[type^="math/tex"]',        // MathJax v2（Codeforces 2.7.9 自托管，TeX 源码兜底在此）
    'mjx-container',                   // MathJax v3/v4（DOM 不留源码，必须占位符保护）
    'span.katex',                      // KaTeX（源码在 .katex-mathml annotation[x-tex]，可取回）
    'math',                            // 原生 MathML——放最后，靠祖先去重
    '.notranslate', '[translate="no"]' // 站点自标
  ];
  var FORMULA_SEL = FORMULA_SELECTORS.join(',');

  // AtCoder 内联数学原语（var/sup/sub）：站点级保护，故意不进全局 FORMULA_SELECTORS——
  // 否则所有站点的上标/变量记号（1st、x2）都会被误当公式挖空。仅 protectInlineMath
  // 在 AtCoder（或测试钩子）下扫描这些元素，登记进同一个 placeholders Map。
  var INLINE_MATH_SELECTORS = ['var', 'sup', 'sub'];
  var INLINE_MATH_SEL = INLINE_MATH_SELECTORS.join(',');

  // 还原期 token 模糊匹配：容忍 MT 改括号/加空格（⟪m3⟫ → (m3)/【m 3】等变体）。
  // 仅当 id 在 protect 登记过才动文本，避免误伤正文自带的 "(m3)" 类记号。
  var TOKEN_RE = /[⟪({[«<【]\s*m\s*(\d+)\s*[⟫)}\]»>】]/g;

  // 公式占位符登记表：id '⟪mN⟫' → {node, parent, next}（detach 前记录，供兜底回滚）
  var placeholders = new Map();
  // 本轮 restore 实际触碰过的 [data-ta] 单元（供 main.js 刷新 data-ta-hash，
  // 否则还原后重建文本与收集时含 token 的文本不一致，会触发 rewalk 误重译死循环）
  var touchedUnits = [];
  var seq = 0;              // token 序号跨 protect 调用持续自增，保证 id 全页唯一
  var lastSettled = false;  // 最近一次 settle 结果（GET_PAGE_STATE/GET_FEATURES 自检用）

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Codeforces 判据：v2 转换完成后题面里的 $$$ 定界符消失（实测直接判据），
  // 轮询时无 $$$ 且计数稳定即可提前 settled，省去固定等待
  function isCodeforces() {
    return /(^|\.)codeforces\.com$/i.test(location.hostname);
  }

  // 各选择器命中计数（稳定轮询的观测向量）
  function countAll(root) {
    var counts = [];
    for (var i = 0; i < FORMULA_SELECTORS.length; i++) {
      var n = 0;
      try { n = root.querySelectorAll(FORMULA_SELECTORS[i]).length; } catch (e) { n = 0; }
      counts.push(n);
    }
    return counts;
  }

  function deepEq(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // 单个公式/内联数学节点的摘出：protect() 与 protectInlineMath() 共用，避免逻辑分叉。
  // 打译禁标记 → 分配 token → 登记 placeholders（含 token 文本节点本尊，供 restoreAll
  // 原位替换零残留）→ 原位换成 token 文本。isInlineMath=true 时额外跳过 code 与嵌套
  // var/sup/sub 内层（<sup><var>M</var></sup> 只保护外层，杜绝 orphan token）。
  function protectOne(el, skipSel, isInlineMath) {
    if (el.closest('pre')) return false;                       // 代码块整段不动（原 protect 行为）
    if (isInlineMath && el.closest('code')) return false;      // 内联代码里的数学记号不动
    if (el.parentElement && el.parentElement.closest(FORMULA_SEL)) return false; // 去重根：只保护最外层
    if (isInlineMath && el.parentElement && el.parentElement.closest(INLINE_MATH_SEL)) return false;
    if (skipSel) {
      try { if (el.closest(skipSel)) return false; } catch (e) { /* 选择器异常视为不跳过 */ }
    }
    try {
      el.setAttribute('translate', 'no');
      el.classList.add('notranslate');                          // 自卫：MT 端不再二次触碰
    } catch (e) { /* 只读节点（如 SVG 内部）忽略 */ }
    var id = '⟪m' + (seq++) + '⟫';                             // 非字母符号+数字 token
    var tokenNode = document.createTextNode(' ' + id + ' ');
    placeholders.set(id, {
      node: el, parent: el.parentNode, next: el.nextSibling,
      token: tokenNode, inline: !!isInlineMath
    });
    try {
      el.parentNode.replaceChild(tokenNode, el);
    } catch (e) {
      placeholders.delete(id); // 替换失败（节点已脱管等）：撤销登记
      return false;
    }
    return true;
  }

  // 译文 wrapper 内重复 token 的公式克隆：剥除 id 防 DOM id 重复（与 injector.cloneClean
  // 同语义，但 formula.js 独立加载，不依赖 injector 是否就绪）。
  function cloneForWrapper(node) {
    var c = node.cloneNode(true);
    if (c.nodeType === 1) {
      if (c.hasAttribute && c.hasAttribute('id')) c.removeAttribute('id');
      try {
        var withIds = c.querySelectorAll('[id]');
        for (var i = 0; i < withIds.length; i++) withIds[i].removeAttribute('id');
      } catch (e) { /* 无 querySelectorAll 的实现忽略 */ }
    }
    return c;
  }

  // 内联数学兜底：MT（如 deepl-free 在数学密集句中）可能直接丢弃 ⟪mN⟫ token，
  // 此时译文 wrapper 里无 token 触发下面的克隆分支，数学只留在原文位。对本轮已还原的
  // inline 数学记录，检查其所属 wrapper 的 .ta-target-inner 是否已有该 token 的克隆，
  // 没有则补一个。仅 inline 数学参与——KaTeX/MathJax 等既有公式行为逐字不变。
  function fallbackInlineClones(consumed) {
    consumed.forEach(function (rec, id) {
      if (!rec.inline) return;
      var node = rec.node;
      if (!node || !node.isConnected) return;
      // 常规 after 模式：.ta-original 是 wrapper 的兄弟（同在 unit 内），故先找
      // [data-ta] 单元再取其直属 wrapper；flex/grid 外插兄弟另外兜底。
      var unitEl = node.closest && node.closest('[data-ta]');
      var w = null;
      if (unitEl) {
        try { w = unitEl.querySelector(':scope > .ta-target-wrapper'); } catch (e) { w = null; }
        w = w || unitEl.querySelector('.ta-target-wrapper');
        if (!w && unitEl.parentElement && unitEl.hasAttribute('data-ta-id')) {
          try {
            w = unitEl.parentElement.querySelector(
              ':scope > .ta-target-wrapper[data-ta-for="' + unitEl.getAttribute('data-ta-id') + '"]');
          } catch (e) { w = null; }
        }
      }
      if (!w) return;
      var inner = null;
      try { inner = w.querySelector(':scope > .ta-target-inner'); } catch (e) { inner = w.querySelector('.ta-target-inner'); }
      if (!inner) return;
      var key = id.slice(2, -2); // ⟪m0⟫ → m0
      try { if (inner.querySelector('[data-ta-math="' + key + '"]')) return; } catch (e) { /* 忽略 */ }
      var c = cloneForWrapper(node);
      c.setAttribute('data-ta-math', key);
      inner.appendChild(c);
      trackTouched(c);
    });
  }

  TA.formula = {
    // —— 等待公式渲染稳定 ——
    // root： Element（通常 document.body）；timeoutMs 默认 8000。
    // 主方案 = 每 400ms 轮询各选择器命中计数，连续 2 次相同且无 .MathJax_Processing
    // 中间态 → settled。库信号（MathJax.startup.promise，v3/v4）仅作加速：
    // 本扩展 run_at=document_idle，v2 的 StartupHook("End") 大概率已错过发布，
    // v2 不回调迟到注册，故不能依赖库回调。超时强行返回 false 进入提取（兜底）。
    settle: async function (root, timeoutMs) {
      timeoutMs = timeoutMs || 8000;
      if (!root) { lastSettled = true; return true; }
      // v3/v4 加速信号：startup.promise 就绪即大部分公式已排版（不等待也可靠轮询兜底）
      try {
        if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
          await window.MathJax.startup.promise.catch(function () {});
        }
      } catch (e) { /* 库信号不可得，走轮询 */ }
      var t0 = Date.now();
      var prev = countAll(root);
      var stable = 0;
      var cf = isCodeforces();
      while (Date.now() - t0 < timeoutMs) {
        await sleep(400);
        var cur = countAll(root);
        var doc = root.ownerDocument || document;
        var processing = false;
        try { processing = !!doc.querySelector('.MathJax_Processing'); } catch (e) { processing = false; }
        var countsStable = deepEq(cur, prev);
        if (countsStable && !processing) {
          stable += 1;
          // Codeforces 附加判据：$$$ 已从文本消失 + 计数稳定 → 提前 settled
          if (cf) {
            var txt = '';
            try { txt = root.textContent || ''; } catch (e) { txt = ''; }
            if (txt.indexOf('$$$') === -1) { lastSettled = true; return true; }
          }
          if (stable >= 2) { lastSettled = true; return true; } // 连续 2 次相同 → settled
        } else {
          stable = 0;
        }
        prev = cur;
      }
      lastSettled = false; // 超时：强行进入提取（protect 仍会保护当前已存在的公式）
      return false;
    },

    // —— 翻译前：公式 → ⟪mN⟫ 占位符 ——
    // root：扫描根；opts.skipInside：选择器串（如 '[data-ta]'），命中祖先的公式跳过——
    // rewalk 增量补译时只保护新增/变更内容，已翻译单元内的公式不动（否则其 token
    // 会一直留在已翻译单元的原文里）。token 随句送 MT（'where ⟪m3⟫ is…'），
    // 上下文完整，避免挖洞式跳过破坏语义。
    protect: function (root, opts) {
      if (!root) return 0;
      var skipSel = (opts && opts.skipInside) || null;
      var els;
      try { els = root.querySelectorAll(FORMULA_SEL); } catch (e) { return 0; }
      var n = 0;
      for (var i = 0; i < els.length; i++) {
        if (protectOne(els[i], skipSel, false)) n += 1;
      }
      return n;
    },

    // —— 翻译前（AtCoder 专用）：内联数学 var/sup/sub → ⟪mN⟫ 占位符 ——
    // 与 protect() 共用 protectOne，登记进同一个 placeholders Map，因此 restore /
    // restoreAll / refreshTouchedHashes 无需改动即可覆盖。仅 AtCoder（或测试钩子
    // window.__TA_ATCODER_MATH_TEST__）启用：var/sup/sub 是通用 HTML 元素，
    // 全局保护会误伤所有站点的上标与变量记号。
    protectInlineMath: function (root, opts) {
      if (!root) return 0;
      if (!/(^|\.)atcoder\.jp$/i.test(location.hostname) &&
          !window.__TA_ATCODER_MATH_TEST__) return 0;
      var skipSel = (opts && opts.skipInside) || null;
      var els;
      try { els = root.querySelectorAll(INLINE_MATH_SEL); } catch (e) { return 0; }
      var n = 0;
      for (var i = 0; i < els.length; i++) {
        if (protectOne(els[i], skipSel, true)) n += 1;
      }
      return n;
    },

    // —— 翻译后：token → 公式原位还原 ——
    // 作用域覆盖原文 DOM 与译文 wrapper 内的 token（TreeWalker 全树扫描）。
    // 同一 id 的公式节点只有一个：原文位置优先（文档序靠前先还原）。译文中重复的
    // 同 id token：inline 数学插克隆（公式进译文），KaTeX/MathJax 沿用删除路径
    //（保持 .katex DOM 逐字节不变）；两条路径均做到 token 零残留。
    restore: function (root) {
      var scanRoot = root || document;
      var doc = scanRoot.ownerDocument || document;
      var walker;
      try { walker = doc.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, null); }
      catch (e) { return; }
      // 先收集后处理：splitText 会破坏遍历中的 walker
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      var consumed = new Map(); // id → rec（原文位真身，供 wrapper 内重复 token 插克隆/兜底）
      for (var i = 0; i < nodes.length; i++) {
        var tn = nodes[i];
        if (!tn || !tn.parentNode) continue;
        TOKEN_RE.lastIndex = 0;
        var m;
        while ((m = TOKEN_RE.exec(tn.data)) !== null) {
          var id = '⟪m' + m[1] + '⟫';
          var rec = placeholders.get(id);
          if (rec) {
            var head = tn.splitText(m.index);        // head = token 段
            var after = head.splitText(m[0].length); // after = token 后段
            head.parentNode.replaceChild(rec.node, head); // 原文位优先：真身回归
            placeholders.delete(id);
            consumed.set(id, rec);
            trackTouched(rec.node);
            tn = after;
            TOKEN_RE.lastIndex = 0;
          } else if (consumed.has(id)) {
            // 同一 token 在译文 wrapper 内重复出现：原文位已是真身。
            var crec = consumed.get(id);
            var head2 = tn.splitText(m.index);
            var after2 = head2.splitText(m[0].length);
            if (crec.inline) {
              // AtCoder 内联数学：插克隆，让公式同时出现在译文句子里。
              var c = cloneForWrapper(crec.node);
              c.setAttribute('data-ta-math', id.slice(2, -2));
              head2.parentNode.replaceChild(c, head2);
            } else {
              // KaTeX/MathJax：沿用旧删除路径——既有验收要求 .katex DOM 逐字节不变，
              // 不能额外增一个克隆节点（公式仍在原文位，token 零残留）。
              head2.parentNode.removeChild(head2);
            }
            tn = after2;
            TOKEN_RE.lastIndex = 0;
          }
          // 未知 id（正文原本就有的 "(m3)" 类记号）：保留不动，避免误删正文
        }
      }
      // MT 直接丢 token 时没有重复 token 可克隆 → inline 数学走兜底补克隆（不影响 KaTeX）
      fallbackInlineClones(consumed);
    },

    // —— 兜底还原：未消费公式全部回归原位 ——
    // 显示原文/翻页/中途取消时调用（main.js restoreAll 在 injector.restoreAll 之前）；
    // 也用于"收集到 0 段"等提前退出的路径，防止 token 留在正文里。
    // 2026-11-15 独立评审修复（两点）：
    //   ① 逆文档序回插：MathJax v2 每条公式是 MathJax_Preview + span.MathJax +
    //      script[type=math/tex] 三连相邻节点，protect 按文档序全部摘出后，正序回插时
    //      前者的 rec.next 指向当时仍脱管的兄弟节点（本批尚未回插）→ insertBefore 抛
    //      NotFoundError 被静默吞掉 → preview/span.MathJax 永久丢失。逆序回插时
    //      rec.next 必已回归原位。
    //   ② 优先按 token 文本节点原位替换（replaceChild(公式, token)）：与 restore()
    //      同路径，兜底回插后 token 零残留；token 失效才退回 insertBefore(rec.next)，
    //      再失效退回 parent.appendChild。
    restoreAll: function () {
      var recs = [];
      placeholders.forEach(function (rec) { recs.push(rec); }); // Map 保持插入序 = 文档序
      for (var i = recs.length - 1; i >= 0; i--) {
        var rec = recs[i];
        if (rec.node.isConnected) continue; // 已被 restore 消费
        if (!rec.parent || !rec.parent.isConnected) continue;
        try {
          if (rec.token && rec.token.isConnected &&
              rec.token.parentNode === rec.parent &&
              rec.token.nodeValue && rec.token.nodeValue.indexOf('⟪') !== -1) {
            rec.parent.replaceChild(rec.node, rec.token); // token 原位替换，零残留
          } else if (rec.next && rec.next.isConnected) {
            rec.parent.insertBefore(rec.node, rec.next);
          } else {
            rec.parent.appendChild(rec.node);
          }
        } catch (e) { /* 极端脱管场景：放弃单点，不影响其余 */ }
      }
      placeholders.clear();
    },

    // —— 重渲染兜底（best-effort，验收不强制）——
    // v2：MathJax.Hub.Queue 重排版；KaTeX：用 annotation 里的 TeX 源码重画；
    // v3：DOM 无源码，无法重渲染——这正是 v3 站点必须走占位符保护的硬理由。
    rerender: function (root) {
      var target = root || document.body;
      if (!target) return;
      try {
        if (window.MathJax && window.MathJax.Hub && typeof window.MathJax.Hub.Queue === 'function') {
          window.MathJax.Hub.Queue(['Typeset', window.MathJax.Hub, target]);
          return;
        }
      } catch (e) { /* 继续尝试 KaTeX */ }
      try {
        if (window.katex && typeof window.katex.render === 'function') {
          var spans = target.querySelectorAll('span.katex');
          for (var i = 0; i < spans.length; i++) {
            var sp = spans[i];
            var src = sp.querySelector('annotation[encoding="application/x-tex"]');
            if (!src || !src.textContent) continue;
            var host = document.createElement('span');
            sp.parentNode.replaceChild(host, sp);
            try { window.katex.render(src.textContent, host, { displayMode: false }); }
            catch (e2) { host.parentNode.replaceChild(sp, host); } // 重画失败：还原旧节点
          }
        }
      } catch (e) { /* best-effort */ }
    },

    // 自检数据（GET_PAGE_STATE / GET_FEATURES 用）：settled=最近一次 settle 结果；
    // protectedCount=当前登记（未消费）的占位符数量
    getStats: function () {
      return { settled: !!lastSettled, protectedCount: placeholders.size };
    },

    // 取出并清空"本轮 restore 触碰过的单元"集合（main.js 在 restore 后刷新 hash 用）
    takeTouchedUnits: function () {
      var out = touchedUnits;
      touchedUnits = [];
      return out;
    }
  };

  // 公式节点回归后，记录其所在的已翻译单元（最近 [data-ta] 祖先）
  function trackTouched(node) {
    try {
      var unitEl = node.closest && node.closest('[data-ta]');
      if (unitEl && touchedUnits.indexOf(unitEl) === -1) touchedUnits.push(unitEl);
    } catch (e) { /* 忽略 */ }
  }
})();
