// 审查 translate-anywhere 五项优化交付：先跑测试门控，再按领域并行审查 + 独立复核，最后汇总。

interface Finding {
  /** 文件:行号，如 "doc/doc.js:245"。 */
  where: string;
  /** 一句话：问题是什么，不写怎么修。 */
  what: string;
  /** 支撑证据：读到的代码行 / 命令与输出。 */
  evidence: string;
  /** verified=独立复核或确定性检查确认；unconfirmed=复核失败或未尝试。 */
  status: "verified" | "unconfirmed";
  /** high 仅用于数据丢失/崩溃/错误结果。 */
  severity: "low" | "medium" | "high";
  /** 所属领域，便于汇总。 */
  area: string;
}

interface Review {
  /** 该领域审查结论，一两句。 */
  summary: string;
  findings: Finding[];
}

interface Confirmation {
  /** 复核结论：成立 / 不成立 / 无法复现。 */
  verdict: "confirmed" | "refuted" | "unreproducible";
  /** 复核者实际执行的检查与输出摘要。 */
  evidence: string;
}

interface WorkflowReport {
  conclusion: string;
  findings: Finding[];
  verified: string[];
  notCovered: string[];
}

// ---- 阶段一：确定性测试门控（退出码即确认，不让 subagent 重跑）----
phase("运行三套测试作为门控");
const suites: Array<[string, string[]]> = [
  ["主回归 run-tests.js", ["tests/run-tests.js"]],
  ["功能冒烟 run-feature-tests.js", ["tests/run-feature-tests.js"]],
  ["优化验收 run-optimization-tests.js", ["tests/run-optimization-tests.js"]],
];
const gateLines: string[] = [];
let allGreen = true;
for (const [label, argv] of suites) {
  const r = await world.run("node", argv, { timeoutMs: 300000, output: { tail: 600 } });
  const tail = r.stdout.trim().split("\n").slice(-1)[0] ?? "";
  gateLines.push(`${label}: exit=${r.exitCode} | ${tail}`);
  if (r.exitCode !== 0) allGreen = false;
}
const gateSummary = gateLines.join("\n");
log(allGreen ? "三套测试全部通过，进入分领域审查" : "有测试未通过，审查需关注回归");

// ---- 阶段二：分领域并行审查 + 每个高/中危发现的独立复核（按项链式，无屏障）----
phase("分领域审查代码并独立复核发现");

const AREAS: Array<{ key: string; name: string; scope: string }> = [
  {
    key: "doc",
    name: "文档/PDF 与公式渲染审查员",
    scope:
      "doc/doc.js、doc/pdf-formula.js、doc/doc.html、doc/doc.css。重点：parsePdf 是否保留几何/分页、pdfItemsToParagraphs 聚类与双栏、公式遮罩 maskFormulas/unmaskFormulas 是否在原文层与导出（md/txt/srt/html）都正确还原（不得残留 ⟪mN⟫）、分页对照与仅译文视图、导出正确性。",
  },
  {
    key: "render",
    name: "划词与侧栏渲染审查员",
    scope:
      "content/interactions.js 的 renderResult、content/ball.js 的 renderSideResult、styles/interactions.css、styles/sidebar.css。重点：译文经 TA.markdown 安全渲染（html:false / KaTeX trust:false / 外链 rel）、原文回显与复制按钮仍取原始源码、XSS 安全、white-space 与 KaTeX 布局冲突、侧栏内联 whiteSpace 覆盖。",
  },
  {
    key: "terms",
    name: "OI 术语预设审查员",
    scope:
      "background/terminology.js、options/options.js、options/options.html。重点：oi 预设是否真正进入设置页下拉（options.html 是否加载 terminology.js 或经 runtime 取 getPresetNames）、PRESET_FALLBACK 是否含 oi、CONTEST_RULES 拼接、parseCSV 对 => 与逗号格式、术语段语言边界、对免 key 服务无效的范围说明。",
  },
  {
    key: "ball",
    name: "悬浮球子菜单与主题审查员",
    scope:
      "content/ball.js、styles/ball.css、styles/themes.css、shared/defaults.js、options/options.js 的主题部分。重点：主菜单不被 renderSub 清空、.ta-ball-submenu 作为 menu 兄弟 fixed 定位、视口翻转/clamp、scroll/resize 重定位、拖动/外部点击/ESC 守卫含 sub.contains、跨缝隙 grace、hover 与点击语义、主题 26 档三处 fallback 同步、暗色/打印。",
  },
  {
    key: "base",
    name: "共享基座与集成审查员",
    scope:
      "shared/markdown.js、shared/defaults.js、manifest.json、background/adapters/index.js 的 TOKEN_RE/splitHard。重点：markdown-it 与 KaTeX 本地 vendor 离线、content_scripts 顺序与 web_accessible_resources、CSP、⟪mN⟫ token 与 splitHard 跨界是否腰斩公式、Node 与浏览器双可用、XSS、错误降级。",
  },
];

const reviewed = await Promise.all(
  AREAS.map(async (area) => {
    const review = await agent(area.name).ask<Review>(
      `你在审查一个 Chrome 扩展（MV3）的一次交付，仓库根就是当前工作目录。\n` +
        `本次只审查以下范围，不要越界修改任何文件（只读）：${area.scope}\n\n` +
        `三套测试已由脚本跑过，结果如下（不要自己重跑测试）：\n${gateSummary}\n\n` +
        `请实际打开上述文件、核对行号，找出真实存在的 bug 或可优化点。每条 finding 给出 where（文件:行号）、what（一句话问题）、evidence（你读到的代码或命令输出）、severity（low/medium/high，high 仅用于数据丢失/崩溃/错误结果）、area（填 "${area.key}"）。` +
        `只报你真正读到并能定位的问题；没有就返回空 findings。summary 用中文一两句。`,
    );

    // 每个 high/medium 发现链 Within 本项 fan-out 立即派独立复核，无屏障。
    const checked = await Promise.all(
      review.findings.map(async (f, i) => {
        if (f.severity === "low") return { ...f, status: "unconfirmed" as const };
        const conf = await agent(`复核员·${area.key}-${i}`).ask<Confirmation>(
          `独立复核下面这条审查发现是否成立。仓库根是当前工作目录，只读，不要修改文件，不要重跑测试套件。\n` +
            `发现：${JSON.stringify(f)}\n\n` +
            `请从 evidence 出发，亲自打开相关文件 reproduce：读代码确认逻辑、必要时用 node -e 做一次性验证（不要起常驻服务）。` +
            `给出 verdict（confirmed/refuted/unreproducible）与你实际执行的检查与输出摘要 evidence。`,
        );
        const status: "verified" | "unconfirmed" =
          conf.verdict === "confirmed" ? "verified" : "unconfirmed";
        return { ...f, status, evidence: `${f.evidence}\n[复核:${conf.verdict}] ${conf.evidence}` };
      }),
    );

    return { area, review, checked };
  }),
);

// ---- 阶段三：汇总（需要全部领域到齐，这是唯一屏障）----
phase("汇总发现并产出报告");
const allFindings: Finding[] = reviewed.flatMap((r) => r.checked);
const high = allFindings.filter((f) => f.severity === "high");
const verifiedCount = allFindings.filter((f) => f.status === "verified").length;

// 逐条即时上报，失败也不丢。
for (const f of allFindings) report(f);

const conclusion =
  `三套测试门控${allGreen ? "全部通过" : "存在失败"}（${gateLines.length} 套）。` +
  `五个领域审查共得 ${allFindings.length} 条发现，其中高severity ${high.length} 条、经独立复核确认 ${verifiedCount} 条。`;

const md = [
  "# translate-anywhere 五项优化：审查报告",
  "",
  "## 结论",
  conclusion,
  "",
  "## 测试门控（脚本实际执行）",
  "```",
  gateSummary,
  "```",
  "",
  "## 发现清单",
  ...allFindings.map(
    (f) =>
      `- [${f.severity}/${f.status}] ${f.where} — ${f.what}\n  ${f.evidence.replace(/\n/g, "\n  ")}`,
  ),
  "",
  "## 未覆盖",
  "- 未做真实在线翻译服务调用（测试用本地桩/缓存）。",
  "- 未在 Firefox/Safari 实测。",
  "- PDF 扫描版（纯图片）不在范围。",
].join("\n");

await artifact.markdown("review-report", md, {
  title: "五项优化审查报告",
  description: "分领域审查 + 独立复核 + 测试门控的完整结果",
  primary: true,
});

const result: WorkflowReport = {
  conclusion,
  findings: allFindings,
  verified: gateLines,
  notCovered: [
    "真实在线翻译服务调用（离线桩/缓存）",
    "Firefox/Safari 兼容性",
    "PDF 扫描版（纯图片）路径",
  ],
};
return result;