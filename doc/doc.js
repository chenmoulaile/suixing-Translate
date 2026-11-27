/* doc/doc.js —— 文档翻译页（纯原生 JS 经典脚本，挂载 globalThis.TA.doc）
 *
 * 能力：拖拽/选择文件 → 本地解析为段落（TXT/MD/HTML/SRT/VTT/EPUB/PDF）
 *      → 经 chrome.runtime TRANSLATE_BATCH 逐段翻译 → 双语对照渲染 + 多格式导出。
 * 约束：无构建步骤、无外部网络（仅扩展翻译总线 + 本地 pdf.js）；任何异常都在 UI 中友好呈现。
 */
(function () {
  'use strict';

  var TA = globalThis.TA = globalThis.TA || {};
  var MAX_TEXT = 180;          // 单批最大段数（后台上限 200，留余量）
  var MAX_CHARS = 200000;      // 单批最大字符数（后台硬上限）
  var PARA_MAX = 2000;         // 单段最大字符数，超过则按句拆分
  var PDF_PAGE_LIMIT = 300;    // PDF 最多处理页数
  var MAX_FILE_BYTES = 40 * 1024 * 1024;

  var BLOCK_TAGS = {
    p: 1, div: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1,
    li: 1, blockquote: 1, pre: 1, section: 1, article: 1,
    header: 1, footer: 1, tr: 1, table: 1, ul: 1, ol: 1, hr: 1
  };

  // 全局状态
  var state = {
    fileName: '',
    fileSize: 0,
    kind: 'text',          // 'text' | 'subtitle' | 'pdf'
    segments: [],          // 送 MT 用的文本（PDF 里公式被遮罩成 ⟪mN⟫）
    sourceSegments: [],    // 原始文本（公式未遮罩），供展示与导出原文层使用
    groups: [],            // 与 segments 平行的分组标签（如“第 N 页 / 章节名”），可为 null
    cues: null,            // 字幕：与 segments 平行 [{start,end,text}]
    translations: [],
    errors: [],
    cancelled: false,
    batchSeq: 0,
    // PDF 分页/几何元数据（仅 kind==='pdf' 时有效）
    pdfPages: [],          // [{pageNo,width,height,lines:[...],blocks:[...]}]
    segMeta: [],           // 与 segments 平行 {pageNo,x,y,right,bottom,width,height,lines}
    formulaSlots: []       // 与 segments 平行 [{token,source,tex,displayMode,bbox}]
  };

  var el = {};

  /* ==================== 初始化 ==================== */

  function init() {
    el.dropZone = document.getElementById('dropZone');
    el.fileInput = document.getElementById('fileInput');
    el.targetLang = document.getElementById('targetLang');
    el.progressArea = document.getElementById('progressArea');
    el.progressPhase = document.getElementById('progressPhase');
    el.progressText = document.getElementById('progressText');
    el.progressBar = document.getElementById('progressBar');
    el.progressNote = document.getElementById('progressNote');
    el.cancelBtn = document.getElementById('cancelBtn');
    el.notice = document.getElementById('notice');
    el.results = document.getElementById('results');
    el.resultName = document.getElementById('resultName');
    el.resultMeta = document.getElementById('resultMeta');
    el.cardList = document.getElementById('cardList');

    populateLanguages();
    loadSettings(function (settings) {
      var wanted = (settings && settings.targetLang) || 'zh-CN';
      if (langExists(wanted)) el.targetLang.value = wanted;
    });

    bindEvents();
  }

  function bindEvents() {
    el.dropZone.addEventListener('click', function (e) {
      if (e.target === el.fileInput) return;
      try { el.fileInput.click(); } catch (err) { /* noop */ }
    });
    el.dropZone.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        try { el.fileInput.click(); } catch (err) { /* noop */ }
      }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.dropZone.classList.add('dragover');
      });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      el.dropZone.addEventListener(ev, function (e) {
        e.preventDefault();
        el.dropZone.classList.remove('dragover');
      });
    });
    el.dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      el.dropZone.classList.remove('dragover');
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) safeHandleFile(dt.files[0]);
    });
    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files.length) safeHandleFile(el.fileInput.files[0]);
      // 允许重复选择同一文件
      try { el.fileInput.value = ''; } catch (err) { /* noop */ }
    });
    el.cancelBtn.addEventListener('click', function () {
      state.cancelled = true;
      el.cancelBtn.disabled = true;
      el.progressPhase.textContent = '正在取消…';
    });

    // 显示样式切换（段式三态 + PDF 分页两态）
    document.querySelectorAll('.style-toggle .seg').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.style-toggle .seg').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        var style = btn.getAttribute('data-style');
        el.results.setAttribute('data-style', style);
        // 非 PDF 文档没有分页视图：选到分页模式时回退到段式译文，避免空视图
        if (state.kind !== 'pdf' && (style === 'page-compare' || style === 'translation-page')) {
          var fallback = style === 'page-compare' ? 'bilingual' : 'translation';
          document.querySelectorAll('.style-toggle .seg').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-style') === fallback);
          });
          el.results.setAttribute('data-style', fallback);
        }
      });
    });

    // 导出
    document.querySelectorAll('[data-export]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        try { doExport(btn.getAttribute('data-export')); }
        catch (err) { showNotice('导出失败：' + friendly(err), 'error'); }
      });
    });

    // 兜底：任何未捕获异常都呈现到界面
    window.addEventListener('error', function (e) {
      showNotice('发生错误：' + ((e && e.message) || '未知错误'), 'error');
    });
  }

  function safeHandleFile(file) {
    Promise.resolve().then(function () { return handleFile(file); })
      .catch(function (err) { showNotice('处理失败：' + friendly(err), 'error'); hideProgress(); });
  }

  /* ==================== 设置 / 语言 ==================== */

  function populateLanguages() {
    var langs = (TA && Array.isArray(TA.TARGET_LANGS) && TA.TARGET_LANGS.length)
      ? TA.TARGET_LANGS
      : [
        { code: 'zh-CN', name: '简体中文' },
        { code: 'zh-TW', name: '繁體中文' },
        { code: 'en', name: 'English' },
        { code: 'ja', name: '日本語' },
        { code: 'ko', name: '한국어' }
      ];
    el.targetLang.innerHTML = '';
    langs.forEach(function (l) {
      var opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.name + ' (' + l.code + ')';
      el.targetLang.appendChild(opt);
    });
    if (!langExists('zh-CN') && el.targetLang.options.length) el.targetLang.selectedIndex = 0;
  }

  function langExists(code) {
    for (var i = 0; i < el.targetLang.options.length; i++) {
      if (el.targetLang.options[i].value === code) return true;
    }
    return false;
  }

  function loadSettings(cb) {
    var fallback = { targetLang: 'zh-CN' };
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { cb(fallback); return; }
    try {
      chrome.storage.local.get('settings', function (res) {
        var stored = res && res.settings;
        var merged;
        try {
          merged = (TA && typeof TA.mergeDefaults === 'function')
            ? TA.mergeDefaults(stored)
            : Object.assign({}, fallback, stored || {});
        } catch (e) { merged = Object.assign({}, fallback, stored || {}); }
        cb(merged || fallback);
      });
    } catch (e) { cb(fallback); }
  }

  /* ==================== 主流程 ==================== */

  function resetState() {
    state.kind = 'text';
    state.segments = [];
    state.sourceSegments = [];
    state.groups = [];
    state.cues = null;
    state.translations = [];
    state.errors = [];
    state.cancelled = false;
    state.pdfPages = [];
    state.segMeta = [];
    state.formulaSlots = [];
    if (TA.pdfFormula && TA.pdfFormula.reset) TA.pdfFormula.reset();
    el.notice.hidden = true;
    el.results.hidden = true;
    el.cardList.innerHTML = '';
    el.cancelBtn.disabled = false;
  }

  function handleFile(file) {
    resetState();
    var name = (file && file.name) || '未命名文件';
    var lower = name.toLowerCase();

    if (!/\.(txt|md|markdown|html|htm|srt|vtt|epub|pdf)$/.test(lower)) {
      throw new Error('不支持的文件格式：' + name + '。请选择 TXT / Markdown / HTML / SRT / VTT / EPUB / PDF。');
    }
    if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
      throw new Error('文件过大（' + formatBytes(file.size) + '），上限 40 MB。');
    }

    state.fileName = name;
    state.fileSize = file.size || 0;
    showProgress('读取文件…', 0, 0, '');

    return readArrayBuffer(file)
      .then(function (buffer) {
        el.progressPhase.textContent = '解析文档…';
        return parseByExtension(lower, buffer);
      })
      .then(function (parsed) {
        state.kind = parsed.kind || 'text';
        state.segments = parsed.segments || [];
        state.sourceSegments = state.segments.slice();
        state.groups = parsed.groups || new Array(state.segments.length).fill(null);
        state.cues = parsed.cues || null;
        state.pdfPages = parsed.pdfPages || [];
        state.segMeta = parsed.segMeta || [];

        // 公式遮罩：切分/翻译前把 TeX 换成 ⟪mN⟫，token 作为普通串随段送 MT。
        var masked = maskAllSegments(state.segments);
        state.segments = masked.segments;
        state.formulaSlots = masked.slots;

        if (parsed.notice) showNotice(parsed.notice, 'info');
        if (!state.segments.length) {
          throw new Error('没有从文档中解析出可翻译的文本。');
        }

        var targetLang = el.targetLang.value || 'zh-CN';
        showProgress('翻译中…', 0, state.segments.length, '正在调用翻译服务…');
        return translateAll(state.segments, targetLang, onTranslateProgress, function () { return state.cancelled; });
      })
      .then(function (result) {
        // 译文回填前先还原公式：把 ⟪mN⟫ 换回原始 TeX，绝不送 MT 改写。
        state.translations = restoreAllTranslations(result.translations);
        state.errors = result.errors || [];
        if (result.cancelled) {
          showNotice('已取消翻译；未完成的段落显示原文。', 'info');
        }
        var failed = state.errors.filter(function (e) { return e && !/取消/.test(e); }).length;
        if (failed) {
          showNotice('有 ' + failed + ' 段翻译失败，已保留原文（可导出后检查）。', 'error');
        }
        renderResults();
        el.progressPhase.textContent = '完成';
        el.progressText.textContent = state.segments.length + ' / ' + state.segments.length;
        el.progressBar.style.width = '100%';
        setTimeout(hideProgress, 900);
      })
      .catch(function (err) {
        showNotice('处理失败：' + friendly(err), 'error');
        hideProgress();
      });
  }

  function onTranslateProgress(done, total) {
    el.progressText.textContent = done + ' / ' + total;
    el.progressBar.style.width = (total ? (done / total * 100) : 0).toFixed(1) + '%';
  }

  /* ==================== 文件读取 / 分发 ==================== */

  function readArrayBuffer(file) {
    if (typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer();
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('文件读取失败')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function decodeText(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      bytes = bytes.subarray(3);
    }
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
    // 兜底（老环境）：按字节解码（Unicode 场景有限，但保证不崩）
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function parseByExtension(lower, buffer) {
    if (lower.endsWith('.pdf')) return parsePdf(buffer);
    if (lower.endsWith('.epub')) return parseEpub(buffer);
    if (lower.endsWith('.srt')) return Promise.resolve(parseSubtitle(decodeText(buffer), 'srt'));
    if (lower.endsWith('.vtt')) return Promise.resolve(parseSubtitle(decodeText(buffer), 'vtt'));
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      return Promise.resolve({ kind: 'text', segments: paragraphsFromHtml(decodeText(buffer)) });
    }
    return Promise.resolve({ kind: 'text', segments: paragraphsFromText(decodeText(buffer)) });
  }

  /* ==================== 纯文本 / HTML 解析 ==================== */

  function paragraphsFromText(text) {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var raw = text.split(/\n\s*\n+/);
    var out = [];
    raw.forEach(function (p) {
      p = p.trim();
      if (!p) return;
      splitLargeParagraph(p, PARA_MAX).forEach(function (s) { if (s) out.push(s); });
    });
    return out;
  }

  // 超长段落按句拆分，并把句子累积到 ≈PARA_MAX 的段里
  function splitLargeParagraph(text, max) {
    text = String(text || '').trim();
    if (text.length <= max) return [text];
    var sentences = text.match(/[^。！？!?；;.!?]+[。！？!?；;.!?]*["'”’）)]?/g) || [text];
    var acc = [], cur = '';
    sentences.forEach(function (s) {
      if (!s) return;
      if (cur && cur.length + s.length > max) { acc.push(cur.trim()); cur = s; }
      else cur += s;
    });
    if (cur.trim()) acc.push(cur.trim());
    // 若单句仍超长，做硬切
    var final = [];
    acc.forEach(function (seg) {
      while (seg.length > max) { final.push(seg.slice(0, max)); seg = seg.slice(max); }
      if (seg) final.push(seg);
    });
    return final;
  }

  // 用临时 div 解析 HTML，按块级元素插入换行，再取 textContent 语义的文本
  function paragraphsFromHtml(html) {
    var temp = document.createElement('div');
    try { temp.innerHTML = String(html || ''); }
    catch (e) { return paragraphsFromText(String(html || '').replace(/<[^>]+>/g, ' ')); }
    var parts = [];
    (function walk(node) {
      if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      var tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
      if (tag === 'br') { parts.push('\n'); return; }
      var children = node.childNodes;
      for (var i = 0; i < children.length; i++) walk(children[i]);
      if (BLOCK_TAGS[tag]) parts.push('\n\n');
    })(temp);
    return paragraphsFromText(parts.join(''));
  }

  /* ==================== SRT / VTT 字幕解析 ==================== */

  function parseSubtitle(text, fmt) {
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    var blocks = text.split(/\n{2,}/);
    var cues = [];
    blocks.forEach(function (block) {
      var lines = block.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) return;
      var ti = -1;
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('-->') !== -1) { ti = i; break; }
      }
      if (ti < 0) return;
      var times = lines[ti].split('-->');
      if (times.length < 2) return;
      var start = times[0].trim();
      var end = times[1].trim();
      // VTT 行尾可能带 cue settings（align/position…），去掉
      end = end.split(/\s+/)[0];
      if (!start || !end) return;
      var cueText = lines.slice(ti + 1).join('\n').trim();
      if (!cueText) return;
      cues.push({ start: start, end: end, text: cueText });
    });
    // SRT 无 WEBVTT 头；VTT 的 NOTE/STYLE 块因无 '-->' 已被跳过
    void fmt;
    return {
      kind: 'subtitle',
      segments: cues.map(function (c) { return c.text; }),
      cues: cues
    };
  }

  /* ==================== EPUB（ZIP）解析 ==================== */

  function parseEpub(buffer) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持 EPUB 解压（需要 Chrome 103+）。请改用 TXT 或 PDF。'));
    }
    var view = new DataView(buffer);
    var bytes = new Uint8Array(buffer);

    var entries;
    try { entries = readZipEntries(view, bytes); }
    catch (e) { return Promise.reject(new Error('EPUB 结构解析失败：' + friendly(e) + '。请确认文件是有效的 epub。')); }

    var byName = {};
    entries.forEach(function (e) { byName[e.name] = e; });
    var htmlEntries = entries.filter(function (e) {
      return /\.(xhtml|html)$/i.test(e.name) && !/(^|\/)META-INF\//i.test(e.name);
    });
    var opfEntry = entries.filter(function (e) { return /\.opf$/i.test(e.name); })[0];

    var chain = Promise.resolve([]);
    if (opfEntry) {
      chain = decompressEntry(opfEntry, view)
        .then(function (data) { return decodeText(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)); })
        .then(function (opfText) { return orderFromOpf(opfText, opfEntry.name, byName, htmlEntries); })
        .catch(function () { return htmlEntries.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }); });
    } else {
      chain = Promise.resolve(htmlEntries.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }));
    }

    return chain.then(function (ordered) {
      var seq = Promise.resolve({ segments: [], groups: [], notice: '' });
      ordered.forEach(function (entry) {
        seq = seq.then(function (acc) {
          return decompressEntry(entry, view).then(function (data) {
            var text = decodeText(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            var paras = paragraphsFromHtml(text);
            var label = entry.name.split('/').pop().replace(/\.(xhtml|html)$/i, '');
            paras.forEach(function (p) { acc.segments.push(p); acc.groups.push(label); });
            return acc;
          }).catch(function () { return acc; }); // 单章失败不影响整本
        });
      });
      return seq;
    }).then(function (acc) {
      var notice = '已从 EPUB 中提取 ' + acc.segments.length + ' 段文本。';
      return { kind: 'text', segments: acc.segments, groups: acc.groups, notice: notice };
    });
  }

  // 读取 ZIP 中央目录，得到 [{name, method, compSize, localOffset}]
  function readZipEntries(view, bytes) {
    var eocd = -1;
    var min = Math.max(0, bytes.length - 22 - 65535);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 ZIP 结束标志');
    var total = view.getUint16(eocd + 10, true);
    var cdOffset = view.getUint32(eocd + 16, true);
    var p = cdOffset;
    var out = [];
    var dec = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
    for (var n = 0; n < total; n++) {
      if (p + 46 > bytes.length || view.getUint32(p, true) !== 0x02014b50) break;
      var method = view.getUint16(p + 10, true);
      var compSize = view.getUint32(p + 20, true);
      var nameLen = view.getUint16(p + 28, true);
      var extraLen = view.getUint16(p + 30, true);
      var commentLen = view.getUint16(p + 32, true);
      var localOffset = view.getUint32(p + 42, true);
      var nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
      var name = dec ? dec.decode(nameBytes) : decodeText(nameBytes.buffer);
      out.push({ name: name, method: method, compSize: compSize, localOffset: localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  // 解压单个 ZIP 条目（method 0 存储 / 8 deflate）
  function decompressEntry(entry, view) {
    return Promise.resolve().then(function () {
      var p = entry.localOffset;
      if (view.getUint32(p, true) !== 0x04034b50) throw new Error('错误的本地文件头: ' + entry.name);
      var nameLen = view.getUint16(p + 26, true);
      var extraLen = view.getUint16(p + 28, true);
      var dataStart = p + 30 + nameLen + extraLen;
      var data = new Uint8Array(view.buffer, view.byteOffset + dataStart, entry.compSize);
      if (entry.method === 0) return data;
      if (entry.method === 8) return inflate(data);
      throw new Error('不支持的压缩方式: ' + entry.method);
    });
  }

  function inflate(data) {
    var ds;
    try { ds = new DecompressionStream('deflate-raw'); }
    catch (e) { ds = new DecompressionStream('deflate'); }
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function orderFromOpf(opfText, opfName, byName, htmlEntries) {
    var doc = new DOMParser().parseFromString(opfText, 'application/xml');
    var manifest = {};
    var items = doc.getElementsByTagNameNS('*', 'item');
    for (var i = 0; i < items.length; i++) {
      var id = items[i].getAttribute('id');
      var href = items[i].getAttribute('href');
      if (id && href) manifest[id] = href;
    }
    var opfDir = opfName.indexOf('/') >= 0 ? opfName.slice(0, opfName.lastIndexOf('/') + 1) : '';
    var ordered = [];
    var refs = doc.getElementsByTagNameNS('*', 'itemref');
    for (var j = 0; j < refs.length; j++) {
      var idref = refs[j].getAttribute('idref');
      var rel = manifest[idref];
      if (!rel) continue;
      var resolved = resolveZipPath(opfDir, rel);
      if (byName[resolved] && /\.(xhtml|html)$/i.test(resolved)) ordered.push(byName[resolved]);
      else {
        // 回退：按后缀匹配（epub 内路径写法可能带 ../ 差异）
        var base = resolved.split('/').pop().toLowerCase();
        var found = htmlEntries.filter(function (e) { return e.name.toLowerCase().endsWith('/' + base) || e.name.toLowerCase() === base; })[0];
        if (found) ordered.push(found);
      }
    }
    // 去重并把 spine 未覆盖的 html 追加在后
    var seen = {};
    var result = [];
    ordered.forEach(function (e) { if (!seen[e.name]) { seen[e.name] = 1; result.push(e); } });
    htmlEntries.forEach(function (e) { if (!seen[e.name]) { seen[e.name] = 1; result.push(e); } });
    return result;
  }

  function resolveZipPath(baseDir, href) {
    var raw = (baseDir + href).split('/');
    var out = [];
    raw.forEach(function (part) {
      if (part === '' || part === '.') return;
      if (part === '..') { out.pop(); return; }
      out.push(part);
    });
    return out.join('/');
  }

  /* ==================== PDF 解析（保留几何 / 坐标 / 分页） ==================== */

  // pdf.js 3.11 的 page.getTextContent() 项带 transform，但必须叠加 viewport
  // transform 才是页面坐标（y 向下）。保留 x/y/w/h 供分页视图绝对定位使用。
  function pdfItemRect(it, viewport) {
    var tr = it.transform || [0, 0, 0, 0, 0, 0];
    var m = viewport && viewport.transform;
    var x = tr[4], y = tr[5];
    if (m) {
      x = m[0] * tr[4] + m[2] * tr[5] + m[4];
      y = m[1] * tr[4] + m[3] * tr[5] + m[5];
    }
    var scaleX = m ? m[0] : 1;
    var scaleY = m ? Math.abs(m[3]) : 1;
    var w = Math.abs(it.width != null ? it.width * scaleX : (tr[0] || 0) * scaleX);
    var h = Math.abs(it.height != null ? it.height : (tr[3] || 0)) * scaleY;
    if (!h) h = 10;
    return { x: x, y: y, w: w, h: h };
  }

  // 按 y 聚类成行，行内按 x 排序；容差随字高自适应，避免双栏基线微错位被合并。
  function pdfItemsToLines(items, viewport) {
    var lines = [];
    (items || []).forEach(function (it) {
      if (!it || typeof it.str !== 'string' || !it.str.trim()) return;
      var rect = pdfItemRect(it, viewport);
      var line = null;
      var tol = Math.max(1.2, rect.h * 0.35);
      for (var i = lines.length - 1; i >= 0; i--) {
        if (Math.abs(lines[i].y - rect.y) <= Math.max(tol, lines[i].h * 0.35)) { line = lines[i]; break; }
      }
      if (!line) {
        line = { y: rect.y, x: rect.x, right: rect.x + rect.w, h: rect.h, items: [] };
        lines.push(line);
      } else {
        line.x = Math.min(line.x, rect.x);
        line.right = Math.max(line.right, rect.x + rect.w);
        line.h = Math.max(line.h, rect.h);
      }
      line.items.push({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, str: it.str, font: it.fontName, dir: it.dir });
    });
    lines.forEach(function (l) {
      l.items.sort(function (a, b) { return a.x - b.x; });
      l.str = joinPdfItems(l.items);
      l.width = l.right - l.x;
    });
    return lines;
  }

  // 双栏检测：x 起点分布若存在明显断层且两侧各有多行，则按左右栏分别由上到下排序。
  function orderPdfLines(lines, pageWidth) {
    if (lines.length < 6) return lines.slice().sort(function (a, b) { return a.y - b.y; });
    var xs = lines.map(function (l) { return l.x; }).sort(function (a, b) { return a - b; });
    var best = -1, bestGap = 0;
    for (var i = 1; i < xs.length; i++) {
      var gap = xs[i] - xs[i - 1];
      if (gap > bestGap) { bestGap = gap; best = i; }
    }
    var threshold = pageWidth * 0.12;
    if (best <= 0 || bestGap < threshold || best < 2 || xs.length - best < 2) {
      return lines.slice().sort(function (a, b) { return a.y - b.y; });
    }
    var splitX = (xs[best - 1] + xs[best]) / 2;
    var left = [], right = [];
    lines.forEach(function (l) { (l.x < splitX ? left : right).push(l); });
    left.sort(function (a, b) { return a.y - b.y; });
    right.sort(function (a, b) { return a.y - b.y; });
    return left.concat(right);
  }

  // 行按行距聚段；保留行首缩进（不再 trim 掉），行尾空白才清掉。
  function pdfLinesToParagraphs(lines) {
    var paras = [], cur = [];
    for (var i = 0; i < lines.length; i++) {
      if (i > 0 && cur.length) {
        var gap = lines[i].y - lines[i - 1].y;
        var threshold = Math.max(lines[i - 1].h, lines[i].h, 8) * 1.7;
        if (gap > threshold) {
          paras.push(cur);
          cur = [];
        }
      }
      cur.push(lines[i]);
    }
    if (cur.length) paras.push(cur);
    return paras.filter(function (p) {
      return p.some(function (l) { return l.str.trim(); });
    });
  }

  function parsePdf(buffer) {
    if (typeof pdfjsLib === 'undefined') {
      return Promise.reject(new Error('PDF 解析组件未加载（vendor/pdf.min.js 缺失）。'));
    }
    var notice = '';
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    } catch (e) { /* 某些构建无 setter，忽略 */ }
    try {
      return pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise.then(function (pdf) {
        var pages = pdf.numPages;
        var limit = Math.min(pages, PDF_PAGE_LIMIT);
        if (pages > PDF_PAGE_LIMIT) {
          notice = '文档共 ' + pages + ' 页，仅翻译前 ' + PDF_PAGE_LIMIT + ' 页。';
        }
        var segments = [], groups = [], segMeta = [], pdfPages = [];
        var chain = Promise.resolve();
        for (var p = 1; p <= limit; p++) {
          (function (pageNo) {
            chain = chain.then(function () {
              return pdf.getPage(pageNo).then(function (page) {
                var viewport = page.getViewport({ scale: 1 });
                return page.getTextContent().then(function (tc) {
                  var pageWidth = viewport.width || 612;
                  var pageHeight = viewport.height || 792;
                  var lines = orderPdfLines(pdfItemsToLines(tc.items, viewport), pageWidth);
                  var paras = pdfLinesToParagraphs(lines);
                  var pageRec = {
                    pageNo: pageNo,
                    width: pageWidth,
                    height: pageHeight,
                    lines: lines,
                    blocks: []
                  };
                  pdfPages.push(pageRec);
                  paras.forEach(function (para) {
                    var ys = para.map(function (l) { return l.y; });
                    var bottoms = para.map(function (l) { return l.y + l.h; });
                    var xs = para.map(function (l) { return l.x; });
                    var rights = para.map(function (l) { return l.right; });
                    var top = Math.min.apply(null, ys);
                    var bottom = Math.max.apply(null, bottoms);
                    var left = Math.min.apply(null, xs);
                    var right = Math.max.apply(null, rights);
                    var text = para.map(function (l) { return l.str; }).join('\n');
                    text = text.replace(/[ \t]+$/gm, '');
                    if (!text.trim()) return;
                    var idx = segments.length;
                    segments.push(text);
                    groups.push('第 ' + pageNo + ' 页');
                    segMeta.push({
                      pageNo: pageNo,
                      x: left, y: top, width: right - left, height: bottom - top,
                      right: right, bottom: bottom,
                      lines: para
                    });
                    pageRec.blocks.push(idx);
                  });
                });
              });
            }).catch(function (e) {
              // 单页失败写一条可见占位，避免静默丢页
              notice = (notice ? notice + ' ' : '') + '第 ' + pageNo + ' 页解析失败（' + friendly(e) + '）。';
            });
          })(p);
        }
        return chain.then(function () {
          if (!segments.length) throw new Error('未能在 PDF 中提取到文本（可能是扫描版图片 PDF）。');
          pdfPages.sort(function (a, b) { return a.pageNo - b.pageNo; });
          return {
            kind: 'pdf', segments: segments, groups: groups,
            segMeta: segMeta, pdfPages: pdfPages, notice: notice
          };
        });
      }).catch(function (err) {
        throw new Error('PDF 打开失败：' + friendly(err));
      });
    } catch (e) {
      return Promise.reject(new Error('PDF 解析失败：' + friendly(e)));
    }
  }

  function joinPdfItems(items) {
    var out = '';
    items.forEach(function (o) {
      var s = o.str;
      if (out && !/\s$/.test(out) && !/^\s/.test(s) &&
          /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(s)) out += ' ';
      out += s;
    });
    return out.trim();
  }

  /* ==================== 公式占位 / 还原 ==================== */

  function hasFormula() { return !!(TA && TA.pdfFormula); }

  // 在翻译前对每段遮罩公式；token 留在段内随 MT 走，slots 按段索引登记。
  function maskAllSegments(segments) {
    var masked = [];
    var slots = [];
    segments.forEach(function (seg, i) {
      if (!hasFormula()) {
        masked.push(seg);
        slots.push([]);
        return;
      }
      var meta = state.segMeta[i] || null;
      var bbox = meta ? { x: meta.x, y: meta.y, width: meta.width, height: meta.height, pageNo: meta.pageNo } : null;
      var r = TA.pdfFormula.maskFormulas(seg, bbox);
      masked.push(r.masked);
      slots.push(r.slots);
    });
    return { segments: masked, slots: slots };
  }

  function restoreAllTranslations(translations) {
    return (translations || []).map(function (v, i) {
      var out = v == null ? '' : v;
      if (hasFormula() && state.formulaSlots[i] && state.formulaSlots[i].length) {
        out = TA.pdfFormula.unmaskFormulas(out, state.formulaSlots[i]);
      }
      return out;
    });
  }

  // 把一段文本渲染为 DOM：公式块走 KaTeX/TA.markdown，普通文本用 textContent 防 XSS。
  function appendSegmentContent(container, text, kind) {
    var src = String(text == null ? '' : text);
    if (!hasFormula()) {
      TA.markdown.renderInto(container, src);
      return;
    }
    var chunks = TA.pdfFormula.splitByFormulas(src);
    var pending = '';
    function flush() {
      if (!pending) return;
      var span = document.createElement('span');
      span.className = 'segment-text';
      if (TA.markdown && TA.markdown.isAvailable && TA.markdown.isAvailable()) {
        TA.markdown.renderInto(span, pending);
      } else {
        span.textContent = pending;
      }
      container.appendChild(span);
      pending = '';
    }
    chunks.forEach(function (ch) {
      if (ch.type === 'text') {
        // 普通文本（可能含 Markdown）交给共享渲染引擎，保留链接/加粗/换行语义
        pending += ch.value;
        return;
      }
      flush();
      var slot = document.createElement('span');
      slot.className = 'formula-slot' + (ch.displayMode ? ' formula-display' : ' formula-inline');
      slot.setAttribute('data-formula', ch.tex);
      slot.innerHTML = TA.pdfFormula.renderFormulaHTML(ch.value, ch.displayMode);
      container.appendChild(slot);
    });
    flush();
    void kind;
  }

  /* ==================== 翻译总线 ==================== */

  function makeChunks(segments) {
    var chunks = [], cur = { indices: [], texts: [], chars: 0 };
    segments.forEach(function (text, i) {
      var len = (text || '').length;
      if (cur.texts.length && (cur.texts.length >= MAX_TEXT || cur.chars + len > MAX_CHARS)) {
        chunks.push(cur);
        cur = { indices: [], texts: [], chars: 0 };
      }
      cur.indices.push(i);
      cur.texts.push(text);
      cur.chars += len;
    });
    if (cur.texts.length) chunks.push(cur);
    return chunks;
  }

  function sendBatch(texts, targetLang) {
    return new Promise(function (resolve) {
      var id = 'doc-' + Date.now().toString(36) + '-' + (++state.batchSeq);
      var req = {
        type: 'TRANSLATE_BATCH',
        requestId: id,
        batchId: id,
        texts: texts,
        targetLang: targetLang || 'zh-CN',
        sourceLang: 'auto'
      };
      try {
        chrome.runtime.sendMessage(req, function (res) {
          if (typeof chrome.runtime.lastError !== 'undefined' && chrome.runtime.lastError) {
            resolve({ ok: false, error: { message: chrome.runtime.lastError.message } });
            return;
          }
          resolve(res);
        });
      } catch (e) {
        resolve({ ok: false, error: { message: String((e && e.message) || e) } });
      }
    });
  }

  function getErr(res) {
    if (!res) return '后台无响应';
    if (res.error) {
      if (typeof res.error === 'string') return res.error;
      return res.error.message || res.error.code || '翻译失败';
    }
    return '翻译失败';
  }

  // 发送一个 chunk；失败时拆半重试一次（depth < 1）
  function sendChunk(texts, targetLang, isCancelled, depth) {
    return sendBatch(texts, targetLang).then(function (res) {
      if (isCancelled()) return { translations: new Array(texts.length).fill(null), error: '已取消', cancelled: true };
      var ok = res && res.ok && Array.isArray(res.translations) &&
        res.translations.every(function (v) { return typeof v === 'string' && v; });
      if (ok) return { translations: res.translations, error: '' };
      if (depth < 1 && texts.length > 1) {
        var mid = Math.ceil(texts.length / 2);
        return sendChunk(texts.slice(0, mid), targetLang, isCancelled, depth + 1)
          .then(function (a) {
            return sendChunk(texts.slice(mid), targetLang, isCancelled, depth + 1)
              .then(function (b) {
                return {
                  translations: a.translations.concat(b.translations),
                  error: a.error || b.error,
                  cancelled: a.cancelled || b.cancelled
                };
              });
          });
      }
      var partial = (res && Array.isArray(res.translations)) ? res.translations : [];
      return {
        translations: texts.map(function (_, i) {
          var v = partial[i];
          return (typeof v === 'string' && v) ? v : null;
        }),
        error: getErr(res)
      };
    });
  }

  function translateAll(segments, targetLang, onProgress, isCancelled) {
    var translations = new Array(segments.length).fill('');
    var errors = new Array(segments.length).fill('');
    var chunks = makeChunks(segments);
    var total = segments.length;
    var done = 0;
    var cancelled = false;
    var chain = Promise.resolve();

    chunks.forEach(function (chunk) {
      chain = chain.then(function () {
        if (isCancelled()) { cancelled = true; return; }
        return sendChunk(chunk.texts, targetLang, isCancelled, 0).then(function (res) {
          if (isCancelled()) { cancelled = true; return; }
          chunk.indices.forEach(function (idx, j) {
            var v = res.translations[j];
            if (typeof v === 'string' && v) {
              translations[idx] = v;
            } else {
              translations[idx] = segments[idx]; // 失败：原文即译文
              errors[idx] = res.error || '翻译失败';
            }
          });
          done += chunk.indices.length;
          if (onProgress) onProgress(done, total);
        });
      });
    });

    return chain.then(function () {
      // 取消或遗漏的段落：回填原文，保证渲染/导出可用
      for (var i = 0; i < segments.length; i++) {
        if (!translations[i]) {
          translations[i] = segments[i];
          errors[i] = cancelled ? '未翻译（已取消）' : (errors[i] || '未翻译');
        }
      }
      if (onProgress) onProgress(done, total);
      return { translations: translations, errors: errors, cancelled: cancelled };
    });
  }

  /* ==================== 渲染 ==================== */

  function renderResults() {
    el.resultName.textContent = state.fileName;
    var kindLabel = state.kind === 'subtitle' ? '字幕' : '文档';
    var langLabel = el.targetLang.selectedIndex >= 0 && el.targetLang.options[el.targetLang.selectedIndex]
      ? el.targetLang.options[el.targetLang.selectedIndex].text
      : el.targetLang.value;
    el.resultMeta.textContent = kindLabel + ' · ' + state.segments.length + ' 段 · ' + formatBytes(state.fileSize) +
      ' · → ' + langLabel;
    document.querySelectorAll('.subtitle-only').forEach(function (b) { b.hidden = state.kind !== 'subtitle'; });
    document.querySelectorAll('.pdf-only').forEach(function (b) { b.hidden = state.kind !== 'pdf'; });
    document.querySelectorAll('.style-toggle .seg').forEach(function (b) {
      var st = b.getAttribute('data-style');
      if (st === 'page-compare' || st === 'translation-page') b.hidden = state.kind !== 'pdf';
    });

    var frag = document.createDocumentFragment();
    if (state.kind === 'pdf' && state.pdfPages.length) {
      // PDF 两种视图：分页对照 / 仅译文（保排版），另保留段式作为第三种模式。
      var pageCompare = document.createElement('div');
      pageCompare.className = 'pdf-pages';
      state.pdfPages.forEach(function (page) { pageCompare.appendChild(buildPdfPagePair(page)); });
      frag.appendChild(pageCompare);
      var segList = document.createElement('div');
      segList.className = 'pdf-segment-list';
      var lastGroup = '__none__';
      state.segments.forEach(function (seg, i) {
        var group = state.groups[i] || null;
        if (group && group !== lastGroup) {
          var gl = document.createElement('div');
          gl.className = 'group-label';
          gl.textContent = group;
          segList.appendChild(gl);
          lastGroup = group;
        }
        segList.appendChild(buildCard(seg, i));
      });
      frag.appendChild(segList);
    } else {
      var lastGroup2 = '__none__';
      state.segments.forEach(function (seg, i) {
        var group = state.groups[i] || null;
        if (group && group !== lastGroup2) {
          var gl2 = document.createElement('div');
          gl2.className = 'group-label';
          gl2.textContent = group;
          frag.appendChild(gl2);
          lastGroup2 = group;
        }
        frag.appendChild(buildCard(seg, i));
      });
    }
    el.cardList.innerHTML = '';
    el.cardList.appendChild(frag);
    el.results.hidden = false;
    // PDF 默认进入分页对照；非 PDF 维持原双语段式
    el.results.setAttribute('data-style', state.kind === 'pdf' ? 'page-compare' : 'bilingual');
    syncStyleActive();
  }

  function syncStyleActive() {
    var current = el.results.getAttribute('data-style') || 'bilingual';
    document.querySelectorAll('.style-toggle .seg').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-style') === current);
    });
  }

  // 按比例把 pt 坐标转成页面容器的百分比位置，原样保留排版。
  function placeAt(node, rect, page) {
    if (!rect || !page) return;
    var pw = page.width || 612, ph = page.height || 792;
    node.style.left = (rect.x / pw * 100).toFixed(3) + '%';
    node.style.top = (rect.y / ph * 100).toFixed(3) + '%';
    node.style.width = (Math.max(rect.width, 20) / pw * 100).toFixed(3) + '%';
    node.style.minHeight = (Math.max(rect.height, 8) / ph * 100).toFixed(3) + '%';
  }

  // data（可选）：{segments,translations,segMeta,sourceSegments}，测试/独立调用时传入；缺省用 state。
  // segments 是送 MT 的遮罩串；展示原文优先取 sourceSegments（未遮罩），确保公式可见。
  function buildPdfPagePair(page, data) {
    var view = data || {
      segments: state.segments,
      sourceSegments: state.sourceSegments,
      translations: state.translations,
      segMeta: state.segMeta
    };
    var pair = document.createElement('section');
    pair.className = 'pdf-page-pair';
    pair.setAttribute('data-page', String(page.pageNo));

    var label = document.createElement('div');
    label.className = 'pdf-page-label';
    label.textContent = '第 ' + page.pageNo + ' 页';
    pair.appendChild(label);

    ['pdf-source', 'pdf-target'].forEach(function (cls) {
      var layer = document.createElement('div');
      layer.className = 'pdf-page ' + cls;
      layer.style.aspectRatio = page.width + ' / ' + page.height;
      (page.blocks || []).forEach(function (idx) {
        var meta = view.segMeta && view.segMeta[idx];
        if (!meta) return;
        var block = document.createElement('div');
        block.className = 'pdf-block';
        block.setAttribute('data-seg', String(idx));
        placeAt(block, meta, page);
        var original = view.sourceSegments && view.sourceSegments[idx] != null
          ? view.sourceSegments[idx] : view.segments[idx];
        var text = cls === 'pdf-source'
          ? original
          : (view.translations && view.translations[idx] != null ? view.translations[idx] : original);
        appendSegmentContent(block, text, cls);
        layer.appendChild(block);
      });
      pair.appendChild(layer);
    });
    return pair;
  }

  function buildCard(seg, i) {
    var card = document.createElement('div');
    card.className = 'card';
    // seg 来自送 MT 的遮罩串；展示/复制原文用未遮罩的原始串，避免公式变 ⟪mN⟫。
    var original = state.sourceSegments && state.sourceSegments[i] != null
      ? state.sourceSegments[i] : seg;

    var idx = document.createElement('div');
    idx.className = 'card-index';
    idx.textContent = String(i + 1);
    card.appendChild(idx);

    var body = document.createElement('div');
    body.className = 'card-body';

    if (state.kind === 'subtitle' && state.cues && state.cues[i]) {
      var timing = document.createElement('span');
      timing.className = 'card-timing';
      timing.textContent = state.cues[i].start + ' --> ' + state.cues[i].end;
      body.appendChild(timing);
    }

    var orig = document.createElement('p');
    orig.className = 'segment-original';
    appendSegmentContent(orig, original, 'original');
    body.appendChild(orig);

    var trans = document.createElement('p');
    trans.className = 'segment-translation';
    if (state.errors[i]) trans.classList.add('failed');
    appendSegmentContent(trans, state.translations[i] != null ? state.translations[i] : original, 'translation');
    body.appendChild(trans);

    if (state.errors[i]) {
      var err = document.createElement('div');
      err.className = 'progress-note';
      err.textContent = '⚠ ' + state.errors[i];
      body.appendChild(err);
    }

    card.appendChild(body);

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'card-copy';
    copy.textContent = '复制';
    copy.addEventListener('click', function () {
      var style = el.results.getAttribute('data-style') || 'bilingual';
      var text;
      if (style === 'translation') text = state.translations[i];
      else if (style === 'original') text = original;
      else text = original + '\n' + state.translations[i];
      copyText(text).then(function () {
        copy.textContent = '已复制';
        copy.classList.add('done');
        setTimeout(function () { copy.textContent = '复制'; copy.classList.remove('done'); }, 1200);
      }).catch(function () { showNotice('复制失败，请手动选择文本。', 'error'); });
    });
    card.appendChild(copy);
    return card;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { var ok = document.execCommand('copy'); document.body.removeChild(ta); ok ? resolve() : reject(); }
      catch (e) { try { document.body.removeChild(ta); } catch (e2) {} reject(e); }
    });
  }

  /* ==================== 导出 ==================== */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeName(ext) {
    var base = state.fileName.replace(/\.[^.]+$/, '') || 'document';
    return base.replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
  }

  function doExport(type) {
    var n = state.segments.length;
    if (!n) { showNotice('没有可导出的内容。', 'error'); return; }
    var s = state.sourceSegments && state.sourceSegments.length === n ? state.sourceSegments : state.segments;
    var t = state.translations;

    if (type === 'md') {
      var md = '';
      for (var i = 0; i < n; i++) md += '## [' + (i + 1) + ']\n\n> ' + s[i] + '\n\n' + t[i] + '\n\n---\n\n';
      download(safeName('bilingual.md'), md, 'text/markdown;charset=utf-8');
    } else if (type === 'txt') {
      var txt = '';
      for (var j = 0; j < n; j++) txt += s[j] + '\n' + t[j] + '\n\n';
      download(safeName('bilingual.txt'), txt, 'text/plain;charset=utf-8');
    } else if (type === 'html' || type === 'translation-html') {
      download(safeName(type === 'html' ? 'bilingual.html' : 'translated.html'),
        buildExportHtml(type === 'translation-html'), 'text/html;charset=utf-8');
    } else if (type === 'translated-txt') {
      download(safeName('translated.txt'), t.join('\n\n'), 'text/plain;charset=utf-8');
    } else if (type === 'srt') {
      download(safeName('bilingual.srt'), buildSrt(false), 'application/x-subrip;charset=utf-8');
    } else if (type === 'translated-srt') {
      download(safeName('translated.srt'), buildSrt(true), 'application/x-subrip;charset=utf-8');
    }
  }

  function buildSrt(translatedOnly) {
    var out = '';
    for (var i = 0; i < state.segments.length; i++) {
      var c = state.cues && state.cues[i];
      var start = c ? c.start : '00:00:00,000';
      var end = c ? c.end : '00:00:00,000';
      out += (i + 1) + '\n' + start + ' --> ' + end + '\n';
      if (!translatedOnly) out += (state.sourceSegments[i] != null ? state.sourceSegments[i] : state.segments[i]) + '\n';
      out += state.translations[i] + '\n\n';
    }
    return out;
  }

  // PDF 导出内联 KaTeX 样式兜底；行内/块级公式还原原始 TeX 后渲染。
  function exportFormulaHtml(text) {
    var src = String(text == null ? '' : text);
    if (!hasFormula()) return esc(src);
    var chunks = TA.pdfFormula.splitByFormulas(src);
    var out = '';
    chunks.forEach(function (ch) {
      if (ch.type === 'text') { out += esc(ch.value); return; }
      var html = TA.pdfFormula.renderFormulaHTML(ch.value, ch.displayMode);
      out += '<span class="' + (ch.displayMode ? 'formula-display' : 'formula-inline') +
        '" data-formula="' + esc(ch.tex) + '">' + html + '</span>';
    });
    return out;
  }

  // 分页保排版导出：按 source/target 两层绝对定位，左右对照或仅译文。
  function buildPdfExportHtml(translatedOnly) {
    var pages = '';
    var pageStyle = 'position:relative;margin:18px 0;border:1px solid #e2e5ec;border-radius:8px;overflow:hidden;background:#fff';
    (state.pdfPages || []).forEach(function (page) {
      var layers = '';
      if (!translatedOnly) {
        layers += '<div class="pdf-source" style="position:absolute;inset:0">' + pdfLayerBlocks(page, false) + '</div>';
      }
      layers += '<div class="pdf-target" style="position:absolute;inset:0' +
        (translatedOnly ? '' : ';left:50%;width:50%') + '">' + pdfLayerBlocks(page, true) + '</div>';
      pages += '<section class="pdf-page" data-page="' + page.pageNo + '" style="' + pageStyle +
        ';aspect-ratio:' + page.width + '/' + page.height + '">' + layers + '</section>';
    });
    return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + esc(state.fileName) + (translatedOnly ? ' · 仅译文' : ' · 分页对照') + '</title><style>' +
      'body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:1100px;margin:32px auto;padding:0 16px;color:#222}' +
      '.pdf-block{position:absolute;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.35;overflow:hidden}' +
      '.pdf-source{color:#666}.pdf-target{color:#111}' +
      '.formula-inline{display:inline}.formula-display{display:block;margin:6px 0}' +
      '</style></head><body><h1>' + esc(state.fileName) + '</h1>' + pages + '</body></html>';
  }

  function pdfLayerBlocks(page, translated) {
    var out = '';
    var pw = page.width || 612, ph = page.height || 792;
    (page.blocks || []).forEach(function (idx) {
      var meta = state.segMeta[idx];
      if (!meta) return;
      var original = state.sourceSegments[idx] != null ? state.sourceSegments[idx] : state.segments[idx];
      var text = translated
        ? (state.translations[idx] != null ? state.translations[idx] : original)
        : original;
      var style = 'left:' + (meta.x / pw * 100).toFixed(3) + '%;top:' + (meta.y / ph * 100).toFixed(3) +
        '%;width:' + (Math.max(meta.width, 20) / pw * 100).toFixed(3) + '%';
      out += '<div class="pdf-block" style="' + style + '">' + exportFormulaHtml(text) + '</div>';
    });
    return out;
  }

  function buildExportHtml(translatedOnly) {
    if (state.kind === 'pdf' && state.pdfPages.length) {
      return buildPdfExportHtml(!!translatedOnly);
    }
    var rows = '';
    for (var i = 0; i < state.segments.length; i++) {
      var group = state.groups[i] ? '<div class="grp">' + esc(state.groups[i]) + '</div>' : '';
      if (translatedOnly) {
        rows += '<section class="pair">' + group + '<div class="col"><div class="lbl">译文</div>' +
          '<div class="trans">' + exportFormulaHtml(state.translations[i]) + '</div></div></section>\n';
      } else {
        rows += '<section class="pair">' + group +
          '<div class="num">' + (i + 1) + '</div>' +
          '<div class="col"><div class="lbl">原文</div><div class="orig">' +
          exportFormulaHtml(state.sourceSegments[i] != null ? state.sourceSegments[i] : state.segments[i]) + '</div></div>' +
          '<div class="col"><div class="lbl">译文</div><div class="trans">' + exportFormulaHtml(state.translations[i]) + '</div></div>' +
          '</section>\n';
      }
    }
    return '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + esc(state.fileName) + (translatedOnly ? ' · 仅译文' : ' · 双语对照') + '</title><style>' +
      'body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#222;line-height:1.7}' +
      'h1{font-size:22px}.pair{display:flex;gap:16px;border:1px solid #e2e5ec;border-radius:10px;padding:14px 16px;margin:12px 0;position:relative}' +
      '.num{position:absolute;top:10px;right:14px;color:#aaa;font-size:12px}.grp{width:100%;color:#5b7cfa;font-size:12px;font-weight:700;margin-bottom:4px}' +
      '.col{flex:1;min-width:0}.lbl{font-size:11px;color:#999;margin-bottom:4px}.orig{color:#777;white-space:pre-wrap;word-break:break-word}' +
      '.trans{color:#111;font-weight:500;white-space:pre-wrap;word-break:break-word}' +
      '.formula-inline{display:inline}.formula-display{display:block;margin:6px 0}' +
      '@media(max-width:640px){.pair{flex-direction:column}}</style></head><body>' +
      '<h1>' + esc(state.fileName) + (translatedOnly ? ' · 仅译文' : ' · 双语对照') + '</h1>' + rows + '</body></html>';
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { document.body.removeChild(a); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
    }, 1000);
  }

  /* ==================== UI 辅助 ==================== */

  function showProgress(phase, done, total, note) {
    el.progressArea.hidden = false;
    el.progressPhase.textContent = phase;
    el.progressText.textContent = done + ' / ' + total;
    el.progressBar.style.width = '0%';
    el.progressNote.textContent = note || '';
  }

  function hideProgress() {
    el.progressArea.hidden = true;
  }

  function showNotice(msg, type) {
    el.notice.textContent = msg;
    el.notice.className = 'notice ' + (type === 'error' ? 'error' : 'info');
    el.notice.hidden = false;
  }

  function friendly(err) {
    if (err && typeof err === 'object') {
      if (err.message) return err.message;
      if (err.code) return err.code;
    }
    return String(err || '未知错误');
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // 暴露接口，便于调试/复用（不污染其它模块）
  TA.doc = {
    translateAll: translateAll,
    parseSubtitle: parseSubtitle,
    paragraphsFromText: paragraphsFromText,
    paragraphsFromHtml: paragraphsFromHtml,
    makeChunks: makeChunks,
    // 测试入口：从 ArrayBuffer 解析 PDF 为段落（保留几何/分页/公式）
    parsePdfBuffer: function (buffer) { return parsePdf(buffer); },
    pdfItemsToLines: pdfItemsToLines,
    maskAllSegments: maskAllSegments,
    restoreAllTranslations: restoreAllTranslations,
    buildPdfPagePair: buildPdfPagePair,
    buildExportHtml: buildExportHtml
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
