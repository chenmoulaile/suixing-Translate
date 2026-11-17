// content/export.js —— 导出双语（v0.2，C 全面还原实现员）
// 数据源（协议 fullRestore 第 4 条）：遍历 document.querySelectorAll('[data-ta="done"]')
// 翻译单元，cloneNode(true) → 移除 .ta-target-wrapper 取原文文本；wrapper.textContent
// 取译文；按 DOM 顺序成对输出。嵌套单元（外层 div 与其子 li 都是翻译单元）在父单元
// 的 clone 中剔除已单独成对的子单元，避免原文/译文重复输出。
// 三格式（协议 EXPORT_BILINGUAL format 'html'|'markdown'|'txt'）：
//   HTML   —— 独立快照：<!DOCTYPE html> + <style>（优先内联 styles/content.css+themes.css
//             原文，fetch 扩展资源受 web_accessible_resources 限制失败时用内置兜底样式），
//             内容全部经 escapeHtml 以文本节点写入，天然无 <script>、无事件属性；
//   Markdown —— 「原文\n\n译文\n\n」逐段成对；
//   TXT    —— 「原文\n译文\n空行」逐段成对。
// 下载：Blob + URL.createObjectURL + a[download]，文件名 `<站点host>.双语.<ext>`，无新权限。
// 入口：悬浮球「导出双语」子菜单（ball.js）与 popup「更多」导出按钮（经 EXPORT_BILINGUAL
// 消息 → features.messages 分发，协议 protocolChanges 第 4 条）。
// 未翻译页面调用 → 轻提示「请先翻译本页」+ {ok:false,error:{code:'NOT_TRANSLATED'}}。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || TA.__exportLoaded) return;
  TA.__exportLoaded = true;

  // 键 = 入参格式名（popup/ball 传入），值 = 下载文件扩展名；
  // run() 以 FORMATS[format] 归一（'markdown' → 'md'），mime/构建分支均按归一后值判断
  var FORMATS = { html: 'html', markdown: 'md', txt: 'txt' };

  /* ==================== 单元收集 ==================== */

  // 返回 [{src, dst}]（按 DOM 顺序）；无已完成单元返回 []。
  // wrapper 带 .ta-error / .ta-loading 时该段视为未完成，仅导出原文（dst 为空串）。
  function collect() {
    var els = document.querySelectorAll('[data-ta="done"]');
    var pairs = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var clone = el.cloneNode(true);
      // 剔除已单独成对的嵌套翻译单元（子单元在自身循环里输出，避免重复）
      var innerUnits = clone.querySelectorAll('[data-ta]');
      for (var j = 0; j < innerUnits.length; j++) {
        if (innerUnits[j] !== clone) innerUnits[j].remove();
      }
      // 译文本体（首个 .ta-target-wrapper；v0.1 结构每单元至多一个）
      var w = clone.querySelector('.ta-target-wrapper');
      var dst = '';
      if (w && !w.classList.contains('ta-loading') && !w.classList.contains('ta-error')) {
        dst = normalizeText(w.textContent);
      }
      if (w) w.remove();
      // flex/grid 外插的兄弟 wrapper 不在 el 子树内（data-ta-for=<elId> 关联，
      // 见 injector.js injectLoading ③ 分支），克隆里取不到 → 从活 DOM 补取；
      // 只读 textContent，绝不移动/删除活节点（还原语义归 injector 管）
      if (!dst) {
        var elId = el.getAttribute('data-ta-id');
        if (elId && el.parentElement) {
          try {
            var sib = el.parentElement.querySelector(
              ':scope > .ta-target-wrapper[data-ta-for="' + elId + '"]');
            if (sib && !sib.classList.contains('ta-loading') && !sib.classList.contains('ta-error')) {
              dst = normalizeText(sib.textContent);
            }
          } catch (eS) { /* 选择器异常忽略 */ }
        }
      }
      var src = normalizeText(clone.textContent);
      if (!src && !dst) continue;
      pairs.push({ src: src, dst: dst });
    }
    return pairs;
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s*\n\s*/g, '\n').replace(/[ \t]+/g, ' ')
      .replace(/^\n+|\n+$/g, '').trim();
  }

  /* ==================== 三格式构建 ==================== */

  function buildTxt(pairs) {
    var out = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      out.push(p.src, p.dst, '');
    }
    return out.join('\n');
  }

  function buildMarkdown(pairs, title) {
    var out = ['# ' + title, ''];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      out.push(p.src, '', p.dst || '（译文缺失）', '');
    }
    return out.join('\n');
  }

  // 内置兜底快照样式（fetch 扩展 CSS 失败时使用；自包含，保证离线可读）
  var FALLBACK_CSS = [
    'body{margin:0;background:#f5f6f8;color:#1f2328;',
    'font:15px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;}',
    '.ta-export{max-width:760px;margin:0 auto;padding:28px 20px 64px;}',
    'h1{font-size:20px;margin:0 0 4px;}',
    '.ta-export-meta{color:#8a9099;font-size:12px;margin:0 0 24px;word-break:break-all;}',
    '.ta-pair{background:#fff;border:1px solid #e1e4e8;border-radius:10px;',
    'padding:12px 16px;margin:0 0 12px;}',
    '.ta-src{color:#6a737d;font-size:14px;white-space:pre-line;}',
    '.ta-dst{margin-top:6px;padding-top:6px;border-top:1px dashed #d0d4d9;',
    'font-size:15px;white-space:pre-line;}',
    '.ta-dst:empty::after{content:"（无译文）";color:#c0c4cc;font-size:13px;}',
    '@media (prefers-color-scheme:dark){body{background:#15171a;color:#e6e8eb;}',
    '.ta-pair{background:#1f2126;border-color:#33363b;}',
    '.ta-src{color:#9aa0a6;}.ta-dst{border-top-color:#44474d;}}'
  ].join('');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 尽力获取扩展内主题样式文本（需 manifest web_accessible_resources 放行；
  // 失败静默回落 FALLBACK_CSS）
  function fetchExtCss(paths) {
    var list = paths.slice();
    return new Promise(function (resolve) {
      var acc = [];
      (function next() {
        if (!list.length) { resolve(acc.join('\n')); return; }
        var p = list.shift();
        try {
          fetch(chrome.runtime.getURL(p)).then(function (r) {
            return r.ok ? r.text() : '';
          }).then(function (t) {
            if (t) acc.push('/* ' + p + ' */\n' + t);
            next();
          }).catch(function () { next(); }); // fetch 或 r.text() 任一失败都推进下一个（原实现 text() 失败会卡死整条导出链）
        } catch (e) { next(); }
      })();
    });
  }

  function buildHtml(pairs, title, url) {
    var host = '';
    try { host = new URL(location.href).hostname; } catch (e) { host = ''; }
    var body = [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      body.push('    <section class="ta-pair">');
      body.push('      <div class="ta-src">' + escapeHtml(p.src) + '</div>');
      body.push('      <div class="ta-dst">' + escapeHtml(p.dst) + '</div>');
      body.push('    </section>');
    }
    var cssPromise = fetchExtCss(['styles/content.css', 'styles/themes.css']);
    return cssPromise.then(function (css) {
      return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>' + escapeHtml(title) + '</title>',
        '<style>',
        css || FALLBACK_CSS,
        '</style>',
        '</head>',
        '<body>',
        '<main class="ta-export">',
        '  <h1>' + escapeHtml(title) + '</h1>',
        '  <p class="ta-export-meta">来源：' + escapeHtml(url) + ' · 导出时间：' +
          escapeHtml(new Date().toLocaleString()) + ' · 随行翻译双语快照</p>',
        body.join('\n'),
        '</main>',
        '</body>',
        '</html>'
      ].join('\n');
    });
  }

  /* ==================== 下载与提示 ==================== */

  function hostOf() {
    try { return new URL(location.href).hostname || 'page'; } catch (e) { return 'page'; }
  }

  function download(text, ext, mime) {
    var filename = hostOf() + '.双语.' + ext;
    var blob = new Blob(['\ufeff' + text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      URL.revokeObjectURL(url);
    }, 4000);
    return filename;
  }

  var toastEl = null;
  function toast(msg) {
    // 优先复用悬浮球 tooltip（同一视觉通道），不可用时自建轻 toast
    if (TA.ball && typeof TA.ball.showTip === 'function' && document.getElementById('ta-float-ball')) {
      TA.ball.showTip(msg, 2400);
      return;
    }
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.setAttribute('data-ta-export-toast', '1');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);' +
        'z-index:2147483647;padding:7px 14px;border-radius:999px;background:rgba(31,35,40,.92);' +
        'color:#fff;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = '';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { if (toastEl) toastEl.style.display = 'none'; }, 2400);
  }

  /* ==================== 主入口 ==================== */

  // run(format, opts) → Promise<{ok, filename?} | {ok:false, error:{code,message}}>
  // format: 'html' | 'markdown' | 'txt'
  function run(format, opts) {
    // 归一为扩展名形态（'markdown' → 'md'）：此前 format 保持 'markdown'，
    // 而 mime/构建分支判 'md'，Markdown 导出会静默落成 TXT 内容 + text/plain + .markdown 扩展名
    format = FORMATS[format] || 'txt';
    var pairs = collect();
    if (!pairs.length) {
      toast('请先翻译本页');
      return Promise.resolve({ ok: false, error: { code: 'NOT_TRANSLATED', message: '当前页没有已完成的翻译单元' } });
    }
    var title = (document.title || hostOf()) + ' · 双语';
    var mime = format === 'html' ? 'text/html' : (format === 'md' ? 'text/markdown' : 'text/plain');
    var build;
    if (format === 'html') build = buildHtml(pairs, title, location.href);
    else if (format === 'md') build = Promise.resolve(buildMarkdown(pairs, document.title || hostOf()));
    else build = Promise.resolve(buildTxt(pairs));

    return build.then(function (text) {
      var filename = download(text, format, mime);
      toast('已导出 ' + filename + '（' + pairs.length + ' 段）');
      return { ok: true, filename: filename, pairs: pairs.length };
    }).catch(function (e) {
      toast('导出失败：' + ((e && e.message) || e));
      return { ok: false, error: { code: 'EXPORT_FAILED', message: String((e && e.message) || e) } };
    });
  }

  /* ==================== 消息与 features 挂载 ==================== */

  // 协议消息 4：{type:'EXPORT_BILINGUAL', format:'html'|'markdown'|'txt', download}
  // → {ok:true, filename} | {ok:false, error:{code:'NOT_TRANSLATED'}}
  function handleExportBilingual(msg) {
    var fmt = (msg && msg.format) || 'txt';
    if (!FORMATS[fmt]) return Promise.resolve({ ok: false, error: { code: 'BAD_REQUEST', message: '非法导出格式: ' + fmt } });
    return run(fmt, { source: 'message', download: !!(msg && msg.download) });
  }

  function registerFeature() {
    if (!TA.features || typeof TA.features.register !== 'function') return; // A 未合入时独立运行
    try {
      TA.features.register({
        name: 'export',
        messages: { EXPORT_BILINGUAL: handleExportBilingual },
        cmds: {}
      });
    } catch (e) {
      console.warn('[TA] export.js 注册 TA.features 失败（以独立模式运行）', e);
    }
  }

  // 公共命名空间：TA.export.run 供悬浮球直接调用
  TA.export = {
    run: run,
    collect: collect,
    buildTxt: buildTxt,
    buildMarkdown: buildMarkdown,
    buildHtml: buildHtml
  };

  registerFeature();
})();
