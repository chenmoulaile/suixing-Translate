/* doc/pdf-formula.js —— PDF 文档公式占位 / 还原 / 渲染
 *
 * 与 content/formula.js 独立：doc.html 不注入 content script，PDF 解析出来的是
 * 纯字符串，没有 DOM 节点可供摘出。本模块在「切分与送 MT 之前」把公式换成
 * ⟪mN⟫ 占位（与 5 个 AI 适配器 prompt 已声明的 token 同形），译文回来后还原，
 * 再由 TA.markdown 渲染。绝不把 TeX 源码送进翻译器。
 *
 * 暴露 globalThis.TA.pdfFormula；经典脚本、无构建、无外部网络。
 */
(function () {
  'use strict';

  var TA = globalThis.TA = globalThis.TA || {};
  var seq = 0; // 文档内全局唯一，跨段不重复

  function reset() { seq = 0; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // source 保存完整定界串（含 $ / $$ / \[ / \(），还原后交给 TA.markdown 再渲染。
  function stripDelimiters(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (/^\$\$[\s\S]+\$\$$/.test(s)) return s.slice(2, -2).trim();
    if (/^\\\[[\s\S]+\\\]$/.test(s)) return s.slice(2, -2).trim();
    if (/^\\\([^\n]+\\\)$/.test(s)) return s.slice(2, -2).trim();
    if (/^\$[^$\n]+\$$/.test(s)) return s.slice(1, -1).trim();
    return s;
  }

  // 优先 KaTeX；无 KaTeX（或渲染抛错）时降级为等宽显示原始 TeX，绝不喂给 MT。
  function renderFormulaHTML(source, displayMode) {
    var tex = stripDelimiters(source);
    var katex = globalThis.katex;
    if (katex && typeof katex.renderToString === 'function') {
      try {
        return katex.renderToString(tex, {
          displayMode: !!displayMode,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          output: 'htmlAndMathml'
        });
      } catch (e) { /* 落到下方等宽兜底 */ }
    }
    return '<code class="pdf-formula">' + escapeHtml(tex) + '</code>';
  }

  // 按文档序识别公式片段。定界符优先；无定界符的数学密集串作为 best-effort 补充。
  function detectFormulaSpan(text) {
    var src = String(text == null ? '' : text);
    var out = [];
    var taken = [];

    function collides(s, e) {
      for (var i = 0; i < taken.length; i++) {
        if (s < taken[i][1] && e > taken[i][0]) return true;
      }
      return false;
    }

    var patterns = [
      { re: /\$\$[\s\S]+?\$\$/g, display: true },
      { re: /\\\[[\s\S]+?\\\]/g, display: true },
      { re: /\\\([^\n]+?\\\)/g, display: false },
      { re: /\$[^$\n]+?\$/g, display: false }
    ];
    patterns.forEach(function (p) {
      p.re.lastIndex = 0;
      var m;
      while ((m = p.re.exec(src)) !== null) {
        if (!m[0].trim()) continue;
        var s = m.index;
        var e = s + m[0].length;
        if (collides(s, e)) continue;
        taken.push([s, e]);
        out.push({
          start: s, end: e, source: m[0],
          tex: stripDelimiters(m[0]), displayMode: p.display
        });
      }
    });

    // 裸数学串：含数学运算符/符号且含字母数字，长度 >=3。保守判定，避免误吃正文。
    var bareRe = /[^\s，。；、,;:：]{1,32}/g;
    var mathMark = /[=≈∑∫√∞∂∇≤≥≠±]/;
    var bm;
    while ((bm = bareRe.exec(src)) !== null) {
      var raw = bm[0];
      if (!mathMark.test(raw) || !/[A-Za-z0-9]/.test(raw)) continue;
      var trimmed = raw.replace(/^[^\w∑∫√∞∂∇≤≥≠±]+|[^\w∑∫√∞∂∇≤≥≠±]+$/g, '');
      if (trimmed.length < 3) continue;
      var s2 = bm.index + raw.indexOf(trimmed);
      var e2 = s2 + trimmed.length;
      if (collides(s2, e2)) continue;
      taken.push([s2, e2]);
      out.push({ start: s2, end: e2, source: trimmed, tex: trimmed, displayMode: false });
    }

    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  // 生成一个或多个 ⟪mN⟫ 槽位；从后往前替换，避免前面的替换改变后面的下标。
  function maskFormulas(text, bbox) {
    var spans = detectFormulaSpan(text);
    var out = String(text == null ? '' : text);
    var slots = [];
    for (var i = spans.length - 1; i >= 0; i--) {
      var sp = spans[i];
      var token = '⟪m' + (seq++) + '⟫';
      slots.push({
        token: token,
        source: sp.source,
        tex: sp.tex,
        displayMode: sp.displayMode,
        bbox: bbox || null
      });
      out = out.slice(0, sp.start) + token + out.slice(sp.end);
    }
    slots.reverse(); // 回到文档顺序
    return { masked: out, slots: slots };
  }

  // 译文回填：模糊匹配容忍 MT 改括号/加空格（⟪m3⟫ → (m3) / 【m 3】）。
  function unmaskFormulas(translated, slots) {
    var out = String(translated == null ? '' : translated);
    if (!slots || !slots.length) return out;
    var byId = {};
    slots.forEach(function (s) { byId['m' + s.token.replace(/\D/g, '')] = s; });

    out = out.replace(/[⟪({[«<【]\s*m\s*(\d+)\s*[⟫)}\]»>】]/g, function (whole, num) {
      var rec = byId['m' + num];
      return rec ? rec.source : whole;
    });
    // MT 丢掉一侧括号时的兜底：仅替换本段登记过的 id。
    out = out.replace(/\bm\s*(\d+)\b/g, function (whole, num) {
      var rec = byId['m' + num];
      return rec ? rec.source : whole;
    });
    return out;
  }

  // 供 DOM 逐块渲染使用：公式块直接给 KaTeX，文本块保持纯文本节点。
  function splitByFormulas(text) {
    var src = String(text == null ? '' : text);
    var spans = detectFormulaSpan(src);
    var chunks = [];
    var pos = 0;
    spans.forEach(function (sp, i) {
      if (sp.start > pos) chunks.push({ type: 'text', value: src.slice(pos, sp.start) });
      chunks.push({
        type: 'formula', value: sp.source, tex: sp.tex,
        displayMode: sp.displayMode, index: i
      });
      pos = sp.end;
    });
    if (pos < src.length) chunks.push({ type: 'text', value: src.slice(pos) });
    return chunks;
  }

  TA.pdfFormula = {
    reset: reset,
    detectFormulaSpan: detectFormulaSpan,
    maskFormulas: maskFormulas,
    unmaskFormulas: unmaskFormulas,
    renderFormulaHTML: renderFormulaHTML,
    splitByFormulas: splitByFormulas
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TA.pdfFormula;
})();
