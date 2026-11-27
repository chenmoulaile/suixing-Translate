// 修复五项优化审查发现的问题：按领域并行修复（文件所有权互斥）→ 测试门控 → 独立复核 → 汇总。

interface FixResult {
  /** 领域 key。 */
  area: string;
  /** 实际改动的文件（仓库相对路径）。 */
  changed: string[];
  /** 一句话：本领域修了什么。 */
  summary: string;
  /** 未修复项与原因（含判定为风险过大的项）。 */
  notes: string;
}

interface VerifyItem {
  /** 文件:行号。 */
  where: string;
  /** fixed=已正确修复；partial=部分修复；not_fixed=未修复；regressed=修复引入新问题。 */
  status: "fixed" | "partial" | "not_fixed" | "regressed";
  /** 复核者实际读到的代码 / 运行的命令与输出。 */
  evidence: string;
}

interface VerifyResult {
  area: string;
  items: VerifyItem[];
}

interface WorkflowReport {
  conclusion: string;
  findings: VerifyItem[];
  verified: string[];
  notCovered: string[];
}

// 每个领域：文件所有权 + 待修清单 + 决策口径。修复员只能碰自己名下的文件。
const AREAS: Array<{ key: string; name: string; files: string; items: string }> = [
  {
    key: "doc",
    name: "修复员·文档与公式",
    files: "doc/doc.js、doc/pdf-formula.js",
    items: [
      "1) doc/doc.js:633 双栏拼接边界并段：orderPdfLines 的 left.concat(right) 丢掉栏归属，pdfLinesToParagraphs 在边界按 y 差判断会把左栏末段与右栏首段合并。修法：orderPdfLines 给每行标记栏号（或返回 {left,right}），pdfLinesToParagraphs 在栏号变化处强制断段，绝不跨栏合并；单栏路径行为保持不变。",
      "2) doc/doc.js:1222 导出 HTML 缺 katex.min.css：buildPdfExportHtml(:1221-1227) 与 buildExportHtml(:1266-1275) 的 head 无 <link>，导出文件里 KaTeX 标记排版错乱。修法：导出时内联 vendor/katex.min.css 全文进 <style>（离线自包含；读不到文件时降级为不内联但保留公式源码可读）。",
      "3) doc/pdf-formula.js:88 裸数学串误判：要求收紧启发式，正文里的 A=B、x≤y 不再被当公式（例如要求成对定界符，或要求符号密度/上下文更强），宁可漏判不可误判。",
      "4) doc/pdf-formula.js:140 unmaskFormulas 兜底 /\\bm\\s*(\\d+)\\b/ 会误替换译文里的正常 mN 文本：去掉裸 mN 兜底，只还原 ⟪mN⟫ 形态（含 MT 改括号的宽松形态）。",
      "5) doc/doc.js:1161 Markdown 导出多行段落只有首行进 blockquote：给段落每一行都加 '> ' 前缀。",
      "6) doc/doc.js:308 decodeText 只按 UTF-8：加 GBK/Big5 回退（TextDecoder 支持时按 gb18030/big5 试解，失败再回退），不改变 UTF-8 默认路径。",
    ].join("\n"),
  },
  {
    key: "ball",
    name: "修复员·悬浮球与样式",
    files: "content/ball.js、content/interactions.js、styles/ball.css、styles/interactions.css、styles/sidebar.css",
    items: [
      "1) content/ball.js:1228 与 :1265 runTranslateChunks(0) 双调用：删掉第二次调用，只保留一条链；确保重试计数不被两条链分摊（重试预算完整）。",
      "2) content/ball.js:738/631 悬停 tooltip 永不出现：菜单在 hoverDelay=200ms 打开、800ms 的 tip 回调被 menuOpen 守卫挡掉。修法：让前 5 次引导在菜单打开前/打开瞬间可见（例如把 tip 定时器改为先于 openMenu 触发，或菜单打开时不 hideTip 而让 tip 自然消失），保证默认配置下 TIP_KEY 能递增到 5。",
      "3) content/ball.js:1561 setupFullscreen 无幂等守卫：加守卫（已注册则跳过），与 setupStateObserver/setupCleanupObserver 同风格。",
      "4) content/ball.js:1536 拉黑/关闭时直接 sub=null 漏 removeSubReposition：补调用，清掉 openSub 注册的 scroll(捕获)/resize 监听。",
      "5) content/ball.js:64 pinned 永不为 true、注释与实现不符：接通 pinned 语义（子面板展开期间菜单不因 mouseleave 收起）或删除该分支与误导注释，二选一，不留死代码。",
      "6) content/ball.js:550 菜单打开时 showTip 盖住菜单：菜单展开期间不再 showTip（或调整层级/位置），保证菜单项可见。",
      "7) content/ball.js:140 声明 role=button/tabindex=0 但无键盘激活：补 Enter/Space 打开菜单与触发翻译。",
      "8) content/ball.js:55 mask 中文名 fallback 与 shared/defaults.js 不一致：以 defaults.js 为准改为全角「模糊（学习模式）」。",
      "9) styles/ball.css:232 font:12px/1.3 inherit 无效声明被丢弃：拆成 font-size/line-height/font-family 合法写法。",
      "10) styles/ball.css:217 .ta-ball-sub,.ta-ball-submenu{padding:2px 0 6px} 覆盖 submenu 的 padding:6px 且 .ta-ball-sub 是死选择器：删除 .ta-ball-sub 死选择器，保留 submenu 的 padding:6px。",
      "11) styles/sidebar.css:263 无 .ta-side-res-trans 后代样式：补齐 Markdown/KaTeX 排版（标题/列表/代码/表格/链接/.katex-display overflow-x:auto），与 styles/interactions.css 的 .ta-sel-trans 规则对齐。",
      "12) styles/sidebar.css:338 暗色下链接用 UA 默认 #0000EE：补 .ta-side-res-trans a 的明暗两色。",
      "13) styles/sidebar.css:254 .ta-side-res-orig 已死：删除该规则（含暗色块内对应项）。",
      "14) styles/interactions.css:124 .ta-sel-trans 未固定 white-space 会继承宿主：显式设 white-space:normal。",
      "15) styles/interactions.css:445 KaTeX 错误内联 color:#cc0000 压过暗色规则：给 .katex-error 规则加 !important（或等价的更高优先级写法）。",
      "16) content/interactions.js:607 renderResult 用 body.innerHTML 重建会清掉已追加的 AI 词典卡：重建后重新挂回词典卡（或改为只更新译文节点，不清整体）。",
    ].join("\n"),
  },
  {
    key: "terms",
    name: "修复员·术语预设",
    files: "background/terminology.js、options/options.html、options/options.js",
    items: [
      "1) 【高】options/options.html:548 自定义术语 placeholder 写「原文写法 => 目标译法」，但 terminology.js:157 parseCSV 只按 , ， \\t 切分，按文档输入整行被静默丢弃。修法：让 parseCSV 同时兼容 =>、→、全角＝＞ 作为分隔符（优先级：制表符 > 逗号 > 箭头），并只按第一个分隔符切成两段（顺带修目标译文含逗号被截断的问题）。placeholder 文案保持不变。",
      "2) background/terminology.js:191 术语段忽略目标语言：buildTermsSection 增加语言参数（或 buildSystemPrompt 把 langName 传下去），目标语言非中文时不要注入「source => 中文」词表（oi 预设在 ja 目标下尤其错误）。保持 enableTerms=false 返回空串的既有契约。",
      "3) options/options.js:854 PRESET_FALLBACK 补 'oi'（与 getPresetNames 的 9 项一致）。",
      "4) options/options.html:544 文案补「OI/算法竞赛」；下拉项给预设加中文标签（若改动面可控），至少让 oi 可被用户发现。",
      "5) background/terminology.js:100 oi 预设里的高频通用词（tree/state/table/weight/node/identity/median/edge/vertex 等）会污染同页普通英文散文：移出通用词，只保留竞赛专有术语；歧义消解词（DP/mod 等）保留。",
    ].join("\n"),
  },
  {
    key: "base",
    name: "修复员·共享基座与清单",
    files: "shared/markdown.js、shared/defaults.js、manifest.json",
    items: [
      "1) shared/markdown.js:98 行内 $…$ 把任意两个 $ 之间文本吞成公式（价格 $5 and $10、shell 变量 $PATH）：收紧规则——两侧 $ 不得紧邻空白、不得是货币（前后为数字时跳过）、支持 \\$ 转义、避免跨词吞空格；宁可少渲染不可吞正文。",
      "2) shared/markdown.js:129 公式抽取在 Markdown 解析前跑，围栏代码块与行内代码里的 $…$ 被当公式：先占位保护 fenced code block 与 inline code，再抽数学，解析后回填；代码内容必须原样保留。",
      "3) shared/markdown.js:82 块级 $$…$$ 只在独占行识别，行内 $$x$$ 残留两个游离 $：支持行内 $$…$$ 作为块级公式（或至少不残留游离 $）。",
      "4) shared/defaults.js:151 mergeInto 对 __proto__ 直接赋值可污染 Object.prototype：跳过 __proto__/constructor/prototype 键。",
      "5) shared/defaults.js:8 注释仍写 12→24 档、theme=24 档之一：改为 26 档，与实际数组一致。",
      "6) manifest.json:69 toggle-subtitle 的 description 是 UTF-8/GBK 互转乱码：改为正常中文（保持 JSON 不带 BOM、UTF-8）。",
      "7) manifest.json:17 web_accessible_resources 暴露整页 doc/doc.html：移除 doc/doc.html（保留 vendor/katex.min.css），background 用 chrome.tabs.create 打开扩展页不需要 WAR。改完必须确认三套测试仍全绿，否则回退该项并在 notes 说明。",
      "8) manifest.json:31 markdown-it+KaTeX 约 400KB 每 frame 注入：本项风险大于收益（all_frames 改动可能破坏 iframe 侧栏/划词），不要改，在 notes 里写明保留原因。",
    ].join("\n"),
  },
];

const COMMON =
  "\n\n【硬约束】\n" +
  "- 只修改你名下的文件，绝不碰其它文件；绝不修改 tests/ 下任何文件（测试是门控，改测试视为作弊）。\n" +
  "- 不碰 .zcode/。不要执行 git reset --hard / git checkout -- 等破坏性命令。\n" +
  "- 改完对每个改动的 .js 跑 `node --check <file>` 确认语法通过。\n" +
  "- 保持既有编码：.json 不带 BOM，.md/.css/.js 维持原 BOM 状态；中文注释用中文。\n" +
  "- 每处修复保持最小改动，不重构无关代码；修不了的写进 notes 说明原因，不要硬改。\n" +
  "- 返回 changed（实际改过的文件）、summary（一两句）、notes（未修项与原因）。";

// ---- 阶段一：检查点备份 ----
phase("打检查点备份");
const addRes = await world.run("git", ["add", "-A"]);
const commitRes = await world.run("git", [
  "commit",
  "-m",
  "checkpoint: WP-TRANSLATE-160 修复前备份（工作流自动提交）",
]);
log(
  commitRes.exitCode === 0
    ? "检查点已提交"
    : `检查点提交未成功（exit=${commitRes.exitCode}），继续；改动仍可用 git diff 追踪`,
);

// ---- 阶段二：分领域并行修复（文件所有权互斥，可安全并行）----
phase("分领域并行修复");
const fixes = await Promise.all(
  AREAS.map((a) =>
    agent(a.name).ask<FixResult>(
      `你在修复一个 Chrome 扩展（MV3）审查发现的问题，仓库根就是当前工作目录。\n` +
        `你只负责这些文件：${a.files}\n\n待修清单：\n${a.items}${COMMON}`,
    ),
  ),
);

// ---- 阶段三：测试门控（需要全部修复落地，这是屏障）----
async function runGate(): Promise<{ green: boolean; lines: string[] }> {
  const suites: Array<[string, string[]]> = [
    ["run-tests.js", ["tests/run-tests.js"]],
    ["run-feature-tests.js", ["tests/run-feature-tests.js"]],
    ["run-optimization-tests.js", ["tests/run-optimization-tests.js"]],
  ];
  const lines: string[] = [];
  let green = true;
  for (const [label, argv] of suites) {
    const r = await world.run("node", argv, { timeoutMs: 300000, output: { tail: 800 } });
    const tail = r.stdout.trim().split("\n").slice(-1)[0] ?? "";
    lines.push(`${label}: exit=${r.exitCode} | ${tail}`);
    if (r.exitCode !== 0) green = false;
  }
  return { green, lines };
}

phase("运行三套测试作为门控");
let gate = await runGate();
let repairRounds = 0;

// ---- 阶段四：失败则修复（最多 2 轮）----
phase("修复未通过的测试");
while (!gate.green && repairRounds < 2) {
  repairRounds += 1;
  const repairer = agent("修复协调员");
  await repairer.ask(
    `三套测试未全部通过，输出如下：\n${gate.lines.join("\n")}\n\n` +
      `请定位失败原因并修复（可以改任何源码文件，但绝不修改 tests/ 下任何文件）。` +
      `修完不要自己跑测试，脚本会重跑门控。只改必要的代码，说明改了什么。`,
  );
  gate = await runGate();
}

// ---- 阶段五：独立复核（每个领域一个，读 git diff 逐条核对）----
phase("独立复核每处修复");
const verified = await Promise.all(
  AREAS.map(async (a) => {
    const v = await agent(`复核员·${a.key}`).ask<VerifyResult>(
      `独立复核一个修复批次是否真的修好了问题、且没有引入回归。仓库根是当前工作目录，只读，不要修改任何文件，不要重跑测试套件（脚本已跑过门控）。\n` +
        `领域：${a.files}\n\n待核对清单：\n${a.items}\n\n` +
        `请用 \`git diff\` 看这些文件的实际改动，逐条核对：问题是否真的被修掉（读改后的代码，必要时用 node -e 做一次性验证），` +
        `有没有改坏既有行为。对每条给出 where、status（fixed/partial/not_fixed/regressed）、evidence（你读到的代码或命令输出）。` +
        `area 填 "${a.key}"。`,
    );
    return v;
  }),
);

// ---- 阶段六：汇总 ----
phase("汇总修复结果并产出报告");
const allItems: VerifyItem[] = verified.flatMap((v) => v.items);
for (const it of allItems) report(it);

const fixedCount = allItems.filter((i) => i.status === "fixed").length;
const regressed = allItems.filter((i) => i.status === "regressed");
const notFixed = allItems.filter((i) => i.status === "not_fixed" || i.status === "partial");

const conclusion =
  `四个领域并行修复完成，门控${gate.green ? "三套全绿" : "仍有失败"}（修复轮次 ${repairRounds}）。` +
  `复核 ${allItems.length} 条：修好 ${fixedCount} 条，部分/未修 ${notFixed.length} 条，引入回归 ${regressed.length} 条。`;

const md = [
  "# 五项优化审查问题：修复报告",
  "",
  "## 结论",
  conclusion,
  "",
  "## 各领域改动",
  ...fixes.map((f) => `- ${f.area}: ${f.summary}\n  文件: ${f.changed.join(", ")}`),
  "",
  "## 测试门控（脚本实际执行）",
  "```",
  gate.lines.join("\n"),
  "```",
  "",
  "## 逐条复核",
  ...allItems.map((i) => `- [${i.status}] ${i.where}\n  ${i.evidence.replace(/\n/g, "\n  ")}`),
  "",
  "## 未修复与保留项",
  ...fixes.map((f) => `- ${f.area}: ${f.notes}`),
  "",
  "## 未覆盖",
  "- 未在真实浏览器中加载扩展做端到端人工核对（仅 node 与三套离线测试）。",
  "- 未做真实在线翻译服务调用。",
].join("\n");

await artifact.markdown("fix-report", md, {
  title: "修复报告",
  description: "四个领域修复 + 测试门控 + 逐条独立复核的结果",
  primary: true,
});

const result: WorkflowReport = {
  conclusion,
  findings: allItems,
  verified: gate.lines,
  notCovered: [
    "真实浏览器内端到端人工核对",
    "真实在线翻译服务调用",
    "manifest all_frames 注入成本（按风险保留未改）",
  ],
};
return result;