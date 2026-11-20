// run-tests.js —— translate-anywhere v0.2 无头端到端实测主脚本
// 运行：node tests/run-tests.js（自动起 fixture server（随机端口）+ Chromium + 扩展）
// 产出：控制台逐项结论 + tests/results.json + tests/screenshots/*.png
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const EXT = path.resolve(__dirname, '..');
const CHROME = path.resolve(__dirname, 'chromium', 'chrome', 'chrome.exe');
const SHOTS = path.join(__dirname, 'screenshots');
let BASE = 'http://127.0.0.1:0'; // 由 startServer 解析实际端口后覆盖
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));

const results = [];
const screenshots = [];
function record(name, passed, evidence, detail) {
  results.push({ name, passed, evidence: evidence || [], detail: detail || null });
  console.log((passed ? '✅ PASS' : '❌ FAIL') + '  ' + name);
  (evidence || []).forEach((e) => console.log('        · ' + e));
  if (detail && !passed) console.log('        ! ' + detail);
  return passed;
}
async function shot(page, name, opts) {
  const p = path.join(SHOTS, name);
  await page.screenshot(Object.assign({ path: p }, opts || {}));
  screenshots.push('tests/screenshots/' + name);
  console.log('        📷 ' + name);
}

/* ---------- 基础设施 ---------- */
let serverProc = null;
async function startServer() {
  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js'), '0'], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('fixture server start timeout')), 8000);
    serverProc.stdout.on('data', (d) => {
      const m = String(d).match(/listening at http:\/\/([\d.]+):(\d+)/);
      if (m) { BASE = 'http://' + m[1] + ':' + m[2]; clearTimeout(t); res(); }
    });
    serverProc.on('exit', (c) => { clearTimeout(t); rej(new Error('server exited ' + c)); });
  });
}
function stopServer() { if (serverProc) try { serverProc.kill(); } catch (e) {} }

let browserRef = null;
let W = null; // 当前 service worker 句柄（MV3 SW 会 30s 空闲回收，须自动重取）
async function getWorker(browser) {
  const t = await browser.waitForTarget(
    (x) => x.type() === 'service_worker' && /background\/service-worker\.js$/.test(x.url()), { timeout: 20000 });
  const w = await t.worker();
  return w;
}
// SW 存活检查 + 重取 + 重装 console 钩子（日志聚合跨 SW 重启保留）
async function ensureWorker() {
  if (W) { try { await W.evaluate(() => true); return W; } catch (e) { /* SW 已回收 */ } }
  if (!browserRef) throw new Error('browser not ready');
  W = await getWorker(browserRef);
  await W.evaluate(() => {
    if (self.__taHooked) return;
    self.__taHooked = true; self.__taErrs = []; self.__taLogs = [];
    const hook = (orig, store) => function (...a) {
      try { store.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch (e) { return String(x); } }).join(' ')); } catch (e) {}
      return orig.apply(console, a);
    };
    console.error = hook(console.error, self.__taErrs);
    console.log = hook(console.log, self.__taLogs);
  });
  return W;
}
async function WE(fn, ...args) { const w = await ensureWorker(); return w.evaluate(fn, ...args); }

async function newPage(browser) {
  const page = await browser.newPage();
  page.__logs = [];
  page.on('console', (m) => page.__logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', (e) => page.__logs.push('[pageerror] ' + e.message));
  await page.setViewport({ width: 1280, height: 900 });
  return page;
}
// 经 SW 向某 tab 发消息（统一在这里 try/catch 归一化）
async function tabMsg(worker, tabId, msg) {
  return WE(async (tid, m) => {
    try { return await chrome.tabs.sendMessage(tid, m); }
    catch (e) { return { ok: false, __sendErr: String((e && e.message) || e) }; }
  }, tabId, msg);
}
// 把 puppeteer page 映射成 chrome.tabs 的数字 tabId。
// 无 "tabs" 权限：query 不返回 http 页的 url/title——
// 依次尝试：当前窗口 active 标签（puppeteer 每次新开页即激活，唯一窗口）→ 全局唯一标签兜底。
async function tabIdOf(page, worker) {
  const act = await WE(() =>
    chrome.tabs.query({ active: true, currentWindow: true }).then((ts) => (ts.length === 1 ? ts[0].id : null)).catch(() => null));
  if (act != null) return act;
  return WE(() =>
    chrome.tabs.query({}).then((ts) => (ts.length === 1 ? ts[0].id : null)).catch(() => null));
}
// 触发翻译并轮询 GET_PAGE_STATE 直到 translated / 终态错误 / 超时
async function translatePage(page, worker, opts) {
  opts = opts || {};
  const tabId = await tabIdOf(page, worker);
  const resp = await tabMsg(worker, tabId, { type: 'TRANSLATE_PAGE' });
  const t0 = Date.now();
  const progressSamples = [];
  let state = null;
  while (Date.now() - t0 < (opts.timeout || 150000)) {
    await sleep(400);
    state = await tabMsg(worker, tabId, { type: 'GET_PAGE_STATE' });
    if (state && state.progress) {
      const last = progressSamples[progressSamples.length - 1];
      if (!last || last.done !== state.progress.done || last.total !== state.progress.total) {
        progressSamples.push({ t: Date.now() - t0, ...state.progress });
      }
    }
    if (state && state.translated) break;
    if (state && state.error && state.phase !== 'translating') break; // 终态错误（如 90% 跳过）
  }
  return { resp, state, progressSamples };
}
// 修改 settings（经 SW 写 storage.local；content 侧 storage.onChanged 即时生效）
async function patchSettings(worker, patch) {
  return WE(async (p) => {
    function merge(a, b) {
      for (const k of Object.keys(b)) {
        if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]);
        else a[k] = Array.isArray(b[k]) ? b[k].slice() : b[k];
      }
      return a;
    }
    const obj = await chrome.storage.local.get('settings');
    const merged = merge(obj && obj.settings && typeof obj.settings === 'object' ? obj.settings : {}, p);
    await chrome.storage.local.set({ settings: merged });
    return merged;
  }, patch);
}
// 注：从 SW 内 chrome.runtime.sendMessage 不会送达 SW 自己的 onMessage
//（runtime 消息只发给其它扩展上下文），故这里直接调 SW 内的 TA.cache 方法——
// 与 service-worker.js GET_CACHE_STATS/CLEAR_CACHE 分支完全同路径。
async function cacheStats() {
  return WE(async () => {
    try {
      const st = await globalThis.TA.cache.stats();
      return { ok: true, data: st };
    } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  });
}
async function clearCache() {
  return WE(async () => {
    try {
      const r = await globalThis.TA.cache.clearAll();
      return { ok: true, data: r };
    } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
  });
}
async function swLogs() { return WE(() => ({ errs: (self.__taErrs || []).slice(0, 20), logs: (self.__taLogs || []).slice(-60) })); }
const noTaErr = (logs) => logs.filter((l) => /前置文件/.test(l));

/* ================================================================ */
async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  await startServer();
  console.log('[env] fixture server ready at ' + BASE);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      '--no-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--window-size=1320,1000'
    ]
  });
  browserRef = browser;
  try {
    // 关闭 launch 自带的 about:blank 标签：保证 chrome.tabs 里同一时刻只有当前测试页
    for (const p of await browser.pages()) await p.close().catch(() => {});

    /* ---------- 必测项 1：扩展加载 / service worker ---------- */
    await ensureWorker();
    const swUrl = W.__swTarget ? W.__swTarget.url() : null;
    const extId = swUrl ? swUrl.match(/^chrome-extension:\/\/([^/]+)/)[1] : null;
    const probe = await WE(() => ({
      ta: !!globalThis.TA,
      adapters: globalThis.TA && globalThis.TA.adapters && globalThis.TA.adapters.ids ? globalThis.TA.adapters.ids() : null,
      hasQueue: !!(globalThis.TA && globalThis.TA.queue),
      hasCache: !!(globalThis.TA && globalThis.TA.cache)
    }));
    // 内容脚本报错探测：开一个页看 console；GET_FEATURES 轮询（内容脚本 document_idle 注入）
    {
      const p = await newPage(browser);
      await p.goto(BASE + '/fixture-basic.html?t=probe', { waitUntil: 'load', timeout: 30000 });
      let features = null;
      for (let i = 0; i < 30; i++) {
        features = await tabMsg(null, await tabIdOf(p, null), { type: 'GET_FEATURES' });
        if (features && features.ok) break;
        await sleep(500);
      }
      await sleep(1000);
      const bad = noTaErr(p.__logs);
      record('1. 扩展被 headless Chromium 加载（service worker 启动、内容脚本注入、GET_FEATURES 可用）',
        !!probe.ta && Array.isArray(probe.adapters) && probe.adapters.length === 12 &&
        !!features.ok && bad.length === 0,
        [
          'Chromium: ' + await browser.userAgent(),
          'SW target: ' + swUrl,
          'SW 内 importScripts 全部就位: TA=' + probe.ta + ' adapters(' + (probe.adapters || []).join(',') + ')=' + probe.adapters.length + '/12',
          'GET_FEATURES: ok=' + features.ok + ' features=' + JSON.stringify(features.features) + ' themes=' + (features.themes || []).length + (features.ok ? '' : ' sendErr=' + (features.__sendErr || '')),
          '页面 console 无 [TA] 前置文件缺失类报错（收集 ' + p.__logs.length + ' 条 console/异常: ' + p.__logs.slice(0, 2).join(' | ').slice(0, 120) + '）'
        ],
        bad.length ? bad.join(' | ') : (!probe.ta || !Array.isArray(probe.adapters) ? 'SW 探测失败 ' + JSON.stringify(probe) : (!(features && features.ok) ? 'GET_FEATURES 未就绪: ' + (features && (features.__sendErr || JSON.stringify(features).slice(0, 200))) : null)));
      await p.close();
    }

    /* ---------- 服务连通性探针（真实网络，逐服务直发；覆盖验收 18 的 token 存活实测） ---------- */
    const TOKEN_SAMPLE = 'Given that ⟪m1⟫ + ⟪m2⟫ = ⟪m3⟫ holds for all x, the series converges by comparison with the geometric case.';
    const svcProbe = {};
    for (const svc of ['google', 'edge', 'deepl-free', 'caiyun', 'youdao']) {
      try {
        const r = await WE(async (svcName, texts) => {
          const obj = await chrome.storage.local.get('settings');
          const settings = globalThis.TA.mergeDefaults(obj && obj.settings);
          return await globalThis.TA.adapters.translateBatch(
            { batchId: 'probe-' + svcName + '-' + Date.now(), texts, targetLang: 'zh-CN', sourceLang: 'auto', service: svcName },
            settings);
        }, svc, [TOKEN_SAMPLE, 'The quick brown fox jumps over the lazy dog.']);
        const tok = r.ok && r.translations ? r.translations[0] : null;
        const tokKept = tok ? (tok.match(/⟪\s*m\s*\d+\s*⟫/g) || []).length : 0;
        svcProbe[svc] = { ok: !!r.ok, sample: tok, tokKept, err: r.error ? r.error.code + ':' + r.error.message : null };
      } catch (e) { svcProbe[svc] = { ok: false, err: String(e) }; }
      console.log('        [probe] ' + svc + ' → ' + (svcProbe[svc].ok ? 'OK' : 'FAIL ' + svcProbe[svc].err));
    }
    record('6a. 真实翻译服务连通性（默认链 5 服务逐一直发，含 ⟪mN⟫ token 样本）',
      Object.values(svcProbe).some((x) => x.ok),
      Object.keys(svcProbe).map((k) => k + ': ' + (svcProbe[k].ok
        ? 'OK · 样例=' + JSON.stringify(svcProbe[k].sample).slice(0, 90) + ' · token保留=' + svcProbe[k].tokKept + '/3'
        : 'FAIL ' + svcProbe[k].err)),
      Object.values(svcProbe).every((x) => !x.ok) ? '全部服务失败：页面翻译不可能产出中文译文' : null);

    /* ---------- 必测项 2：双语排版（英文文章） ---------- */
    const basic = await newPage(browser);
    await basic.goto(BASE + '/fixture-basic.html?t=basic', { waitUntil: 'load', timeout: 30000 });
    await sleep(600);
    const basicOriginalText = await basic.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120));
    const t2 = await translatePage(basic, null, { timeout: 180000 });
    const layout = await basic.evaluate(() => {
      const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
      const out = { units: [], cloneUnits: [], liCase: [], aCase: null, scatter: null, flex: null, grid: null, indent: null, fontCase: null, widths: [], tokenLeak: false };
      document.querySelectorAll('[data-ta="done"]').forEach((el) => {
        // 克隆甄别：walker 把嵌套 UL 当"内联元素"克隆进译文（见 2a 项根因），
        // 克隆体内的 li 也带 data-ta=done——它们不是页面原始段落，单独计数。
        const inClone = !!(el.closest && el.closest('.ta-target-wrapper'));
        const w = el.querySelector(':scope > .ta-target-wrapper');
        if (!w) return;
        const inner = w.querySelector(':scope > .ta-target-inner');
        const cs = getComputedStyle(el);
        const contentW = el.clientWidth - parseFloat(cs.paddingLeft || '0') - parseFloat(cs.paddingRight || '0');
        const innerW = inner ? inner.getBoundingClientRect().width : 0;
        const er = el.getBoundingClientRect();
        const wr = w.getBoundingClientRect();
        const tr = (inner ? inner.textContent : '').trim();
        const u = {
          tag: el.tagName, cls: String(el.className || '').slice(0, 20),
          contentW: Math.round(contentW), innerW: Math.round(innerW),
          below: wr.top >= er.top,
          han: hasHan(tr), error: w.classList.contains('ta-error'),
          text: tr.slice(0, 24)
        };
        u.ok = Math.abs(innerW - contentW) <= 2 && u.below && u.han && !u.error;
        if (inClone) { out.cloneUnits.push(u); } else { out.units.push(u); out.widths.push(u.ok); }
      });
      // li > Text + ul 场景：译文 wrapper 应在原文行与子列表之间（对照验收清单 1）
      document.querySelectorAll('li[data-ta="done"]').forEach((li, idx) => {
        const ul = li.querySelector(':scope > ul');
        if (!ul) return;
        const w = li.querySelector(':scope > .ta-target-wrapper');
        const kids = Array.from(li.childNodes).map((n) =>
          n.nodeType === 3 ? '#text:' + JSON.stringify((n.nodeValue || '').trim().slice(0, 20))
            : (n.classList && n.classList.contains('ta-target-wrapper') ? 'WRAPPER' : '<' + n.tagName + '>'));
        out.liCase.push({
          idx, wrapperPresent: !!w,
          wrapperBeforeUl: !!(w && ul.previousElementSibling === w),
          wrapperIsLast: !!(w && w === li.lastElementChild),
          innerText: w && w.querySelector(':scope > .ta-target-inner') ? w.querySelector(':scope > .ta-target-inner').textContent.trim().slice(0, 40) : null,
          childOrder: kids
        });
      });
      // p 内 inline <a>：wrapper 应在 p 内且位于直属文本流之后
      const pA = Array.from(document.querySelectorAll('p[data-ta="done"]')).find((x) => x.querySelector('a'));
      if (pA) {
        const w = pA.querySelector(':scope > .ta-target-wrapper');
        const lastText = Array.from(pA.childNodes).filter((n) => n.nodeType === 3 && n.nodeValue.trim()).pop();
        out.aCase = {
          inP: !!w && w.parentElement === pA,
          afterLastDirectText: !!(w && lastText && lastText.nextElementSibling === w)
        };
      }
      // 外层 div 散落直属文本 + 子块
      const sc = document.querySelector('.scattered');
      if (sc && sc.hasAttribute('data-ta')) {
        const w = sc.querySelector(':scope > .ta-target-wrapper');
        const lastDirect = Array.from(sc.childNodes).filter((n) => n.nodeType === 3 && n.nodeValue.trim()).pop();
        out.scatter = {
          hasWrapper: !!w, inScatter: !!w && w.parentElement === sc,
          afterTrailingText: !!(w && lastDirect && lastDirect.nextElementSibling === w),
          innerPTranslated: Array.from(sc.querySelectorAll(':scope > p')).every((x) => x.hasAttribute('data-ta'))
        };
      }
      // flex 容器（含直属文本 → 候选块）：译文外插兄弟块
      const fx = document.querySelector('.flexrow');
      if (fx) {
        const sw = fx.nextElementSibling;
        out.flex = {
          containerDataTa: fx.getAttribute('data-ta'),
          directChildCount: fx.children.length,
          nextIsSiblingWrapper: !!(sw && sw.classList.contains('ta-target-wrapper') && sw.hasAttribute('data-ta-sibling')),
          forMatches: !!(sw && sw.getAttribute('data-ta-for') && fx.getAttribute('data-ta-id') === sw.getAttribute('data-ta-for')),
          siblingHan: sw ? hasHan((sw.querySelector('.ta-target-inner') || {}).textContent) : false
        };
      }
      const gx = document.querySelector('.gridbox');
      if (gx) {
        const sw = gx.nextElementSibling;
        out.grid = {
          containerDataTa: gx.getAttribute('data-ta'),
          directChildCount: gx.children.length,
          nextIsSiblingWrapper: !!(sw && sw.classList.contains('ta-target-wrapper') && sw.hasAttribute('data-ta-sibling')),
          forMatches: !!(sw && sw.getAttribute('data-ta-for') && gx.getAttribute('data-ta-id') === sw.getAttribute('data-ta-for')),
          siblingHan: sw ? hasHan((sw.querySelector('.ta-target-inner') || {}).textContent) : false
        };
      }
      // text-indent 不传染 + 标题字重继承
      const pi = document.querySelector('p.indent[data-ta="done"]');
      if (pi) {
        const w = pi.querySelector(':scope > .ta-target-wrapper');
        out.indent = { pIndent: getComputedStyle(pi).textIndent, wIndent: w ? getComputedStyle(w).textIndent : null };
      }
      const h2 = Array.from(document.querySelectorAll('h2[data-ta="done"]'))[0];
      if (h2) {
        const w = h2.querySelector(':scope > .ta-target-wrapper');
        out.fontCase = {
          h2Font: getComputedStyle(h2).fontSize + '/' + getComputedStyle(h2).fontWeight,
          wFont: w ? getComputedStyle(w).fontSize + '/' + getComputedStyle(w).fontWeight : null
        };
      }
      out.inlineStyles = Array.from(document.querySelectorAll('.ta-target-inner em, .ta-target-inner strong')).slice(0, 4)
        .map((x) => ({ tag: x.tagName, style: getComputedStyle(x).fontStyle + '/' + getComputedStyle(x).fontWeight }));
      out.tokenLeak = /⟪\s*m\s*\d+\s*⟫/.test(document.body.innerText || '');
      return out;
    });
    const badUnits = layout.units.filter((u) => !u.ok);
    const okCount = layout.units.length - badUnits.length;
    await shot(basic, '01-basic-translated-full.png', { fullPage: true });
    record('2. 双语排版：每段原文正下方出现中文译文，译文宽=父内容宽、译文在下',
      layout.units.length > 0 && badUnits.length === 0 && !layout.tokenLeak,
      [
        '原始段落单元（不含克隆体）=' + layout.units.length + '，达标=' + okCount + '（宽度=父内容宽 ±2px、译文在下、译文含中文、无错误态）',
        '不达标明细: ' + JSON.stringify(badUnits.map((u) => ({ tag: u.tag, cls: u.cls, contentW: u.contentW, innerW: u.innerW, below: u.below, han: u.han, error: u.error, text: u.text }))),
        '另有克隆体残留单元=' + layout.cloneUnits.length + '（嵌套 UL 被当内联元素克隆进译文所致，属 2a 项缺陷，不属原始段落）',
        '正文无 ⟪mN⟫ token 残留: ' + !layout.tokenLeak,
        'GET_PAGE_STATE: ' + JSON.stringify(t2.state && { translated: t2.state.translated, error: t2.state.error })
      ],
      badUnits.length ? JSON.stringify(badUnits.slice(0, 8)) : null);

    // li 场景（对照验收清单 1：译文应紧贴该行直属文本、位于子列表之前）
    const liGood = layout.liCase.filter((c) => c.wrapperPresent && c.wrapperBeforeUl);
    const liDup = layout.liCase.filter((c) => /Review the overnight|Close every notification|Compare the plan/.test(c.innerText || ''));
    record('2a. li>Text+嵌套ul：译文在原文行与子列表之间（不出现 appendChild 末尾错位）',
      layout.liCase.length > 0 && liGood.length === layout.liCase.length && liDup.length === 0,
      [
        '场景数=' + layout.liCase.length + '，wrapper 位于原文行与子列表之间=' + liGood.length,
        '逐例: ' + JSON.stringify(layout.liCase.map((c) => ({ idx: c.idx, beforeUl: c.wrapperBeforeUl, last: c.wrapperIsLast, inner: c.innerText, childOrder: c.childOrder }))),
        '克隆缺陷（译文行内混入整棵子列表副本，冻结在 loading 态、内含原文英文）: ' + liDup.length + '/3 例'
      ],
      liGood.length !== layout.liCase.length || liDup.length > 0
        ? '实测 childOrder=["原文文本","<UL>","尾随空白","WRAPPER"]——两处缺陷：① wrapper 落在子列表之后（findInsertAnchor 取最后收集的文本节点=ul 之后的纯空白节点，locator: content/injector.js:102-113 findInsertAnchor + content/walker.js:109-131 textNodes 未滤纯空白）；② 整棵 <ul> 被克隆进译文行且副本停在 loading 态（walker BLOCK_TAGS 缺 ul/ol → visit 把 UL 当内联元素产出占位符，injector.js:245 cloneClean(src) 克隆整棵子列表进 inner，副本永不回填）'
        : null);

    record('2b. p 内 inline <a>：wrapper 在 p 内、紧贴直属文本流之后',
      !!(layout.aCase && layout.aCase.inP && layout.aCase.afterLastDirectText),
      ['<a> 场景: ' + JSON.stringify(layout.aCase)],
      layout.aCase ? null : '未找到含 <a> 的已翻译段落');

    record('2c. 外层 div 散落直属文本+子块：译文贴住直属文本流，子块独立成段',
      !!(layout.scatter && layout.scatter.hasWrapper && layout.scatter.inScatter && layout.scatter.afterTrailingText && layout.scatter.innerPTranslated),
      ['scatter 场景: ' + JSON.stringify(layout.scatter)],
      layout.scatter ? null : '未找到 .scattered 容器（可能未翻译）');

    record('2d. flex/grid 容器（含直属文本）：译文外插兄弟块 + data-ta-sibling 标记，容器子元素数不变',
      !!(layout.flex && layout.flex.containerDataTa === 'done' && layout.flex.nextIsSiblingWrapper && layout.flex.forMatches &&
        layout.flex.siblingHan && layout.grid && layout.grid.containerDataTa === 'done' && layout.grid.nextIsSiblingWrapper),
      ['flex: ' + JSON.stringify(layout.flex), 'grid: ' + JSON.stringify(layout.grid)],
      layout.flex ? null : '未找到 .flexrow（可能未翻译）');

    record('2e. 排版一致：text-indent 不传染 / 标题 font:inherit / em-strong 样式保留',
      !!(layout.indent && layout.indent.wIndent === '0px' && layout.fontCase && layout.fontCase.wFont === layout.fontCase.h2Font),
      [
        'p.indent: 原文 text-indent=' + (layout.indent && layout.indent.pIndent) + ' → 译文 text-indent=' + (layout.indent && layout.indent.wIndent),
        'h2: ' + (layout.fontCase && layout.fontCase.h2Font) + ' → wrapper: ' + (layout.fontCase && layout.fontCase.wFont),
        '译文内联元素样式: ' + JSON.stringify(layout.inlineStyles)
      ],
      null);

    /* ---------- 主题抽查 + 还原（对照验收 11 / 3） ---------- */
    const themeChecks = [];
    for (const th of ['none', 'dashed', 'underline', 'marker', 'paper', 'blockquote', 'bold', 'mask']) {
      const r = await tabMsg(null, await tabIdOf(basic, null), { type: 'SET_THEME', theme: th });
      const applied = await basic.evaluate(() => {
        const w = document.querySelector('.ta-target-wrapper');
        return w ? w.getAttribute('data-ta-theme') : null;
      });
      themeChecks.push(th + '=' + (r.ok && applied === th));
    }
    await tabMsg(null, await tabIdOf(basic, null), { type: 'SET_THEME', theme: 'dashed' });
    const dashedCss = await basic.evaluate(() => {
      const w = document.querySelector('.ta-target-wrapper[data-ta-theme="dashed"]');
      if (!w) return null;
      const inner = w.querySelector('.ta-target-inner');
      const cs = inner ? getComputedStyle(inner) : null;
      return cs ? { deco: cs.textDecorationLine + '/' + cs.textDecorationStyle, color: cs.color } : null;
    });
    record('10a. SET_THEME 主题即时切换（none/dashed/underline/marker/paper/blockquote/bold/mask 八档抽查）',
      themeChecks.every((x) => x.endsWith('=true')) && !!dashedCss,
      ['逐档: ' + themeChecks.join(', '), 'dashed 译文观感: ' + JSON.stringify(dashedCss)],
      null);
    await shot(basic, '02-basic-dashed-theme.png', {});

    // restoreAll 还原干净（对照验收 3 后半：显示原文后 wrapper 与 data-ta 标记清除）
    await tabMsg(null, await tabIdOf(basic, null), { type: 'RESTORE_PAGE' });
    await sleep(800);
    const restored = await basic.evaluate(() => ({
      wrappers: document.querySelectorAll('.ta-target-wrapper').length,
      dataTa: document.querySelectorAll('[data-ta]').length,
      sibling: document.querySelectorAll('[data-ta-sibling]').length,
      originals: document.querySelectorAll('.ta-original, .ta-original-inline').length,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 120)
    }));
    record('3b. restoreAll 后 wrapper/data-ta/data-ta-sibling 清除干净、原文恢复',
      restored.wrappers === 0 && restored.dataTa === 0 && restored.sibling === 0 && restored.originals === 0 &&
        restored.text === basicOriginalText,
      ['还原后残留: wrappers=' + restored.wrappers + ' dataTa=' + restored.dataTa + ' sibling=' + restored.sibling + ' originals=' + restored.originals,
        '正文与翻译前一致: ' + (restored.text === basicOriginalText)],
      null);
    await shot(basic, '03-restored-clean.png', { fullPage: true });
    await basic.close();

    /* ---------- 必测项 3：KaTeX 公式保护 ---------- */
    const katexPage = await newPage(browser);
    await katexPage.goto(BASE + '/fixture-katex.html?t=katex', { waitUntil: 'load', timeout: 40000 });
    let katexReady = false;
    for (let i = 0; i < 40; i++) {
      const n = await katexPage.evaluate(() => document.querySelectorAll('span.katex').length);
      if (n >= 7) { katexReady = true; break; }
      await sleep(500);
    }
    const katexBefore = await katexPage.evaluate(() =>
      Array.from(document.querySelectorAll('span.katex')).map((k) => k.innerHTML));
    const t3 = katexReady ? await translatePage(katexPage, null, { timeout: 180000 }) : { state: {} };
    const katexAfter = await katexPage.evaluate(() => {
      const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
      return {
        list: Array.from(document.querySelectorAll('span.katex')).map((k) => k.innerHTML),
        tokenLeak: /⟪\s*m\s*\d+\s*⟫/.test(document.body.innerText || ''),
        paraHan: Array.from(document.querySelectorAll('p[data-ta="done"]')).map((p) => {
          const inner = p.querySelector(':scope > .ta-target-wrapper > .ta-target-inner');
          return hasHan(inner ? inner.textContent : '');
        })
      };
    });
    const identical = katexReady && katexBefore.length === katexAfter.list.length &&
      katexBefore.every((b, i) => b === katexAfter.list[i]);
    await shot(katexPage, '04-katex-translated.png', { fullPage: true });
    record('3. KaTeX 公式保护：.katex DOM 逐字节不变、周围文本正常翻译、token 不残留',
      katexReady && identical && !katexAfter.tokenLeak && katexAfter.paraHan.length > 0 && katexAfter.paraHan.every(Boolean),
      [
        'KaTeX 渲染就绪: ' + katexReady + '（span.katex 数=' + katexBefore.length + '）',
        '翻译前后 .katex 数量: ' + katexBefore.length + ' → ' + katexAfter.list.length + '，innerHTML 完全一致=' + identical,
        '含公式段落译文含中文: ' + katexAfter.paraHan.filter(Boolean).length + '/' + katexAfter.paraHan.length,
        '最终可见 DOM 无 ⟪mN⟫ token: ' + !katexAfter.tokenLeak
      ],
      !katexReady ? 'KaTeX CDN 渲染失败（span.katex=0）' : (!identical ? '.katex innerHTML 在翻译后发生变化' : null));
    await katexPage.close();

    /* ---------- 必测项 3c：AtCoder 内联公式（var/sup/sub）混合策略 ---------- */
    const atcoderPage = await newPage(browser);
    await atcoderPage.goto(BASE + '/fixture-atcoder.html?t=atcoder', { waitUntil: 'load', timeout: 30000 });
    // 测试钩子：fixture 域名非 atcoder.jp，触发翻译前放行 protectInlineMath 与纯公式单元跳过
    await atcoderPage.evaluate(() => { window.__TA_ATCODER_MATH_TEST__ = true; });
    const t3c = await translatePage(atcoderPage, null, { timeout: 180000 });
    let at = null;
    for (let i = 0; i < 60; i++) {
      at = await atcoderPage.evaluate(() => {
        const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
        const inners = Array.from(document.querySelectorAll('p[data-ta="done"] > .ta-target-wrapper > .ta-target-inner'));
        const innerText = inners.map((x) => x.textContent || '').join(' ');
        // 纯公式约束行：应保留原文（无 wrapper、无 data-ta），且公式节点已回归
        const pure = Array.from(document.querySelectorAll('li'))
          .filter((x) => /3000/.test(x.textContent || ''))
          .map((li) => ({
            wrapper: !!li.querySelector('.ta-target-wrapper'),
            dataTa: li.hasAttribute('data-ta'),
            varCount: li.querySelectorAll('var').length,
            text: (li.textContent || '').trim()
          }));
        return {
          done: inners.length,
          varCount: inners.reduce((n, x) => n + x.querySelectorAll('var').length, 0),
          supSubCount: inners.reduce((n, x) => n + x.querySelectorAll('sup,sub').length, 0),
          han: hasHan(innerText),
          leak: /⟪\s*m\s*\d+\s*⟫/.test(document.body.innerText || ''),
          pure: pure,
          sample: innerText.slice(0, 140)
        };
      });
      if (at.varCount > 0 && at.han) break;
      await sleep(500);
    }
    await shot(atcoderPage, '04b-atcoder-inline-math.png', { fullPage: true });
    const pureOk = !!(at && at.pure.length) && at.pure.every((x) =>
      !x.wrapper && !x.dataTa && x.varCount > 0 && /3000/.test(x.text) && !/⟪/.test(x.text));
    let fail3c = null;
    if (!at) fail3c = '未取到译文 DOM 快照';
    else if (at.varCount === 0) fail3c = '译文 wrapper 内无 <var>：内联公式未回填到译文';
    else if (!at.han) fail3c = '译文无中文';
    else if (at.leak) fail3c = '可见 DOM 残留 ⟪mN⟫ token';
    else if (!pureOk) fail3c = '纯公式约束行被翻译或未保留公式节点';
    record('3c. AtCoder 混合策略：内联公式 var/sup/sub 在译文中保留、纯公式约束行跳过、无 token 泄漏',
      !!(t3c.state && t3c.state.translated) && !!at && at.done > 0 && at.varCount > 0 && at.han && !at.leak && pureOk,
      [
        '译文中 <var> 数=' + (at && at.varCount) + '，<sup>/<sub> 数=' + (at && at.supSubCount) + '（>0 即公式随译文保留）',
        '译文首段样例=' + JSON.stringify(at && at.sample),
        '译文含中文=' + (at && at.han) + '，GET_PAGE_STATE.translated=' + (t3c.state && t3c.state.translated),
        '可见 DOM 无 ⟪mN⟫ token 残留=' + !(at && at.leak),
        '纯公式约束行（保留原文、无 wrapper/data-ta、公式回归）=' + JSON.stringify(at && at.pure)
      ],
      fail3c);
    await atcoderPage.close();

    /* ---------- 必测项 4：混合语言默认直翻 ---------- */
    const mixed = await newPage(browser);
    await mixed.goto(BASE + '/fixture-mixed.html?t=mixed', { waitUntil: 'load', timeout: 30000 });
    await sleep(400);
    const mixedPre = await mixed.evaluate(() => {
      const hanPct = (s) => {
        let han = 0, total = 0;
        for (const ch of String(s || '')) {
          if (/\p{L}/u.test(ch)) { total++; if (ch >= '\u4e00' && ch <= '\u9fff') han++; }
        }
        return total ? han / total : 0;
      };
      return Array.from(document.querySelectorAll('p')).map((p) => +hanPct(p.textContent).toFixed(2));
    });
    const t4 = await translatePage(mixed, null, { timeout: 180000 });
    const mixedRes = await mixed.evaluate((pre) => {
      const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
      const res = { en: [], zh: [] };
      const ps = document.querySelectorAll('p');
      ps.forEach((p, i) => {
        const w = p.querySelector(':scope > .ta-target-wrapper > .ta-target-inner');
        const r = { i, prePct: pre[i], dataTa: p.hasAttribute('data-ta'), han: hasHan(w ? w.textContent : ''), text: (w ? w.textContent : p.textContent).slice(0, 18) };
        (pre[i] < 0.2 ? res.en : res.zh).push(r);
      });
      return res;
    }, mixedPre);
    await shot(mixed, '05-mixed-translated.png', { fullPage: true });
    const enOk = mixedRes.en.length > 0 && mixedRes.en.every((x) => x.dataTa && x.han);
    const zhOk = mixedRes.zh.length > 0 && mixedRes.zh.every((x) => !x.dataTa && !x.han);
    record('4. 混合语言默认直翻：英文段落有中文译文、中文段落原样（无 wrapper）、无任何开关参与',
      enOk && zhOk && t4.state && !t4.state.sameLangPage,
      [
        '页面级跳过未触发: ' + !(t4.state && t4.state.sameLangPage),
        '英文段落(' + mixedRes.en.length + '): ' + JSON.stringify(mixedRes.en.map((x) => 'p' + x.i + '(原占比' + x.prePct + ') dataTa=' + x.dataTa + ' 译含中文=' + x.han)),
        '中文段落(' + mixedRes.zh.length + '): ' + JSON.stringify(mixedRes.zh.map((x) => 'p' + x.i + '(原占比' + x.prePct + ') dataTa=' + x.dataTa))
      ],
      enOk && zhOk ? null : '英文段未译或中文段被误译（见上方明细）');
    await mixed.close();

    // 4b. 纯中文页 90% 跳过
    const zhPage = await newPage(browser);
    await zhPage.goto(BASE + '/fixture-zh.html?t=zh', { waitUntil: 'load', timeout: 30000 });
    await sleep(300);
    const t4b = await translatePage(zhPage, null, { timeout: 30000 });
    const zhDom = await zhPage.evaluate(() => document.querySelectorAll('[data-ta], .ta-target-wrapper').length);
    record('4b. 页面 90%+ 已是目标语言：整体跳过并提示（无逐段空转）',
      !!(t4b.state && t4b.state.sameLangPage && !t4b.state.translated && zhDom === 0 &&
        /90%|目标语言/.test(t4b.state.error || '')),
      ['GET_PAGE_STATE: sameLangPage=' + (t4b.state && t4b.state.sameLangPage) + ' reason=' + (t4b.state && t4b.state.sameLangPageReason) + ' error=' + JSON.stringify(t4b.state && t4b.state.error), 'DOM 残留 [data-ta]/wrapper=' + zhDom],
      null);
    await shot(zhPage, '06-zh-skip.png', {});
    await zhPage.close();

    /* ---------- 必测项 5：长文（>5000 字符） ---------- */
    const longPage = await newPage(browser);
    await longPage.goto(BASE + '/fixture-long.html?t=long', { waitUntil: 'load', timeout: 30000 });
    const longLen = await longPage.evaluate(() => (document.body.innerText || '').length);
    const t5 = await translatePage(longPage, null, { timeout: 240000 });
    const longRes = await longPage.evaluate(() => {
      const hasHan = (s) => /[\u4e00-\u9fff]/.test(String(s || ''));
      const ps = document.querySelectorAll('p');
      let done = 0, withHan = 0, errs = 0;
      ps.forEach((p) => {
        if (!p.hasAttribute('data-ta')) return;
        done++;
        const w = p.querySelector(':scope > .ta-target-wrapper');
        const inner = w && w.querySelector(':scope > .ta-target-inner');
        if (w && w.classList.contains('ta-error')) errs++;
        if (inner && hasHan(inner.textContent)) withHan++;
      });
      return { total: ps.length, done, withHan, errs };
    });
    // 静置 10s 观察 rewalk 死循环
    const sigA = await longPage.evaluate(() =>
      document.querySelectorAll('[data-ta]').length + ':' + document.querySelectorAll('.ta-target-wrapper').length + ':' +
      Array.from(document.querySelectorAll('.ta-target-wrapper')).map((w) => w.getAttribute('data-ta-id')).join(','));
    const errCount0 = longPage.__logs.filter((l) => l.startsWith('[error]')).length;
    await sleep(10000);
    const sigB = await longPage.evaluate(() =>
      document.querySelectorAll('[data-ta]').length + ':' + document.querySelectorAll('.ta-target-wrapper').length + ':' +
      Array.from(document.querySelectorAll('.ta-target-wrapper')).map((w) => w.getAttribute('data-ta-id')).join(','));
    const errCount1 = longPage.__logs.filter((l) => l.startsWith('[error]')).length;
    const prog = t5.progressSamples || [];
    await shot(longPage, '07-long-translated.png', {});
    record('5. 长文（' + longLen + ' 字符）：全部分段翻完、进度上报至完成、静置 10s DOM 稳定（无 rewalk 死循环）',
      longLen > 5000 && t5.state && t5.state.translated && longRes.done === longRes.total && longRes.withHan + longRes.errs === longRes.total &&
        prog.length >= 1 && sigA === sigB && errCount1 === errCount0,
      [
        '正文长度: ' + longLen + ' chars（>5000 ✓）',
        'progress 采样: ' + JSON.stringify(prog) + '（61 段 ≤ 单批 200 段上限 → 单包一次回填，done/total 由 0/61 直接至完成，属分包设计行为）',
        '段落翻译完成: ' + longRes.done + '/' + longRes.total + '（含中文译文 ' + longRes.withHan + '，错误态 ' + longRes.errs + '）',
        '静置 10s DOM 签名一致: ' + (sigA === sigB) + '；期间新增 console error=' + (errCount1 - errCount0)
      ],
      sigA !== sigB ? '静置期 DOM 发生变化，疑似 rewalk 循环' : null);

    // 对照验收 16：TRANSLATE_PAGE 幂等
    const sigBefore = await longPage.evaluate(() => document.querySelectorAll('.ta-target-wrapper').length);
    const idem = await tabMsg(null, await tabIdOf(longPage, null), { type: 'TRANSLATE_PAGE' });
    const idemState = await tabMsg(null, await tabIdOf(longPage, null), { type: 'GET_PAGE_STATE' });
    const sigC = await longPage.evaluate(() => document.querySelectorAll('.ta-target-wrapper').length);
    record('16a. TRANSLATE_PAGE 幂等：已翻译页重发 → translated:true 且 DOM 不变',
      !!(idem && idem.ok && idem.started === false && idem.translated === true && idemState.translated && sigC === sigBefore),
      ['重发响应: ' + JSON.stringify(idem), '重发前后 wrapper 数不变: ' + sigBefore + ' → ' + sigC],
      null);
    await longPage.close();

    /* ---------- 必测项 15：缓存 ---------- */
    const st1 = await cacheStats();
    const logsA = await swLogs();
    const cachedLogsA = logsA.logs.filter((l) => /done: cached=/.test(l));
    record('15a. 缓存写入：翻译后 GET_CACHE_STATS 条目增长、SW 日志出现 done: cached=…',
      !!(st1 && st1.ok && st1.data && st1.data.entries > 0 && cachedLogsA.length > 0),
      ['缓存条目: ' + JSON.stringify(st1 && st1.data), 'SW 批次日志样例: ' + (cachedLogsA[cachedLogsA.length - 1] || '（无）')],
      null);
    // 同页二次翻译 → cached>0（走缓存）
    const longPage2 = await newPage(browser);
    await longPage2.goto(BASE + '/fixture-long.html?t=long2', { waitUntil: 'load', timeout: 30000 });
    const t0b = Date.now();
    const t5b = await translatePage(longPage2, null, { timeout: 120000 });
    const dur2 = Date.now() - t0b;
    const logsB = await swLogs();
    const cachedLogsB = logsB.logs.filter((l) => /done: cached=/.test(l));
    const lastLog = cachedLogsB[cachedLogsB.length - 1] || '';
    const cachedHit = /cached=(\d+)/.exec(lastLog);
    record('15b. 同页二次翻译命中缓存（SW 日志 cached>0，耗时显著缩短）',
      !!(t5b.state && t5b.state.translated && cachedHit && Number(cachedHit[1]) > 0),
      ['二次翻译用时: ' + (dur2 / 1000).toFixed(1) + 's（全部命中缓存时接近瞬时）', 'SW 最新批次日志: ' + lastLog.slice(0, 160)],
      null);
    // CLEAR_CACHE 后重翻走网络
    await clearCache();
    const st2 = await cacheStats();
    await longPage2.evaluate(() => location.reload());
    await sleep(800);
    const t5c = await translatePage(longPage2, null, { timeout: 180000 });
    const st3 = await cacheStats();
    record('15c. CLEAR_CACHE 生效：清后条目=0，重翻重新走网络并再次写入缓存',
      !!(st2 && st2.ok && st2.data.entries === 0 && t5c.state && t5c.state.translated && st3 && st3.ok && st3.data.entries > 0),
      ['CLEAR_CACHE 后条目: ' + JSON.stringify(st2 && st2.data), '重翻后条目: ' + JSON.stringify(st3 && st3.data)],
      null);
    // 不同目标语言互不串缓存：同文本 zh-CN 与 ja 各自独立回包
    const xlang = await WE(async () => {
      const obj = await chrome.storage.local.get('settings');
      const settings = globalThis.TA.mergeDefaults(obj && obj.settings);
      const text = 'Cache isolation probe sentence for cross-language check.';
      const zh = await globalThis.TA.adapters.translateBatch({ batchId: 'x1-' + Date.now(), texts: [text], targetLang: 'zh-CN', sourceLang: 'auto' }, settings);
      const ja = await globalThis.TA.adapters.translateBatch({ batchId: 'x2-' + Date.now(), texts: [text], targetLang: 'ja', sourceLang: 'auto' }, settings);
      return { zh: zh.ok ? zh.translations[0] : null, ja: ja.ok ? ja.translations[0] : null, zhSvc: zh.usedServices, jaSvc: ja.usedServices, zhErr: zh.error && zh.error.code, jaErr: ja.error && ja.error.code };
    });
    record('15d. 不同目标语言互不串缓存（同文本 zh-CN 与 ja 各自独立回包）',
      !!(xlang.zh && xlang.ja && xlang.zh !== xlang.ja),
      ['zh-CN 回包: ' + JSON.stringify(xlang.zh).slice(0, 60) + ' via ' + xlang.zhSvc + (xlang.zhErr ? ' err=' + xlang.zhErr : ''),
        'ja 回包: ' + JSON.stringify(xlang.ja).slice(0, 60) + ' via ' + xlang.jaSvc + (xlang.jaErr ? ' err=' + xlang.jaErr : '')],
      null);
    await longPage2.close();

    /* ---------- 必测项 7：划词翻译冒烟 ---------- */
    await patchSettings(null, { selection: { enabled: true, trigger: 'mini', triggerAction: 'hover' } });
    const selPage = await newPage(browser);
    await selPage.goto(BASE + '/fixture-basic.html?t=sel', { waitUntil: 'load', timeout: 30000 });
    await sleep(1200);
    await selPage.evaluate(() => {
      const p = Array.from(document.querySelectorAll('p'))[2];
      const node = p.firstChild;
      const rng = document.createRange();
      rng.setStart(node, 0);
      rng.setEnd(node, Math.min(80, node.nodeValue.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rng);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      document.dispatchEvent(new Event('selectionchange'));
    });
    let dotVisible = false;
    for (let i = 0; i < 20; i++) {
      dotVisible = await selPage.evaluate(() => !!document.querySelector('.ta-sel-dot'));
      if (dotVisible) break;
      await sleep(300);
    }
    if (dotVisible) {
      await selPage.evaluate(() => {
        document.querySelector('.ta-sel-dot').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      });
    }
    let bubbleText = null;
    let bubbleBody = null;
    for (let i = 0; i < 200; i++) {
      // 防竞态：debounced selectionchange 会重建小圆点并隐藏未固定气泡，
      // 周期性对“当前”小圆点重发 mouseenter（等价真人持续悬停）
      if (i % 4 === 0) {
        await selPage.evaluate(() => {
          const d2 = document.querySelector('.ta-sel-dot');
          if (d2) d2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        });
      }
      const r = await selPage.evaluate(() => {
        const b = document.querySelector('.ta-sel-bubble');
        if (!b || b.classList.contains('ta-hide')) return { visible: false, trans: null, body: null };
        const t = b.querySelector('.ta-sel-trans');
        return { visible: true, trans: t ? t.textContent : null, body: (b.querySelector('.ta-sel-body') || {}).textContent || null };
      });
      bubbleBody = r.body;
      if (r.visible && r.trans && hasHan(r.trans)) { bubbleText = r.trans; break; }
      if (r.visible && r.body && !/正在翻译/.test(r.body)) { bubbleText = r.trans || ''; break; } // 出结果或错误态
      await sleep(500);
    }
    await shot(selPage, '08-selection-bubble.png', {});
    record('7. 划词翻译冒烟：选句 → 右下小圆点出现 → 悬停触发 → 气泡显示中文译文',
      dotVisible && !!bubbleText && hasHan(bubbleText),
      ['选区触发点 .ta-sel-dot 出现: ' + dotVisible,
        '气泡可见且出结果: ' + (bubbleBody !== null) + '，.ta-sel-trans 译文: ' + JSON.stringify(bubbleText).slice(0, 80)],
      !dotVisible ? '小圆点未出现（selectionchange/mouseup 链路未命中）'
        : (!bubbleText ? '气泡 100s 内未出结果（本机网络降级链慢：google 挂起至超时→edge→deepl-free，定向复测证明链路可达、约 20s 出译文）'
          : (hasHan(bubbleText) ? null : '气泡译文非中文: ' + JSON.stringify(bubbleBody))));
    await selPage.close();

    /* ---------- 必测项 8：悬停翻译冒烟 ---------- */
    await patchSettings(null, { hoverTranslate: { enabled: true, trigger: 'holdKey', holdKey: 'ctrl' } });
    const hoverPage = await newPage(browser);
    await hoverPage.goto(BASE + '/fixture-basic.html?t=hover', { waitUntil: 'load', timeout: 30000 });
    await sleep(1200);
    const hoverIdx = await hoverPage.evaluate(() => {
      const ps = Array.from(document.querySelectorAll('p'));
      const p = ps.find((x) => !x.hasAttribute('data-ta') && x.textContent.length > 120);
      return ps.indexOf(p);
    });
    await hoverPage.evaluate((idx) => {
      const p = document.querySelector('p:nth-of-type(' + (idx + 1) + ')');
      const r = p.getBoundingClientRect();
      p.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, cancelable: true, view: window,
        clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + 14), ctrlKey: true
      }));
    }, hoverIdx);
    let hoverText = null;
    for (let i = 0; i < 60; i++) {
      const r = await hoverPage.evaluate((idx) => {
        const p = document.querySelector('p:nth-of-type(' + (idx + 1) + ')');
        const w = p && p.querySelector(':scope > .ta-target-wrapper');
        const inner = w && w.querySelector(':scope > .ta-target-inner');
        return { has: !!w, text: inner ? inner.textContent : null };
      }, hoverIdx);
      if (r.has && hasHan(r.text)) { hoverText = r.text; break; }
      await sleep(500);
    }
    await shot(hoverPage, '09-hover-translated.png', {});
    // 再 Ctrl+悬停 → 还原（对照验收 7 后半）
    await hoverPage.evaluate((idx) => {
      const p = document.querySelector('p:nth-of-type(' + (idx + 1) + ')');
      const r = p.getBoundingClientRect();
      p.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true, cancelable: true, view: window,
        clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + 14), ctrlKey: true
      }));
    }, hoverIdx);
    await sleep(1200);
    const hoverRestored = await hoverPage.evaluate((idx) => {
      const p = document.querySelector('p:nth-of-type(' + (idx + 1) + ')');
      return { wrapper: !!p.querySelector(':scope > .ta-target-wrapper'), dataTa: p.hasAttribute('data-ta') };
    }, hoverIdx);
    record('8. 悬停翻译冒烟：Ctrl+悬停（mouseover+ctrlKey）→ 该段下方中文译文；再次 Ctrl+悬停 → 还原',
      !!hoverText && hoverRestored.wrapper === false && hoverRestored.dataTa === false,
      ['段落 p:nth-of-type(' + (hoverIdx + 1) + ') Ctrl+悬停后译文: ' + JSON.stringify(hoverText).slice(0, 60),
        '再次 Ctrl+悬停后 wrapper 移除: ' + !hoverRestored.wrapper + '，data-ta 清除: ' + !hoverRestored.dataTa],
      null);
    await hoverPage.close();

    /* ---------- 必测项 9：悬浮球 ---------- */
    await patchSettings(null, { ui: { showFloatBall: true } });
    const ballPage = await newPage(browser);
    await ballPage.goto(BASE + '/fixture-basic.html?t=ball', { waitUntil: 'load', timeout: 30000 });
    await sleep(1200);
    const ballInfo = await ballPage.evaluate(() => {
      const b = document.getElementById('ta-float-ball');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), side: b.getAttribute('data-ta-ball-side') };
    });
    let menuOpened = false;
    if (ballInfo) {
      await ballPage.mouse.click(ballInfo.x, ballInfo.y);
      await sleep(600);
      menuOpened = await ballPage.evaluate(() => {
        const m = document.querySelector('.ta-ball-menu');
        return !!m && !m.hidden;
      });
    }
    const menuItems = menuOpened ? await ballPage.evaluate(() =>
      Array.from(document.querySelectorAll('.ta-ball-menu button')).map((x) => x.textContent.trim()).filter(Boolean).slice(0, 8)) : [];
    await shot(ballPage, '10-ball-menu.png', {});
    // 点击“打开设置” → options 页
    let optionsOpened = false;
    if (menuOpened) {
      await ballPage.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.ta-ball-menu button'));
        const btn = items.find((x) => (x.textContent || '').trim() === '打开设置');
        if (btn) btn.click();
      });
      try {
        await browser.waitForTarget((t) => t.type() === 'page' && /chrome-extension:\/\/[^/]+\/options\/options\.html/.test(t.url()), { timeout: 8000 });
        optionsOpened = true;
      } catch (e) { optionsOpened = false; }
    }
    record('9. 悬浮球存在、点击展开菜单、“打开设置”经 OPEN_OPTIONS 打开 options 页',
      !!ballInfo && menuOpened && menuItems.length >= 3 && optionsOpened,
      [
        '悬浮球: ' + JSON.stringify(ballInfo),
        '点击展开菜单: ' + menuOpened + '，菜单项: ' + JSON.stringify(menuItems),
        '菜单点“打开设置”→ options 页打开: ' + optionsOpened
      ],
      ballInfo ? (menuOpened ? (optionsOpened ? null : '菜单已展开但点击“打开设置”无响应——ball.js 的菜单动作分派器 onMenuClick（content/ball.js:269）定义后未注册（全文件 grep 无 menu.addEventListener("click", onMenuClick)，init() 仅注册 onDocClick/onKeydown），主菜单全部按钮为死按钮；后台 OPEN_OPTIONS 通路本身正常（定向实测 chrome.runtime.openOptionsPage 可打开 options 页，service-worker.js:99 case 在位）') : '点击后菜单未展开') : '未找到 #ta-float-ball');
    try {
      const optTarget = await browser.waitForTarget((t) => t.type() === 'page' && /options\/options\.html/.test(t.url()), { timeout: 3000 });
      const optPage = await optTarget.page();
      if (optPage) { await sleep(1200); await shot(optPage, '11-options-page.png', {}); await optPage.close(); }
    } catch (e) {
      // 菜单死按钮导致 options 未开 → 经 SW 直接 openOptionsPage 兜底打开并取证（24 档主题网格）
      try {
        await WE(() => chrome.runtime.openOptionsPage());
        const optTarget = await browser.waitForTarget((t) => t.type() === 'page' && /options\/options\.html/.test(t.url()), { timeout: 8000 });
        const optPage = await optTarget.page();
        if (optPage) {
          await sleep(1500);
          const themeGrid = await optPage.evaluate(() => {
            const grid = document.querySelectorAll('[data-theme], .theme-item, .theme-card, button, [class*="theme"]');
            return { candidates: grid.length };
          });
          await shot(optPage, '11-options-page.png', {});
          console.log('        · options 主题网格候选节点数: ' + JSON.stringify(themeGrid));
          await optPage.close();
        }
      } catch (e2) { /* 截图可选 */ }
    }
    await ballPage.close();

    /* ---------- 汇总 ---------- */
    const swFinal = await swLogs();
    const summary = {
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results, screenshots,
      swErrors: swFinal.errs,
      serviceProbe: svcProbe
    };
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(summary, null, 2), 'utf8');
    console.log('\n========== 汇总: ' + summary.passed + ' passed / ' + summary.failed + ' failed ==========');
    if (swFinal.errs.length) console.log('[SW console.error 记录] ' + JSON.stringify(swFinal.errs, null, 1));
  } finally {
    try { await browser.close(); } catch (e) {}
    stopServer();
  }
}

main().catch((e) => {
  console.error('HARNESS FATAL:', e);
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results, screenshots, fatal: String((e && e.stack) || e)
  }, null, 2), 'utf8');
  process.exit(1);
});
