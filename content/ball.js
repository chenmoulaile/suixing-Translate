// content/ball.js —— 悬浮球 v0.2（C 全面还原实现员）
// 从 main.js 剥离的悬浮球职责全部迁入本文件，并按 v0.2 规格增强：
//   1. 位置：settings.ui.ballPosition 'right'|'left'（默认 right）；支持拖动
//      （拖动位置记 localStorage['ta-ball-pos']，切换位置设置时清记忆回默认）；
//   2. 透明度：settings.ui.ballOpacity 0-100（语义=不透明度百分比，默认 70）；
//   3. 交互：点击展开菜单（翻译本页/仅译文/主题选择/遮罩模式/导出双语/打开设置），
//      hover 满 settings.ui.ballHoverDelay（默认 200ms）同样展开；
//   4. 主题选择：菜单子面板 24 档，点击即持久保存（TA.saveSettings）并即时应用
//      （TA.injector.applyThemeSettings，幂等双保险）；
//   5. 遮罩学习模式：开关 documentElement[data-ta-root-theme="mask"]（纯 DOM 即时生效）；
//   6. 导出双语：子面板三格式，调 TA.export.run（content/export.js）；
//   7. tooltip 引导：前 5 次悬停显示「点击翻译本页」（localStorage 计数）；
//   8. 全屏隐藏（fullscreenchange）与打印隐藏（styles/ball.css @media print）；
//   9. 站点黑名单：settings.ui.ballBlockedSites + TA.rules.matchUrlPattern 判定不挂载；
//  10. 状态自推：MutationObserver 观察 [data-ta] / .ta-loading 推导 idle|busy|on，
//      并落地 easysub 借鉴的 EMA 段耗时统计（完成后 tooltip「N 段 · X.Xs」）。
// 挂载协议：TA.features.register({name:'ball', init, onSettingsChanged, messages, cmds})；
// 同时暴露 TA.ball.showTip(text, ms) 供 main.js 翻译完成后直接提示。
//   v0.4 修复：菜单/tooltip 回归为球的子节点，position:absolute 相对球定位（纯 CSS，
//   不用 JS 计算视口坐标），避免页面缩放/CSS transform/scrollbar 造成的错位；球上始终
//   无 filter/transform（悬停/拖动态仅改 background/box-shadow）。
//   交互：hover 展开菜单；点击球 = 翻译本页 / 显示原文（不再用点击开菜单，拖拽仍只移动）。
//   「翻译侧边栏」保持为页面浮层侧边栏（.ta-side-* / styles/sidebar.css）。
(function () {
  'use strict';
  var TA = globalThis.TA;
  if (!TA || TA.__ballLoaded) return;
  if (!TA.rules) {
    console.error('[TA] content/ball.js: 前置文件 content/rules.js 未加载（黑名单匹配不可用，球不挂载）');
    return;
  }
  TA.__ballLoaded = true;

  /* ==================== 常量与状态 ==================== */

  var BALL_ID = 'ta-float-ball';
  var POS_KEY = 'ta-ball-pos';       // 拖动位置记忆
  var TIP_KEY = 'ta-ball-tip-n';     // tooltip 引导计数
  var DRAG_PX = 6;                   // 位移超过该值判定为拖动而非点击
  var EDGE_SNAP_PX = 28;             // 拖放后靠近视口左右边缘的吸附阈值（小范围，非磁吸区）
  // 翻译请求健壮性：连接错误重试退避（唤醒被回收的 MV3 service worker）+ 单次超时
  var RETRY_BACKOFF_MS = [150, 350]; // 第 1/2 次重试前的等待
  var REQ_TIMEOUT_MS = 45000;        // 单次 sendMessage 超时：保证 Promise 必定 settle
  var CONN_ERR_RE = /Could not establish connection|Receiving end does not exist|message port closed/i;
  // 主题 26 档与中文名 fallback（A 在 shared/defaults.js 交付 TA.THEMES/TA.THEME_NAMES 后自动切换）
  var THEMES_FALLBACK = ['none', 'grey', 'dashed', 'thinDashed', 'dotted', 'underline',
    'nativeUnderline', 'nativeDashed', 'nativeDotted', 'wavy', 'dashedBorder', 'solidBorder',
    'dividingLine', 'highlight', 'marker', 'marker2', 'background', 'opacity', 'mask',
    'paper', 'blockquote', 'weakening', 'italic', 'bold', 'doubleUnderline', 'pill'];
  var THEME_NAMES_FALLBACK = {
    none: '无', grey: '黑灰', dashed: '虚线下划线', thinDashed: '细虚线', dotted: '点状',
    underline: '直线', nativeUnderline: '原生下划线', nativeDashed: '原生虚线',
    nativeDotted: '原生点线', wavy: '波浪', dashedBorder: '虚线边框', solidBorder: '实线边框',
    dividingLine: '分割线', highlight: '高亮', marker: '马克笔', marker2: '马克笔2',
    background: '背景色', opacity: '透明', mask: '模糊（学习模式）', paper: '白纸阴影',
    blockquote: '引用', weakening: '弱化', italic: '斜体', bold: '加粗',
    doubleUnderline: '双下划线', pill: '胶囊描边'
  };

  var settings = null;        // 最近一次设置（getSettings / onSettingsChanged 回填）
  var ball = null, menu = null, tip = null, sub = null;
  var inited = false;
  var menuOpen = false;
  var pinned = false;         // 菜单保持展开：键盘展开或子面板打开时不因 mouseleave 收起
  var subKind = null;         // 子菜单当前类别 themes|export|null
  var subHideTimer = 0, subLeaveTimer = 0; // 子菜单隐藏收尾 / 跨缝隙延迟关闭
  var hoverTimer = 0, leaveTimer = 0, tipTimer = 0, tipHideTimer = 0;
  var drag = null;            // {sx, sy, moved, left, top}
  var pageState = 'idle';     // 自推状态：idle | busy | on
  var curMode = 'bilingual';  // 显隐模式（TA.subscribeState 的 snap.mode 同步）
  var curTheme = 'dashed';
  var maskOn = false;
  var subtitleOn = false;     // 双语字幕开关状态（settings.subtitle.enabled）
  var layoutDual = false;     // 并排双语布局（settings.targetStyle.layout === 'dual'）
  // easysub 借鉴：EMA 段耗时（翻译中逐次采样，完成后 tooltip 展示）
  var batch = { startT: 0, doneBase: 0, emaMs: 0, lastT: 0, lastDone: 0 };
  var stateObserver = null;
  var cleanupObserver = null;
  var fullscreenBound = false; // setupFullscreen 幂等守卫（applySettings 每次都会调用）
  // 划译台侧边栏（懒创建，常驻 DOM 隐藏）
  var sideEls = null;         // { backdrop, panel, ... } DOM 引用集合
  var sideOpen = false;
  var sideHistory = [];       // 最近 5 条 {src, dst, original, translated}（内存）
  var sideDirectSeq = 0;      // 降级直发批次号
  var sideTranslating = false; // 划译台翻译进行中：防止连点堆叠，任何出口都会复位

  /* ==================== 设置读取兜底 ==================== */

  function uiCfg(s) {
    var ui = (s && s.ui) || {};
    return {
      show: ui.showFloatBall !== false,
      side: ui.ballPosition === 'left' ? 'left' : 'right',
      opacity: clampPct(ui.ballOpacity == null ? 70 : Number(ui.ballOpacity)),
      hoverDelay: Math.max(0, Number(ui.ballHoverDelay == null ? 200 : Number(ui.ballHoverDelay)) || 0),
      blocked: Array.isArray(ui.ballBlockedSites) ? ui.ballBlockedSites : []
    };
  }
  function clampPct(n) {
    if (!isFinite(n)) return 70;
    return Math.min(100, Math.max(0, n));
  }
  function themes() {
    return (Array.isArray(TA.THEMES) && TA.THEMES.length >= 20) ? TA.THEMES : THEMES_FALLBACK;
  }
  function themeNameOf(id) {
    var names = TA.THEME_NAMES || THEME_NAMES_FALLBACK;
    return names[id] || THEME_NAMES_FALLBACK[id] || id;
  }

  /* ==================== 挂载判定 ==================== */

  // 悬浮球只存在于顶层 frame：all_frames:true 时子 frame 也会注入本脚本，
  // 但不能各自建球/建菜单/建观察器。window.top 跨源访问会抛错，故 try/catch 兜底。
  function isTopFrame() {
    try { return window.self === window.top; } catch (e) { return false; }
  }

  function allowed() {
    if (!isTopFrame()) return false; // 子 frame 不渲染悬浮球（翻译仍由各 frame 主流程执行）
    var cfg = uiCfg(settings);
    if (!cfg.show) return false;
    for (var i = 0; i < cfg.blocked.length; i++) {
      try { if (TA.rules.matchUrlPattern(cfg.blocked[i], location.href)) return false; } catch (e) { /* 非法模式忽略 */ }
    }
    return true;
  }

  /* ==================== DOM 构建 ==================== */

  function buildBall() {
    // 清理 v0.1 main.js 遗留的无 id 球（过渡期防双球；A 合入后该分支自然空转）
    var olds = document.querySelectorAll('.ta-float-ball:not(#' + BALL_ID + ')');
    for (var i = 0; i < olds.length; i++) olds[i].remove();

    var el = document.getElementById(BALL_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = BALL_ID;
      el.className = 'ta-float-ball';
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0'); // 供侧边栏关闭后回焦
      el.setAttribute('aria-haspopup', 'menu');
      el.setAttribute('aria-expanded', 'false');
      el.setAttribute('aria-label', '随行翻译悬浮球');
      el.textContent = '译';
      // 菜单/tooltip 回归为球的子节点：CSS 用 position:absolute 相对球定位，
      // 无需 JS 视口坐标计算，缩放/transform/滚动条都不会造成错位。
      el.appendChild(buildMenu());
      // 子菜单是 menu 的兄弟、球的子节点：主菜单 overflow:auto 会裁剪子节点，
      // 故旁弹面板必须独立于 menu；同时保留球层叠上下文与点击/拖动守卫的 contains 语义。
      el.appendChild(buildSubMenu());
      el.appendChild(buildTip());
      (document.documentElement || document.body).appendChild(el);
      bindBallEvents(el);
    }
    return el;
  }

  function buildTip() {
    tip = document.createElement('div');
    tip.className = 'ta-ball-tip';
    tip.hidden = true;
    return tip;
  }

  function buildMenu() {
    menu = document.createElement('div');
    menu.className = 'ta-ball-menu';
    menu.setAttribute('dir', 'auto');
    menu.hidden = true;
    renderMenuMain();
    return menu;
  }

  // 主菜单：首项为「翻译侧边栏」，其后为原有动作（两项动态 + 两子面板 + 遮罩 + 设置）
  function renderMenuMain() {
    menu.textContent = '';
    menu.appendChild(mkItem('翻译侧边栏', 'sidebar', '↗'));
    menu.appendChild(sep());
    var btnToggle = mkItem(pageState === 'on' ? '显示原文' : '翻译本页', 'toggle-page');
    btnToggle.disabled = pageState === 'busy';
    if (pageState === 'busy') btnToggle.textContent = '翻译中…';
    menu.appendChild(btnToggle);
    var modeNow = curMode || ((TA.injector && TA.injector.getMode) ? TA.injector.getMode() : 'bilingual');
    menu.appendChild(mkItem(modeNow === 'translation-only' ? '双语对照' : '仅译文', 'toggle-mode'));
    menu.appendChild(sep());
    menu.appendChild(mkItem('主题选择', 'themes', '▸'));
    menu.appendChild(mkItem('遮罩模式：' + (maskOn ? '开' : '关'), 'mask'));
    menu.appendChild(mkItem('导出双语', 'export', '▸'));
    menu.appendChild(mkItem('文档翻译', 'doc'));
    menu.appendChild(mkItem('双语字幕：' + (subtitleOn ? '开' : '关'), 'subtitle'));
    menu.appendChild(mkItem('并排双语：' + (layoutDual ? '开' : '关'), 'layout'));
    // 「打开设置」作为顶层项紧跟并排双语，默认展开、不折叠（去掉原末尾分隔线）
    menu.appendChild(mkItem('打开设置', 'options'));
  }

  function buildSubMenu() {
    sub = document.createElement('div');
    sub.className = 'ta-ball-submenu';
    sub.setAttribute('dir', 'auto');
    sub.hidden = true;
    // hover 跨 8px 缝隙时两边都不 hover，延迟关闭避免闪退
    sub.addEventListener('mouseenter', function () { clearTimeout(subLeaveTimer); });
    sub.addEventListener('mouseleave', scheduleSubLeave);
    sub.addEventListener('click', onSubClick);
    return sub;
  }

  // 二级子面板（独立节点）：主题 26 档 / 导出三格式。主菜单常驻，不再清空重建。
  function renderSub(kind) {
    if (!sub) return;
    sub.textContent = '';
    if (kind === 'themes') {
      var label = document.createElement('div');
      label.className = 'ta-ball-group-label';
      label.textContent = '译文主题（本页即时生效）';
      sub.appendChild(label);
      var grid = document.createElement('div');
      grid.className = 'ta-ball-themes';
      var list = themes();
      for (var i = 0; i < list.length; i++) {
        (function (id) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'ta-ball-theme-btn' + (id === curTheme ? ' ta-theme-cur' : '');
          b.textContent = themeNameOf(id);
          b.title = id;
          b.addEventListener('click', function (e) { e.stopPropagation(); pickTheme(id); });
          grid.appendChild(b);
        })(list[i]);
      }
      sub.appendChild(grid);
      // 子面板内也保留设置入口，保证「打开设置」在任意层级都可见/可达
      sub.appendChild(sep());
      sub.appendChild(mkItem('打开设置', 'options'));
    } else if (kind === 'export') {
      var label2 = document.createElement('div');
      label2.className = 'ta-ball-group-label';
      label2.textContent = '导出双语（原文 + 译文）';
      sub.appendChild(label2);
      sub.appendChild(mkItem('网页快照（HTML）', 'export:html'));
      sub.appendChild(mkItem('Markdown（.md）', 'export:markdown'));
      sub.appendChild(mkItem('纯文本（.txt）', 'export:txt'));
      // 子面板内也保留设置入口，保证「打开设置」在任意层级都可见/可达
      sub.appendChild(sep());
      sub.appendChild(mkItem('打开设置', 'options'));
    }
  }

  function mkItem(text, act, arrow) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ta-ball-item';
    b.dataset.act = act;
    b.textContent = text;
    if (arrow) {
      var a = document.createElement('span');
      a.className = 'ta-item-arrow';
      a.textContent = arrow;
      b.appendChild(a);
    }
    // 有子菜单的父项标注语义，aria-expanded 随开合更新
    if (act === 'themes' || act === 'export') {
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
    }
    return b;
  }
  function sep() {
    var d = document.createElement('div');
    d.className = 'ta-ball-sep';
    return d;
  }

  /* ==================== 菜单开合与定位 ==================== */

  function openMenu(pin) {
    if (!menu) return;
    closeSub(); // 防重开残留
    renderMenuMain();
    menu.hidden = false;
    // 定位完全交给 CSS：菜单是球的子节点，position:absolute 相对球解析（见 styles/ball.css），
    // 停靠侧由球的 data-ta-ball-side 决定，无需任何视口坐标/钳制计算。
    // 强制回流后再加显示类，保证 scale 过渡动画
    void menu.offsetHeight;
    menu.classList.add('ta-menu-show');
    ball.classList.add('ta-menu-open');
    if (ball) ball.setAttribute('aria-expanded', 'true');
    menuOpen = true;
    pinned = !!pin;
    // 不在这里 hideTip：菜单展开期间 styles/ball.css 会把 .ta-ball-tip 挪到球上方，
    // 既保证菜单项不被遮挡，也让前 5 次引导 tip 能自然消失（否则 hoverDelay 先开菜单、tip 永不出现）。
  }

  function closeMenu() {
    if (!menu || !menuOpen) return;
    closeSub();
    menu.classList.remove('ta-menu-show');
    ball.classList.remove('ta-menu-open');
    if (ball) ball.setAttribute('aria-expanded', 'false');
    menuOpen = false;
    pinned = false;
    // 键盘操作收起菜单时把焦点还给球，避免焦点随隐藏的菜单项落回 body
    if (ball && menu.contains(document.activeElement)) ball.focus();
    // 等过渡结束再隐藏，避免闪烁
    setTimeout(function () { if (!menuOpen) menu.hidden = true; }, 180);
  }

  // 在触发项旁弹出二级面板，并做视口边缘翻转/钳制。
  // 同一 kind 再次点击同一父项则 toggle 关闭。
  function openSub(kind, anchorBtn) {
    if (!sub || !menuOpen) return;
    var same = subKind === kind && !sub.hidden;
    if (same) { closeSub(); return; }
    clearTimeout(subHideTimer);
    clearTimeout(subLeaveTimer);
    if (typeof removeSubReposition === 'function') removeSubReposition();
    if (subKind && subKind !== kind) setSubParentExpanded(subKind, false); // 切到另一父项时先收起旧项
    subKind = kind;
    renderSub(kind);
    sub.hidden = false;
    sub.classList.add('ta-sub-show');
    pinned = true; // 子面板展开期间菜单不因 mouseleave 收起（见 scheduleLeaveClose）
    // 父项展开态
    setSubParentExpanded(kind, true);
    void sub.offsetWidth; // 强制回流后再定位（见 openMenu 同款写法）
    positionSub(anchorBtn);
    // 滚动（含嵌套滚动）与 resize 时跟随重定位；拖动时关闭，避免边拖边追
    window.addEventListener('scroll', positionSubOnScroll, true);
    window.addEventListener('resize', positionSubOnResize);
  }

  function closeSub() {
    if (!sub || sub.hidden) { subKind = null; return; }
    clearTimeout(subLeaveTimer);
    sub.classList.remove('ta-sub-show');
    setSubParentExpanded(subKind, false);
    subKind = null;
    pinned = false;
    removeSubReposition();
    subHideTimer = setTimeout(function () {
      if (!sub || !sub.classList.contains('ta-sub-show')) sub.hidden = true;
    }, 180);
  }

  function setSubParentExpanded(kind, on) {
    if (!menu || !kind) return;
    var btn = menu.querySelector('button[data-act="' + kind + '"]');
    if (btn) btn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function positionSubOnScroll() { positionSub(currentSubAnchor()); }
  function positionSubOnResize() { positionSub(currentSubAnchor()); }
  function removeSubReposition() {
    window.removeEventListener('scroll', positionSubOnScroll, true);
    window.removeEventListener('resize', positionSubOnResize);
  }
  function currentSubAnchor() {
    if (!menu || !subKind) return null;
    return menu.querySelector('button[data-act="' + subKind + '"]');
  }

  // 视口坐标定位：主菜单方向由球停靠侧决定，子菜单从触发项继续向外弹出，
  // 越界则翻到触发项另一侧，两侧皆不足则钳制在视口内。
  function positionSub(anchorBtn) {
    if (!sub || sub.hidden || !anchorBtn) return;
    try {
      var a = anchorBtn.getBoundingClientRect();
      var s = sub.getBoundingClientRect();
      var vw = document.documentElement.clientWidth;
      var vh = document.documentElement.clientHeight;
      var M = 8, GAP = 8;
      var side = (ball && ball.getAttribute('data-ta-ball-side') === 'left') ? 'left' : 'right';
      var left;
      if (side === 'right') {          // 右缘球：主菜单在球左侧，子菜单继续向左展开
        left = a.left - s.width - GAP;
        if (left < M) left = a.right + GAP;
      } else {                         // 左缘球：主菜单在球右侧，子菜单继续向右展开
        left = a.right + GAP;
        if (left + s.width > vw - M) left = a.left - s.width - GAP;
      }
      left = clampNum(left, M, Math.max(M, vw - s.width - M));
      var top = clampNum(a.top - 6, M, Math.max(M, vh - s.height - M));
      sub.style.left = left + 'px';
      sub.style.top = top + 'px';
    } catch (e) { console.debug('[TA][ball]', 'positionSub 失败', e); }
  }

  // 父项与子菜单各留 300ms grace，斜向跨越 8px 缝隙时不闪退
  function scheduleSubLeave() {
    if (!subKind) return;
    clearTimeout(subLeaveTimer);
    subLeaveTimer = setTimeout(function () {
      if (!subKind) return;
      if ((sub && sub.matches(':hover')) || (menu && menu.matches(':hover'))) return;
      closeSub();
      scheduleLeaveClose(); // 子面板收起后，菜单恢复按 hover 自动收起（pinned 已在 closeSub 复位）
    }, 300);
  }

  // 点击外部 / ESC 收起
  function onDocClick(e) {
    if (!menuOpen) return;
    if (ball.contains(e.target) || menu.contains(e.target) || (sub && sub.contains(e.target))) return;
    closeMenu();
  }
  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    // 侧边栏优先响应 ESC（它盖在菜单之上）
    if (sideOpen) { closeSidebar(); e.stopPropagation(); return; }
    if (subKind) { closeSub(); e.stopPropagation(); return; }
    if (menuOpen) { closeMenu(); e.stopPropagation(); }
  }

  /* ==================== 菜单动作 ==================== */

  function onMenuClick(e) {
    var btn = e.target.closest('button');
    if (!btn || !menu.contains(btn)) return;
    e.stopPropagation();
    var act = btn.dataset.act;
    if (btn.disabled) return;
    if (act === 'sidebar') { openSidebar(); return; }
    if (act === 'themes' || act === 'export') { openSub(act, btn); return; }
    if (act === 'toggle-page') { actTogglePage(); return; }
    if (act === 'toggle-mode') { actToggleMode(); return; }
    if (act === 'mask') { actToggleMask(); return; }
    if (act === 'doc') { actOpenDoc(); return; }
    if (act === 'subtitle') { actToggleSubtitle(); return; }
    if (act === 'layout') { actToggleLayout(); return; }
    if (act === 'options') { actOpenOptions(); return; }
    if (act && act.indexOf('export:') === 0) { actExport(act.slice(7)); return; }
  }

  // 子菜单动作分派：导出格式与「打开设置」；动作后关闭子菜单（导出/设置内部已 closeMenu）
  function onSubClick(e) {
    var btn = e.target.closest && e.target.closest('button');
    if (!btn || !sub || !sub.contains(btn)) return;
    e.stopPropagation();
    if (btn.disabled) return;
    var act = btn.dataset.act;
    if (act && act.indexOf('export:') === 0) { closeSub(); actExport(act.slice(7)); return; }
    if (act === 'options') { closeSub(); actOpenOptions(); return; }
  }

  // 翻译本页 / 显示原文（toggle 语义）。
  // 通道探测（main.js 为 A 所有权，剥离球代码后由 A 暴露其一，按优先级）：
  //   ① TA.toggle / TA.main.toggle（main.js 直接挂载）
  //   ② window CustomEvent 'ta-toggle-page'（main.js addEventListener 即接）
  //   ③ background CMD 转发链（协议 CMD 消息 → handleCmd('toggle-translate')）
  function actTogglePage() {
    closeMenu();
    if (typeof TA.toggle === 'function') { TA.toggle(); return; }
    if (TA.main && typeof TA.main.toggle === 'function') { TA.main.toggle(); return; }
    try {
      window.dispatchEvent(new CustomEvent('ta-toggle-page', { detail: { scope: null, source: 'ball' } }));
    } catch (e) { /* 老内核无 CustomEvent 构造器 */ }
    // 兜底：经 background 的 CMD 转发链（若 background 已实现 CMD case 则可达）
    try {
      chrome.runtime.sendMessage({ type: 'CMD', name: 'toggle-translate', source: 'ball' }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* SW 不可用 */ }
  }

  // 仅译文 / 双语对照（显隐切换，不发请求）
  function actToggleMode() {
    var cur = (TA.injector && TA.injector.getMode) ? TA.injector.getMode() : 'bilingual';
    var next = cur === 'translation-only' ? 'bilingual' : 'translation-only';
    closeMenu();
    if (typeof TA.setMode === 'function') { TA.setMode(next); return; }
    if (TA.main && typeof TA.main.setMode === 'function') { TA.main.setMode(next); return; }
    try {
      window.dispatchEvent(new CustomEvent('ta-set-mode', { detail: { mode: next, source: 'ball' } }));
    } catch (e) { /* 同上 */ }
    try {
      chrome.runtime.sendMessage({ type: 'CMD', name: 'toggle-bilingual', source: 'ball' }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* SW 不可用 */ }
    // v0.1 基线兜底：直接调 injector.applyMode 即时切换（本地同步 curMode；
    // main.js 的 features.cmds 通道就绪后以 TA.setMode 分支为准）
    if (TA.injector && typeof TA.injector.applyMode === 'function') {
      try { TA.injector.applyMode(next, null); curMode = next; } catch (e2) { /* injector 未就绪 */ }
    }
  }

  // 遮罩学习模式全页开关：优先走 A 的 injector.toggleMaskTheme（与快捷键 toggle-mask
  // 同一路径，documentElement[data-ta-root-theme="mask"] ↔ 移除），不可用时本地切属性兜底
  function actToggleMask() {
    if (!isTopFrame()) return; // 子 frame 无球/无菜单，忽略该动作
    if (TA.injector && typeof TA.injector.toggleMaskTheme === 'function') {
      try { maskOn = !!TA.injector.toggleMaskTheme(); }
      catch (e) { maskOn = !maskOn; applyMaskAttr(); }
    } else {
      maskOn = !maskOn;
      applyMaskAttr();
    }
    renderMenuMain();
  }
  function applyMaskAttr() {
    var root = document.documentElement;
    if (maskOn) root.setAttribute('data-ta-root-theme', 'mask');
    else root.removeAttribute('data-ta-root-theme');
  }

  // 打开设置：content 无权直接调 openOptionsPage，按协议发 background OPEN_OPTIONS
  function actOpenOptions() {
    closeMenu();
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }, function (resp) {
        void chrome.runtime.lastError; // SW 未实现该 case 时静默（console 已有兜底日志）
      });
    } catch (e) { /* SW 不可用 */ }
  }

  // 文档翻译页：由 background 打开 chrome-extension://.../doc/doc.html
  function actOpenDoc() {
    closeMenu();
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_DOC' }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* SW 不可用 */ }
  }

  // 双语字幕开关：球与字幕模块同处一个 content script，优先直接调用
  // TA.features.get('subtitle').messages.SUBTITLE_TOGGLE（返回 {ok, enabled}），
  // 模块未就绪时退化为 runtime 消息（由 content/main.js 的 features 分发）。
  function actToggleSubtitle() {
    var feature = (TA.features && typeof TA.features.get === 'function') ? TA.features.get('subtitle') : null;
    var handler = feature && feature.messages && feature.messages.SUBTITLE_TOGGLE;
    if (typeof handler === 'function') {
      var ret;
      try { ret = handler({ type: 'SUBTITLE_TOGGLE', source: 'ball' }); }
      catch (e) { ret = null; }
      if (ret && typeof ret.then === 'function') {
        ret.then(function (r) {
          if (r && r.ok) subtitleOn = !!r.enabled;
          renderMenuMain();
        });
      } else {
        if (ret && ret.ok && typeof ret.enabled === 'boolean') subtitleOn = ret.enabled;
        renderMenuMain();
      }
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'SUBTITLE_TOGGLE', source: 'ball' }, function (resp) {
        void chrome.runtime.lastError;
        if (resp && resp.ok && typeof resp.enabled === 'boolean') subtitleOn = resp.enabled;
        renderMenuMain();
      });
    } catch (e) { /* SW 不可用 */ }
  }

  // 并排双语：切换 targetStyle.layout（core.js 的 saveSettings 对 patch 做深合并）
  function actToggleLayout() {
    layoutDual = !layoutDual;
    if (typeof TA.saveSettings === 'function') {
      TA.saveSettings({ targetStyle: { layout: layoutDual ? 'dual' : 'block' } }).catch(function (e) {
        console.warn('[TA] ball.js 保存并排布局失败', e);
      });
    }
    renderMenuMain();
    showTip(layoutDual ? '并排双语已开启（对新翻译生效）' : '已切回块级上下布局', 1800);
  }

  // 导出双语：TA.export.run（content/export.js；manifest 加载顺序 ball 在 export 前，
  // 运行时点击时两文件均已就绪）
  function actExport(format) {
    closeMenu();
    if (TA.export && typeof TA.export.run === 'function') {
      TA.export.run(format || 'txt', { source: 'ball' });
    } else {
      showTip('导出模块未就绪（export.js 未加载）', 2400);
    }
  }

  // 主题选择：持久保存 + 即时应用（幂等双保险）
  function pickTheme(id) {
    curTheme = id;
    if (typeof TA.saveSettings === 'function') {
      TA.saveSettings({ targetStyle: { theme: id } }).catch(function (e) {
        console.warn('[TA] ball.js 保存主题失败', e);
      });
    }
    if (TA.injector && typeof TA.injector.applyThemeSettings === 'function') {
      try {
        var s = TA.getCachedSettings();
        if (s) { s.targetStyle = s.targetStyle || {}; s.targetStyle.theme = id; TA.injector.applyThemeSettings(s); }
      } catch (e) { /* injector 未就绪 */ }
    }
    if (subKind === 'themes') { // 刷新当前档高亮（仅子面板打开时，不再碰主菜单）
      renderSub('themes');
      positionSub(currentSubAnchor());
    }
  }

  /* ==================== 球事件：点击 / hover / 拖动 ==================== */

  function bindBallEvents(el) {
    // mousedown → 可能是拖动起点。
    // 菜单是球的 DOM 子节点：菜单内的按下必须放行（2026-11-15 第 1 轮修复，验收 9），
    // 否则菜单项点击会冒泡到这里 → drag 被武装 → mouseup 触发点击动作，把菜单
    // 在 click 动作执行前收起（主题子面板点选后即被隐藏、动作与视觉脱节）
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if ((menu && menu.contains(e.target)) || (sub && sub.contains(e.target))) return; // 菜单/子菜单内交互：不进拖动/点击判定
      var r = el.getBoundingClientRect();
      drag = { sx: e.clientX, sy: e.clientY, moved: false, left: r.left, top: r.top };
      e.preventDefault(); // 防选中/防拖影
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_PX) return;
      drag.moved = true;
      closeSub(); // 拖动中关闭子菜单，避免 fixed 面板边拖边追
      el.classList.add('ta-dragging');
      el.style.marginTop = '0'; // 内联 left/top 接管后取消垂直居中偏移
      el.style.left = clampNum(drag.left + dx, 4, document.documentElement.clientWidth - 44) + 'px';
      el.style.top = clampNum(drag.top + dy, 4, document.documentElement.clientHeight - 44) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', function (e) {
      if (!drag) return;
      var wasDrag = drag.moved;
      drag = null;
      el.classList.remove('ta-dragging');
      if (wasDrag) {
        // 拖拽只移动位置，不翻译；靠近边缘时先吸附，再按结果决定是否记忆自由坐标
        if (!snapToEdge(el)) savePos();
        else if (subKind) positionSub(currentSubAnchor()); // 吸附换侧后子菜单跟随重定位
        clearTimeout(hoverTimer);
      } else {
        closeMenu();      // 点击不再开菜单（菜单由 hover 展开）
        actTogglePage();  // 点击球 = 翻译本页 / 显示原文
      }
    });

    // 键盘激活：球声明了 role=button/tabindex=0，Enter/Space 必须可用。
    // 菜单关闭时先展开菜单并聚焦「翻译本页」（键盘用户没有 hover 入口）；
    // 菜单已展开时再按则触发翻译本页。菜单项自身是原生 button，其 Enter/Space 走 click。
    el.addEventListener('keydown', function (e) {
      if (e.target !== el) return; // 菜单内按钮的按键不在此处理
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar' && e.key !== 'Space') return;
      e.preventDefault();
      if (menuOpen) { actTogglePage(); return; }
      clearTimeout(hoverTimer); // 取消待触发的 hover 展开，避免随即重渲染菜单把刚设置的焦点冲掉
      openMenu(true); // 键盘展开没有 mouseleave 语义，pin 住菜单直到 ESC / 点外部 / 选中动作
      var first = menu && (menu.querySelector('button[data-act="toggle-page"]') || menu.querySelector('button'));
      if (first && typeof first.focus === 'function') first.focus();
    });

    // hover 满 ballHoverDelay 展开菜单；离开延迟收起（给移入菜单留 grace 期）
    el.addEventListener('mouseenter', function () {
      scheduleTip();
      var delay = settings ? uiCfg(settings).hoverDelay : 200;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { if (!drag) openMenu(false); }, delay);
    });
    el.addEventListener('mouseleave', function () {
      clearTimeout(hoverTimer);
      clearTimeout(tipTimer);
      scheduleLeaveClose();
    });
    menu.addEventListener('mouseenter', function () { clearTimeout(leaveTimer); });
    menu.addEventListener('mouseleave', function () { scheduleLeaveClose(); scheduleSubLeave(); });
    // 主菜单动作分派（2026-11-15 第 1 轮修复，验收 9）：onMenuClick 此前只定义未注册，
    // 主菜单 6 个动作（翻译本页/仅译文/主题/遮罩/导出/打开设置）全部为死按钮
    menu.addEventListener('click', onMenuClick);

    // 子面板悬停展开（点击仍由 onMenuClick 兜底）：120ms 短延时，避免误触。
    // 用 btn.isConnected + aria-expanded 判定，不再依赖会销毁按钮的 ta-sub-open 类。
    var subHoverTimer = null;
    menu.addEventListener('mouseover', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-act]');
      if (!btn || !menu.contains(btn)) return;
      var act = btn.dataset.act;
      if (act !== 'themes' && act !== 'export') return;
      clearTimeout(subHoverTimer);
      subHoverTimer = setTimeout(function () {
        if (btn && btn.isConnected && btn.getAttribute('aria-expanded') !== 'true') {
          openSub(act, btn);
        }
      }, 120);
    });
    menu.addEventListener('mouseout', function (e) {
      var btn = e.target.closest && e.target.closest('button[data-act]');
      if (btn && (btn.dataset.act === 'themes' || btn.dataset.act === 'export')) clearTimeout(subHoverTimer);
    });
  }

  function scheduleLeaveClose() {
    if (!menuOpen || pinned) return;
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(function () {
      if (menuOpen && !pinned && !ball.matches(':hover') && !menu.matches(':hover') &&
          (sub && (sub.hidden || !sub.matches(':hover')))) closeMenu();
    }, 600);
  }

  function clampNum(v, min, max) { return Math.min(Math.max(v, min), max); }

  // 拖放后若球靠近视口左/右边缘（≤EDGE_SNAP_PX），清除内联坐标并切到对应停靠侧，
  // 让 CSS 的 left/right:10px 接管吸附。吸附态无自由坐标 → 走 clearPos() 清除位置记忆
  // （与「切换停靠侧设置」时的持久化方式一致，刷新后回落到 CSS 默认停靠位）。
  // 保留 wasDrag 判定：仅真实拖动后调用，不影响 hover 展开菜单，也不触发翻译。
  function snapToEdge(el) {
    try {
      var rect = el.getBoundingClientRect();
      var left = rect.left;
      var size = rect.width || el.offsetWidth || 36;
      var vw = document.documentElement.clientWidth;
      var side = null;
      if (left < EDGE_SNAP_PX) side = 'left';
      else if (left + size > vw - EDGE_SNAP_PX) side = 'right';
      if (!side) return false;                 // 中间区域：保留自由位置
      el.setAttribute('data-ta-ball-side', side);
      clearPos();                              // 清内联 left/top/right/marginTop + 位置记忆
      if (sideOpen) positionSidebar();          // 侧边栏若开着，跟随新的停靠侧
      return true;
    } catch (e) { return false; }
  }

  function savePos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: parseInt(ball.style.left, 10) || 0,
        top: parseInt(ball.style.top, 10) || 0
      }));
    } catch (e) { /* localStorage 不可用（隐私模式）忽略 */ }
  }

  function restorePos() {
    var pos = null;
    try { pos = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { pos = null; }
    if (pos && isFinite(pos.left) && isFinite(pos.top)) {
      ball.style.marginTop = '0';
      ball.style.left = clampNum(pos.left, 4, document.documentElement.clientWidth - 44) + 'px';
      ball.style.top = clampNum(pos.top, 4, document.documentElement.clientHeight - 44) + 'px';
      ball.style.right = 'auto';
    }
  }

  function clearPos() {
    try { localStorage.removeItem(POS_KEY); } catch (e) { /* 忽略 */ }
    if (ball) {
      ball.style.left = '';
      ball.style.top = '';
      ball.style.right = '';
      ball.style.marginTop = '';
    }
  }

  /* ==================== tooltip 引导（前 5 次） ==================== */

  function scheduleTip() {
    var n = 0;
    try { n = parseInt(localStorage.getItem(TIP_KEY) || '0', 10) || 0; } catch (e) { n = 0; }
    if (n >= 5) return;
    clearTimeout(tipTimer);
    // 引导 tip 必须先于 hover 展开菜单出现：取 hoverDelay 的 60%（默认 200ms → 120ms）。
    // 原先固定 800ms 晚于 openMenu（默认 200ms），回调被 menuOpen 守卫吞掉，前 5 次引导永不出现。
    var hoverDelay = uiCfg(settings).hoverDelay;
    var delay = Math.max(60, Math.min(600, Math.round(hoverDelay * 0.6)));
    tipTimer = setTimeout(function () {
      if (!ball || drag) return;
      showTip(pageState === 'on' ? '点击显示原文' : '点击翻译本页', 2600);
      try { localStorage.setItem(TIP_KEY, String(n + 1)); } catch (e) { /* 忽略 */ }
    }, delay);
  }

  // 公共 API：main.js / export.js 可直接调用（easysub 借鉴：翻译完成后
  // 以 tooltip 展示「N 段 · X.Xs」等轻量状态）
  function showTip(text, ms) {
    if (!tip || !ball) return;
    tip.textContent = String(text || '');
    tip.hidden = false;
    void tip.offsetHeight;
    tip.classList.add('ta-tip-show');
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(hideTip, Math.max(800, ms || 2200));
  }

  function hideTip() {
    if (!tip) return;
    tip.classList.remove('ta-tip-show');
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(function () { if (tip) tip.hidden = true; }, 220);
  }

  /* ==================== 随行翻译 · 划译台（页面浮层侧边栏） ====================
     首次打开时懒建 DOM，挂 documentElement 常驻隐藏；面板/遮罩均为 position:fixed，
     靠 data-ta-side 与 --ta-side-w（JS 按设置写入）决定停靠侧与宽度。 */

  // 目标语言全集：优先 TA.TARGET_LANGS（shared/defaults.js），兜底精简表
  function targetLangs() {
    if (Array.isArray(TA.TARGET_LANGS) && TA.TARGET_LANGS.length) return TA.TARGET_LANGS;
    return [
      { code: 'zh-CN', name: '简体中文' },
      { code: 'zh-TW', name: '繁體中文' },
      { code: 'en', name: 'English' },
      { code: 'ja', name: '日本語' }
    ];
  }

  function langName(code) {
    if (code === 'auto') return '自动检测';
    var list = targetLangs();
    for (var i = 0; i < list.length; i++) {
      if (list[i].code === code) return list[i].name;
    }
    return code || '自动检测';
  }

  function fillLangSelect(sel, withAuto, selected) {
    sel.textContent = '';
    if (withAuto) {
      var auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = '自动检测';
      sel.appendChild(auto);
    }
    var list = targetLangs();
    for (var i = 0; i < list.length; i++) {
      var op = document.createElement('option');
      op.value = list[i].code;
      op.textContent = list[i].name;
      sel.appendChild(op);
    }
    sel.value = selected || (withAuto ? 'auto' : ((list[0] && list[0].code) || 'zh-CN'));
  }

  function buildSidebar() {
    if (sideEls) return;
    try {
      var root = document.documentElement || document.body;

      var backdrop = document.createElement('div');
      backdrop.className = 'ta-side-backdrop';

      var panel = document.createElement('div');
      panel.className = 'ta-side-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', '随行翻译 · 划译台');
      panel.setAttribute('data-ta-side', 'right');

      // 头部：标题 + 副标题 + 关闭按钮
      var head = document.createElement('div');
      head.className = 'ta-side-head';
      var titles = document.createElement('div');
      titles.className = 'ta-side-titles';
      var title = document.createElement('div');
      title.className = 'ta-side-title';
      title.textContent = '随行翻译 · 划译台';
      var subtitle = document.createElement('div');
      subtitle.className = 'ta-side-subtitle';
      subtitle.textContent = '随时随地的双语翻译';
      titles.appendChild(title);
      titles.appendChild(subtitle);
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'ta-side-close';
      close.setAttribute('aria-label', '关闭侧边栏');
      close.textContent = '×';
      head.appendChild(titles);
      head.appendChild(close);

      // 源 / 目标语言行
      var langs = document.createElement('div');
      langs.className = 'ta-side-langs';
      var srcWrap = document.createElement('label');
      srcWrap.className = 'ta-side-lang';
      var srcLabel = document.createElement('span');
      srcLabel.className = 'ta-side-lang-label';
      srcLabel.textContent = '源语言';
      var src = document.createElement('select');
      src.className = 'ta-side-select ta-side-src';
      srcWrap.appendChild(srcLabel);
      srcWrap.appendChild(src);
      var swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'ta-side-swap';
      swap.textContent = '⇄ 交换语言';
      swap.title = '交换源语言与目标语言';
      var dstWrap = document.createElement('label');
      dstWrap.className = 'ta-side-lang';
      var dstLabel = document.createElement('span');
      dstLabel.className = 'ta-side-lang-label';
      dstLabel.textContent = '目标语言';
      var dst = document.createElement('select');
      dst.className = 'ta-side-select ta-side-dst';
      dstWrap.appendChild(dstLabel);
      dstWrap.appendChild(dst);
      langs.appendChild(srcWrap);
      langs.appendChild(swap);
      langs.appendChild(dstWrap);

      // 输入框 + 字数
      var editor = document.createElement('div');
      editor.className = 'ta-side-editor';
      var input = document.createElement('textarea');
      input.className = 'ta-side-input';
      input.setAttribute('placeholder', '输入要翻译的文字… （Ctrl+Enter 翻译）');
      input.setAttribute('spellcheck', 'false');
      var meta = document.createElement('div');
      meta.className = 'ta-side-meta';
      var count = document.createElement('span');
      count.className = 'ta-side-count';
      count.textContent = '0 字';
      meta.appendChild(count);
      editor.appendChild(input);
      editor.appendChild(meta);

      // 动作行：翻译（带 spinner）/ 清空
      var actions = document.createElement('div');
      actions.className = 'ta-side-actions';
      var translate = document.createElement('button');
      translate.type = 'button';
      translate.className = 'ta-side-translate';
      var spin = document.createElement('span');
      spin.className = 'ta-side-spin';
      spin.setAttribute('aria-hidden', 'true');
      var tLabel = document.createElement('span');
      tLabel.className = 'ta-side-btn-label';
      tLabel.textContent = '翻译';
      translate.appendChild(spin);
      translate.appendChild(tLabel);
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'ta-side-clear';
      clear.textContent = '清空';
      actions.appendChild(translate);
      actions.appendChild(clear);

      // slim 进度条
      var progress = document.createElement('div');
      progress.className = 'ta-side-progress';
      var bar = document.createElement('div');
      bar.className = 'ta-side-progress-bar';
      progress.appendChild(bar);

      // 结果区（默认提示）
      var result = document.createElement('div');
      result.className = 'ta-side-result';
      var hint = document.createElement('div');
      hint.className = 'ta-side-hint';
      hint.textContent = '译文会显示在这里 · 支持分段翻译';
      result.appendChild(hint);

      // 最近历史
      var history = document.createElement('div');
      history.className = 'ta-side-history';

      panel.appendChild(head);
      panel.appendChild(langs);
      panel.appendChild(editor);
      panel.appendChild(actions);
      panel.appendChild(progress);
      panel.appendChild(result);
      panel.appendChild(history);

      root.appendChild(backdrop);
      root.appendChild(panel);

      sideEls = {
        backdrop: backdrop, panel: panel, close: close,
        src: src, dst: dst, swap: swap,
        input: input, count: count, translate: translate, tLabel: tLabel,
        clear: clear, progress: progress, bar: bar, result: result,
        hint: hint, history: history, hideTimer: 0
      };

      // 默认语言选项（openSidebar 每次会按持久化设置重填）
      fillLangSelect(src, true, 'auto');
      fillLangSelect(dst, false, (settings && settings.targetLang) || 'zh-CN');

      // 事件绑定
      backdrop.addEventListener('click', closeSidebar);
      close.addEventListener('click', closeSidebar);
      translate.addEventListener('click', doTranslate);
      clear.addEventListener('click', function () {
        input.value = '';
        autoResize();
        updateCount();
        result.textContent = '';
        var h = document.createElement('div');
        h.className = 'ta-side-hint';
        h.textContent = '译文会显示在这里 · 支持分段翻译';
        result.appendChild(h);
        input.focus();
      });
      swap.addEventListener('click', function () {
        var a = src.value, b = dst.value;
        // auto 没有对应的目标码：源是自动检测时只把目标设为新源，避免写入非法目标
        src.value = b;
        if (a !== 'auto') dst.value = a;
        persistSidebarLang();
      });
      dst.addEventListener('change', persistSidebarLang);
      input.addEventListener('input', function () { autoResize(); updateCount(); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doTranslate(); }
      });
    } catch (e) {
      console.debug('[TA][ball]', 'buildSidebar 失败', e);
      sideEls = null;
    }
  }

  // 按球的停靠侧与 settings.ui.sidebarWidth 重新定位侧边栏
  function positionSidebar() {
    if (!sideEls) return;
    try {
      var cfgSide = (ball && ball.getAttribute('data-ta-ball-side')) || 'right';
      sideEls.panel.setAttribute('data-ta-side', cfgSide === 'left' ? 'left' : 'right');
      var ui = (settings && settings.ui) || {};
      var w = clampNum(Number(ui.sidebarWidth) || 380, 280, 720);
      sideEls.panel.style.setProperty('--ta-side-w', w + 'px');
    } catch (e) { console.debug('[TA][ball]', 'positionSidebar 失败', e); }
  }

  function openSidebar() {
    if (!isTopFrame()) return; // 划译台浮层只在顶层 frame 唤起
    try {
      if (!sideEls) buildSidebar();
      if (!sideEls) return;
      // 取消上一次关闭的延迟隐藏，清掉关闭态写入的内联样式，再滑入
      clearTimeout(sideEls.hideTimer);
      sideEls.backdrop.style.opacity = '';
      sideEls.backdrop.style.pointerEvents = '';
      sideEls.backdrop.style.visibility = '';
      sideEls.panel.style.visibility = '';
      positionSidebar();
      var ui = (settings && settings.ui) || {};
      var dst = ui.sidebarTargetLang || (settings && settings.targetLang) || 'zh-CN';
      // 源语言无需持久化：重开时沿用上次选择（无则自动检测）
      var prevSrc = sideEls.src.value || 'auto';
      fillLangSelect(sideEls.src, true, prevSrc);
      fillLangSelect(sideEls.dst, false, dst);
      updateCount();
      autoResize();
      closeMenu();
      hideTip();
      sideEls.backdrop.classList.add('ta-side-show');
      sideEls.panel.classList.add('ta-side-show');
      sideOpen = true;
      sideEls.input.focus();
    } catch (e) { console.debug('[TA][ball]', 'openSidebar 失败', e); }
  }

  function closeSidebar() {
    if (!sideEls || !sideOpen) return;
    try {
      sideEls.backdrop.classList.remove('ta-side-show');
      sideEls.panel.classList.remove('ta-side-show');
      sideOpen = false;
      setSideLoading(false);
      // 阴影残留修复：滑出过渡结束后彻底隐藏遮罩与面板（含 box-shadow）。
      // CSS 已把关闭态 transform 推到 translateX(±120%) 并延迟 visibility:hidden；
      // 这里再用内联样式兜底，确保 opacity:0 / pointer-events:none / visibility:hidden。
      clearTimeout(sideEls.hideTimer);
      sideEls.hideTimer = setTimeout(function () {
        if (!sideEls || sideOpen) return;
        sideEls.backdrop.style.opacity = '0';
        sideEls.backdrop.style.pointerEvents = 'none';
        sideEls.backdrop.style.visibility = 'hidden';
        sideEls.panel.style.visibility = 'hidden';
      }, 380); // > CSS 0.32s 滑出时长
      // 无障碍：关闭后把焦点还给悬浮球
      if (ball && typeof ball.focus === 'function') ball.focus();
    } catch (e) { console.debug('[TA][ball]', 'closeSidebar 失败', e); }
  }

  function updateCount() {
    if (!sideEls) return;
    sideEls.count.textContent = sideEls.input.value.length + ' 字';
  }

  function autoResize() {
    if (!sideEls) return;
    var el = sideEls.input;
    el.style.height = 'auto';
    el.style.height = Math.min(Math.max(el.scrollHeight, 96), 320) + 'px';
  }

  function persistSidebarLang() {
    if (!sideEls) return;
    var val = sideEls.dst.value;
    if (settings && settings.ui) settings.ui.sidebarTargetLang = val;
    if (typeof TA.saveSettings === 'function') {
      TA.saveSettings({ ui: { sidebarTargetLang: val } }).catch(function (e) {
        console.debug('[TA][ball]', '保存侧边栏目标语言失败', e);
      });
    }
  }

  function setSideLoading(on) {
    if (!sideEls) return;
    sideEls.translate.disabled = !!on;
    sideEls.panel.classList.toggle('ta-side-loading', !!on);
    sideEls.tLabel.textContent = on ? '翻译中…' : '翻译';
  }

  // 按空行分段，长段再按 2000 字硬切（优先在换行处切，避免截碎句子）
  function splitChunks(text) {
    var paras = String(text || '').split(/\n\s*\n/);
    var chunks = [];
    var MAX = 2000;
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i].trim();
      if (!p) continue;
      while (p.length > MAX) {
        var cut = p.lastIndexOf('\n', MAX);
        if (cut < MAX * 0.5) cut = MAX;
        chunks.push(p.slice(0, cut).trim());
        p = p.slice(cut).trim();
      }
      if (p) chunks.push(p);
    }
    return chunks;
  }

  // 受限并发 map：最多 limit 个 worker 并行，全部完成返回结果数组，任一失败即 reject
  function mapLimit(items, limit, worker) {
    return new Promise(function (resolve, reject) {
      var results = new Array(items.length);
      var idx = 0, active = 0, finished = 0, errored = false, allErrors = null;
      function launch() {
        while (active < limit && idx < items.length) {
          (function (i) {
            active++;
            Promise.resolve().then(function () { return worker(items[i], i); })
              .then(function (v) { results[i] = v; }, function (e) {
                // 单个 chunk 失败：记错并回填空，不打断其它 chunk（保证最终都有显示值）
                if (results[i] == null) results[i] = '';
                (allErrors = allErrors || []).push(e);
              })
              .then(function () {
                active--;
                finished++;
                if (finished === items.length) {
                  var hasRealErrors = (allErrors || []).some(function (e) { return e && e.code !== 'CANCELLED'; });
                  if (hasRealErrors) reject(allErrors[0]);
                  else resolve(results);
                } else launch();
              });
          })(idx++);
        }
      }
      if (!items.length) resolve(results);
      else launch();
    });
  }

  // 健壮发送：对连接类错误（SW 被回收 / 端口关闭）重试 2 次（150ms、350ms 退避唤醒 SW），
  // 并用 Promise.race 式单次超时保证 Promise 必定 settle（不会让「翻译中…」永久卡住）。
  function isConnError(e) {
    return CONN_ERR_RE.test((e && e.message) || String(e || ''));
  }
  function requestWithRetry(payload, opts) {
    opts = opts || {};
    var maxAttempts = (typeof opts.retries === 'number' ? opts.retries : 2) + 1; // 首轮 + 2 次重试
    var timeoutMs = opts.timeout || REQ_TIMEOUT_MS;

    // 单次 sendMessage：回调里读 lastError 清提示；超时/抛错都归一化成 TA-like 错误对象
    function sendOnce() {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          if (settled) return;
          settled = true;
          reject({ code: 'TIMEOUT', message: '翻译请求超时，请重试' });
        }, timeoutMs);
        function cb(res) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          var lastErr = chrome.runtime.lastError; // 读取以清除运行时的 "Unchecked lastError" 提示
          if (lastErr) { reject(lastErr); return; }
          resolve(res);
        }
        try { chrome.runtime.sendMessage(payload, cb); }
        catch (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
    }

    function attempt(n) {
      return sendOnce().catch(function (e) {
        if (n < maxAttempts && isConnError(e)) {
          return new Promise(function (resolve) {
            setTimeout(resolve, RETRY_BACKOFF_MS[n - 1] || 350);
          }).then(function () { return attempt(n + 1); });
        }
        // 非连接错误 / 重试耗尽 / 超时：统一抛出 TA-like 错误，交由 doTranslate 展示
        if (e && e.code) throw e;
        throw { code: 'NETWORK', message: '无法连接后台服务：' + ((e && e.message) || String(e)) };
      });
    }
    return attempt(1);
  }

  // 划译台独立翻译通道：不经过 TA.pipeline.translateText——其内部 sendMessage 无法在
  // ball.js 内重试，且尊重页面 runSeq（页面状态变化会 reject CANCELLED）。这里直发
  // 同一条 TRANSLATE_BATCH 消息，但走 requestWithRetry（重试 + 超时），更加健壮。
  function translateViaPipeline(text, target) {
    return translateDirect(text, target);
  }

  function translateDirect(text, target) {
    sideDirectSeq += 1;
    var id = (TA.util && typeof TA.util.genId === 'function')
      ? TA.util.genId()
      : ('side-' + Date.now() + '-' + sideDirectSeq);
    return requestWithRetry({
      type: 'TRANSLATE_BATCH',
      requestId: id,
      batchId: Date.now().toString(36) + '-side' + sideDirectSeq,
      texts: [String(text)],
      targetLang: target || 'zh-CN',
      sourceLang: 'auto',
      service: null
    }).then(function (res) {
      if (res && res.ok && res.translations && typeof res.translations[0] === 'string' && res.translations[0]) {
        return res.translations[0];
      }
      throw (res && (res.error || (res.itemErrors && res.itemErrors[0]))) ||
        { code: 'UNKNOWN', message: '翻译失败' };
    });
  }

  function doTranslate() {
    if (!sideEls || sideTranslating) return; // 连点防护：一次翻译未结束前忽略后续点击
    var text = sideEls.input.value.trim();
    if (!text) {
      showTip('请输入要翻译的文字', 1800);
      sideEls.input.focus();
      return;
    }
    var finished = false;
    // 任何出口（成功 / 失败 / 超时 / 异常）都复位保护锁与按钮，保证失败后可立即重试
    function finish() {
      if (finished) return;
      finished = true;
      sideTranslating = false;
      setSideLoading(false);
    }
    sideTranslating = true;
    try {
      setSideLoading(true);
      var target = sideEls.dst.value || 'zh-CN';
      var source = sideEls.src.value || 'auto';
      var chunks = splitChunks(text);
      runTranslateChunks(0);
    } catch (e) {
      renderSideError((e && e.message) || '翻译失败，请重试', e && e.code);
      finish();
    }

    // 失败后重试（服务可能从冷却/打断中恢复）：最多 2 轮
    var sideTranslateRetries = 0;
    function runTranslateChunks(round) {
      mapLimit(chunks, 3, function (chunk) { return translateViaPipeline(chunk, target); })
        .then(function (outs) {
          // 容错渲染：即使个别 chunk 失败也展示已拿到的译文
          var translated = outs.filter(function (x) { return typeof x === 'string' && x; }).join('\n\n');
          renderSideResult(text, translated, source, target);
          pushHistory(source, target, text, translated);
          finish();
        })
        .catch(function (e) {
          var msg = (e && e.message) ||
            (typeof TA.errorText === 'function' ? TA.errorText(e || {}) : '翻译失败');
          if (e && e.code === 'CANCELLED') {
            renderSideError(msg, e.code);
            finish();
            return;
          }
          if (sideTranslateRetries < 2) {
            sideTranslateRetries++;
            showTip('正在重试(' + (sideTranslateRetries) + '/2)…', 900);
            setTimeout(function () { runTranslateChunks(sideTranslateRetries); }, 400);
            return;
          }
          renderSideError(msg, e && e.code);
          finish();
        })
        .then(function () { /* 首轮成功时 */ }, function () {});
    }
  }

  function renderSideResult(original, translated, source, target) {
    if (!sideEls) return;
    var box = sideEls.result;
    box.textContent = '';
    // 用户自己粘贴了原文，输入框里已可见：结果区只展示译文，不回显原文
    // （保留 original 形参以兼容历史回填调用，但不再渲染 .ta-side-res-orig）
    void original;
    var trans = document.createElement('div');
    trans.className = 'ta-side-res-trans';
    // 译文按 Markdown + TeX 渲染（$...$ / $$...$$）；TA.markdown 以 html:false 解析，
    // 不执行译文里的 HTML，保留原 textContent 时代的安全性。复制按钮仍用原文。
    // sidebar.css 的 white-space:pre-wrap 会破坏 KaTeX 块级布局，此处按渲染态覆盖。
    if (TA.markdown && typeof TA.markdown.renderInto === 'function') {
      trans.style.whiteSpace = 'normal';
      TA.markdown.renderInto(trans, translated);
    } else {
      trans.textContent = translated; // markdown 基座未加载时回退纯文本
    }
    var foot = document.createElement('div');
    foot.className = 'ta-side-res-foot';
    var lang = document.createElement('span');
    lang.className = 'ta-side-res-lang';
    // 管线自动检测源语言：源选择器仅作展示/记录，auto 模式如实标注
    lang.textContent = langName(source) + ' → ' + langName(target);
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'ta-side-copy';
    copy.textContent = '复制译文';
    copy.addEventListener('click', function () { copyText(translated, copy); });
    foot.appendChild(lang);
    foot.appendChild(copy);
    box.appendChild(trans);
    box.appendChild(foot);
  }

  function renderSideError(msg, code) {
    if (!sideEls) return;
    var box = sideEls.result;
    box.textContent = '';
    var err = document.createElement('div');
    err.className = 'ta-side-error';
    err.textContent = msg || '翻译失败，请稍后重试';
    box.appendChild(err);
    // 无可用服务时给出一条配置提示（不改变错误码，仅补充可读指引）
    if (code === 'NO_USABLE_SERVICE') {
      var hint = document.createElement('div');
      hint.className = 'ta-side-error-hint';
      hint.textContent = '提示：默认翻译服务为 DeepL（免费）；若仍未配置密钥的谷歌等服务失败会自动跳过。可在设置→服务与密钥中调整。';
      box.appendChild(hint);
    }
  }

  function copyText(text, btn) {
    function done() {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1400);
    }
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = String(text || '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        (document.documentElement || document.body).appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (e) { console.debug('[TA][ball]', '复制译文失败', e); }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(text || '')).then(done, fallback);
        return;
      }
    } catch (e) { /* 无 clipboard API → 回退 */ }
    fallback();
  }

  function pushHistory(srcCode, dstCode, original, translated) {
    sideHistory.unshift({ src: srcCode, dst: dstCode, original: original, translated: translated });
    if (sideHistory.length > 5) sideHistory.length = 5;
    renderHistory();
  }

  function renderHistory() {
    if (!sideEls) return;
    var box = sideEls.history;
    box.textContent = '';
    if (!sideHistory.length) return;
    var label = document.createElement('span');
    label.className = 'ta-side-history-label';
    label.textContent = '最近';
    box.appendChild(label);
    for (var i = 0; i < sideHistory.length; i++) {
      (function (h) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ta-side-history-chip';
        chip.textContent = h.original.length > 12 ? h.original.slice(0, 12) + '…' : h.original;
        chip.title = h.original + '\n→ ' + h.translated;
        chip.addEventListener('click', function () {
          sideEls.input.value = h.original;
          sideEls.src.value = h.src;
          sideEls.dst.value = h.dst;
          updateCount();
          autoResize();
          renderSideResult(h.original, h.translated, h.src, h.dst);
        });
        box.appendChild(chip);
      })(sideHistory[i]);
    }
  }

  /* ==================== 状态通道 + EMA 段耗时（easysub 借鉴落地） ====================
     首选通道：TA.subscribeState（main.js 状态订阅，phase/progress/lastStats 变化点推送）——
       busy = phase 'translating'；on = 'translated'；idle = 'idle'；
       本批完成（busy→on）时读 snap.lastStats {count, seconds, emaMs}（main.js runUnits
       的 EMA 统计成果）tooltip 展示「N 段 · X.Xs」。
     兜底通道（main.js 未就绪的注入时序）：MutationObserver 观察翻译产物 DOM 自推——
       busy = 存在 .ta-target-wrapper.ta-loading；on = 存在 [data-ta="done"] 且无 loading；
       翻译期间按 done 计数增量自采样 EMA（α=0.3）。 */

  var stateSubscribed = false;
  var lastSnapPhase = null;

  // main.js 就绪后由 featureInit 升级到订阅通道（停掉 DOM 兜底观察器）
  function ensureStateChannel() {
    if (stateSubscribed || typeof TA.subscribeState !== 'function') return;
    stateSubscribed = true;
    if (stateObserver) { stateObserver.disconnect(); stateObserver = null; }
    if (cleanupObserver) { cleanupObserver.disconnect(); cleanupObserver = null; } // v0.1 遗留球清理器一并停用
    try { TA.subscribeState(applySnap); } catch (e) { /* 订阅失败保留 DOM 兜底 */ return; }
    if (typeof TA.getState === 'function') {
      try { applySnap(TA.getState()); } catch (e2) { /* 快照异常忽略 */ }
    }
  }

  function applySnap(snap) {
    if (!snap || typeof snap !== 'object') return;
    var next = snap.phase === 'translating' ? 'busy' : (snap.phase === 'translated' ? 'on' : 'idle');
    var now = Date.now();
    if (next === 'busy' && pageState !== 'busy') {
      batch.startT = now; batch.doneBase = 0; batch.emaMs = 0;
    }
    if (pageState === 'busy' && next === 'on' && lastSnapPhase === 'translating') {
      // 本批完成：优先消费 main.js 的 EMA 统计（count/seconds），无则用本模块兜底采样
      var st = snap.lastStats;
      if (st && st.count > 0 && st.seconds > 0) {
        showTip(st.count + ' 段 · ' + Number(st.seconds).toFixed(1) + 's', 3000);
      } else if (batch.emaMs > 0) {
        showTip('均速 ' + (batch.emaMs >= 1000 ? (batch.emaMs / 1000).toFixed(1) + 's' : Math.round(batch.emaMs) + 'ms') + '/段', 3000);
      }
    }
    if (snap.mode) { curMode = snap.mode === 'translation-only' ? 'translation-only' : 'bilingual'; }
    lastSnapPhase = snap.phase || null;
    if (next !== pageState) {
      pageState = next;
      syncBallVisual();
    }
  }

  function recomputed() {
    var loading = document.querySelectorAll('.ta-target-wrapper.ta-loading').length;
    var done = document.querySelectorAll('[data-ta="done"]').length;
    var next = loading > 0 ? 'busy' : (done > 0 ? 'on' : 'idle');

    // EMA 采样：done 增量 > 0 时记录 (now - lastT) / delta
    var now = Date.now();
    if (next === 'busy') {
      if (pageState !== 'busy') { // 新批次开始
        batch.startT = now; batch.lastT = now;
        batch.doneBase = done; batch.lastDone = done; batch.emaMs = 0;
      } else if (done > batch.lastDone) {
        var segMs = (now - batch.lastT) / (done - batch.lastDone);
        batch.emaMs = batch.emaMs ? batch.emaMs * 0.7 + segMs * 0.3 : segMs;
        batch.lastT = now; batch.lastDone = done;
      }
    }
    if (pageState === 'busy' && next === 'on') { // 本批完成
      var n = done - batch.doneBase;
      var secs = (now - batch.startT) / 1000;
      if (n > 0 && secs > 0.2) showTip(n + ' 段 · ' + secs.toFixed(1) + 's', 3000);
      batch.lastDone = done;
    }
    if (next === 'idle') { batch.doneBase = 0; batch.emaMs = 0; }

    if (next !== pageState) {
      pageState = next;
      syncBallVisual();
    }
  }

  // 只改球的文字节点：菜单/tooltip 已是球的子节点，
  // 直接写 ball.textContent 会把它们一并清掉（BUG A 回归防护）。
  function setBallLabel(ch) {
    if (!ball) return;
    for (var i = 0; i < ball.childNodes.length; i++) {
      var n = ball.childNodes[i];
      if (n.nodeType === 3) { n.nodeValue = ch; return; }
    }
    ball.insertBefore(document.createTextNode(ch), ball.firstChild);
  }

  function syncBallVisual() {
    if (!ball) return;
    ball.setAttribute('data-ta-state', pageState === 'on' ? 'on' : (pageState === 'busy' ? 'busy' : 'idle'));
    setBallLabel(pageState === 'on' ? '原' : '译');
    if (menuOpen && !pinned) renderMenuMain(); // 主菜单动态项随状态刷新
    if (subKind) setSubParentExpanded(subKind, true); // 重建后恢复父项展开态
    if (subKind === 'themes') { renderSub('themes'); positionSub(currentSubAnchor()); } // 主题高亮随状态刷新
  }

  function setupStateObserver() {
    if (stateSubscribed || stateObserver || !document.body) return;
    stateObserver = new MutationObserver(debounce(recomputed, 120));
    stateObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-ta', 'class', 'data-ta-theme']
    });
    recomputed();
  }

  // 过渡期清理器：持续移除 v0.1 main.js 可能重建的无 id 球（防双球）
  function setupCleanupObserver() {
    if (cleanupObserver || !document.documentElement) return;
    cleanupObserver = new MutationObserver(debounce(function () {
      var olds = document.querySelectorAll('.ta-float-ball:not(#' + BALL_ID + ')');
      for (var i = 0; i < olds.length; i++) olds[i].remove();
    }, 300));
    cleanupObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function debounce(fn, ms) {
    var t = 0;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  /* ==================== 全屏隐藏 ==================== */

  function setupFullscreen() {
    if (fullscreenBound) return; // applySettings 每次设置变更都会调用，只注册一次
    fullscreenBound = true;
    document.addEventListener('fullscreenchange', function () {
      if (!ball) return;
      var fsEl = document.fullscreenElement;
      // 全屏元素是页面自身内容（非本扩展节点）时隐藏球
      ball.setAttribute('data-ta-fullscreen', fsEl && !ball.contains(fsEl) ? 'hide' : 'show');
    });
  }

  /* ==================== 应用设置 / 挂载编排 ==================== */

  function applySettings(s) {
    settings = s;
    if (!allowed()) {
      // 菜单/tooltip 是球的子节点，ball.remove() 会一并移除；仅清空引用以便下次重建
      removeSubReposition(); // 摘掉 openSub 注册的 scroll(捕获)/resize 监听，避免引用已移除的 sub
      menu = null;
      tip = null;
      sub = null;
      subKind = null;
      if (sideOpen) closeSidebar();
      if (ball) { ball.remove(); ball = null; }
      menuOpen = false;
      pinned = false;
      return;
    }
    var prevSide = ball ? ball.getAttribute('data-ta-ball-side') : null;
    ball = buildBall();
    var cfg = uiCfg(s);
    ball.setAttribute('data-ta-ball-side', cfg.side);
    ball.style.opacity = String(cfg.opacity / 100);
    // 位置设置变化时清除拖动记忆，回到新默认位（用户再次拖动会重新记忆）
    if (prevSide && prevSide !== cfg.side) {
      clearPos();
      if (subKind) positionSub(currentSubAnchor()); // 停靠侧切换 → 子菜单重新选边
    }
    else if (ball && !ball.style.left) restorePos();
    if (settings.targetStyle && settings.targetStyle.theme) curTheme = settings.targetStyle.theme;
    if (settings.subtitle && typeof settings.subtitle.enabled === 'boolean') subtitleOn = settings.subtitle.enabled;
    if (settings.targetStyle && settings.targetStyle.layout) layoutDual = settings.targetStyle.layout === 'dual';
    // 靠边方向/宽度设置变化时，打开中的侧边栏即时重定位
    if (sideOpen) positionSidebar();
    setupStateObserver();
    setupFullscreen();
  }

  /* ==================== features 挂载（协议 TA.features.register） ==================== */

  function featureInit(s) {
    applySettings(s);
    ensureStateChannel(); // main.js initFeatures 时升级到状态订阅通道
  }
  function featureOnSettingsChanged(s) {
    var before = settings ? JSON.stringify(uiCfg(settings)) : '';
    settings = s;
    applySettings(s);
    // 主題档变化（在别处改的）→ 刷新子面板当前高亮
    if (s.targetStyle && s.targetStyle.theme) curTheme = s.targetStyle.theme;
    if (subKind === 'themes') { renderSub('themes'); positionSub(currentSubAnchor()); } // 主题档在别处改了 → 刷新子面板高亮
    void before;
  }
  // 协议：onMessage 未知 type 时遍历 features.messages 分发；
  // CMD 未知 name 时遍历 features.cmds。球对外提供 mask 切换与侧边栏唤起
  // （BALL_OPEN_SIDEBAR / 'ball-open-sidebar'），供 popup / 快捷键 / 测试触发。
  function featureMessages() {
    return {
      BALL_TOGGLE_MASK: function () { actToggleMask(); return { ok: true, maskOn: maskOn }; },
      BALL_OPEN_SIDEBAR: function () { openSidebar(); return { ok: true }; }
    };
  }
  function featureCmds() {
    return {
      'ball-toggle-mask': function () { actToggleMask(); },
      'ball-open-sidebar': function () { openSidebar(); }
    };
  }
  function registerFeature() {
    if (!TA.features || typeof TA.features.register !== 'function') return; // A 未合入时独立运行
    try {
      TA.features.register({
        name: 'ball',
        init: featureInit,
        onSettingsChanged: featureOnSettingsChanged,
        messages: featureMessages(),
        cmds: featureCmds()
      });
    } catch (e) {
      console.warn('[TA] ball.js 注册 TA.features 失败（以独立模式运行）', e);
    }
  }

  /* ==================== 初始化 ==================== */

  function init(s) {
    if (inited) { applySettings(s || settings); return; }
    inited = true;
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKeydown, true);
    setupCleanupObserver();
    applySettings(s);
    registerFeature();
  }

  function boot() {
    var p = (typeof TA.getSettings === 'function')
      ? TA.getSettings()
      : Promise.resolve(null);
    p.then(function (s) { init(s); }).catch(function (e) {
      console.error('[TA] ball.js 初始化失败', e);
    });
  }

  // 公共命名空间：TA.ball.showTip 供 main.js/export.js 调用；
  // openSidebar / closeSidebar 供 popup / 测试直接唤起 / 关闭浮层划译台。
  TA.ball = {
    showTip: showTip,
    getState: function () { return pageState; },
    isMaskOn: function () { return maskOn; },
    toggleMask: actToggleMask,
    openSidebar: openSidebar,
    closeSidebar: closeSidebar
  };

  if (TA.getSettings) boot();
  else setTimeout(boot, 0); // core.js 未就绪的极端时序兜底（manifest 顺序保证其先于本文件）
})();
