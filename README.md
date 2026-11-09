<div align="center">

**中文** | [English](README_en.md)

</div>

<h1 align="center">小书童</h1>

<p align="center"><strong>网页版 AI 小说写作工具 —— 从设定、大纲到正文，一章一章把书写完</strong></p>

<p align="center">
  网页版正在改造中，上线后的访问地址将在仓库首页与网站公示。<br />
  <sub>本项目是独立运营的衍生版本，不是 Pagekin / 书童 官方版本，与原作者无隶属关系。</sub>
</p>

---

## 一、开源与许可声明（重要）

本项目基于 **[EthanYoQ/Pagekin](https://github.com/EthanYoQ/Pagekin)**（原名 AI Novel Writer / AI 小说作家，中文名「书童」）修改而来。

- 原项目由 **EthanYoQ 及其贡献者**维护，以 **GPL-3.0** 协议开源，原项目的版权归原作者及贡献者所有。
- **本项目同样以 [GPL-3.0](LICENSE) 协议开源**，完整许可文本见本仓库根目录的 `LICENSE`，该文件保持原样未作修改。
- 原项目中的版权与许可声明均予以保留；本项目不对原代码主张所有权，也未获得原作者的商业例外授权。
- 商标说明：「Pagekin」「书童 Pagekin」及原项目 Logo 归原项目所有。本项目使用自有品牌「小书童」，**不使用原项目 Logo**，也不代表原项目官方；所有对外页面均标注「非官方衍生版本」以避免混淆。
- 「小书童」及其标识为本运营方自有品牌，不属于 GPL 授权范围；原项目未授权、也未参与本项目的运营。

### 本项目的修改记录

| 日期 | 修改内容 | 修改者 |
| --- | --- | --- |
| 2026-11-09 | Fork 原项目（Pagekin / AI Novel Writer）v1.4.0，仓库改名 `my-novel-web`，产品定名「小书童」，新增 GPL-3.0 衍生声明、完整源码公示、非官方声明与网页版说明 | banceboy |
| 2026-11-09 | 新增网页版通信层适配骨架（7 个文件）：`src/services/ipc-client.web.ts` 及 `server/` 下 6 个模块；用 Node ESM loader、TypeScript 完整转译与 Electron 适配桩，在服务端复用原 285 个 IPC 通道，新增 `/api/rpc`、`/api/events`、`/api/health` | banceboy |
| 2026-11-09 | 新增 `vite.web.config.ts`：网页构建时把 IPC 客户端重定向到网页版实现、不加载 Electron 插件、将 `/api` 代理到 RPC 服务；`server/index.mjs` 补两个启动通道并修正确认返回值，解决网页启动阻塞 | banceboy |
| 2026-11-09 | 网页版「新建作品」改为服务端自动分配目录：`server/electron-shim.mjs` 的目录选择返回 `DATA_ROOT/projects`，`server/index.mjs` 补 `sender.once`，`vite.web.config.ts` 忽略运行时 `data/` 目录；实测中文书名创建成功 | banceboy |
| 2026-11-09 | 新增网页版文件桥接：浏览器原生文件选择器 → `/api/upload` 上传 → 服务端授权队列接回原导入流程；新增 `/api/dialog-intent`（导出目录意图，10 秒有效）、`/api/files/state`、`/api/download/latest` 下载端点，导出类通道成功后自动触发下载。涉及 `src/services/ipc-client.web.ts`、`server/index.mjs`、`server/electron-shim.mjs` | banceboy |

> 本表在每次代码改动时补一行（由助手维护本文件，维护者统一上传）；每次发布新版本在仓库打对应 tag，保证线上版本与源码一致。
>
> 下列为**规划中、尚未实施**的内容，不计入上表：账号体系与多租户隔离、计费额度与任务队列、SSE 事件按用户定向、正式部署上线。

### 完整源码

**本仓库即为本项目各版本的完整对应源码（Corresponding Source）**，包含构建所需的依赖清单与构建说明。当前阶段仓库以原项目 v1.4.0 为基础，叠加「本项目的修改记录」表所列的网页版改造文件；网页版每次发布时会在本仓库打上对应 tag。

- 源码入口：https://github.com/banceboy/my-novel-web
- 线上版本对应的 commit / tag：上线后在网站页脚「源码」处公示
- 网站页脚固定提供指向本仓库的「源码」链接
- 本项目不附加任何禁止复制、修改或再分发的额外限制；任何人可依 GPL-3.0 使用、修改和再分发本仓库代码

若你从本仓库构建或运行，请一并保留 `LICENSE` 与上述版权声明。

---

## 二、它能做什么

沿用原项目的写作工作流：你是作者，软件是书童，每一步结果存进作品，下一步接着用，AI 负责起草、由你确认。

- **书房**：管理全部作品，查看进度、字数、定稿章数
- **拆解与仿写**：导入 .txt / .md / .epub 参考小说，AI 拆解结构、提取文风
- **设定与架构**：类型、受众、总章数；故事前提、角色名单、世界观、情节大纲
- **章节蓝图**：逐章规划目标、冲突、悬念钩子、出场人物
- **正文**：写稿 → 审稿 → 修稿（逐段差异对比）→ 定稿
- **续写与改写**：选段续写、润色、扩写、改成对话
- **资料与版本**：剧情伏笔、知识库、版本历史、导出 Markdown / TXT
- **写作 Skill**：导入自包含的 SKILL.md 提示词，绑定到规划、写稿、审稿、修稿阶段

功能的完整介绍与原版截图见 [原项目 README](https://github.com/EthanYoQ/Pagekin#readme)。

---

## 三、模型服务

软件不内置模型，需要配置模型服务后使用。沿用原项目支持的两种协议：

- **OpenAI 兼容协议**（DeepSeek、硅基流动、智谱、OpenAI、xAI、Ollama 等）
- **Google Gemini 原生协议**

网页版中，模型配置与凭据由服务端从环境变量读取，**不写入源码、不提交到仓库**。用户可在设置中填写自己的服务地址与 API Key（BYOK），或使用本运营方提供的额度方案。

> 调用云端模型产生的费用由用户与模型服务商结算；如使用本运营方提供的额度，则按网站公示的资费与条款执行。

---

## 四、数据与隐私

| 数据 | 存放位置 / 去向 |
| --- | --- |
| 作品、角色、蓝图、草稿、定稿 | 本服务的云端数据库（按账号隔离） |
| 导入的参考资料 | 存在你的作品中；仅在你发起生成时作为上下文发送给所选模型服务 |
| 模型配置与 API Key | 服务端加密存储 / 由环境变量注入，不落源码仓库 |
| 云端模型请求 | 提示词与上下文发给你选择的服务商 |
| 账号与订阅信息 | 本服务数据库，用于登录与计费 |
| 运营数据 | 不公开；本仓库只包含源码，不含任何用户数据 |

具体的数据留存、导出与删除方式，以网站上的《隐私政策》与《服务条款》为准。

---

## 五、从源码构建

需要 Node.js 22.14+ 与仓库指定版本的 pnpm（11.11.0）。

**网页版（本地开发，两个终端）**

```sh
git clone https://github.com/banceboy/my-novel-web.git
cd my-novel-web
pnpm install --frozen-lockfile --ignore-scripts

# 终端 A：RPC 服务（127.0.0.1:8787）
node --import ./server/register.mjs server/index.mjs

# 终端 B：网页前端（127.0.0.1:5180）
pnpm exec vite --config vite.web.config.ts
```

浏览器打开 `http://127.0.0.1:5180/`。`--ignore-scripts` 用于跳过 Electron 二进制下载（网页版不需要该运行时）；作品数据保存在服务端 `DATA_ROOT/projects`（默认 `./data/projects`）。

**桌面版（原样保留）**：`pnpm dev`（需另行准备 Electron 二进制）。

所有密钥通过环境变量或本地 `.env` 提供，`.env` 已被 `.gitignore` 排除，**请勿提交任何密钥**。

---

## 六、参与贡献

Bug 与建议请提交到本仓库的 Issues。原项目的问题请发到 [原项目 Issues](https://github.com/EthanYoQ/Pagekin/issues)，不要混在一起。

提交前请脱敏：不要上传 API Key、完整小说正文、用户数据或本机路径。

---

## 七、致谢与许可证

感谢 **EthanYoQ 及 AI Novel Writer / Pagekin 项目的所有贡献者**以 GPL-3.0 开源该项目，使本项目成为可能。

- 原项目：https://github.com/EthanYoQ/Pagekin
- 原项目许可：GPL-3.0
- **本项目许可：[GPL-3.0](LICENSE)**

本项目为原项目的衍生版本，依 GPL-3.0 第 5 条，整体继续以 GPL-3.0 授权，并标注了所修改的内容与日期。
