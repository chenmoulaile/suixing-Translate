# 随行翻译（ParaTranslate）

纯原生 JavaScript 实现的 MV3 浏览器扩展：把网页每个段落下方的译文插入为双语对照（或仅译文），共 **12 个翻译服务**——谷歌、DeepL、微软 Edge、彩云小译、有道、讯飞、DeepL API、OpenAI 兼容端点，以及 **Claude / Google Gemini / DeepSeek / 本地 Ollama**；按降级链自动回退，译文本地缓存。

v0.2 新增：悬浮球全面增强（点击展开菜单、拖动记忆位置、主题/遮罩/导出入口）、译文主题 24 档全集、遮罩学习模式（译文模糊 + 悬停显示）、导出双语（HTML 快照 / Markdown / TXT）、输入框翻译升级（斜杠命令 / 撤销浮条 / Alt+I）、悬停翻译与划词翻译（默认关闭）、混合语言默认直翻（页面级 90% 语言统计跳过）、公式占位符保护（MathJax/KaTeX 翻译不破坏公式）。

最新新增：**AI 术语库与智能上下文**（仅对 AI 服务生效）；**YouTube / 网页双语字幕**；**文档翻译**（PDF / EPUB / TXT / SRT / Markdown / HTML）；**图片翻译 OCR**；**AI 词典卡**（释义 / 音标 / 例句）；**并排双语布局**（原文与译文左右对照）。

v1.1 交互升级：**悬浮球缩小至 32px 并修复悬停菜单错位**；新增**翻译侧边栏**（球菜单 / 弹窗更多 → 「翻译侧边栏」，带输入框、语言选择、双语结果与历史）；新增「**⑨ 设置页翻译**」可把设置界面本身译成目标语言并一键还原；弹窗与设置页改为玻璃拟态 + 渐变的高级视觉；划词小圆点同步缩小。

- 中文展示名：随行翻译 ｜ 英文内部名：ParaTranslate ｜ 版本：1.5.2
- 运行环境：Chromium 内核浏览器 ≥ 102（Chrome / Edge）
- 无构建步骤、无 npm 依赖：全部为经典脚本（`globalThis.TA` 命名空间），加载目录即可使用

## 安装

### Chrome（≥102）

1. 打开 `chrome://extensions/`；
2. 打开右上角「开发者模式」；
3. 点击左上角「加载已解压的扩展程序」；
4. 选择本目录 `D:\code\translate-anywhere`；
5. 工具栏出现「随行翻译」图标即安装成功。

### Edge（≥102）

1. 打开 `edge://extensions/`；
2. 打开左侧「开发人员模式」；
3. 点击「加载解压缩的扩展」；
4. 选择同一目录 `D:\code\translate-anywhere`（零改动，与 Chrome 共用）；
5. 其余功能与验收项和 Chrome 一致。

## 快捷键

| 快捷键 | 命令 | 作用 |
|---|---|---|
| Alt+A | toggle-translate | 翻译本页 / 恢复原文 |
| Alt+W | translate-full | 整页翻译（智能模式排除的导航区也会翻译） |
| Alt+B | toggle-bilingual | 双语对照 / 仅译文 切换 |
| （无默认键） | toggle-mask | 遮罩学习模式全页开关：所有译文模糊，悬停单条译文变清晰，再按还原 |
| （无默认键） | translate-input-box | 翻译当前聚焦的输入框内容（= Alt+I 建议绑定） |
| （无默认键） | _execute_action | 打开弹窗（可自行绑定） |

在 `chrome://extensions/shortcuts`（Edge：`edge://extensions/shortcuts`）可查看并修改绑定。

## 使用说明

- **弹窗**（点工具栏图标）：主按钮三态「翻译 / 翻译中… / 显示原文」；「双语对照｜仅译文」「智能｜全文」两组分段开关；翻译服务与目标语言下拉（需密钥的服务未配置时显示「(未配置)」）；翻译中显示 `done/total` 进度与错误提示；「更多」菜单里有**导出双语三格式**、缓存条数与清除、打开设置、「永不翻译此站点」。
- **智能模式**：自动排除导航栏、页眉页脚、代码块（pre/code/kbd）、数学公式（KaTeX/MathJax，翻译前以 ⟪mN⟫ 占位符保护、译文回填后原位还原）等非正文区域；**全文模式**（Alt+W）只保留代码块等硬排除。
- **悬浮球**：页面左/右缘中部圆形按钮（蓝底「译」，翻译后变灰显「原」）。**点击展开菜单**：翻译本页（或显示原文）、仅译文/双语对照、主题选择（24 档即时生效）、遮罩模式开关、导出双语（HTML/Markdown/TXT）、打开设置；**按住拖动**可移动位置并记忆，切换左/右缘设置时回到默认位；悬停满 500ms（可调）自动展开菜单；透明度可调；全屏播放视频与打印时自动隐藏；可在设置中关闭或按站点黑名单禁用。首次使用前 5 次悬停有「点击翻译本页」引导。
- **译文主题 24 档**：无 / 黑灰 / 虚线下划线（默认）/ 细虚线 / 点状 / 直线 / 原生下划线 / 原生虚线 / 原生点线 / 波浪 / 虚线边框 / 实线边框 / 分割线 / 高亮 / 马克笔 / 马克笔2 / 背景色 / 透明 / 模糊(学习) / 白纸阴影 / 引用 / 弱化 / 斜体 / 加粗，样式还原官方扩展观感；设置页可「预览全部样式」逐档真实渲染。
- **遮罩学习模式**：两种用法——把主题选为「模糊(学习)」档（译文 blur(5px)，悬停变清晰）；或用快捷键 `toggle-mask` 全页开关（所有译文统一模糊/还原，即时生效不发请求）。
- **导出双语**：悬浮球菜单与弹窗「更多」面板双入口，三格式——**HTML** 独立快照（可离线打开，无脚本执行）、**Markdown**、**TXT**，按 DOM 顺序逐段「原文 + 译文」成对；未翻译页面会提示先翻译。
- **右键菜单**：「翻译网页」「显示原文」两项。
- **输入框翻译**：在 input / textarea 内 200ms（可调 150–1000）内连按三次空格，把输入内容整段译成目标语言；斜杠命令 `/ja 你好`（仅命令后内容译为日语）、`//内容`（仅命令后内容按默认目标语言）；替换成功后出现**撤销浮条**（点击还原，Ctrl+Z 也可）；译文与原文相同时不替换并提示；快捷键 `translate-input-box` 可直接翻译当前聚焦输入框。
- **悬停翻译**（默认关闭）：开启后悬停候选段显示虚线轮廓，修饰键按住 + 悬停（Ctrl/Alt/Shift/Meta 可选）触发，译文内嵌在该段原文下方；再按住修饰键悬停已翻译段 = 还原该段；另有「按住停留」「纯悬停」两档触发。
- **划词翻译**（默认关闭）：选中文字后出现小圆点/图标（选完即弹可选），悬停或点击触发气泡卡：复制、朗读（本地 speechSynthesis）、重试、三档禁用（本次/本站/永久）；整句仅译文，单词可回显原文。
- **混合语言默认直翻**：中文页面里的英文段落默认直接翻译，中文段落原样保留，无需任何开关；页面级整体跳过仅在正文 90% 以上已是目标语言时发生（智能与全文模式同样遵守），弹窗会提示。
- **按站点固定主题**：站点规则新字段 `theme`（如 `"theme": "paper"`），该站点译文固定使用该主题档；内置 Codeforces 规则针对题面 `.ttypography` 提取，样例区与题目头部限制行不翻译。

### 文档翻译页

独立页面翻译本地文档，支持 **PDF / EPUB / TXT / SRT / Markdown / HTML**（PDF 解析由内置 pdf.js 完成，无需联网）。三种打开方式：

- **弹窗**：点工具栏图标 →「更多」→「文档翻译」；
- **悬浮球**：展开菜单 →「文档翻译」；
- **设置页**：`⑦ AI 与扩展场景` →「打开文档翻译页」。

## 服务说明与失效风险

| 服务 | 密钥 | 说明 |
|---|---|---|
| 谷歌翻译 | 无需 | translate.googleapis.com 免费接口，默认链首位 |
| 微软翻译 | 无需 | Edge 匿名 JWT（9 分钟缓存续取） |
| DeepL（免费） | 无需 | oneshot 免费接口，限速严格（429 不自动重试），不支持繁体中文目标 |
| 彩云小译 | 无需 | 内置公开测试 token，目标限 zh/ja/ko/es/fr |
| 有道翻译 | 无需 | webfanyi 两步签名 + AES 解密 |
| 讯飞翻译 | 无需 | 免费接口，仅支持译入简体中文 |
| DeepL API | 需要 | api-free / api-pro 官方 key，或 DeepLX 端点（key 可空） |
| OpenAI | 需要 | 任意 OpenAI 兼容 chat/completions 端点，逐段请求非流式 |
| Claude | 需要 | Anthropic Messages API（默认 `claude-3-5-sonnet-latest`），支持术语库/上下文 |
| Google Gemini | 需要 | generateContent 接口（默认 `gemini-2.0-flash`） |
| DeepSeek | 需要 | `deepseek-chat`，支持自定义 System Prompt |
| 本地 Ollama | 无需 | 本机 `http://localhost:11434`（需允许跨域），模型默认 `llama3.1:8b` |

> **失效风险**：免 key 的六个服务均为非官方公开端点，随时可能失效、限速或被风控；某个服务失败时扩展自动沿降级链切换（默认：谷歌 → 微软 → DeepL 免费 → 彩云 → 有道），全部失败时对应段落显示错误态而非静默丢失。需要稳定服务请自行申请官方 API 并在设置页配置密钥。

## 隐私声明

- 待翻译文本只发送到你（或默认降级链上）选择的翻译服务商，由浏览器直连，不经过任何中间服务器；
- API key 等配置仅保存在本地 `chrome.storage.local`，不回传给任何第三方，设置页也永不回显明文；
- 译文缓存仅保存在本地（默认 30 天 / 2000 条），可随时在弹窗或设置页清除；
- 扩展不收集浏览历史与个人信息，不含任何统计埋点。

## 设置说明（options 页）

- **① 基础**：目标语言、默认翻译模式、默认范围、译文位置（原文下方 / 替换原文）。
- **② 译文样式**：24 档主题网格（带简预览）+「预览全部样式」真实渲染面板、遮罩学习模式说明、等待动画三档（闪烁圆点 / 静态省略号 / 无）、自定义颜色与字号、自定义 CSS（注入为 `#ta-user-css`，可修站点错乱）；并排双语布局请在 `⑦` 区设置（`targetStyle.layout`，对新翻译生效）。
- **③ 服务与密钥**：主服务与降级链编辑器（勾选 + 上下移）；DeepL API 卡片（api-free / api-pro / DeepLX、代理地址）；OpenAI 卡片（Base URL / 模型 / temperature / System Prompt，非官方域名需点「授权该域名」）；新增 Claude / Gemini / DeepSeek（Base URL / 模型 / 密钥掩码 / temperature / maxTokens / System Prompt）与本地 Ollama（无密钥）卡片。
- **④ 网站规则**：永不翻译 / 强制翻译网址通配（每行一条）、语言排除多选、内置站点规则只读展示（twitter/x.com、github.com、news.ycombinator.com、codeforces.com）、「插入当前站点规则骨架」「导出规则 JSON」按钮、用户站点规则 JSON（保存前校验，支持 `selectors.add` / `selectors.remove` 增量、`additional*` 追加与 `theme` 字段）。
- **⑤ 高级**：段落阈值（默认 4 字符 / 1 词）、输入框翻译（间隔 150–1000ms、斜杠命令、撤销浮条说明）、悬停翻译（触发方式 / 修饰键 / 按住时长）、划词翻译（样式 / 触发 / 回显原文 / 禁用站点展示）、悬浮球（开关 / 左右位置 / 不透明度 / 悬停展开延迟 / 站点黑名单）、导出双语默认格式、快捷键管理指引、缓存期限与容量。
- **⑦ AI 与扩展场景**：AI 术语库（预设领域 + 自定义术语）、智能上下文、并排双语布局、双语字幕（自动双语 / 字号 / 背景 / 目标语言）、AI 词典卡（查询服务 / 例句 / 自动朗读）、图片翻译（触发方式 / OCR 服务 / 目标语言）、「打开文档翻译页」按钮。
- **⑧ 关于**：版本、安装步骤、隐私与免责声明。

> 新增设置键（由 `shared/defaults.js` 统一定义，读取时深合并回填）：`ai:{enableTerms,termsPreset,customTerms,enableContext}`、`subtitle:{enabled,autoBilingual,fontSize,showBackground,targetLang}`、`dictionary:{enabled,service,showExamples,autoSpeak}`、`imageTranslate:{enabled,trigger,service,targetLang}`、`targetStyle.layout:'block'|'dual'`，以及 `services` 下 `claude/gemini/deepseek/ollama` 四项配置。

所有页面监听 `chrome.storage.onChanged`，保存后即时生效，无需刷新。

## 目录结构

```
translate-anywhere/
├── manifest.json            MV3 清单（v0.2：content_scripts 含全部新文件 + 新增 commands）
├── README.md                本文件
├── _locales/                zh_CN / en 文案（扩展名与右键菜单）
├── assets/icons/            icon16/32/48/128.png
├── shared/                  defaults.js / langmap.js / md5.js（四处共用）
├── background/              service worker + http/cache/queue + 12 个服务适配器
├── content/                 core / rules / formula / walker / injector / interactions /
│                            ball / export / input-enhance / subtitle / dictionary /
│                            image-translate / main（按 manifest 加载顺序）
├── doc/                     文档翻译页（doc.html + 内置 pdf.js / epub 解析）
├── styles/                  content.css（基础结构 + loading/error）· themes.css（24 档主题）
│                            · ball.css（悬浮球）· interactions.css（悬停/划词）
├── popup/                   弹窗（html/css/js）
└── options/                 设置页（html/css/js）
```

## 已知限制

- 不支持 `file://` 本地文件、浏览器内置页（`chrome://`、`edge://`、`about:`）与扩展商店页；文档翻译页仅处理用户主动选择/拖入的本地文件；
- 不处理 iframe 内的内容（只翻译顶层框架）；
- 浏览器 fetch 无法伪造 Origin / Referer / Cookie 头，个别免 key 服务（讯飞、有道）可能因此被风控拒绝——扩展会自动降级到链上下一个服务；
- DeepL 免费接口不支持繁体中文目标（zh-TW 会自动跳到下一个支持的服务，避免产出简体译文）；
- 显式指定主服务时失败不降级（错误原样可见）；仅「自动（默认链）」走降级链；
- MathJax v3 站点（DOM 不留 TeX 源码）公式还原依赖翻译前的占位符保护，页面在保护完成前剧烈改版仍可能丢公式；KaTeX / MathJax v2 可从源码重渲染兜底（best-effort）；
- 「导出双语」仅针对当前网页快照（HTML / Markdown / TXT），PDF / EPUB / TXT / SRT / Markdown / HTML 文档请走文档翻译页；HTML 快照内联样式为导出专用（若扩展资源未开放跨源读取，主题效果以内置快照样式为准）；
- 图片翻译依赖 OCR 服务，免费 OCR key 通常有调用频率限制，超限会失败或需更换服务；
- AI 智能上下文会附带前后段落，额外消耗 token 并增大请求体积；术语库与上下文仅对 AI 服务生效，对免 key 服务无效；
- AI 词典卡 / 音标 / 例句需配置 AI 服务密钥或本地 Ollama 才会生成，未配置时单词查询仅回显原文；
- 双语字幕在开启或更改设置后**需刷新视频页**才会挂载；仅支持 YouTube 及带 WebVTT / 文本 track 的网页字幕；
- PDF 解析由内置的 pdf.js 完成（随扩展打包，无需联网）；扫描版 / 图片型 PDF 无文本层时无法提取文字；
- 并排双语布局对**新翻译**的段落生效，已翻译页面需先还原再重新翻译；
- 输入框翻译不做"保留原文双语显示"（input value 无合理的双语 DOM 形态）；
- 悬浮球不做长按菜单与移动端手势（桌面端范围）；SSE 流式翻译、iframe 支持留待后续版本。

## 免责声明

本扩展仅供个人学习与研究使用。内置的免 key 接口并非服务商官方授权的客户端，可能违反服务商服务条款或随时失效；如需稳定服务请自行申请官方 API 并配置密钥。使用本扩展产生的一切后果由使用者自行承担。

