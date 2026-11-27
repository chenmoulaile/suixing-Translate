// shared/markdown.js —— 共享 Markdown + 数学公式渲染基座
// 供文档翻译页(doc/doc.html)与划词/侧栏(content scripts)共同复用。
// 依赖本地 vendor/markdown-it.min.js (UMD: globalThis.markdownit) 与
// vendor/katex.min.js (UMD: globalThis.katex)，均离线打包，禁止 CDN。
// 暴露 API：TA.markdown.render(text) / renderElement(el) / isAvailable()
(function () {
  'use strict';

  var TA = globalThis.TA = globalThis.TA || {};

  // Node 下允许直接 require 本地 vendor（浏览器 content script 不进入此分支）。
  if (typeof module !== 'undefined' && module.exports) {
    if (!globalThis.markdownit) {
      try { globalThis.markdownit = require('../vendor/markdown-it.min.js'); } catch (e) {}
    }
    if (!globalThis.katex) {
      try { globalThis.katex = require('../vendor/katex.min.js'); } catch (e) {}
    }
  }

  var seq = 0;
  var mdInstance = null;

  function hasMarkdownIt() {
    return typeof globalThis.markdownit === 'function';
  }
  function hasKatex() {
    return !!(globalThis.katex && typeof globalThis.katex.renderToString === 'function');
  }

  // 每次渲染生成唯一 token 前缀，避免与译文里已有的 ⟪…⟫ 文本冲突。
  function newPrefix(text) {
    var p;
    do {
      seq += 1;
      p = '⟪MT' + seq + '_' + ((Math.random() * 1e6) | 0) + '-';
    } while (text.indexOf(p) >= 0);
    return p;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMath(tex, display) {
    var opts = {
      displayMode: !!display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'htmlAndMathml',
      macros: {}
    };
    if (hasKatex()) {
      try {
        return globalThis.katex.renderToString(tex, opts);
      } catch (e) {
        // KaTeX 抛错时降级为转义源码，不影响其余译文。
      }
    }
    // 无 KaTeX：等宽展示原始 TeX，绝不把公式喂给翻译器。
    return '<code class="ta-math-fallback">' + escapeHtml(tex) + '</code>';
  }

  // 先块后行抽取数学。抽出的 token 是惰性文本，markdown-it 不会改写其中的
  // 反斜杠/下划线/星号；Markdown 解析完成后再一次性回填 KaTeX HTML。
  function extractMath(text, prefix, slots) {
    function stash(tex, display) {
      var token = prefix + (display ? 'B' : 'I') + slots.length + '⟫';
      slots.push({ token: token, html: renderMath(tex, display) });
      return token;
    }

    var out = text;

    // 1) 块级 $$...$$（独占一行、可跨行）
    out = out.replace(/(^|\n)[ \t]*\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?=\n|$)/g,
      function (whole, lead, tex) {
        return '\n\n' + stash(tex, true) + '\n\n';
      });

    // 2) 块级 \[...\]（别名，可跨行）
    out = out.replace(/\\\[([\s\S]+?)\\\]/g, function (whole, tex) {
      return '\n\n' + stash(tex, true) + '\n\n';
    });

    // 3) 行内 \(...\)（别名，不跨行）
    out = out.replace(/\\\(([^\n]+?)\\\)/g, function (whole, tex) {
      return stash(tex, false);
    });

    // 4) 行内 $...$（不跨行、非空）
    out = out.replace(/\$([^$\n]+?)\$/g, function (whole, tex) {
      return stash(tex, false);
    });

    return out;
  }

  function getMd() {
    if (mdInstance) return mdInstance;
    var MarkdownIt = globalThis.markdownit;
    mdInstance = new MarkdownIt({ html: false, linkify: true, breaks: false });

    // 外链安全属性（沙箱页面尤其必要）；原 HTML 已被 html:false 转义。
    var defaultLinkOpen = mdInstance.renderer.rules.link_open || function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };
    mdInstance.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      tokens[idx].attrSet('target', '_blank');
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    return mdInstance;
  }

  function render(text) {
    if (text === null || text === undefined) return '';
    var src = String(text);
    if (!hasMarkdownIt()) return escapeHtml(src);

    var slots = [];
    var masked = extractMath(src, newPrefix(src), slots);
    var html = getMd().render(masked);

    for (var i = 0; i < slots.length; i++) {
      html = html.split(slots[i].token).join(slots[i].html);
    }
    return html;
  }

  function renderElement(el) {
    if (!el) return el;
    if (typeof el.innerHTML !== 'string') return el;
    el.innerHTML = render(el.textContent || '');
    return el;
  }

  TA.markdown = {
    // 返回渲染后的 HTML 字符串（含行内 $...$ 与块级 $$...$$ 的 KaTeX 结果）
    render: render,
    // 以 el 的 textContent 为源，原地渲染写入 el.innerHTML
    renderElement: renderElement,
    // 兼容别名：划译侧栏规格以 renderInto(el, src) 调用
    renderInto: function (el, src) {
      if (!el) return el;
      if (typeof el.innerHTML !== 'string') return el;
      el.innerHTML = render(src);
      return el;
    },
    // markdown-it 是否就绪（KaTeX 缺失时数学降级为转义源码，仍视为可用）
    isAvailable: hasMarkdownIt
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TA.markdown;
  }
})();
