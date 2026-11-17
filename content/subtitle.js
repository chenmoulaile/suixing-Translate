// content/subtitle.js —— 实时双语字幕（YouTube + 通用 <track> 兜底）
// 特性对标 Immersive Translate 的字幕翻译：抓取站点字幕轨 → 批量送后台翻译 →
// 在 <video> 上方叠加双语浮层，随播放时间同步显示。
//
// 挂载协议（接口冻结）：TA.features.register({
//   name:'subtitle', init, onSettingsChanged, messages, cmds
// })；本文件自包含、自注册，wirer 只需把它加进 manifest 的 content_scripts.js
// 数组并在 shared/defaults.js + options UI 增加 settings.subtitle.* 键。
//
// 依赖（均可选降级）：TA.features / TA.getSettings / TA.getCachedSettings /
//   TA.onSettingsChanged / TA.util.debounce / TA.lang.baseLang；翻译走既有
//   TRANSLATE_BATCH 后台总线（宿主权限需覆盖 youtube.com / video.google.com）。
//
// 设置键（settings.subtitle）：enabled:boolean（默认 false）、
//   autoBilingual:boolean（默认 true）、fontSize:number（默认 18）、
//   showBackground:boolean（默认 false）、targetLang:string（可选覆盖）。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || TA.__subtitleLoaded) return;
  TA.__subtitleLoaded = true;

  /* ==================== 常量 ==================== */

  var LOG = '[TA][subtitle]';
  var MAX_TEXTS = 200;       // 后台单批段数上限
  var MAX_CHARS = 200000;    // 后台单批字符上限
  var TIMEUPDATE_THROTTLE_MS = 100;
  var REDETECT_MS = 400;     // SPA/播放器替换防抖
  var CAPTION_RETRY_MS = 1500;
  var CAPTION_RETRY_MAX = 6;
  var VIDEO_CHECK_MS = 1000; // 兜底轮询：视频元素被替换/移除
  var TRANSLATE_TIMEOUT_MS = 60000;

  /* ==================== 状态 ==================== */

  var state = {
    settings: null,          // 最近一次设置
    running: false,          // 特性启用（钩子已安装）
    active: false,           // 已附着视频并在同步
    video: null,             // 当前 <video>
    host: null,              // overlay 挂载父节点
    hostPrevPos: null,       // 宿主原 position（用于还原）
    overlay: null,
    origEl: null,
    transEl: null,
    cues: [],                // [{startMs, endMs, text, translation?}]
    translations: new Map(), // text → 译文（避免重复翻译）
    targetLang: 'zh-CN',
    captionLang: '',
    hasTracks: false,
    captionsKey: '',         // 当前已加载字幕的来源标识（避免重复抓取）
    loadingCaptions: false,
    captionAttempts: 0,
    lastTU: 0,
    // 观察者/定时器引用
    domObserver: null,
    resizeObserver: null,
    watchTimer: 0,
    captionRetryTimer: 0,
    navigBound: false,
    inRedetect: false
  };

  var FEATURE = null; // 注册对象（延迟构建，便于等 core.js 就绪）

  /* ==================== 工具 ==================== */

  function debug() {
    try {
      if (console && typeof console.debug === 'function') {
        console.debug.apply(console, [LOG].concat(Array.prototype.slice.call(arguments)));
      }
    } catch (e) { /* 忽略 */ }
  }

  function num(v, d) {
    var n = Number(v);
    return isFinite(n) ? n : (typeof d === 'number' ? d : 0);
  }

  function baseLang(code) {
    if (TA.lang && typeof TA.lang.baseLang === 'function') return TA.lang.baseLang(code);
    var c = String(code || '').toLowerCase().trim();
    if (!c) return '';
    return c.indexOf('zh') === 0 ? 'zh' : c.split('-')[0];
  }

  function clampInt(v, lo, hi, d) {
    var n = Number(v);
    if (!isFinite(n)) return d;
    return Math.min(Math.max(Math.round(n), lo), hi);
  }

  // 当前目标语言：settings.subtitle.targetLang → 全局 targetLang → zh-CN
  function resolveTargetLang() {
    var c = (state.settings && state.settings.subtitle) || {};
    if (c.targetLang) return c.targetLang;
    var cached = null;
    try { cached = typeof TA.getCachedSettings === 'function' ? TA.getCachedSettings() : null; } catch (e) {}
    return (cached && cached.targetLang) || 'zh-CN';
  }

  // 防御式读取设置（缺省 enabled=false / fontSize=18）
  function cfg(s) {
    var c = (s && s.subtitle) || {};
    return {
      enabled: !!c.enabled,
      autoBilingual: c.autoBilingual !== false,
      fontSize: clampInt(c.fontSize, 10, 48, 18),
      showBackground: !!c.showBackground,
      targetLang: c.targetLang || resolveTargetLang()
    };
  }

  function isYouTube() { return /(^|\.)youtube\.com$/.test(location.hostname); }

  function resolveUrl(u) {
    try { return new URL(String(u), location.href).href; } catch (e) { return String(u || ''); }
  }

  function isOwnNode(n) {
    return !!(n && n.nodeType === 1 &&
      (n === state.overlay || (typeof n.closest === 'function' && n.closest('.ta-sub-overlay'))));
  }

  /* ==================== 字幕源探测 ==================== */

  // 从脚本文本中按大括号配平提取 JSON 对象（跳过字符串内的括号）
  function extractJsonAfter(text, marker) {
    var idx = text.indexOf(marker);
    if (idx < 0) return null;
    var i = idx + marker.length;
    while (i < text.length && /[\s=:]/.test(text[i])) i++;
    if (text[i] !== '{') return null;
    var start = i;
    var depth = 0, inStr = false, esc = false;
    for (; i < text.length; i++) {
      var ch = text[i];
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  // 取 YouTube 播放器响应（全局变量优先，其次遍历 script 文本）
  function getPlayerResponse() {
    try {
      if (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.captions) {
        return window.ytInitialPlayerResponse;
      }
    } catch (e) { /* 忽略 */ }
    var scripts = document.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var txt = '';
      try { txt = String(scripts[i].textContent || ''); } catch (e2) { continue; }
      if (txt.indexOf('ytInitialPlayerResponse') === -1) continue;
      var obj = extractJsonAfter(txt, 'ytInitialPlayerResponse');
      if (obj && obj.captions) return obj;
    }
    return null;
  }

  // 评分选轨：手工轨优先于 asr；同档内优先外语（非目标语言）
  function trackScore(langCode, isAsr, targetBase) {
    var s = 0;
    if (!isAsr) s += 4;
    var base = baseLang(langCode);
    if (base && base !== targetBase) s += 2;
    return s;
  }

  function pickCaptionTrack(captions, targetBase) {
    var r = captions && captions.playerCaptionsTracklistRenderer;
    var list = r && r.captionTracks;
    if (!Array.isArray(list) || !list.length) return null;
    var best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || !t.baseUrl) continue;
      var sc = trackScore(t.languageCode, t.kind === 'asr', targetBase);
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best;
  }

  function findVideo() {
    var vids = [];
    try { vids = document.querySelectorAll('video'); } catch (e) { return null; }
    // 优先可见/正在播放/已有画面的视频
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      try {
        if (!v.paused || v.videoWidth || v.currentTime > 0) return v;
      } catch (e2) { /* 继续 */ }
    }
    return vids.length ? vids[0] : null;
  }

  // 返回 {url, fmt:'json3'|'vtt'} 或 null
  function getCaptionSource() {
    var targetBase = baseLang(resolveTargetLang());
    if (isYouTube()) {
      var pr = getPlayerResponse();
      if (pr) {
        var track = pickCaptionTrack(pr.captions, targetBase);
        if (track) {
          state.captionLang = String(track.languageCode || '');
          return { url: resolveUrl(track.baseUrl), fmt: 'json3' };
        }
      }
    }
    // 通用兜底：当前视频下的 <track> 元素
    var v = state.video || findVideo();
    var tracks = [];
    try { tracks = v && v.querySelectorAll ? v.querySelectorAll('track') : []; } catch (e) {}
    if (!tracks.length) {
      try { tracks = document.querySelectorAll('video track'); } catch (e2) {}
    }
    var best = null, bestScore = -1;
    for (var i = 0; i < tracks.length; i++) {
      var tr = tracks[i];
      if (!tr || !tr.src) continue;
      var kind = String(tr.kind || '');
      if (kind === 'metadata') continue;
      var sc = trackScore(tr.srclang, kind === 'captions', targetBase) + (kind === 'subtitles' ? 1 : 0);
      if (sc > bestScore) { bestScore = sc; best = tr; }
    }
    if (best) {
      state.captionLang = String(best.srclang || '');
      return { url: resolveUrl(best.src), fmt: 'vtt' };
    }
    return null;
  }

  /* ==================== 字幕解析 ==================== */

  function fetchJson3(url) {
    var sep = url.indexOf('?') !== -1 ? '&' : '?';
    return fetch(url + sep + 'fmt=json3').then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      return r.json();
    }).then(function (data) {
      var events = data && data.events;
      var cues = [];
      if (!Array.isArray(events)) return cues;
      for (var i = 0; i < events.length; i++) {
        var e = events[i] || {};
        var parts = [];
        if (Array.isArray(e.segs)) {
          for (var j = 0; j < e.segs.length; j++) {
            var seg = e.segs[j];
            if (seg && seg.utf8) parts.push(String(seg.utf8).replace(/\r?\n/g, ' '));
          }
        }
        var text = parts.join('').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        var start = num(e.tStartMs, 0);
        var dur = num(e.durationMs, 0);
        var end = start + dur;
        if (!(end > start)) {
          var next = events[i + 1];
          var ns = next ? num(next.tStartMs, 0) : 0;
          end = ns > start ? ns : start + 3000;
        }
        cues.push({ startMs: start, endMs: end, text: text });
      }
      return cues;
    });
  }

  function vttTimeMs(str) {
    var parts = String(str).replace(',', '.').split(':');
    var h = 0, m = 0, s = 0, ms = 0;
    if (parts.length === 3) { h = num(parts[0], 0); m = num(parts[1], 0); parts = [parts[2]]; }
    else if (parts.length === 2) { m = num(parts[0], 0); parts = [parts[1]]; }
    else if (parts.length !== 1) return NaN;
    var sp = String(parts[0]).split('.');
    s = num(sp[0], 0);
    if (sp[1]) {
      ms = num(sp[1], 0);
      if (sp[1].length === 1) ms *= 100;
      else if (sp[1].length === 2) ms *= 10;
    }
    return ((h * 60 + m) * 60 + s) * 1000 + ms;
  }

  function parseWebVTT(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var timeRe = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;
    var cues = [];
    var i = 0;
    while (i < lines.length) {
      var m = lines[i].match(timeRe);
      if (!m) { i++; continue; }
      var start = vttTimeMs(m[1]);
      var end = vttTimeMs(m[2]);
      i++;
      var parts = [];
      while (i < lines.length && lines[i].trim() !== '' && !timeRe.test(lines[i])) {
        var ln = lines[i].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
        if (ln) parts.push(ln);
        i++;
      }
      var cueText = parts.join(' ').replace(/\s+/g, ' ').trim();
      if (cueText && isFinite(start) && isFinite(end) && end > start) {
        cues.push({ startMs: start, endMs: end, text: cueText });
      }
    }
    return cues;
  }

  function fetchVtt(url) {
    return fetch(url).then(function (r) {
      if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
      return r.text();
    }).then(parseWebVTT);
  }

  /* ==================== 翻译通道 ==================== */

  // 批量直译（兼容后台 TRANSLATE_BATCH_RESULT 广播兜底；主路径为 sendMessage 回调）
  function translateTexts(texts, targetLang) {
    return new Promise(function (resolve, reject) {
      var id = 'sub-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      var done = false;
      function finish(fn, val) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { chrome.runtime.onMessage.removeListener(h); } catch (e) {}
        fn(val);
      }
      var h = function (m) {
        if (m && m.type === 'TRANSLATE_BATCH_RESULT' && m.batchId === id) {
          finish(resolve, m.result || m.translations);
        }
      };
      var timer = setTimeout(function () { finish(reject, { code: 'TIMEOUT' }); }, TRANSLATE_TIMEOUT_MS);
      try { chrome.runtime.onMessage.addListener(h); } catch (e) {}
      try {
        chrome.runtime.sendMessage({
          type: 'TRANSLATE_BATCH',
          batchId: id,
          texts: texts,
          targetLang: targetLang || 'zh-CN',
          sourceLang: 'auto',
          service: null
        }, function (res) {
          if (!res) return; // 无响应：等待广播或超时
          if (res.ok) finish(resolve, res.translations);
          else finish(reject, res.error || { code: 'TRANSLATE_FAILED' });
        });
      } catch (e) {
        finish(reject, (e && e.code) ? e : { code: 'NETWORK' });
      }
    });
  }

  // 对 cues 里尚未缓存的文本分批翻译（去重 + 分包）
  function translateCues(cues, targetLang) {
    var pending = [];
    var seen = new Set();
    for (var i = 0; i < cues.length; i++) {
      var t = cues[i].text;
      if (!t || state.translations.has(t) || seen.has(t)) continue;
      seen.add(t);
      pending.push(t);
    }
    if (!pending.length) return Promise.resolve();

    var chunks = [];
    var cur = [], curLen = 0;
    for (var k = 0; k < pending.length; k++) {
      var txt = pending[k];
      if (cur.length && (cur.length >= MAX_TEXTS || (curLen + txt.length) > MAX_CHARS)) {
        chunks.push(cur); cur = []; curLen = 0;
      }
      cur.push(txt); curLen += txt.length;
    }
    if (cur.length) chunks.push(cur);

    var chain = Promise.resolve();
    chunks.forEach(function (chunk) {
      chain = chain.then(function () {
        return translateTexts(chunk, targetLang).then(function (res) {
          var arr = Array.isArray(res) ? res : (res && res.translations);
          if (Array.isArray(arr)) {
            for (var n = 0; n < chunk.length; n++) {
              if (typeof arr[n] === 'string' && arr[n]) state.translations.set(chunk[n], arr[n]);
            }
          }
          if (state.overlay) renderCurrent(); // 译文回填后即刻刷新
        }).catch(function (err) {
          debug('批量翻译失败（降级为仅原文）', err);
        });
      });
    });
    return chain;
  }

  /* ==================== Overlay 构建与定位 ==================== */

  function buildOverlay() {
    var host = state.video && state.video.parentElement;
    if (!host) return false;
    teardownOverlay();

    // 宿主为 static 时改为 relative，使 overlay 的 absolute 定位以视频容器为基准
    try {
      var pos = String(window.getComputedStyle(host).position || '');
      if (pos === 'static') {
        state.hostPrevPos = host.style.position || '';
        host.style.position = 'relative';
      } else {
        state.hostPrevPos = null;
      }
    } catch (e) { state.hostPrevPos = null; }

    var overlay = document.createElement('div');
    overlay.className = 'ta-sub-overlay';
    overlay.setAttribute('translate', 'no');
    overlay.setAttribute('aria-live', 'off');
    try { overlay.classList.add('notranslate'); } catch (e) {}

    var orig = document.createElement('div'); orig.className = 'ta-sub-original';
    var trans = document.createElement('div'); trans.className = 'ta-sub-trans';
    overlay.appendChild(orig);
    overlay.appendChild(trans);
    try { host.appendChild(overlay); } catch (e2) { return false; }

    state.host = host;
    state.overlay = overlay;
    state.origEl = orig;
    state.transEl = trans;
    positionOverlay();
    return true;
  }

  function positionOverlay() {
    var o = state.overlay, v = state.video, h = state.host;
    if (!o) return;
    var c = cfg(state.settings);
    o.style.setProperty('--ta-sub-fs', c.fontSize + 'px');
    if (c.showBackground) o.classList.add('ta-sub-bg');
    else o.classList.remove('ta-sub-bg');
    if (!v || !h) return;
    try {
      var hr = h.getBoundingClientRect(), vr = v.getBoundingClientRect();
      if (hr.height > 0 && vr.height > 0) {
        // 让浮层底部落在视频可视区底部往上 16% 处
        var bottom = Math.max(0, hr.bottom - vr.bottom + vr.height * 0.16);
        o.style.bottom = Math.round(bottom) + 'px';
      }
    } catch (e) { /* 回退到 CSS 的 bottom:16% */ }
  }

  function teardownOverlay() {
    if (state.overlay) {
      try { state.overlay.remove(); } catch (e) {
        try { if (state.overlay.parentNode) state.overlay.parentNode.removeChild(state.overlay); } catch (e2) {}
      }
    }
    if (state.host && state.hostPrevPos !== null) {
      try { state.host.style.position = state.hostPrevPos; } catch (e) {}
    }
    state.overlay = null;
    state.origEl = null;
    state.transEl = null;
    state.host = null;
    state.hostPrevPos = null;
  }

  /* ==================== 播放同步与渲染 ==================== */

  function findCue(ms) {
    var cues = state.cues;
    for (var i = 0; i < cues.length; i++) {
      if (cues[i].startMs <= ms && ms < cues[i].endMs) return cues[i];
      if (cues[i].startMs > ms) break;
    }
    return null;
  }

  function setText(el, text) {
    if (!el) return;
    if (el.textContent !== text) el.textContent = text;
  }

  function renderCue(cue) {
    if (!state.origEl || !state.transEl) return;
    var c = cfg(state.settings);
    if (!cue) {
      setText(state.origEl, '');
      setText(state.transEl, '');
      return;
    }
    var tr = state.translations.get(cue.text) || '';
    if (!c.autoBilingual) {
      // 仅译文模式：无译文时降级为仅原文
      setText(state.origEl, '');
      setText(state.transEl, tr || cue.text);
    } else {
      setText(state.origEl, cue.text);
      setText(state.transEl, tr);
    }
  }

  function renderCurrent() {
    if (!state.video || !state.active) return;
    try {
      renderCue(findCue(num(state.video.currentTime, 0) * 1000));
    } catch (e) { /* 忽略 */ }
  }

  function onTimeUpdate() {
    if (!state.active || !state.video) return;
    var now = Date.now();
    if (now - state.lastTU < TIMEUPDATE_THROTTLE_MS) return;
    state.lastTU = now;
    renderCurrent();
  }

  /* ==================== 字幕加载流程 ==================== */

  function loadCaptions() {
    if (state.loadingCaptions) return;
    var src = getCaptionSource();
    state.hasTracks = !!src;
    if (!src) {
      // 轨道尚未就绪（SPA 切换常见）：有限次重试
      if (state.captionAttempts < CAPTION_RETRY_MAX) {
        state.captionAttempts++;
        state.captionRetryTimer = setTimeout(function () {
          state.captionRetryTimer = 0;
          if (state.running) loadCaptions();
        }, CAPTION_RETRY_MS);
      }
      return;
    }
    var key = src.fmt + '|' + src.url;
    if (key === state.captionsKey && state.cues.length) return;
    state.loadingCaptions = true;
    state.captionAttempts = 0;

    var p = src.fmt === 'json3' ? fetchJson3(src.url) : fetchVtt(src.url);
    p.then(function (cues) {
      state.cues = cues || [];
      state.captionsKey = key;
      state.hasTracks = state.cues.length > 0;
      debug('字幕已加载', state.cues.length, '条, lang=' + state.captionLang);
      return translateCues(state.cues.slice(), resolveTargetLang());
    }).catch(function (err) {
      debug('字幕抓取/解析失败，降级为仅原文', err);
      state.hasTracks = false;
    }).then(function () {
      state.loadingCaptions = false;
      if (state.overlay) renderCurrent();
    });
  }

  /* ==================== 视频附着 / 拆除 ==================== */

  function attachVideo(v) {
    state.video = v;
    state.active = true;
    state.cues = [];
    state.captionsKey = '';
    state.captionAttempts = 0;
    state.translations.clear();
    if (!buildOverlay()) {
      debug('无法挂载浮层（视频无父节点）');
      state.active = false;
      return;
    }
    try { v.addEventListener('timeupdate', onTimeUpdate, true); } catch (e) {}
    try { v.addEventListener('seeked', onTimeUpdate, true); } catch (e) {}
    try { v.addEventListener('playing', onTimeUpdate, true); } catch (e) {}
    if (typeof ResizeObserver === 'function') {
      try {
        state.resizeObserver = new ResizeObserver(function () { positionOverlay(); });
        state.resizeObserver.observe(state.host || v);
      } catch (e) { state.resizeObserver = null; }
    }
    window.addEventListener('resize', positionOverlay);
    loadCaptions();
  }

  function detachVideo() {
    if (state.video) {
      try { state.video.removeEventListener('timeupdate', onTimeUpdate, true); } catch (e) {}
      try { state.video.removeEventListener('seeked', onTimeUpdate, true); } catch (e) {}
      try { state.video.removeEventListener('playing', onTimeUpdate, true); } catch (e) {}
    }
    if (state.resizeObserver) {
      try { state.resizeObserver.disconnect(); } catch (e) {}
      state.resizeObserver = null;
    }
    window.removeEventListener('resize', positionOverlay);
    clearTimeout(state.captionRetryTimer);
    state.captionRetryTimer = 0;
    teardownOverlay();
    state.video = null;
    state.active = false;
    state.cues = [];
    state.captionsKey = '';
    state.loadingCaptions = false;
    state.captionAttempts = 0;
    state.hasTracks = false;
  }

  /* ==================== SPA / DOM 钩子 ==================== */

  function mutationTouchesVideo(m) {
    var candidates = [m.target];
    if (m.addedNodes) for (var a = 0; a < m.addedNodes.length; a++) candidates.push(m.addedNodes[a]);
    if (m.removedNodes) for (var r = 0; r < m.removedNodes.length; r++) candidates.push(m.removedNodes[r]);
    for (var i = 0; i < candidates.length; i++) {
      var n = candidates[i];
      if (!n || n.nodeType !== 1 || isOwnNode(n)) continue;
      if (String(n.tagName || '').toLowerCase() === 'video') return true;
      if (typeof n.querySelector === 'function' && n.querySelector('video')) return true;
      // 播放器响应脚本注入（字幕轨信息就绪）
      if (String(n.tagName || '').toLowerCase() === 'script' &&
          String(n.textContent || '').indexOf('ytInitialPlayerResponse') !== -1) return true;
    }
    return false;
  }

  function onDomMutation(muts) {
    if (!state.running || state.inRedetect) return;
    for (var i = 0; i < muts.length; i++) {
      if (mutationTouchesVideo(muts[i])) { scheduleRedetect(); return; }
    }
  }

  function onYtNavigate() { scheduleRedetect(); }

  function checkVideo() {
    if (!state.running || state.inRedetect) return;
    var v = findVideo();
    if (!v) {
      if (state.video) scheduleRedetect();
      return;
    }
    if (v !== state.video) scheduleRedetect();
  }

  function debounce(fn, ms) {
    if (TA.util && typeof TA.util.debounce === 'function') return TA.util.debounce(fn, ms);
    var t = 0;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  var doRedetect = debounce(function () { redetect(); }, REDETECT_MS);

  function scheduleRedetect() {
    if (!state.running) return;
    doRedetect();
  }

  function redetect() {
    if (!state.running || state.inRedetect) return;
    state.inRedetect = true;
    try {
      var v = findVideo();
      if (!v) { detachVideo(); return; }
      if (v !== state.video) detachVideo();
      if (!state.video) attachVideo(v);
      else {
        // 同一视频：刷新配置 + 若字幕尚未就绪则继续尝试
        positionOverlay();
        if (!state.cues.length && !state.loadingCaptions) loadCaptions();
      }
    } catch (e) {
      debug('重检测失败', e);
    } finally {
      state.inRedetect = false;
    }
  }

  function installHooks() {
    if (!state.domObserver) {
      try {
        state.domObserver = new MutationObserver(onDomMutation);
        state.domObserver.observe(document.documentElement || document, {
          childList: true, subtree: true
        });
      } catch (e) { state.domObserver = null; }
    }
    if (!state.navigBound) {
      try {
        document.addEventListener('yt-navigate-finish', onYtNavigate, true);
        state.navigBound = true;
      } catch (e) {}
    }
    if (!state.watchTimer) {
      state.watchTimer = setInterval(checkVideo, VIDEO_CHECK_MS);
    }
  }

  function removeHooks() {
    if (state.domObserver) {
      try { state.domObserver.disconnect(); } catch (e) {}
      state.domObserver = null;
    }
    if (state.navigBound) {
      try { document.removeEventListener('yt-navigate-finish', onYtNavigate, true); } catch (e) {}
      state.navigBound = false;
    }
    if (state.watchTimer) { clearInterval(state.watchTimer); state.watchTimer = 0; }
  }

  /* ==================== 生命周期 ==================== */

  function applyOverlayConfig() {
    positionOverlay();
    if (state.overlay) renderCurrent();
  }

  function start(settings) {
    state.settings = settings || state.settings || {};
    var c = cfg(state.settings);
    if (!c.enabled) { stop(); return; }

    // 目标语言变化 → 清空译文缓存与已加载字幕，重新翻译
    if (c.targetLang !== state.targetLang) {
      state.targetLang = c.targetLang;
      state.translations.clear();
      state.cues = [];
      state.captionsKey = '';
    }
    state.running = true;
    installHooks();
    if (state.active) {
      applyOverlayConfig();
      if (!state.cues.length && !state.loadingCaptions) loadCaptions();
    } else {
      redetect();
    }
  }

  function stop() {
    removeHooks();
    detachVideo();
    state.running = false;
    state.hasTracks = false;
    debug('已停止');
  }

  function initFeature(settings) {
    try {
      state.settings = settings || (typeof TA.getCachedSettings === 'function' ? TA.getCachedSettings() : null) || {};
      state.targetLang = resolveTargetLang();
      if (cfg(state.settings).enabled) start(state.settings);
      else stop();
    } catch (e) {
      debug('init 异常（已吞没）', e);
    }
  }

  function onSettingsChanged(settings) {
    try {
      var prevTarget = state.targetLang;
      state.settings = settings || {};
      state.targetLang = resolveTargetLang();
      var c = cfg(state.settings);
      if (!c.enabled) { stop(); return; }
      if (prevTarget !== state.targetLang) {
        state.translations.clear();
        state.cues = [];
        state.captionsKey = '';
      }
      start(state.settings);
      applyOverlayConfig();
    } catch (e) {
      debug('onSettingsChanged 异常（已吞没）', e);
    }
  }

  // 开关（供消息 / 命令复用）：同步落地内存态，并尽力持久化
  function setEnabled(next) {
    next = !!next;
    var base = state.settings || (typeof TA.getCachedSettings === 'function' ? TA.getCachedSettings() : null) || {};
    state.settings = Object.assign({}, base, {
      subtitle: Object.assign({}, (base.subtitle || {}), { enabled: next })
    });
    if (next) start(state.settings);
    else stop();
    try {
      if (typeof TA.saveSettings === 'function') {
        TA.saveSettings({ subtitle: { enabled: next } }).catch(function () {});
      }
    } catch (e) { /* 忽略 */ }
    return next;
  }

  function currentEnabled() {
    return cfg(state.settings || (typeof TA.getCachedSettings === 'function' ? TA.getCachedSettings() : null)).enabled;
  }

  function status() {
    var c = cfg(state.settings || (typeof TA.getCachedSettings === 'function' ? TA.getCachedSettings() : null));
    return {
      ok: true,
      enabled: !!c.enabled,
      hasTracks: !!state.hasTracks,
      active: !!(c.enabled && state.active && state.overlay),
      lang: c.targetLang,
      sourceLang: state.captionLang || '',
      youtube: isYouTube(),
      cueCount: state.cues.length
    };
  }

  /* ==================== 注册 ==================== */

  FEATURE = {
    name: 'subtitle',
    init: function (settings) { initFeature(settings); },
    onSettingsChanged: function (settings) { onSettingsChanged(settings); },
    messages: {
      'SUBTITLE_TOGGLE': function (msg) {
        try {
          var next = (msg && typeof msg.enabled === 'boolean') ? msg.enabled : !currentEnabled();
          return { ok: true, enabled: setEnabled(next) };
        } catch (e) {
          return { ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } };
        }
      },
      'SUBTITLE_STATUS': function () {
        try { return status(); }
        catch (e) { return { ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } }; }
      }
    },
    cmds: {
      'toggle-subtitle': function () {
        try { setEnabled(!currentEnabled()); } catch (e) { debug('cmd 异常', e); }
      }
    }
  };

  // 注册（core.js 尚未就绪时短暂轮询等待，保证自包含）
  if (TA.features && typeof TA.features.register === 'function') {
    TA.features.register(FEATURE);
  } else {
    var tries = 0;
    var regTimer = setInterval(function () {
      if (TA.features && typeof TA.features.register === 'function') {
        clearInterval(regTimer);
        TA.features.register(FEATURE);
      } else if (++tries > 100) {
        clearInterval(regTimer);
      }
    }, 50);
  }

  // 与 interactions.js 一致：注册表尚未被 main.js 驱动时自初始化（幂等）
  if (typeof TA.getSettings === 'function') {
    TA.getSettings().then(function (s) {
      try { initFeature(s); } catch (e) { debug('自初始化异常', e); }
    }).catch(function () {});
  }
  if (typeof TA.onSettingsChanged === 'function') {
    TA.onSettingsChanged(function (s) {
      try { onSettingsChanged(s); } catch (e) { debug('自监听设置异常', e); }
    });
  }
})();
