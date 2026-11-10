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
| 2026-11-09 | 文件选择入口补齐：前端按通道声明选择器规格（小说 / 知识库文件 / 项目存档 / 角色头像 / Skill / 文件夹导入），删除不存在的幽灵通道；服务端按「用户 + 通道」隔离上传队列并按通道自动分配目录，用户取消时如实返回取消而不回退到服务端目录 | banceboy |
| 2026-11-09 | SSE 事件按用户定向：`server/electron-shim.mjs` 用 `AsyncLocalStorage` 给每次请求绑定用户，`broadcast` 携带目标用户；`server/rpc/events.mjs` 只投递给同名连接（无用户上下文的后台事件仍广播）；前端 EventSource 带用户标识并二次校验 | banceboy |
| 2026-11-09 | 导出下载改为 token 精确获取：`server/index.mjs` 比对每次 RPC 前后的导出目录快照（含分章子目录），仅为本次产出的文件签发 token 并放进响应；前端弃用「按通道名正则触发 + 取最新」，改为按 `exportTokens` 请求 `/api/download?token=…`，token 与用户绑定。涉及 `src/services/ipc-client.web.ts`、`server/index.mjs`、`server/electron-shim.mjs`、`server/rpc/events.mjs` | banceboy |
| 2026-11-09 | 真实会话鉴权：新增 `server/auth.mjs`、`server/auth-cli.mjs`、`src/components/auth/LoginGate.tsx`；scrypt 加盐口令、服务端不透明会话（落盘只存 token 的 SHA-256）、`HttpOnly + SameSite=Strict + Secure` Cookie、登录失败锁定、全接口 401 门禁与管理员账号 API；前端不再自报用户标识，401 自动切回登录页 | banceboy |
| 2026-11-09 | 多租户数据隔离：`server/index.mjs` 改为网关，`server/tenant-pool.mjs` 按账号 fork 独立 RPC 进程（`server/tenant-server.mjs`），每进程独享 `DATA_ROOT` 与模块级单例（当前项目连接、全局数据根），网关鉴权后反向代理并注入内部共享密钥；Windows 短路径根规避原项目 85 字符路径闸门 | banceboy |
| 2026-11-09 | 上传改流式并下线兼容端点：新增 `/api/upload/stream`（逐文件原始字节、批次提交、文件夹目录还原），删除 base64 `/api/upload` 与 `/api/download/latest`；服务端只认 `/api/download?token=…`，前端按响应 `exportTokens` 精确下载 | banceboy |
| 2026-11-09 | P3 配额与任务队列：新增 `server/quota.mjs`（每日 AI 调用额度、单文件与累计存储上限、全局并发闸门、每账号串行、排队超时），管理员可通过 `auth-cli` 或 `/api/admin/users` 调整；`/api/quota` 查询用量 | banceboy |
| 2026-11-09 | 生产运行形态与部署：`vite.web.config.ts` 增加 `dist-web` 产物；新增 `server/static.mjs`（单端口静态托管、gzip、缓存、CSP nonce 与安全头）、`Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.env.example`、`deploy/Caddyfile.example`、`scripts/web-smoke.mjs`；网页构建与部署不再需要 Vite dev server 或 Electron 运行时 | banceboy |
| 2026-11-09 | 安全加固与上线修复：网关与租户进程间共享密钥、CSRF 来源校验（生产不隐式信任开发源）、上传路径双重防穿越、健康检查脱敏、内部错误泛化、上传/导出目录启动清理、会话同步落盘（强杀重启不掉线）、favicon 内联消除 404；`index.html`、`src/main.tsx`、`package.json`、`.gitignore` 同步调整 | banceboy |
| 2026-11-10 | 修复账号管理热生效：`server/auth-cli.mjs` 是独立进程，此前改密码 / 禁用 / 加账号都要重启网关才起作用；`server/auth.mjs` 现在按账号库与会话库磁盘指纹惰性重载，管理操作立即生效并吊销该账号的旧会话（12 项实测通过）；本机回归测试账号已清理，只保留管理员账号 | banceboy |

> 本表在每次代码改动时补一行（由助手维护本文件，维护者统一上传）；每次发布新版本在仓库打对应 tag，保证线上版本与源码一致。
>
> 下列为**规划中、尚未实施**的内容，不计入上表：真实支付与账单、多节点水平扩展（会话/配额改为共享存储）、接入 KMS 或系统密钥环做凭据持久化加密、网站《隐私政策》与《服务条款》正式文本、ICP 备案与版权行。

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

网页版中，用户在设置页填写自己的服务地址与 API Key（BYOK），**按账号隔离保存在服务端数据目录，不写入源码、不提交到仓库**；部署方应启用磁盘加密与目录权限控制。也可由部署方通过环境变量预置，或使用本运营方提供的额度方案。

> 调用云端模型产生的费用由用户与模型服务商结算；如使用本运营方提供的额度，则按网站公示的资费与条款执行。

---

## 四、数据与隐私

| 数据 | 存放位置 / 去向 |
| --- | --- |
| 作品、角色、蓝图、草稿、定稿 | 服务端 `XST_TENANT_ROOT_BASE/<账号ID>/projects`；**一个账号一个独立进程与独立数据根**，进程内的当前项目连接、全局配置路径也不共享 |
| 导入的参考资料 | 存在你的作品中；仅在你发起生成时作为上下文发送给所选模型服务 |
| 模型配置与 API Key | 按账号隔离保存在该账号的数据目录；服务端不预置任何密钥。请启用磁盘加密、限制目录权限，并定期备份 |
| 登录口令与会话 | 口令以 scrypt 加盐哈希保存；会话是不透明 token，落盘只存其 SHA-256，Cookie 为 `HttpOnly + SameSite=Strict + Secure` |
| WebDAV 云备份凭据 | 网页版没有 OS 密钥环，按原项目的安全降级策略仅保存在会话内存中，进程重启后需重新填写，**不会明文落盘** |
| 云端模型请求 | 提示词与上下文发给你选择的服务商 |
| 账号与配额用量 | 服务端 `DATA_ROOT/auth`、`DATA_ROOT/quota` |
| 运营数据 | 不公开；本仓库只包含源码，不含任何用户数据 |

数据在账号之间不共享；账号、会话管理与配额由管理员通过 `server/auth-cli.mjs` 或管理员 API 维护。具体的数据留存、导出与删除方式，以网站上的《隐私政策》与《服务条款》为准。

---

## 五、从源码构建

需要 Node.js 22.14+ 与仓库指定版本的 pnpm（11.11.0）。

**网页版（生产部署，单端口）**

```sh
git clone https://github.com/banceboy/my-novel-web.git
cd my-novel-web
pnpm install --frozen-lockfile --ignore-scripts
pnpm rebuild better-sqlite3     # 服务端需要原生 SQLite；仍不下载 Electron 二进制
pnpm run build:web              # 产物 dist-web/
cp .env.example .env            # 必填：PUBLIC_ORIGIN、BOOTSTRAP_ADMIN_*、两个数据目录
pnpm start:web                  # = node server/index.mjs，页面与 /api 同端口
node scripts/web-smoke.mjs      # 部署自检（可带 SMOKE_USER / SMOKE_PASSWORD 做登录态检查）
```

浏览器打开 `PUBLIC_ORIGIN`，用首次启动创建的管理员账号登录。生产环境**必须**设置 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`，缺失时服务拒绝启动；建号后请从环境变量移除，后续用 `pnpm run auth:cli -- list|add|passwd|quota` 或管理员 API 维护账号。

- **HTTPS**：不要把 8787 直接暴露公网。用 `deploy/Caddyfile.example`（自动证书）或 Nginx 终止 TLS 后反代到 `127.0.0.1:8787`；`PUBLIC_ORIGIN` 设为 `https://` 后 Cookie 自动带 `Secure` 并启用 HSTS。
- **Docker**：`docker compose up -d --build`，凭据与数据卷见 `.env` / `docker-compose.yml`。镜像内已构建 `dist-web`、重建原生模块并配置健康检查。
- **Windows 路径**：原项目对作品根目录有 85 字符上限，`XST_TENANT_ROOT_BASE` 必须指向短目录（如 `D:\xst`）；路径过长时网关启动会打印警告，新建作品会被原项目拒绝。
- **数据**：账号/会话/配额在 `DATA_ROOT`，作品/导出/上传在 `XST_TENANT_ROOT_BASE/<账号ID>/`，两者都要持久化与备份。

**网页版（本地开发，两个终端）**

```sh
pnpm install --frozen-lockfile --ignore-scripts
# 终端 A：网关 127.0.0.1:8787
pnpm start:web
# 终端 B：前端 127.0.0.1:5180
pnpm exec vite --config vite.web.config.ts
```

开发模式首次启动会在日志打印一次性 `dev` 账号与随机口令（不写入任何文件）；访问 `http://127.0.0.1:5180/` 登录后使用。`PUBLIC_ORIGIN` 非 https 时 Cookie 不带 `Secure`，仅限本机使用。

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
