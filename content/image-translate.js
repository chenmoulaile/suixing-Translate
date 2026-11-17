// content/image-translate.js —— 图片翻译（OCR，Immersive-Translate 风格）
// 挂载方式：TA.features.register（core.js 注册表；main.js 统一 init / 消息 / CMD 分发）。
// 两个触发入口：
//   ① 消息 IMAGE_TRANSLATE（右键菜单 ta-ctx-image 点击后由 background 转发）：
//      {url?:string, dataUrl?:string} → 取图 → OCR → 翻译 → 结果卡。
//   ② 悬停按钮：图片足够大（≥180×120）悬停 ~450ms 显示「译」按钮，点击走同一管线。
//      canvas 取 dataUrl 规避跨域 fetch；canvas 被污染时回退把 url 交给 OCR API。
// OCR 引擎：ocr.space 免密钥 demo（apikey:'helloworld'，有速率限制）；任何失败 throw，
// 由 run() 收口成 {ok:false,error} 并提示，绝不向页面抛异常。
// 宿主权限：需 background 侧放行 https://api.ocr.space/*（由接线方补充）。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || !TA.util || !TA.features || TA.__imageTranslateLoaded) {
    if (TA && !TA.__imageTranslateLoaded && (!TA.util || !TA.features)) {
      console.error('[TA] content/image-translate.js: 前置文件 content/core.js 未加载');
    }
    return;
  }
  TA.__imageTranslateLoaded = true;

  /* ==================== 常量 / 状态 ==================== */

  var OCR_URL = 'https://api.ocr.space/parse/image';
  var HOVER_DELAY_MS = 450;     // 悬停显示按钮的防抖时长
  var HIDE_DELAY_MS = 250;      // 移出图片后延迟收按钮（允许移入按钮点击）
  var BATCH_SIZE = 5;           // 行翻译并发批次
  var CARD_SEL = '.ta-img-trans-card';
  var OWN_UI_SEL = '.ta-img-hover-btn, .ta-img-trans-card';

  var currentSettings = null;
  var currentCfg = null;
  var listenersBound = false;
  var shownImgs = new WeakSet();        // 已展示过按钮的图片（不重复展示）
  var lineCache = new Map();            // 行译文缓存：key = [service,targetLang,line]

  var hoverState = {
    img: null,        // 当前挂了按钮的 img
    btn: null,        // 当前按钮元素
    lastImg: null,    // 最近一次悬停到的 img（命令兜底用）
    hideTimer: 0,
    lastMouse: { x: 0, y: 0 }
  };

  var cardEl = null;    // 当前结果卡
  var copyBtn = null;   // 结果卡上的「复制全部」按钮

  /* ==================== 配置读取（缺省键防御回填） ==================== */

  function cfgImage(s) {
    var c = (s && s.imageTranslate) || {};
    var trigger = c.trigger;
    if (trigger !== 'hover' && trigger !== 'context' && trigger !== 'both') trigger = 'both';
    return {
      enabled: !!c.enabled,
      trigger: trigger,
      service: c.service || undefined,
      targetLang: c.targetLang || undefined
    };
  }

  function hoverAllowed() {
    return !!(currentCfg && currentCfg.enabled &&
              (currentCfg.trigger === 'hover' || currentCfg.trigger === 'both'));
  }

  /* ==================== 状态提示 ==================== */

  function tip(msg) {
    console.debug('[TA][img-trans]', msg);
    try {
      if (TA.ball && typeof TA.ball.showTip === 'function') TA.ball.showTip(msg, 2400);
    } catch (e) { /* 提示通道不可用时静默 */ }
  }

  /* ==================== 图片字节获取 ==================== */

  // 从 <img> 取图：优先 canvas → dataUrl（同源/CORS 已授权图片可直接读）；
  // canvas 被污染（跨域未授权）抛 SecurityError → 回退把 http(s) url 交给 OCR API。
  function imagePayload(img) {
    if (!img || img.tagName !== 'IMG') return null;
    var url = img.currentSrc || img.src || '';
    try {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (w > 0 && h > 0) {
        // 限幅，避免超大图产生过大的 base64（demo key 有体积上限）
        var max = 1600;
        if (w > max || h > max) {
          var scale = max / Math.max(w, h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
        }
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        var dataUrl = c.toDataURL('image/png'); // 污染 canvas 会在此抛出
        if (typeof dataUrl === 'string' && dataUrl.indexOf('data:image/png;base64,') === 0) {
          return { dataUrl: dataUrl };
        }
      }
    } catch (e) { /* 落入 URL / dataUrl 回退 */ }
    if (/^https?:\/\//i.test(url)) return { url: url };
    if (/^data:image\//i.test(url)) return { dataUrl: url };
    return null;
  }

  // 右键菜单带 url 时，尽量在页面里找到对应 <img>，好把结果卡贴着它显示
  function findImgByUrl(url) {
    if (!url) return null;
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].currentSrc === url || imgs[i].src === url ||
          imgs[i].getAttribute('src') === url) return imgs[i];
    }
    return null;
  }

  /* ==================== OCR 引擎（ocr.space demo key） ==================== */

  function ocrImage(msg) {
    msg = msg || {};
    if (!msg.dataUrl && !msg.url) {
      return Promise.reject({ code: 'BAD_REQUEST', message: '缺少图片数据（url / dataUrl）' });
    }
    var fd = new FormData();
    fd.append('apikey', 'helloworld');
    fd.append('language', 'eng');
    fd.append('isOverlayRequired', 'true');
    fd.append('OCREngine', '2');
    fd.append('scale', 'true');
    fd.append('detectOrientation', 'true');
    if (msg.dataUrl) fd.append('base64Image', msg.dataUrl);
    else fd.append('url', msg.url);

    return fetch(OCR_URL, { method: 'POST', body: fd })
      .then(function (res) {
        if (!res.ok) throw { code: 'HTTP_ERROR', message: 'OCR 服务返回 HTTP ' + res.status };
        return res.json();
      })
      .then(function (json) {
        if (json && json.IsErroredOnProcessing) {
          var em = (json.ErrorMessage && (json.ErrorMessage[0] || json.ErrorMessage)) || '';
          throw { code: 'OCR_ERROR', message: typeof em === 'string' && em ? em : 'OCR 处理失败' };
        }
        var parsed = json && json.ParsedResults && json.ParsedResults[0];
        var text = parsed && parsed.ParsedText;
        if (typeof text !== 'string' || !text.trim()) {
          throw { code: 'NO_TEXT', message: '未在图片中识别到文字' };
        }
        return text;
      })
      .catch(function (e) {
        if (e && e.code) throw e;
        throw { code: 'NETWORK', message: 'OCR 请求失败：' + ((e && e.message) || String(e)) };
      });
  }

  /* ==================== 文本分行 + 批量翻译（带缓存） ==================== */

  function splitLines(text) {
    return String(text || '').split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; });
  }

  function cacheKey(line, cfg) {
    return JSON.stringify([cfg.service || '', cfg.targetLang || '', line]);
  }

  // 小并发（每批 5 行）逐行译；单行失败保留原文；管线未就绪时回显原文。
  function translateLines(lines, cfg) {
    var out = new Array(lines.length);
    var i = 0;

    function nextBatch() {
      var batch = [];
      while (i < lines.length && batch.length < BATCH_SIZE) {
        batch.push(i);
        i += 1;
      }
      if (!batch.length) return Promise.resolve();
      return Promise.all(batch.map(function (idx) {
        var line = lines[idx];
        var key = cacheKey(line, cfg);
        if (lineCache.has(key)) {
          out[idx] = lineCache.get(key);
          return Promise.resolve();
        }
        if (!TA.pipeline || typeof TA.pipeline.translateText !== 'function') {
          out[idx] = line;
          return Promise.resolve();
        }
        return TA.pipeline.translateText(line, {
          service: cfg.service || undefined,
          targetLang: cfg.targetLang || undefined
        }).then(function (t) {
          out[idx] = (typeof t === 'string' && t) ? t : line;
          lineCache.set(key, out[idx]);
        }, function () {
          out[idx] = line; // 单行失败：保留原文，不让整批失败
        });
      })).then(nextBatch);
    }

    return nextBatch().then(function () { return out; });
  }

  /* ==================== 结果卡（关闭 / 复制全部 / Esc） ==================== */

  function removeCard() {
    if (cardEl && cardEl.isConnected) cardEl.remove();
    cardEl = null;
    copyBtn = null;
  }

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

  function copyAll(originalLines, translations) {
    var parts = [];
    for (var i = 0; i < originalLines.length; i++) {
      parts.push(originalLines[i]);
      parts.push(translations[i] == null ? '' : translations[i]);
    }
    var text = parts.join('\n');
    var done = function (ok) {
      if (!copyBtn) return;
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () {
        if (copyBtn) copyBtn.textContent = '复制全部';
      }, 1500);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text)
        .then(function () { done(true); })
        .catch(function () { done(legacyCopy(text)); });
    } else {
      done(legacyCopy(text));
    }
  }

  // 渲染结果卡：每行「原文在上、译文在下」；有 imgEl 时固定定位贴近图片，
  // 否则清空 inline 定位，落回 CSS 默认的右下角浮层。
  function showResult(imgEl, originalLines, translations) {
    removeCard();
    originalLines = originalLines || [];
    translations = translations || [];

    var card = document.createElement('div');
    card.className = 'ta-img-trans-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('translate', 'no');
    card.classList.add('notranslate');

    var head = document.createElement('div');
    head.className = 'ta-img-trans-head';
    var title = document.createElement('span');
    title.className = 'ta-img-trans-title';
    title.textContent = '图片翻译';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ta-img-trans-copy';
    copy.textContent = '复制全部';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'ta-img-trans-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    head.appendChild(title);
    head.appendChild(copy);
    head.appendChild(close);
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'ta-img-trans-body';
    for (var i = 0; i < originalLines.length; i++) {
      var line = document.createElement('div');
      line.className = 'ta-img-trans-line';
      var src = document.createElement('div');
      src.className = 'ta-img-trans-src';
      src.textContent = originalLines[i];
      var dst = document.createElement('div');
      dst.className = 'ta-img-trans-dst';
      dst.textContent = translations[i] == null ? '' : translations[i];
      line.appendChild(src);
      line.appendChild(dst);
      body.appendChild(line);
    }
    card.appendChild(body);

    close.addEventListener('click', removeCard);
    copy.addEventListener('click', function (e) {
      e.stopPropagation();
      copyAll(originalLines, translations);
    });
    card.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    card.setAttribute('dir', 'auto');

    (document.documentElement || document.body).appendChild(card);
    cardEl = card;
    copyBtn = copy;

    // 贴着图片显示（position:fixed，用 inline 覆盖 CSS 的 right/bottom 默认值）
    if (imgEl && imgEl.isConnected) {
      var r = imgEl.getBoundingClientRect();
      if (r && (r.width || r.height)) {
        var cw = card.offsetWidth || 380;
        var ch = card.offsetHeight || 0;
        var left = r.right + 10;
        if (left + cw > window.innerWidth - 8) left = r.left - cw - 10;
        if (left < 8) left = 8;
        var top = r.top;
        if (top + ch > window.innerHeight - 8) {
          top = Math.max(8, window.innerHeight - ch - 8);
        }
        card.style.right = 'auto';
        card.style.bottom = 'auto';
        card.style.left = Math.round(left) + 'px';
        card.style.top = Math.round(top) + 'px';
      }
    }
    return card;
  }

  /* ==================== 主入口 run() ==================== */

  function run(msg, imgEl) {
    msg = msg || {};
    var cfg = currentCfg || cfgImage(TA.getCachedSettings && TA.getCachedSettings());
    imgEl = imgEl || findImgByUrl(msg.url);

    return ocrImage(msg).then(function (text) {
      var lines = splitLines(text);
      if (!lines.length) {
        tip('未在图片中识别到文字');
        return { ok: false, original: '', originalLines: [], translations: [],
                 error: { code: 'NO_TEXT', message: '未在图片中识别到文字' } };
      }
      tip('识别到 ' + lines.length + ' 行，翻译中…');
      return translateLines(lines, cfg).then(function (translations) {
        showResult(imgEl, lines, translations);
        tip('图片翻译完成');
        return { ok: true, original: text.trim(), originalLines: lines, translations: translations };
      });
    }).catch(function (e) {
      var err = (e && e.code) ? e : { code: 'INTERNAL', message: String((e && e.message) || e) };
      tip('图片翻译失败：' + (err.message || '未知错误'));
      return { ok: false, original: '', originalLines: [], translations: [], error: err };
    });
  }

  // 从 <img> 元素发起（悬停按钮 / CMD）：先取字节，取不到再退化为 url。
  function runImageEl(img) {
    var payload = imagePayload(img);
    if (!payload) {
      tip('无法读取该图片');
      return Promise.resolve({ ok: false, error: { code: 'BAD_IMAGE', message: '无法读取该图片' } });
    }
    return run(payload, img);
  }

  /* ==================== 悬停按钮 ==================== */

  function isLargeImg(img) {
    if (!img || img.tagName !== 'IMG') return false;
    var w = img.naturalWidth || 0;
    var h = img.naturalHeight || 0;
    if (!w && img.getAttribute('width')) w = parseInt(img.getAttribute('width'), 10) || 0;
    if (!h && img.getAttribute('height')) h = parseInt(img.getAttribute('height'), 10) || 0;
    return w >= 180 && h >= 120;
  }

  function positionHoverBtn(img, btn) {
    var r = img.getBoundingClientRect();
    var size = 28;
    var left = Math.min(Math.max(r.right - size - 6, 4), Math.max(4, window.innerWidth - size - 4));
    var top = Math.min(Math.max(r.top + 6, 4), Math.max(4, window.innerHeight - size - 4));
    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(top) + 'px';
  }

  function hideHoverBtn() {
    clearTimeout(hoverState.hideTimer);
    hoverState.hideTimer = 0;
    if (hoverState.btn) {
      hoverState.btn.remove();
      hoverState.btn = null;
    }
    hoverState.img = null;
  }

  function scheduleHideBtn() {
    clearTimeout(hoverState.hideTimer);
    hoverState.hideTimer = setTimeout(hideHoverBtn, HIDE_DELAY_MS);
  }

  function showHoverBtn(img) {
    if (!img || !img.isConnected || shownImgs.has(img)) return;
    // 复核指针仍在该图片上（防扫过误触）
    var m = hoverState.lastMouse;
    var under = null;
    try { under = document.elementFromPoint(m.x, m.y); } catch (e) { /* 忽略 */ }
    if (under && img !== under && !img.contains(under)) return;

    hideHoverBtn();
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ta-img-hover-btn';
    btn.textContent = '译';
    btn.title = '翻译图片中的文字';
    btn.setAttribute('aria-label', '翻译图片中的文字');
    btn.setAttribute('translate', 'no');
    btn.classList.add('notranslate');
    btn.addEventListener('mouseenter', function () { clearTimeout(hoverState.hideTimer); });
    btn.addEventListener('mouseleave', scheduleHideBtn);
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideHoverBtn();
      tip('正在识别图片…');
      runImageEl(img);
    });
    (document.documentElement || document.body).appendChild(btn);
    positionHoverBtn(img, btn);
    hoverState.img = img;
    hoverState.btn = btn;
    shownImgs.add(img); // 同一张图只展示一次
  }

  var debouncedShow = TA.util.debounce(function (img) {
    if (hoverAllowed()) showHoverBtn(img);
  }, HOVER_DELAY_MS);

  /* ==================== 事件（委托，只绑定一次） ==================== */

  function onDocMouseOver(e) {
    // 始终记录最近悬停图片，供 CMD 兜底
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var img = t.closest('img');
    if (img) hoverState.lastImg = img;
    if (!hoverAllowed()) return;
    if (t.closest(OWN_UI_SEL)) return;
    if (!img || !isLargeImg(img)) {
      if (hoverState.img) scheduleHideBtn();
      return;
    }
    if (shownImgs.has(img)) {
      if (hoverState.img && hoverState.img !== img) scheduleHideBtn();
      return;
    }
    clearTimeout(hoverState.hideTimer);
    debouncedShow(img);
  }

  function onDocMouseOut(e) {
    if (!hoverState.img) return;
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    var img = t.closest('img');
    if (img !== hoverState.img) return;
    var rel = e.relatedTarget;
    if (rel && typeof rel.closest === 'function' && rel.closest('.ta-img-hover-btn')) return;
    scheduleHideBtn();
  }

  function onDocMouseMove(e) {
    hoverState.lastMouse.x = e.clientX;
    hoverState.lastMouse.y = e.clientY;
  }

  function onScrollOrResize() {
    if (!hoverState.img || !hoverState.btn) return;
    if (!hoverState.img.isConnected) { hideHoverBtn(); return; }
    positionHoverBtn(hoverState.img, hoverState.btn);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      removeCard();
      hideHoverBtn();
    }
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    document.addEventListener('mouseover', onDocMouseOver, true);
    document.addEventListener('mouseout', onDocMouseOut, true);
    document.addEventListener('mousemove', onDocMouseMove, { capture: true, passive: true });
    document.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('keydown', onKeyDown, true);
  }

  /* ==================== CMD：翻译鼠标下 / 选中的图片 ==================== */

  function imageForCommand() {
    var sel = null;
    try { sel = window.getSelection(); } catch (e) { /* 忽略 */ }
    if (sel && sel.rangeCount) {
      var n = sel.anchorNode;
      var el = n && n.nodeType === 1 ? n : (n && n.parentElement);
      if (el && typeof el.closest === 'function') {
        var img = el.closest('img');
        if (img && isLargeImg(img)) return img;
        var block = el.closest('p, div, figure, article, li');
        if (block) {
          var inner = block.querySelector('img');
          if (inner && isLargeImg(inner)) return inner;
        }
      }
    }
    var m = hoverState.lastMouse;
    var under = null;
    try { under = document.elementFromPoint(m.x, m.y); } catch (e) { /* 忽略 */ }
    if (under && typeof under.closest === 'function') {
      var img2 = under.closest('img');
      if (img2) return img2;
    }
    if (hoverState.lastImg && hoverState.lastImg.isConnected && isLargeImg(hoverState.lastImg)) {
      return hoverState.lastImg;
    }
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      if (isLargeImg(imgs[i])) return imgs[i];
    }
    return null;
  }

  function translateImageCmd() {
    var img = imageForCommand();
    if (!img) {
      tip('未找到可翻译的图片');
      return;
    }
    tip('正在识别图片…');
    runImageEl(img);
  }

  /* ==================== 生命周期 / 注册 ==================== */

  function applySettings(s) {
    currentSettings = s || currentSettings || null;
    currentCfg = cfgImage(currentSettings);
    if (!hoverAllowed()) hideHoverBtn();
  }

  function initAll(settings) {
    currentSettings = settings || currentSettings || null;
    currentCfg = cfgImage(currentSettings);
    bindListeners();
  }

  // 公共命名空间（ball / 其它模块可直接调用）
  TA.imageTranslate = {
    run: run,
    showResult: showResult,
    hideResult: removeCard,
    ocr: ocrImage
  };

  TA.features.register({
    name: 'image-translate',
    init: function (settings) { initAll(settings); },
    onSettingsChanged: function (settings) {
      try { applySettings(settings); } catch (e) { /* 忽略 */ }
    },
    messages: {
      IMAGE_TRANSLATE: function (msg) {
        return run(msg).then(function () { return { ok: true }; }, function (e) {
          var err = (e && e.code) ? e : { code: 'INTERNAL', message: String((e && e.message) || e) };
          return { ok: false, error: err };
        });
      }
    },
    cmds: {
      'translate-image': function () {
        try { translateImageCmd(); } catch (e) { console.debug('[TA][img-trans]', e); }
      }
    }
  });

  // 注册表尚未由 main.js 驱动时（联调期）：立即自初始化，init 幂等。
  if (typeof TA.getSettings === 'function') {
    TA.getSettings().then(function (s) { initAll(s); })
      .catch(function () { /* 读取失败按默认配置运行 */ });
  }
  if (typeof TA.onSettingsChanged === 'function') {
    TA.onSettingsChanged(function (s) {
      try { applySettings(s); } catch (e) { /* 忽略 */ }
    });
  }
})();
