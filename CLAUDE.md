# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini 等 20+ 种，完整列表见 README）。

## 构建 & 运行

```bash
pnpm build                # tsc 编译
pnpm daemon:restart       # 重启 daemon（自动恢复 active sessions）
pnpm daemon:logs          # 查看日志
```

- 每次修改后需要 `pnpm build` 然后 `pnpm daemon:restart`

### Orca-class Desktop + Mobile（`desktop/` · `mobile/`）

上游 Orca 已独立；**PC 与移动端均在 botmux 内维护**（勿再向 deepcoldy/botmux 推送本仓库改动）。

| 目录 | 角色 |
|---|---|
| `desktop/` | Electron IDE（与 Orca Desktop 毫米级对齐 vendor） |
| `mobile/` | Expo 移动端（配对 Desktop + Botmux bridge 会话） |

与飞书 daemon/CLI **独立安装、独立 userData**。

```bash
# Desktop
cd desktop
corepack enable && corepack prepare pnpm@10.24.0 --activate
pnpm install
pnpm exec electron-vite build   # 生产构建 main/preload/renderer → out/
pnpm dev                        # 开发热更（推荐日常）

# Mobile（需已配对的 Desktop runtime）
cd mobile && pnpm install && pnpm start
# 或：pnpm mobile:start / pnpm mobile:install（仓库根）
```

- 详见 `desktop/README.md`、`desktop/NOTICE`、`mobile/NOTICE`（MIT 归因 Lovecast / Orca）
- **新 Desktop 工作只改 `desktop/`**；`src/desktop` 是旧 webview 薄壳，已 deprecated
- **新 Mobile 工作只改 `mobile/`**
- Desktop 用 pnpm 10；根 CLI 仍用 pnpm 9 — 不要混在一个 lock 里
- **Botmux Sessions 桥**（右侧栏 Botmux / Settings → Botmux Sessions；mobile 经 `botmuxBridge.*` RPC）：
  - **多 host** 并行（local + N×SSH + **platform 隧道**），会话带 `hostId`
  - 连接状态持久化到 Desktop userData，启动后 SSH handlers 就绪自动重连
  - SSH 连接时尝试 **自动 Orca SSH connect**，并优先 port-forward
  - 会话列表约 12s 轮询；write-link 自动补 `?t=` token
  - **Ask-hooks**：`GET/POST /api/asks/*` + 侧栏 Needs answer + OS Notification
  - **PTY**：会话 **PTY** 按钮 → `botmux-term-relay.mjs` 进 Desktop xterm（实验）
  - 设计说明：`desktop/docs/botmux-bridge.md`；回归：`desktop/docs/capability-regression-matrix.md`
  - Runtime 别名：`BotmuxRuntimeService`（`desktop/src/main/runtime/botmux-runtime.ts`）
  - Mobile allowlist：`botmuxBridge.getStatus|listSessions|openTerminal|…`
- 本地包：`cd desktop && pnpm pack:local` → `dist/mac-arm64/Botmux.app`；冒烟：`pnpm smoke:desktop`
### 多 checkout：全局 `botmux` 指向谁

全局 `botmux` 命令走 `~/.botmux/bin/botmux` 瘦 wrapper，指向「最后认领的 checkout」的 `dist/cli.js`（daemon 启动时也会写）：

```bash
pnpm use:here             # 把全局 botmux 指向当前 checkout（仅改指向，不重启 daemon）
pnpm switch:here          # = build + use:here 一步到位
BOTMUX_NO_CLAIM=1 pnpm use:here   # 逃生阀：本次不认领
```

纯 `pnpm build` 故意不认领——review/验证别人 PR 时不会悄悄抢走全局指向。实现见 `scripts/claim-botmux-bin.mjs`。

### 改动需用户手动测试时 → 部署本 checkout 到 live daemon

当改动需要用户在飞书里**手动验证**（而非纯单测能覆盖），改完自测绿后执行：

```bash
pnpm switch:here && pnpm daemon:restart
```

这里故意用 `pnpm daemon:restart`，确保从当前 checkout 的 `dist/cli.js` 重启；不要依赖裸 `botmux restart`，它可能被 PATH 中更靠前的 npm 全局安装抢先。否则用户测的还是旧代码（典型症状：新加的命令/配置「找不到」）。⚠️ 这会让**所有 bot** 都跑本 checkout 的 build；测试/合并完成后记得切回 canonical checkout，以免 review worktree 被删后全局 shim 失效。

## 模块结构

- `desktop/` — Orca-class Electron Desktop（vendor import；main/renderer/runtime RPC）
- `mobile/` — Orca-class Expo Mobile（配对 Desktop；Botmux bridge sessions）
- `src/desktop/` — **legacy** 薄壳（webview + 全局 CLI 监管），勿再扩展
- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器，每种 CLI 一个文件（新增适配器的完整步骤见 `src/adapters/cli/CLAUDE.md`）
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `skills/` — 开箱即用的 Skill 定义 + installer
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`、`session-row-enrichment`（/api/sessions 展示增强：bot 头像 + git 仓库/分支）
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## 影响范围评估（改前必做）

任何改动落地前，先想清楚它波及的**其它平台、其它 CLI、其它会话类型**——本仓库是多 CLI × 多后端 × 多 IM 的横向架构，一处改动很容易踩到共用代码路径。默认「牵一发动全身」，主动排查回归面，别只测自己那条路。

- **跨平台**：改了 macOS 相关逻辑要同时考虑 Linux（daemon 实际跑在 Linux）；涉及路径、shell、进程、PTY、编码的代码尤其要两边都想到
- **跨 CLI**：改某个 CLI 适配器时，确认没动到 `adapters/cli/` 的共用基类/工具（`shared-hints`、`runner-input`、`registry` 等）或 worker 侧共用逻辑，否则可能连带影响其它 20+ 个 CLI。共用改动要在至少一个「别的 CLI」上验证仍可用
- **跨后端 / 跨会话类型**：改动涉及 `PtyBackend` vs `TmuxBackend`、话题会话 vs 群会话 vs adopt/restore、sandbox on vs off、v3 workflow vs 普通会话时，逐一核对受影响的组合
- **改公共层**（`core/`、`config.ts`、`bot-registry.ts`、`im/lark/`）时影响面最大——PR 描述里写清评估结论：动了什么共用路径、哪些平台/CLI/会话类型受影响、各自怎么验证的

## PR 规范

- 标题与 commit message 同格式：`type(scope): 中文描述`
- 描述用**中文说明**：改了什么、为什么、影响面（涉及哪些模块/会话类型）
- 附**实际测试验证**：贴出跑过的命令和关键结果（`pnpm build`、`pnpm test`、相关 e2e），不要只写「应该没问题」；需要 live 验证的先 `pnpm switch:here && pnpm daemon:restart` 在飞书里实测并注明结果
- UI 类改动（飞书卡片 / dashboard / web 终端）附**截图示意**，让 reviewer 不用跑代码就能看到效果

## Git 提交 & 发版规范

- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文
- 日常 `git commit` + `git push` 不会触发发版；打 `v*` annotated tag 并 push 才发版（**仅在用户明确要求时**），CI 自动从 tag 提取版本号发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段；tag message 用中文撰写，CI 会用作 Release body
- **正式版（latest）必须从 master 出**：CI 校验被打 tag 的 commit 含最新 `origin/master`。非 master 分支灰度用 `-canary.N`/`-beta.N`/`-rc.N` 后缀（CI 自动路由到对应 npm dist-tag，其它 `-` 后缀兜底到 `next`，都不污染 latest）；验证 canary：`npm i -g botmux@canary`
