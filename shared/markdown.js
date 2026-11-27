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

  // 先保护代码（围栏代码块 / 行内代码），再抽取数学。代码段只把数学敏感字符
  // （$ 与 \）换成占位符，其余字符原样交给 markdown-it，既保住代码的块级/行内
  // 结构与 HTML 转义，又让代码里的 $…$ 不被当公式；渲染完成后原样还原。
  // 抽出的数学 token 是惰性文本，markdown-it 不会改写其中的反斜杠/下划线/星号；
  // Markdown 解析完成后再一次性回填 KaTeX HTML。
  function extractMath(text, prefix, slots) {
    // 统一换行为 LF：CRLF 时 `.`/`$` 行尾判断会失效，围栏识别不出来。
    text = text.replace(/\r\n?/g, '\n');
    // 每次渲染唯一的前缀保证占位符不会与译文/代码内容碰撞。
    var CODE_DOLLAR = prefix + 'CD⟫';
    var CODE_BACKSLASH = prefix + 'CB⟫';
    var CODE_TICK = prefix + 'CT⟫';
    var ESC_DOLLAR = prefix + 'ED⟫';

    function stash(tex, display) {
      var token = prefix + (display ? 'B' : 'I') + slots.length + '⟫';
      // 数学里的 \$ 交给 KaTeX 当字面美元符处理（占位符含字母会干扰公式）。
      slots.push({ token: token, html: renderMath(tex.split(ESC_DOLLAR).join('\\$'), display) });
      return token;
    }
    // 代码段掩码：$ 与 \ 一定掩掉；围栏内容额外掩掉反引号，防止内容里的 ``` 与
    // 外部反引号配对，把后面的正文误判成行内代码（围栏行本身不掩，否则结构失效）。
    function maskCode(seg, maskTicks) {
      var out = seg.replace(/\$/g, CODE_DOLLAR).replace(/\\/g, CODE_BACKSLASH);
      return maskTicks ? out.replace(/`/g, CODE_TICK) : out;
    }
    function maskFenced(text) {
      var lines = text.split('\n');
      var open = null;
      for (var i = 0; i < lines.length; i++) {
        var m = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(lines[i]);
        if (open) {
          // 关闭围栏行本身必须保留反引号，否则 markdown-it 认不出闭合；内容行才掩反引号。
          var closes = !!m && m[1].charAt(0) === open.charAt(0) && m[1].length >= open.length &&
              !/\S/.test(m[2]);
          lines[i] = maskCode(lines[i], !closes);
          if (closes) open = null;
        } else if (m) {
          // CommonMark：反引号围栏的 info string 不得含反引号，否则不是开围栏。
          if (m[1].charAt(0) === '`' && m[2].indexOf('`') >= 0) continue;
          open = m[1];
          lines[i] = maskCode(lines[i], false);
        }
      }
      return lines.join('\n');
    }

    var out = maskFenced(text);
    // 行内代码（成对的 `…`，CommonMark 允许跨行）：同样只掩码 $ 与 \。
    // 长度上限 400 防止孤立反引号跨段吞掉大段正文；围栏内容里的反引号已在上一步掩掉，
    // 不会与围栏外的反引号配对。
    out = out.replace(/(`+)([^`]{0,400}?)\1/g, function (whole) { return maskCode(whole, false); });
    // 转义美元符 \$：先占位，避免参与数学配对；普通文本处回填为 $。
    out = out.replace(/\\\$/g, ESC_DOLLAR);

    // 1) 块级 $$...$$（独占一行、可跨行）
    out = out.replace(/(^|\n)[ \t]*\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$[ \t]*(?=\n|$)/g,
      function (whole, lead, tex) {
        return '\n\n' + stash(tex, true) + '\n\n';
      });

    // 2) 行内 $$...$$：同一行内成对出现时按块级公式渲染，避免残留两个游离 $。
    out = out.replace(/\$\$[ \t]*([^\n$]+?)[ \t]*\$\$/g, function (whole, tex) {
      tex = tex.trim();
      if (!tex) return whole;
      return stash(tex, true);
    });

    // 3) 块级 \[...\]（别名，可跨行）
    out = out.replace(/\\\[([\s\S]+?)\\\]/g, function (whole, tex) {
      return '\n\n' + stash(tex, true) + '\n\n';
    });

    // 4) 行内 \(...\)（别名，不跨行）
    out = out.replace(/\\\(([^\n]+?)\\\)/g, function (whole, tex) {
      return stash(tex, false);
    });

    // 5) 行内 $...$：不跨行、两侧不紧邻空白、非货币、不跨词吞空格。
    //    宁可少渲染，也不把正文吞成公式。
    out = out.replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, function (whole, tex, offset, src) {
      var before = offset > 0 ? src.charAt(offset - 1) : '';
      var after = src.charAt(offset + whole.length);
      // 开 $ 被反斜杠转义（\$ 已提前占位，这里防御残余的 \\$ 等组合）
      if (before === '\\') return whole;
      // 货币：$5 / 5$ / $10 —— 两侧任一侧紧邻数字时按货币跳过
      if (/[0-9]/.test(before) || /[0-9]/.test(after)) return whole;
      // 含空白却没有任何 TeX 结构字符（如 $x and y$）按正文处理
      if (/\s/.test(tex) && !/[\\^_{}=+*/<>|~-]/.test(tex)) return whole;
      // shell 变量：$PATH / $HOME 这类全大写标识符、含冒号的路径串、$VAR= 右侧，
      // 都不是公式；避免 export PATH=$HOME/bin:$PATH 被吞。
      if (/^[A-Z][A-Z0-9_]*$/.test(tex)) return whole;
      if (before === '=') return whole;
      if (tex.indexOf(':') >= 0 && !/[\\^_{}=+*/<>|~-]/.test(tex)) return whole;
      return stash(tex, false);
    });

    slots.codeDollar = CODE_DOLLAR;
    slots.codeBackslash = CODE_BACKSLASH;
    slots.codeTick = CODE_TICK;
    slots.escDollar = ESC_DOLLAR;
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
    // 还原代码段里被掩码的 $ 与 \，以及转义美元符 \$。（split/join 避免 $ 被当替换模式）
    html = html.split(slots.codeDollar).join('$')
      .split(slots.codeBackslash).join('\\')
      .split(slots.codeTick).join('`')
      .split(slots.escDollar).join('$');
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
