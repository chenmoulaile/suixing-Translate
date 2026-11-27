// run-optimization-tests.js —— 五项优化端到端验收测试（新文件，不改 run-tests.js / run-feature-tests.js）
// 运行：node tests/run-optimization-tests.js
// 复用 tests/run-tests.js / run-feature-tests.js 的基础设施：fixture server(随机端口) + puppeteer + 扩展 + SW evaluate。
// 翻译全程离线：文档页用桩 sendMessage，侧边栏用预置译文缓存，不触网。
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');

const EXT = path.resolve(__dirname, '..');
const CHROME = path.resolve(__dirname, 'chromium', 'chrome', 'chrome.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, passed, evidence) {
  results.push({ name, passed: !!passed, evidence: evidence || [] });
  console.log((passed ? '✅ PASS' : '❌ FAIL') + '  ' + name);
  (evidence || []).forEach((e) => console.log('        · ' + e));
}

let serverProc = null;
let BASE = 'http://127.0.0.1:0';
async function startServer() {
  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js'), '0'], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('fixture server start timeout')), 8000);
    serverProc.stdout.on('data', (d) => {
      const m = String(d).match(/listening at http:\/\/([\d.]+):(\d+)/);
      if (m) { BASE = 'http://' + m[1] + ':' + m[2]; clearTimeout(t); res(); }
    });
    serverProc.on('exit', (c) => { clearTimeout(t); rej(new Error('server exit ' + c)); });
  });
}
function stopServer() { if (serverProc) try { serverProc.kill(); } catch (e) {} }

let browserRef = null;
let W = null;
async function getWorker() {
  const t = await browserRef.waitForTarget(
    (x) => x.type() === 'service_worker' && /background\/service-worker\.js$/.test(x.url()), { timeout: 20000 });
  return t.worker();
}
async function WE(fn, ...a) {
  if (!W) W = await getWorker();
  try { return await W.evaluate(fn, ...a); }
  catch (e) { W = await getWorker(); return W.evaluate(fn, ...a); }
}
async function tabIdOf() {
  return WE(() => chrome.tabs.query({ active: true, currentWindow: true })
    .then((ts) => (ts.length === 1 ? ts[0].id : null)).catch(() => null));
}
async function tabMsg(msg) {
  const id = await tabIdOf();
  return WE(async (tid, m) => {
    try { return await chrome.tabs.sendMessage(tid, m); }
    catch (e) { return { ok: false, __sendErr: String((e && e.message) || e) }; }
  }, id, msg);
}

async function main() {
  await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT,
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1320,1000']
  });
  browserRef = browser;
  try {
    for (const p of await browser.pages()) await p.close().catch(() => {});
    const extId = await WE(() => chrome.runtime.id);

    // 文档页：用例 1 / 3 / 5 / 6 共用（扩展页主世界可直接访问 TA.markdown）
    const docPage = await browser.newPage();
    await docPage.goto('chrome-extension://' + extId + '/doc/doc.html', { waitUntil: 'load', timeout: 30000 });
    await sleep(500);

    /* 1. TA.markdown.render 可用，行内/块级公式 -> .katex 节点 */
    let md = null;
    try {
      md = await docPage.evaluate(() => {
        const api = globalThis.TA && globalThis.TA.markdown;
        if (!api || typeof api.render !== 'function') return { ok: false, err: 'TA.markdown.render 不存在' };
        const host = document.createElement('div');
        host.className = 'ta-md-probe';
        host.innerHTML = api.render('行内公式 $E=mc^2$。\n\n块级公式：\n\n$$a^2+b^2=c^2$$');
        document.body.appendChild(host);
        const katex = host.querySelectorAll('.katex');
        return {
          ok: true,
          available: typeof api.isAvailable === 'function' ? api.isAvailable() : true,
          htmlLen: host.innerHTML.length,
          katex: katex.length,
          display: host.querySelectorAll('.katex-display').length,
          mathml: host.querySelectorAll('.katex-mathml').length,
          sample: (katex[0] ? katex[0].textContent : '').slice(0, 36)
        };
      });
    } catch (e) { md = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('1. TA.markdown.render 可用，行内/块级公式渲染为 .katex 节点',
      !!(md && md.ok && md.available !== false && md.katex >= 2 && md.display >= 1 && md.mathml >= 2),
      [JSON.stringify(md)]);

    /* 2. 术语预设含 oi，buildTermsSection(enableTerms+oi) 含竞赛术语 */
    let terms = null;
    try {
      terms = await WE(() => {
        const T = globalThis.TA && globalThis.TA.terminology;
        if (!T) return { ok: false, err: 'TA.terminology 缺失' };
        const presets = typeof T.getPresetNames === 'function' ? T.getPresetNames() : [];
        const oi = T.PRESETS && T.PRESETS.oi;
        const on = T.buildTermsSection({ ai: { enableTerms: true, termsPreset: 'oi', customTerms: '' } });
        const off = T.buildTermsSection({ ai: { enableTerms: false, termsPreset: 'oi', customTerms: '' } });
        return {
          ok: true,
          hasOi: presets.indexOf('oi') >= 0,
          presetKeys: oi ? Object.keys(oi).length : 0,
          sectionLen: on.length,
          hasSegmentTree: /线段树/.test(on),
          hasDP: /动态规划/.test(on),
          hasContestRules: /Competitive-programming rules/i.test(on),
          offEmpty: off === ''
        };
      });
    } catch (e) { terms = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('2. 术语预设含 oi，buildTermsSection(enableTerms+oi) 非空且含竞赛术语',
      !!(terms && terms.ok && terms.hasOi && terms.presetKeys > 20 && terms.sectionLen > 0 &&
         terms.hasSegmentTree && terms.hasDP && terms.hasContestRules && terms.offEmpty),
      [JSON.stringify(terms)]);

    /* 3. doc/doc.html 分页对照 / 仅译文控件 + 切换后 DOM 状态（PDF 真实渲染，翻译用桩离线） */
    let docCase = { ok: false };
    try {
      // 桩掉文档页的 TRANSLATE_BATCH：不触网，仅回显非空的"译文"，让 PDF 解析/渲染走真实路径
      const stub = await docPage.evaluate(() => {
        const rt = globalThis.chrome && chrome.runtime;
        if (!rt || typeof rt.sendMessage !== 'function') return { ok: false, err: 'chrome.runtime.sendMessage 缺失' };
        const orig = rt.sendMessage.bind(rt);
        const fake = function (msg, cb) {
          if (msg && msg.type === 'TRANSLATE_BATCH') {
            const res = {
              requestId: msg.requestId, ok: true,
              translations: (msg.texts || []).map((t, i) => '离线译文' + (i + 1) + '：' + String(t).slice(0, 26)),
              usedServices: ['test-stub'], cached: 0
            };
            if (typeof cb === 'function') { cb(res); return undefined; }
            return Promise.resolve(res);
          }
          return orig(msg, cb);
        };
        try { rt.sendMessage = fake; } catch (e) {
          try { Object.defineProperty(rt, 'sendMessage', { value: fake, configurable: true, writable: true }); } catch (e2) {}
        }
        return { ok: true, replaced: rt.sendMessage === fake };
      });
      if (!stub.ok || !stub.replaced) {
        docCase = { ok: false, err: 'sendMessage 桩安装失败', stub };
      } else {
        const input = await docPage.$('#fileInput');
        if (!input) docCase = { ok: false, err: '#fileInput 缺失' };
        else {
          await input.uploadFile(path.join(__dirname, 'fixtures', 'fixture-text.pdf'));
          let rendered = null;
          for (let i = 0; i < 50; i++) {
            rendered = await docPage.evaluate(() => {
              const r = document.getElementById('results');
              return {
                shown: !!r && !r.hidden,
                style: r ? r.getAttribute('data-style') : null,
                pages: document.querySelectorAll('.pdf-pages .pdf-page').length,
                src: document.querySelectorAll('.pdf-source').length,
                tgt: document.querySelectorAll('.pdf-target').length
              };
            });
            if (rendered.shown && rendered.pages > 0) break;
            await sleep(300);
          }
          const controls = await docPage.evaluate(() => {
            const pc = document.querySelector('.style-toggle .seg[data-style="page-compare"]');
            const tp = document.querySelector('.style-toggle .seg[data-style="translation-page"]');
            return { pc: !!pc, tp: !!tp, pcHidden: pc ? !!pc.hidden : null, tpHidden: tp ? !!tp.hidden : null };
          });
          await docPage.click('.style-toggle .seg[data-style="translation-page"]');
          await sleep(150);
          const afterTp = await docPage.evaluate(() => {
            const r = document.getElementById('results');
            const pc = document.querySelector('.style-toggle .seg[data-style="page-compare"]');
            const tp = document.querySelector('.style-toggle .seg[data-style="translation-page"]');
            const src = document.querySelector('.pdf-page-pair .pdf-source');
            return {
              style: r ? r.getAttribute('data-style') : null,
              tpActive: !!(tp && tp.classList.contains('active')),
              pcActive: !!(pc && pc.classList.contains('active')),
              pages: document.querySelectorAll('.pdf-pages .pdf-page').length,
              srcDisplay: src ? getComputedStyle(src).display : null
            };
          });
          await docPage.click('.style-toggle .seg[data-style="page-compare"]');
          await sleep(150);
          const afterPc = await docPage.evaluate(() => {
            const r = document.getElementById('results');
            const src = document.querySelector('.pdf-page-pair .pdf-source');
            return {
              style: r ? r.getAttribute('data-style') : null,
              srcDisplay: src ? getComputedStyle(src).display : null
            };
          });
          docCase = {
            ok: true, stub, rendered, controls, afterTp, afterPc,
            pass: !!(rendered && rendered.shown && rendered.style === 'page-compare' && rendered.pages > 0 &&
              rendered.src > 0 && rendered.tgt === rendered.src &&
              controls.pc && controls.tp && !controls.pcHidden && !controls.tpHidden &&
              afterTp.style === 'translation-page' && afterTp.tpActive && !afterTp.pcActive &&
              afterTp.pages > 0 && afterTp.srcDisplay === 'none' &&
              afterPc.style === 'page-compare' && afterPc.srcDisplay !== 'none')
          };
        }
      }
    } catch (e) { docCase = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('3. doc.html 分页对照/仅译文控件存在且切换后 DOM 状态正确',
      !!(docCase && docCase.pass), [JSON.stringify(docCase)]);

    /* 5. 新主题 ID 出现在 TA.THEMES 且长度 > 24（SW 与文档页双上下文一致） */
    let themeState = { ok: false };
    try {
      const swThemes = await WE(() => ({
        list: (globalThis.TA && Array.isArray(TA.THEMES)) ? TA.THEMES.slice() : [],
        names: (globalThis.TA && TA.THEME_NAMES) ? TA.THEME_NAMES : {}
      }));
      const docThemes = await docPage.evaluate(() => ({
        list: (globalThis.TA && Array.isArray(TA.THEMES)) ? TA.THEMES.slice() : [],
        names: (globalThis.TA && TA.THEME_NAMES) ? TA.THEME_NAMES : {}
      }));
      const ids = ['doubleUnderline', 'pill'];
      themeState = {
        ok: true, swLen: swThemes.list.length, docLen: docThemes.list.length,
        swHas: ids.filter((x) => swThemes.list.indexOf(x) >= 0),
        docHas: ids.filter((x) => docThemes.list.indexOf(x) >= 0),
        swNamed: ids.filter((x) => !!swThemes.names[x]),
        docNamed: ids.filter((x) => !!docThemes.names[x])
      };
      themeState.pass = themeState.swLen > 24 && themeState.docLen > 24 &&
        themeState.swHas.length === 2 && themeState.docHas.length === 2 &&
        themeState.swNamed.length === 2 && themeState.docNamed.length === 2;
    } catch (e) { themeState = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('5. 新主题 ID 出现在 TA.THEMES 且长度 > 24', !!(themeState && themeState.pass),
      [JSON.stringify(themeState)]);

    /* 6. 划词/侧栏结果容器渲染 Markdown 为 HTML（evaluate 直接调 TA.markdown 注入真实选择器） */
    let containers = { ok: false };
    try {
      containers = await docPage.evaluate(() => {
        const api = globalThis.TA && globalThis.TA.markdown;
        if (!api || typeof api.renderInto !== 'function') return { ok: false, err: 'TA.markdown.renderInto 缺失' };
        const bubble = document.createElement('div');
        bubble.className = 'ta-sel-bubble';
        const selTrans = document.createElement('div');
        selTrans.className = 'ta-sel-trans';
        bubble.appendChild(selTrans);
        const panel = document.createElement('div');
        panel.className = 'ta-side-panel';
        const sideResult = document.createElement('div');
        sideResult.className = 'ta-side-result';
        const sideTrans = document.createElement('div');
        sideTrans.className = 'ta-side-res-trans';
        sideResult.appendChild(sideTrans);
        panel.appendChild(sideResult);
        document.body.appendChild(bubble);
        document.body.appendChild(panel);
        const src = '**译文标题** 行内 $x^2$。\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$';
        api.renderInto(selTrans, src);
        api.renderInto(sideTrans, src);
        const probe = (root) => ({
          katex: root.querySelectorAll('.katex').length,
          display: root.querySelectorAll('.katex-display').length,
          strong: root.querySelectorAll('strong').length,
          sample: root.innerHTML.slice(0, 80)
        });
        return {
          ok: true,
          sel: probe(selTrans),
          side: probe(document.querySelector('.ta-side-panel .ta-side-result .ta-side-res-trans'))
        };
      });
      containers.pass = !!(containers.ok && containers.sel && containers.side &&
        containers.sel.katex >= 2 && containers.sel.display >= 1 && containers.sel.strong >= 1 &&
        containers.side.katex >= 2 && containers.side.display >= 1 && containers.side.strong >= 1);
    } catch (e) { containers = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('6. 划词/侧栏结果容器渲染 Markdown 为 HTML 元素',
      !!(containers && containers.pass), [JSON.stringify(containers)]);

    // 内容页：用例 4 / 7
    const page = await browser.newPage();
    await page.goto(BASE + '/fixture-basic.html?opt=' + Date.now(), { waitUntil: 'load', timeout: 30000 });
    let ballReady = false;
    for (let i = 0; i < 30; i++) {
      try { ballReady = await page.evaluate(() => !!document.querySelector('#ta-float-ball')); } catch (e) {}
      if (ballReady) break;
      await sleep(300);
    }

    /* 4. 悬浮球 hover 主题项 -> 旁弹子菜单 + 主菜单仍可见（dispatch 事件，不依赖真实 hover 时序） */
    let hoverState = { ok: false, ballReady };
    try {
      if (!ballReady) hoverState.err = '#ta-float-ball 未挂载';
      else {
        await page.evaluate(() => {
          const ball = document.querySelector('#ta-float-ball');
          ball.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        });
        await sleep(500); // 默认 ballHoverDelay=200ms + 余量
        const triggered = await page.evaluate(() => {
          const menu = document.querySelector('.ta-ball-menu');
          const btn = menu && menu.querySelector('button[data-act="themes"]');
          if (!btn) return { ok: false, err: '主题菜单项缺失' };
          btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
          return { ok: true };
        });
        if (!triggered.ok) hoverState.err = triggered.err;
        else {
          await sleep(400); // 子面板 hover 延时 120ms + 余量
          const s = await page.evaluate(() => {
            const ball = document.querySelector('#ta-float-ball');
            const menu = document.querySelector('.ta-ball-menu');
            const sub = document.querySelector('.ta-ball-submenu');
            const themeBtn = menu && menu.querySelector('button[data-act="themes"]');
            return {
              menuExists: !!menu,
              menuHidden: menu ? !!menu.hidden : true,
              menuShown: !!(menu && menu.classList.contains('ta-menu-show')),
              subExists: !!sub,
              subHidden: sub ? !!sub.hidden : true,
              subShown: !!(sub && sub.classList.contains('ta-sub-show')),
              themeButtons: sub ? sub.querySelectorAll('.ta-ball-theme-btn').length : 0,
              expanded: !!(themeBtn && themeBtn.getAttribute('aria-expanded') === 'true'),
              subIsBallChild: !!(sub && ball && sub.parentElement === ball)
            };
          });
          hoverState = { ok: true, ballReady, ...s };
          hoverState.pass = !!(s.menuExists && !s.menuHidden && s.menuShown &&
            s.subExists && !s.subHidden && s.subShown && s.themeButtons > 24 && s.expanded && s.subIsBallChild);
        }
      }
    } catch (e) { hoverState = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('4. 悬浮球 hover 主题项出现旁弹子菜单且主菜单仍可见',
      !!(hoverState && hoverState.pass), [JSON.stringify(hoverState)]);

    /* 7. 侧边栏真实翻译结果容器渲染为 HTML（预置离线缓存 -> 真实点击翻译 -> .katex 节点） */
    let sideState = { ok: false };
    try {
      const TEXT = 'Render formula $E=mc^2$ now';
      const VAL = '**质能方程** 已渲染：$E=mc^2$ 以及 $a^2+b^2=c^2$。';
      const seed = await WE(async (text, val) => {
        if (!globalThis.TA || !TA.cache || typeof TA.cache.keyFor !== 'function') {
          return { ok: false, err: 'TA.cache.keyFor 缺失' };
        }
        const key = await TA.cache.keyFor('deepl-free', 'zh-CN', text);
        await chrome.storage.local.set({ [key]: { v: val, at: Date.now() } });
        const got = await chrome.storage.local.get([key]);
        return { ok: true, key, written: !!(got && got[key] && got[key].v === val) };
      }, TEXT, VAL);

      let opened = null;
      if (seed.ok && seed.written) {
        opened = await tabMsg({ type: 'BALL_OPEN_SIDEBAR' });
        await sleep(400);
        await page.evaluate((text) => {
          const input = document.querySelector('.ta-side-input');
          const dst = document.querySelector('.ta-side-dst');
          if (dst) dst.value = 'zh-CN';
          if (!input) return;
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, TEXT);
        await page.click('.ta-side-translate');
      }
      let probe = null;
      for (let i = 0; i < 40; i++) {
        probe = await page.evaluate(() => {
          const panel = document.querySelector('.ta-side-panel');
          const trans = panel && panel.querySelector('.ta-side-result .ta-side-res-trans');
          const err = panel && panel.querySelector('.ta-side-error');
          return {
            panel: !!panel,
            transExists: !!trans,
            katex: trans ? trans.querySelectorAll('.katex').length : 0,
            display: trans ? trans.querySelectorAll('.katex-display').length : 0,
            strong: trans ? trans.querySelectorAll('strong').length : 0,
            html: trans ? trans.innerHTML.slice(0, 140) : '',
            err: err ? err.textContent.slice(0, 140) : ''
          };
        });
        if ((probe.katex >= 2 && probe.strong >= 1) || probe.err) break;
        await sleep(500);
      }
      sideState = {
        ok: true, seed, opened: opened ? { ok: opened.ok } : null, probe,
        pass: !!(seed.ok && seed.written && opened && !!(opened.ok !== false) &&
          probe && probe.panel && probe.transExists && probe.katex >= 2 && probe.strong >= 1 && !probe.err)
      };
    } catch (e) { sideState = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('7. 侧边栏 openSidebar 真实译文结果容器渲染为 HTML（.katex/元素节点）',
      !!(sideState && sideState.pass), [JSON.stringify(sideState)]);

    /* 8. 复核回归：设置页真实下拉含 oi（options.html 必须加载 terminology.js） */
    let presetState = { ok: false };
    try {
      const optPage = await browser.newPage();
      await optPage.goto('chrome-extension://' + extId + '/options/options.html', { waitUntil: 'load', timeout: 30000 });
      await sleep(500);
      presetState = await optPage.evaluate(() => {
        const sel = document.querySelector('#aiTermsPreset');
        const opts = sel ? Array.from(sel.options).map((o) => o.value) : [];
        return { ok: !!sel, hasOi: opts.indexOf('oi') >= 0, opts };
      });
      presetState.pass = !!(presetState.ok && presetState.hasOi);
      await optPage.close().catch(() => {});
    } catch (e) { presetState = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('8. 设置页术语下拉真实包含 oi 预设', !!(presetState && presetState.pass), [JSON.stringify(presetState)]);

    /* 9. 复核回归：PDF 原文层/导出原文保留 TeX，不显示 ⟪mN⟫ 占位 */
    let sourceFormulaState = { ok: false };
    try {
      sourceFormulaState = await docPage.evaluate(() => {
        const F = globalThis.TA.pdfFormula;
        const D = globalThis.TA.doc;
        if (!F || !D || !D.buildPdfPagePair) return { ok: false, err: '缺少 pdfFormula/doc 接口' };
        const src = '设 $E=mc^2$ 为质能方程';
        const m = F.maskFormulas(src);
        const page = { pageNo: 1, width: 612, height: 792, blocks: [0] };
        const meta = { pageNo: 1, x: 10, y: 10, width: 200, height: 20 };
        const node = D.buildPdfPagePair(page, {
          segments: [m.masked],
          sourceSegments: [src],
          translations: [m.masked],
          segMeta: [meta]
        });
        const orig = node.querySelector('.pdf-source .pdf-block');
        const origText = orig ? (orig.textContent || '') : '';
        const formulaNodes = orig ? orig.querySelectorAll('[data-formula]').length : 0;
        return {
          ok: true,
          masked: m.masked, origText, formulaNodes,
          noTokenInSource: origText.indexOf('⟪m') < 0,
          hasFormulaAttr: formulaNodes > 0
        };
      });
      sourceFormulaState.pass = !!(sourceFormulaState.ok && sourceFormulaState.noTokenInSource &&
        sourceFormulaState.hasFormulaAttr);
    } catch (e) { sourceFormulaState = { ok: false, err: 'EXCEPTION=' + String((e && e.message) || e) }; }
    record('9. PDF 原文层与导出保留公式（无 ⟪mN⟫ 占位）', !!(sourceFormulaState && sourceFormulaState.pass),
      [JSON.stringify(sourceFormulaState)]);

    await page.close().catch(() => {});
    await docPage.close().catch(() => {});

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    console.log('\n========== 五项优化端到端验收: ' + passed + ' passed / ' + failed + ' failed ==========');
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { await browser.close(); } catch (e) {}
    stopServer();
  }
}
main().catch((e) => { console.error('OPTIMIZATION HARNESS FATAL:', e); stopServer(); process.exit(1); });
