// run-feature-tests.js —— v1 新功能冒烟测试（AI 服务 / 术语库 / 字幕 / 词典 / 图片 / 文档页 / 并排布局）
// 运行：node tests/run-feature-tests.js  （复用 tests/chromium 内的 Chromium 与扩展目录）
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
  results.push({ name, passed, evidence: evidence || [] });
  console.log((passed ? '✅ PASS' : '❌ FAIL') + '  ' + name);
  (evidence || []).forEach((e) => console.log('        · ' + e));
}
let serverProc = null, BASE = 'http://127.0.0.1:0';
async function startServer() {
  serverProc = spawn(process.execPath, [path.join(__dirname, 'server.js'), '0'], { stdio: 'pipe' });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server start timeout')), 8000);
    serverProc.stdout.on('data', (d) => {
      const m = String(d).match(/listening at http:\/\/([\d.]+):(\d+)/);
      if (m) { BASE = 'http://' + m[1] + ':' + m[2]; clearTimeout(t); res(); }
    });
    serverProc.on('exit', (c) => { clearTimeout(t); rej(new Error('server exit ' + c)); });
  });
}
function stopServer() { if (serverProc) try { serverProc.kill(); } catch (e) {} }

let W = null, browserRef = null;
async function getWorker() {
  const t = await browserRef.waitForTarget((x) => x.type() === 'service_worker' && /background\/service-worker\.js$/.test(x.url()), { timeout: 20000 });
  return t.worker();
}
async function WE(fn, ...a) {
  if (!W) W = await getWorker();
  try { return await W.evaluate(fn, ...a); }
  catch (e) { W = await getWorker(); return W.evaluate(fn, ...a); }
}
async function tabIdOf(page) {
  return WE(() => chrome.tabs.query({ active: true, currentWindow: true }).then((ts) => (ts.length === 1 ? ts[0].id : null)).catch(() => null));
}
async function tabMsg(page, msg) {
  const id = await tabIdOf(page);
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

    /* 1. 后台：12 适配器 / 术语库 / 新默认键 */
    const bg = await WE(() => {
      const TA = globalThis.TA;
      const ids = TA && TA.adapters && TA.adapters.ids ? TA.adapters.ids() : [];
      const defaults = TA && TA.mergeDefaults ? TA.mergeDefaults(null) : {};
      let terms = '', presets = [];
      try {
        presets = TA.terminology.getPresetNames();
        terms = TA.terminology.buildTermsSection({ ai: { enableTerms: true, termsPreset: 'legal', customTerms: '' } });
      } catch (e) { terms = 'ERR:' + e.message; }
      return {
        ids,
        hasNewServices: ['claude', 'gemini', 'deepseek', 'ollama'].every((x) => ids.indexOf(x) !== -1),
        defaultsKeys: ['ai', 'subtitle', 'dictionary', 'imageTranslate'].filter((k) => defaults[k] !== undefined),
        layout: defaults.targetStyle && defaults.targetStyle.layout,
        serviceKeys: ['claude', 'gemini', 'deepseek', 'ollama'].filter((x) => defaults.services && defaults.services[x]),
        presets, hasTerms: /保证金|margin/i.test(terms)
      };
    });
    record('1. 后台 12 适配器 + 术语库 + 新默认键就绪',
      bg.ids.length === 12 && bg.hasNewServices && bg.defaultsKeys.length === 4 &&
      bg.layout === 'block' && bg.serviceKeys.length === 4 && bg.presets.length >= 8 && bg.hasTerms,
      [JSON.stringify(bg)]);

    /* 2/3. 内容脚本：新 feature 消息可达（内容脚本运行在隔离世界，page.evaluate 不可见 TA，故用消息通路） */
    const page = await browser.newPage();
    let pageFeatures = null;
    await page.goto(BASE + '/fixture-basic.html?t=features', { waitUntil: 'load', timeout: 30000 });
    for (let i = 0; i < 24; i++) {
      pageFeatures = await tabMsg(page, { type: 'GET_FEATURES' });
      if (pageFeatures && pageFeatures.ok) break;
      await sleep(400);
    }
    const subStatus = await tabMsg(page, { type: 'SUBTITLE_STATUS' });
    const dict = await tabMsg(page, { type: 'DICTIONARY_LOOKUP', text: 'hello' });
    const dictReachable = !!(dict && typeof dict.ok === 'boolean' && 'card' in dict);
    record('2. 内容脚本新 feature 消息可达（SUBTITLE_STATUS / DICTIONARY_LOOKUP）',
      !!(pageFeatures && pageFeatures.ok) && !!(subStatus && subStatus.ok) && dictReachable,
      ['GET_FEATURES ok=' + !!(pageFeatures && pageFeatures.ok),
       'SUBTITLE=' + JSON.stringify(subStatus),
       'DICTIONARY(可达但无 AI key 时 card=null 属预期)=' + JSON.stringify(dict)]);

    record('3. SUBTITLE_STATUS 返回完整状态字段',
      !!(subStatus && subStatus.ok && typeof subStatus.enabled === 'boolean' && typeof subStatus.hasTracks === 'boolean'),
      [JSON.stringify(subStatus)]);

    /* 4. 文档翻译页可打开 + pdf.js 加载（从 SW 直接 chrome.tabs.create：runtime 消息不送达 SW 自身） */
    await WE(() => chrome.tabs.create({ url: chrome.runtime.getURL('doc/doc.html') }));
    let docPage = null;
    try {
      const t = await browser.waitForTarget((x) => x.type() === 'page' && /doc\/doc\.html/.test(x.url()), { timeout: 8000 });
      docPage = await t.page();
      await sleep(1200);
    } catch (e) { docPage = null; }
    let docState = null;
    if (docPage) {
      docState = await docPage.evaluate(() => ({
        pdfjs: typeof globalThis.pdfjsLib === 'object' && !!globalThis.pdfjsLib.getDocument,
        docApi: !!(globalThis.TA && globalThis.TA.doc),
        hasDrop: !!document.querySelector('#dropzone, .dropzone, [id*=drop], [class*=drop]'),
        hasFile: !!document.querySelector('input[type=file]'),
        langOptions: document.querySelectorAll('select option').length
      }));
      await docPage.close();
    }
    record('4. 文档翻译页打开 + pdf.js 就绪 + UI 存在',
      !!docPage && docState && docState.pdfjs && docState.docApi && docState.hasFile && docState.langOptions >= 5,
      [JSON.stringify(docState)]);

    /* 5. 缓存写入在响应前 flush（15c 根因回归） */
    const cacheFlush = await WE(async () => {
      const TA = globalThis.TA;
      try { await TA.cache.clearAll(); } catch (e) { return { err: 'clear:' + e.message }; }
      const settings = TA.mergeDefaults(null);
      settings.primaryService = 'deepl-free';
      settings.serviceChain = ['deepl-free'];
      const text = 'Cache flush regression probe sentence for feature tests.';
      const r = await TA.adapters.translateBatch({ batchId: 'flushtest-' + Date.now(), texts: [text], targetLang: 'zh-CN' }, settings);
      const st = await TA.cache.stats();
      return { ok: r.ok, entries: st.entries, used: r.usedServices, error: r.error && r.error.code };
    });
    record('5. 翻译返回后缓存已落盘（响应前 flush 修复）',
      !!(cacheFlush.ok && cacheFlush.entries > 0),
      [JSON.stringify(cacheFlush)]);

    /* 6. 设置页新分区 + 新服务卡片渲染，无脚本异常 */
    const optTarget = await browser.waitForTarget((t) => t.type() === 'page' && /options\/options\.html/.test(t.url()), { timeout: 6000 }).catch(() => null);
    let optPage = optTarget ? await optTarget.page() : null;
    if (!optPage) { await WE(() => chrome.runtime.openOptionsPage()); 
      const t2 = await browser.waitForTarget((t) => t.type() === 'page' && /options\/options\.html/.test(t.url()), { timeout: 8000 }); optPage = await t2.page(); }
    const optErrors = [];
    optPage.on('pageerror', (e) => optErrors.push(e.message));
    await optPage.reload({ waitUntil: 'load', timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const optState = await optPage.evaluate(() => ({
      aiSection: !!document.querySelector('#sec-ai'),
      newServices: ['claude', 'gemini', 'deepseek', 'ollama'].filter((id) => document.body.textContent.toLowerCase().indexOf(id) !== -1).length,
      layoutSelect: !!document.querySelector('#layoutSelect'),
      docBtn: !!document.querySelector('#btnDocPage')
    }));
    record('6. 设置页 ⑦ AI 分区 / 新服务 / 布局 / 文档入口渲染且无异常',
      optState.aiSection && optState.newServices >= 4 && optState.layoutSelect && optState.docBtn && optErrors.length === 0,
      [JSON.stringify(optState), 'pageerror=' + JSON.stringify(optErrors)]);
    await optPage.close();

    /* 7. 弹窗更多面板新按钮存在 */
    const popupTarget = await browser.waitForTarget((t) => t.type() === 'page' && /popup\/popup\.html/.test(t.url()), { timeout: 5000 }).catch(() => null);
    let popupPage = popupTarget ? await popupTarget.page() : null;
    if (!popupPage) { popupPage = await browser.newPage(); await popupPage.goto('chrome-extension://' + (await WE(() => chrome.runtime.id)) + '/popup/popup.html', { waitUntil: 'load' }); }
    await sleep(600);
    const popupState = await popupPage.evaluate(() => ({
      doc: !!document.querySelector('#btnDoc'), sub: !!document.querySelector('#btnSubtitle'),
      img: !!document.querySelector('#btnImageTrans'), layout: !!document.querySelector('#btnLayout')
    }));
    record('7. 弹窗更多面板新按钮渲染',
      popupState.doc && popupState.sub && popupState.img && popupState.layout,
      [JSON.stringify(popupState)]);
    await popupPage.close();

    /* 8. 设置页「翻译设置页」分区存在（optPage 已关闭，重新打开） */
    const opt2 = await (async () => {
      const t = await browser.waitForTarget((x) => x.type() === 'page' && /options\/options\.html/.test(x.url()), { timeout: 5000 }).catch(() => null);
      if (t) return t.page();
      await WE(() => chrome.runtime.openOptionsPage());
      const t2 = await browser.waitForTarget((x) => x.type() === 'page' && /options\/options\.html/.test(x.url()), { timeout: 8000 });
      return t2.page();
    })();
    await sleep(700);
    const translateUi = await opt2.evaluate(() => ({
      section: !!document.querySelector('#sec-page-translate'),
      lang: !!document.querySelector('#optPageTranslateLang'),
      go: !!document.querySelector('#btnTranslatePage'),
      restore: !!document.querySelector('#btnRestorePage'),
      quick: !!document.querySelector('#btnQuickTranslatePage')
    }));
    record('8. 设置页「翻译设置页」分区与控件存在',
      translateUi.section && translateUi.lang && translateUi.go && translateUi.restore && translateUi.quick,
      [JSON.stringify(translateUi)]);
    await opt2.close();

    /* 9. 悬浮球侧边栏：菜单项 + 消息打开 + 输入框/按钮存在 */
    const sidebarMenu = await tabMsg(page, { type: 'GET_FEATURES' }); // 确认内容脚本仍健康
    const sideResp = await tabMsg(page, { type: 'BALL_OPEN_SIDEBAR' });
    await sleep(500);
    const sideState = await page.evaluate(() => {
      const p = document.querySelector('.ta-side-panel');
      return {
        panel: !!p,
        visible: !!p && (p.classList.contains('ta-side-show') || getComputedStyle(p).transform === 'none' || p.getBoundingClientRect().width > 0),
        input: !!document.querySelector('.ta-side-input'),
        translate: !!document.querySelector('.ta-side-translate'),
        close: !!document.querySelector('.ta-side-close')
      };
    });
    record('9. 悬浮球翻译侧边栏可打开且控件齐全',
      !!(sidebarMenu && sidebarMenu.ok) && !!(sideResp && sideResp.ok !== false) &&
      sideState.panel && sideState.input && sideState.translate && sideState.close,
      ['BALL_OPEN_SIDEBAR=' + JSON.stringify(sideResp), 'DOM=' + JSON.stringify(sideState)]);

    /* 10. 侧边栏翻译端到端：输入英文 → 真实点击翻译 → 出现中文译文或明确错误 */
    try {
      // 测试 9 已通过 BALL_OPEN_SIDEBAR 打开侧边栏；再发一次确保处于打开状态
      const sideAgain = await tabMsg(page, { type: 'BALL_OPEN_SIDEBAR' });
      await sleep(300);
      const hasControls = await page.evaluate(() =>
        !!(document.querySelector('.ta-side-input') && document.querySelector('.ta-side-translate')));
      let resultText = '';
      if (hasControls) {
        // 内容脚本在隔离世界，但 DOM 共享：用 page.evaluate 设置 textarea 的 value
        await page.evaluate(() => {
          const el = document.querySelector('.ta-side-input');
          el.value = 'Hello, how are you today?';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        // 真实用户点击共享 DOM 节点，触发内容脚本监听器（隔离世界）
        await page.click('.ta-side-translate');
        // 轮询结果，最多约 30 秒（60 * 500ms）。必须排除占位符文本，
        // 否则“译文会显示在这里 · 支持分段翻译”自带中文会造成假阳性。
        const PLACEHOLDER = /译文会显示在这里|支持分段翻译|请输入|翻译中|请稍后重试/;
        for (let i = 0; i < 60; i++) {
          resultText = await page.evaluate(() => {
            const r = document.querySelector('.ta-side-result');
            return r ? (r.innerText || r.textContent || '') : '';
          });
          const meaningful = resultText && !PLACEHOLDER.test(resultText);
          if (meaningful && (/[\u4e00-\u9fff]/.test(resultText) ||
              /错误|失败|无法|异常|超时|未配置|网络|出错|请检查|error|fail|timeout|network|exception|key/i.test(resultText))) break;
          await sleep(500);
        }
      }
      // 排除占位符：只有真实译文（含中文）或明确错误才算通过
      const PLACEHOLDER2 = /译文会显示在这里|支持分段翻译|请输入|翻译中|请稍后重试/;
      const meaningful = !!resultText && !PLACEHOLDER2.test(resultText);
      const hasChinese = meaningful && /[\u4e00-\u9fff]/.test(resultText);
      // 明确的错误信息：非空且带错误特征；单纯“空/翻译中/占位符”不算通过
      const hasError = meaningful && /错误|失败|无法|异常|超时|未配置|网络|出错|请检查|重试|error|fail|timeout|network|exception|not configured|api key/i.test(resultText);
      record('10. 侧边栏翻译端到端：输入英文→点翻译→出现中文译文/明确错误',
        !!hasControls && (hasChinese || hasError),
        ['BALL_OPEN_SIDEBAR=' + JSON.stringify(sideAgain),
         'controls=' + !!hasControls,
         'result=' + JSON.stringify(String(resultText).slice(0, 200))]);
    } catch (e) {
      record('10. 侧边栏翻译端到端：输入英文→点翻译→出现中文译文/明确错误', false,
        ['EXCEPTION=' + String((e && e.message) || e)]);
    }

    /* 11. 默认配置：deepl-free 首选 + 划词/悬停默认开启 + 悬停延时 200ms */
    try {
      const defs = await WE(() => {
        const s = TA.mergeDefaults(null);
        return {
          primary: s.primaryService,
          chain: s.serviceChain,
          hover: s.hoverTranslate && s.hoverTranslate.enabled,
          sel: s.selection && s.selection.enabled,
          delay: s.ui && s.ui.ballHoverDelay
        };
      });
      const pass = defs.primary === 'deepl-free' &&
        Array.isArray(defs.chain) && defs.chain[0] === 'deepl-free' &&
        defs.hover === true && defs.sel === true &&
        typeof defs.delay === 'number' && defs.delay <= 200;
      record('11. 默认配置：deepl-free 首选 + 划词/悬停默认开启 + 悬停延时 200ms', pass,
        [JSON.stringify(defs)]);
    } catch (e) {
      record('11. 默认配置：deepl-free 首选 + 划词/悬停默认开启 + 悬停延时 200ms', false,
        ['EXCEPTION=' + String((e && e.message) || e)]);
    }

    await page.close();
    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    fs.writeFileSync(path.join(__dirname, 'feature-results.json'), JSON.stringify({ passed, failed, results }, null, 2), 'utf8');
    console.log('\n========== 新功能冒烟: ' + passed + ' passed / ' + failed + ' failed ==========');
  } finally {
    try { await browser.close(); } catch (e) {}
    stopServer();
  }
}
main().catch((e) => { console.error('FEATURE HARNESS FATAL:', e); stopServer(); process.exit(1); });
