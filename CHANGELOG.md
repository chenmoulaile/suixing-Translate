# 随行翻译（ParaTranslate）更新日志

## v1.2.0 —— 侧边栏服务、默认配置与 UI 精修

- **侧边栏翻译服务修复**：根因是默认 `google` 首选（本环境 429 失败）导致每次请求先失败 google→edge 才轮到能用的 deepl-free，表现为"无服务响应/超时"。现将 **DeepL（免费）设为默认首选服务**，降级链调整为 `deepl-free → google → edge → caiyun → youdao`；并加一次性设置迁移（`taMigrationVersion=3`），让旧安装自动切换到 deepl-free（仅在用户未显式选其它服务时）。侧边栏无服务时补充可读配置提示。实测侧边栏输入英文→点翻译，约 1 秒返回"你好，今天过得怎么样？"。
- **默认开启划词翻译 + 悬停翻译**：新安装即为 enabled；设置页文案同步为"默认开启"。
- **悬停展开延时再缩短**：`ballHoverDelay` 500→300→**200ms**（权威默认值 + 所有 fallback 同步），菜单弹出更跟手。
- **弹窗 UI**：整体加 14px 圆角（body/#app）+ 透明 html 背景；「更多」面板默认展开（"打开设置"不再需要点开），含缓存统计刷新。
- **悬浮球子菜单改为悬停弹出**：「主题选择」「导出双语」鼠标悬停即在旁边展开二级面板（120ms 延时 + 点击兜底），「打开设置」在主菜单与子面板中均常驻可见。
- **设置页视觉精修**：卡片顶部 accent 边、纯色标题（替换暗色下失真的渐变文字）、行 hover 引导线、玻璃保存栏与按钮光晕、focus-visible 焦点环。
- **测试**：端到端 22/22、新功能冒烟 11/11（新增侧边栏翻译端到端 + 默认配置断言，并修正了此前占位符导致的假阳性）。

## v1.1.1 —— 悬浮球交互与侧边栏打磨

- **菜单彻底贴合悬浮球**：放弃视口坐标 + `position:fixed`（缩放/transform 下会错位），改回球的子元素 + `position:absolute` + `right/left: calc(100% + 10px)` 纯 CSS 定位，菜单永远贴在球旁；球各状态去掉 `filter`/`transform`，杜绝包含块偏移。
- **点击 = 翻译**：点击悬浮球现在直接「翻译本页 / 显示原文」（拖拽仍只移动位置）；悬停默认 300ms 自动弹出菜单（原 500ms）；菜单里的「翻译本页」「翻译侧边栏」等项保留。
- **侧边栏阴影残留修复**：关闭后遮罩与面板彻底 `visibility:hidden`、面板滑出到 `translateX(120%)`，视口边缘不再残留阴影条。
- 原生 Chrome Side Panel 方案已撤回，保留质量更高的页面浮层侧边栏。
- 测试：端到端 22/22、新功能冒烟 9/9 通过。

## v1.1.0 —— 交互体验与界面升级

### 悬浮球改造
- **修复悬停菜单错位**：原实现把 `position:fixed` 菜单挂在带 `:hover filter` 的球节点下，`filter` 创建了包含块，导致用视口坐标定位的菜单被二次偏移。现菜单与提示浮层作为独立节点挂到 `documentElement`，球改用渐变/阴影做悬停态（不再用 `filter`/`transform`），并按菜单实际高度做视口夹取，不再溢出屏幕。
- **悬浮球缩小**：40×40 → 32×32，字号 17 → 14px，停靠间距 12 → 10px；渐变底色 + 分层阴影的高级质感。
- **翻译侧边栏**：菜单新增「翻译侧边栏」入口（弹窗「更多」也新增 `btnSidebar`）。侧边栏从球所在一侧滑入，含源/目标语言选择、输入框（Ctrl+Enter 翻译）、清空/交换、双语结果、复制、最近 5 条历史。消息 `BALL_OPEN_SIDEBAR`，公共 API `TA.ball.openSidebar()`。
- **划词小圆点缩小**：选择点 12→8px、图标钮 32→26px、加载圈 12→10px（JS 尺寸常量同步）。

### 设置页可翻译
- 新增「⑨ 设置页翻译」分区与品牌区「文A」快捷按钮：调用扩展自身翻译引擎，把设置页的标签/说明按目标语言生成双语对照（原文保留，译文以内联 span 插入），支持一键「还原原文」。不触碰任何输入项/按钮的值，保存逻辑不受影响；批量 ≤200 段/≤200000 字符分包、失败重拆重试。

### 界面高级化
- 设置页与弹窗统一升级设计令牌：渐变画布、玻璃拟态导航/保存条、渐变主按钮带光晕、分段控件滑动药丸、卡片抬升阴影与 hover 动效、表单聚焦环、更舒展的间距与字号。保留全部原有元素 ID / class 与暗色模式。

### 垃圾清理
- 删除 tests/ 下 25 个历史调试日志、7 个一次性 debug/probe 脚本、冗余的 `chromium-win.zip`（351 MB）；清理顶层 5 个 `.tmp-*` 临时目录与 v0.1/v0.2 旧版本副本及压缩包——合计释放约 **1 GB**。保留沉浸翻译参考脚本、当前源码、v1.0.0 与测试所需资源。

### 安装
- 通过 CDP `Extensions.loadUnpacked` 将扩展装入独立 Chrome 配置（ID `loceicdohphmfeldbemgfmjjbokmmkdp`，已持久化），内容脚本实测注入、悬浮球实测 32×32。未触碰用户正在使用的主 Chrome 窗口。

### 测试
- `node tests/run-tests.js`：22 / 22 通过。
- `node tests/run-feature-tests.js`：9 / 9 通过（新增设置页翻译、侧边栏断言）。

## v1.0.0 —— 对标沉浸式翻译的大版本升级

本次一次性交付，把扩展从「网页双语翻译 + 基础交互」扩展到覆盖沉浸式翻译的核心能力圈：网页 / 视频字幕 / 文档 / 图片 / AI 词典 / 并排布局 + 12 个翻译引擎。全部为原生 JS、无构建步骤。

### 新增翻译服务（8 → 12）
- **Claude**（api.anthropic.com，需 API Key）
- **Google Gemini**（generativelanguage.googleapis.com，需 API Key）
- **DeepSeek**（OpenAI 兼容，需 API Key）
- **本地 Ollama**（无需密钥，默认 `http://localhost:11434`）

四者可像原有服务一样在设置页配置、加入降级链。适配器含 `cfg.termsText` / `cfg.contextText` 注入钩子，供术语库与 AI 上下文使用。

### AI 智能上下文
- 术语库：内置法律 / 医学 / 电商 / 教育 / 游戏 / 小说 / 金融 / 科技 8 个领域词库，支持自定义 CSV 术语表（`source,target`）。仅对 AI 服务生效。
- 智能上下文：翻译前抽取页面标题、meta 描述、标题层级与正文摘要随请求发送，长文术语更统一（设置 → AI 与扩展场景 → 启用 AI 智能上下文）。

### 视频双语字幕
- YouTube：读取 `ytInitialPlayerResponse` 字幕轨（优先人工字幕，回退 ASR），JSON3 解析、按视频时间轴同步、SPA 导航自动重连。
- 通用网页：读取 `<video><track>` 的 WebVTT 字幕。
- 译文经后台翻译总线，原字幕与译文上下双行显示，字号 / 背景 / 仅译文可调（`subtitle.*` 设置项，`SUBTITLE_TOGGLE` / `SUBTITLE_STATUS` 消息与 `toggle-subtitle` 命令）。

### 文档翻译页（doc/doc.html）
- 拖入文件即可双语对照：PDF（内置 pdf.js，保留文本段落结构）、EPUB（原生 ZIP + DecompressionStream 解析 spine/manifest）、TXT、Markdown、HTML、SRT / VTT 字幕。
- 翻译进度、取消、分段重试；导出双语 Markdown / TXT / HTML / 仅译文 / SRT 字幕。
- 入口：弹窗「更多 → 文档翻译」、悬浮球菜单、设置页按钮。

### 图片翻译（OCR）
- 右键图片「翻译图片」，或悬停大图出现「译」按钮触发。
- ocr.space 免费识别（演示 key 有频率限制），逐行翻译后浮层卡片展示原图文字与译文，可复制 / 关闭（`imageTranslate.*`，需 `api.ocr.space` 权限）。

### AI 词典卡
- 划词短句/单词在气泡下方追加词典卡：音标、词性、中文释义、双语例句、发音按钮（基于 AI 服务结构化 JSON 输出，失败时自动回退为普通翻译）。
- 设置项 `dictionary.*`，消息 `DICTIONARY_LOOKUP`。

### 并排双语布局
- 新增 `targetStyle.layout: 'block' | 'dual'`。`dual` 下原文与译文左右分栏（CSS Grid），窄屏自动回退单栏；默认 `block` 行为与旧版完全一致。

### 缺陷修复
- 修复缓存清理后重翻不落盘的问题（缓存写入由 fire-and-forget 改为在响应前 `await` flush，规避 MV3 Service Worker 空闲回收导致写入丢失）——原 15c 测试由失败转为通过。

### 测试
- `node tests/run-tests.js`：22 / 22 通过。
- `node tests/run-feature-tests.js`（新增新功能冒烟）：7 / 7 通过。

### 说明
- 随扩展附带 `doc/vendor/pdf.min.js` 与 `pdf.worker.min.js`（pdf.js 3.11.174），文档翻译页完全离线解析 PDF。
- 新建服务需要相应域名权限（已在 manifest `host_permissions` 中声明）；Ollama 使用本机地址。
- 免 key 服务的可用性取决于第三方接口（Edge 匿名鉴权接口当前返回 404、谷歌偶发 429、彩云 / 有道响应异常），扩展会自动沿降级链切换；稳定使用请配置官方 API Key。
