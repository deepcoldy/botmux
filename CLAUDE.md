# botmux

飞书话题群 ↔ AI 编程 CLI 桥接。Daemon 监听飞书消息，每个新话题自动 spawn 一个独立 CLI 进程（Claude Code / Codex / Gemini 等 20+ 种，完整列表见 README）。

## 构建 & 运行

```bash
bun run build                # tsc 编译
bun run daemon:restart       # 重启 daemon（自动恢复 active sessions）
bun run daemon:logs          # 查看日志
```

- 每次修改后需要 `bun run build` 然后 `bun run daemon:restart`

**包管理器是 bun**（`packageManager: bun@1.4.0`，锁文件 `bun.lock`）。装依赖用 `bun install --frozen-lockfile`。

⚠️ `trustedDependencies: ["electron","node-pty"]` **不能删**：bun 默认**不跑依赖的生命周期脚本**，而 `node-pty` 要靠它 `node-gyp` 编出 `build/Release/pty.node` —— 少了这个，PTY 全废、编译版二进制也打不出来（`pty.node` 是被嵌进去的）。electron 的 postinstall 负责下载对应平台的二进制。

这个名单**刻意只有两项**（与 pnpm 时代的 `onlyBuiltDependencies` 逐字一致），别照着"顺手补全"往里加 esbuild —— 实测 esbuild 虽然有 postinstall，但它的二进制由 `@esbuild/<platform>` 平台包直接提供：空白目录里 `bun install esbuild` 不跑任何脚本，`esbuild --version` 照样输出 0.28.2。加进白名单只会让 bun 比 pnpm 多跑脚本、扩大两者的行为差异，与迁移目标相反。

注意与「用户怎么装 botmux」区分开：`install-diagnostics.ts` 的 `InstallKind`（含 `'pnpm-global'`）与 `maintenance.ts` 的自动更新说的是**终端用户的安装方式**，线上确实有人 `pnpm i -g botmux`。那些**不是**本仓库的构建工具链，不要跟着一起改。

### Bun 开发链路

daemon / supervisor / dashboard 都能直接跑 TypeScript，不必先 `bun run build`：

```bash
bun run daemon:bun           # bun src/index-daemon.ts
bun run supervisor:bun       # bun src/index-supervisor.ts
bun run dashboard:bun        # bun src/index-dashboard.ts
bun run build:bun            # 打自包含单文件二进制（scripts/build-bun-binary.mjs）
```

发版编译用的 Bun 版本**钉在 1.4.0**（见 `.github/workflows/`）。本地 bun 与它差太多时，编译产物的行为可能和 CI 不一致——排查编译态问题前先核对 `bun --version`。

**测试里 spawn 子进程必须走 `test/helpers/ts-runner.ts`**，不要写 `spawn(process.execPath, ['--import','tsx', …])`：那是 Node-only 形态，Bun 下 `process.execPath` 是 bun 二进制、`bun --import tsx` 不合法，子进程会全部起不来。helper 按运行时解析（Node 加 tsx loader、Bun 原生跑 TS）。片段里 import 仓库模块（`.js` specifier 实际是 `.ts`）时用 `spawnTsEvalWithRepoImports`，普通 `spawnTsEval` 在 Node 下会 ERR_MODULE_NOT_FOUND。

worktree 里也能直接用 bun，且**不额外占依赖体积**——只要不跑 install（见下节）。实测在「源码 + `node_modules` symlink 到 canonical」的 worktree 里，`bun src/cli.ts`、`bun run build`、`tsc`、`vitest`、`build:bun`（`pty.node` 经 symlink 解析，不复制）以及编出二进制跑 smoke 六项，全部正常。

### worktree 的 node_modules：共享还是独立（改前必读）

worktree 的 `node_modules` **形态不统一**，是逐个手工决定的，不是包管理器行为：

| 形态 | 体积 | 风险 |
|---|---|---|
| symlink → canonical | 0 字节 | 见下面两条 🔴 |
| 独立 `bun install` | ~800M | 安全，互不影响 |

**🔴 铁律：绝不在 worktree 里跑 `bun install`（历史上是 `pnpm install`，换成 bun 后同样禁止）。** 理由不是「浪费一次重装」，是下面两条实测出来的后果——而且它们**与包管理器无关**，bun 与 pnpm 在「穿透 symlink 写进被指向目录」上逐字同构：

1. **两个 worktree 同时 symlink 到同一个目标时，install 会失败并把共享目录删掉**：
   ```
   ENOTDIR: not a directory, mkdir '<worktree>/node_modules'
   → 目标目录被删除
   ```
   单个 symlink 时 exit 0、目标完好；双 symlink 指同一目标时 **pnpm** exit 236 且目标被清掉（同场景 **bun** exit 0、目标完好——这一项 bun 更稳，但别指望它兜底）。canonical 的 `node_modules` 是 ~50 个 live daemon 的依赖来源——`/proc/<pid>/maps` 里能看到它们 mmap 着 `node-pty` 的 `pty.node`。已在跑的进程靠 inode 存活不会立刻崩，但**任何重启、spawn worker、或新起 CLI 会话都会失败**，等于 fleet 不可恢复。

2. **共享依赖时，后装的 worktree 会静默覆盖先装的版本**：A 要 `ms@2.1.3`、B 要 `ms@2.0.0`、共享同一 `node_modules` → B 装完后 **A 解析到 `2.0.0`**，而 A 的 `package.json` 写的是 `2.1.3`。**exit 0，零报错零警告**，症状会在完全无关的地方冒出来。

所以：**依赖需求与 canonical 完全一致**时才用 symlink（省 750M）；一旦分支动了 `package.json` / lockfile，就该独立 install，并且**在 worktree 之外**做（比如把改动推上去让 CI 装，或在 canonical 上装完再 symlink）。

### worktree 的分支名：别用通用临时名（改前必读）

本仓 ~40 个 worktree 共享同一个 `.git/refs`——**分支名是全局的**：你在任何一个 worktree 里 `git checkout -B <name>` 都会挪动**所有** checkout 了该分支的 worktree 的 HEAD 指针。`verify-master` / `verify-merged` 这类通用临时名已被多个会话反复 reset（reflog 里一串 `Reset to origin/master`），是 fleet 级现状，不是个例。

**铁律：临时验证一律用 detached HEAD（`git checkout --detach <sha>`）或带 PR 号后缀的分支名（`verify-1198`），绝不用通用名。** 建之前先 `git worktree list | grep <name>` 查一眼有没有人在用。

为什么 `-B` 危险：`git checkout <name>` 在分支已被别的 worktree checkout 时会报 `fatal: ... already checked out` 拒绝；但 `git checkout -B <name>` **绕过这道保护**强制挪指针。被挪的 worktree 文件和 index 一个字没动，但 `git status` 会显示 HEAD 与 index 之间的**假 diff**（实测一次事故制造了 251 条假 staged），受害者可能据此做出破坏性的「修复」。

**怀疑自己的 worktree 被挪了指针，怎么验、怎么还原**：

1. `git reflog show <branch>` 找旧 SHA（看 `Reset to` 记录）；
2. `git -C <worktree> write-tree` 取 index 的 tree hash，与 `git rev-parse <旧SHA>^{tree}` 对比——**精确相等**就是指针被挪的指纹（index 是旧树、HEAD 是新树）；注意同样的症状（几百条 staged）也可能是真工作，必须逐个验、不能看数字下结论；
3. 还原：`git update-ref refs/heads/<branch> <旧SHA> <新SHA>`（**带 old-value 做 CAS**，避免并发下再踩）。

**未经确认不动别人的 worktree**——哪怕你「看出」它是假树，清理由该会话自己或维护者决定。

### 编译态（单文件二进制）注意

编译版里没有 `dist/` 落在磁盘上——模块图在虚拟只读的 `/$bunfs/` 下，`__dirname` 是 `/$bunfs/root`。所以**任何把 `__dirname` 拼出的路径写到磁盘、或交给别的进程用的代码，在编译态都是坏的**（那个路径进程外不存在，且 sh 里未转义的 `$bunfs` 还会被展开成空串）。曾因此把 install.sh 装在 `~/.botmux/bin/botmux` 的二进制**覆盖成 47 字节的壳**。判断运行形态用 `isStandaloneBinary()`（`src/core/self-spawn.ts`），子进程一律走 `resolveEntrySpawn` / `spawnWorker` re-exec `process.execPath`，不要拼 `dist/*.js` 路径。

注意 CI 的 smoke（`scripts/smoke-bun-binary.mjs`）用空 `bots.json`，而 daemon 在 0 个 bot 时会直接以 `Invalid BOTMUX_BOT_INDEX=0` 拒绝启动——**daemon 内的代码路径在前几项检查里结构上不可达**，别把「smoke 绿」当成 daemon 编译态已验证。

### 多 checkout：全局 `botmux` 指向谁

全局 `botmux` 命令走 `~/.botmux/bin/botmux` 瘦 wrapper，指向「最后认领的 checkout」的 `dist/cli.js`（daemon 启动时也会写；编译态下则改为 `exec` 二进制自身，且当该路径就是正在运行的二进制时会跳过写入，不再自毁）：

```bash
bun run use:here             # 把全局 botmux 指向当前 checkout（仅改指向，不重启 daemon）
bun run switch:here          # = build + use:here 一步到位
BOTMUX_NO_CLAIM=1 bun run use:here   # 逃生阀：本次不认领
```

纯 `bun run build` 故意不认领——review/验证别人 PR 时不会悄悄抢走全局指向。实现见 `scripts/claim-botmux-bin.mjs`。

### 改动需用户手动测试时 → 部署本 checkout 到 live daemon

当改动需要用户在飞书里**手动验证**（而非纯单测能覆盖），改完自测绿后执行：

```bash
bun run switch:here && bun run daemon:restart
```

这里故意用 `bun run daemon:restart`，确保从当前 checkout 的 `dist/cli.js` 重启；不要依赖裸 `botmux restart`，它可能被 PATH 中更靠前的 npm 全局安装抢先。否则用户测的还是旧代码（典型症状：新加的命令/配置「找不到」）。⚠️ 这会让**所有 bot** 都跑本 checkout 的 build；测试/合并完成后记得切回 canonical checkout，以免 review worktree 被删后全局 shim 失效。

## 模块结构

- `daemon.ts` — 薄编排层，组装各模块并启动
- `worker.ts` — Worker 子进程，通过适配器管理 CLI + PTY
- `server.ts` — Web 终端 HTTP 服务（xterm.js）
- `bot-registry.ts` — 多机器人配置加载 + 状态管理
- `config.ts` — 全局配置
- `adapters/cli/` — CLI 适配器，每种 CLI 一个文件（新增适配器的完整步骤见 `src/adapters/cli/CLAUDE.md`）
- `adapters/backend/` — 会话后端：`PtyBackend`、`TmuxBackend`
- `skills/` — 开箱即用的 Skill 定义 + installer
- `core/types.ts` — `DaemonSession` 是核心类型，所有模块从此导入
- `core/` — `worker-pool`、`command-handler`、`session-manager`、`cost-calculator`、`scheduler`
- `im/lark/` — 飞书：事件路由（`event-dispatcher`）、卡片（`card-builder`/`card-handler`）、API（`client`）、消息解析（`message-parser`）
- `utils/` — `idle-detector`（CLI 空闲检测）、`terminal-renderer`（xterm.js 截屏）、`logger`

## 飞书 owner 身份边界（setup/onboarding 改动必读）

这里曾发生过一次路径回归：Dashboard onboarding 已经防住跨应用复制 owner，后来新增的 scripted `setup add --create-app` 只做格式校验，又绕过了同一条身份边界。以后新增或修改创建 Bot 的入口时，必须遵守以下不变量：

- `ou_`（`open_id`）是 **app-scoped**：只对签发/观察它的飞书应用有效，绝不能从来源 Bot 复制到另一个 Bot。`BOTMUX_OWNER_OPEN_ID` 也只是 `BOTMUX_LARK_APP_ID` 视角下的 session owner，不是当前 turn 的发送者，更不是可跨应用复用的 owner 配置。
- 跨应用/新建应用的 owner 优先使用完整邮箱、手机号或 `on_`（`union_id`；仍需满足同租户/开发者条件）。新应用创建前，只能通过来源应用转换 daemon 已认证的当前 owner；任意其它 `ou_` 必须在创建应用前拒绝。
- Dashboard onboarding、交互式 setup、scripted `setup add` 以及后续任何新增入口，都必须复用 `src/setup/owner-identity.ts`，不要只校验格式后直接写 `allowedUsers`。在创建应用前归一化来源 owner，在写 `bots.json` 前用目标应用校验；暂时性网络/scope 错误保持 inconclusive，目标应用明确判定不可用时 fail closed。
- `BOTMUX_OWNER_OPEN_ID` / `__OWNER_OPEN_ID` 是 daemon 认证的 session 身份。新增 backend / runner / RPC 子进程时，必须通过 `applySessionOwnerEnv` 在可配置 env 合并完成后注入并冻结，不能让 bot/backend 配置覆盖它；ownerless session 必须同时删除两个变量。
- 回归测试必须覆盖 managed-Agent 场景（source app 的 `BOTMUX_OWNER_OPEN_ID=ou_*` 创建 target app），并验证真人 owner 在目标 Bot 下的 `canOperate`；Bot-to-Bot 消息通、权限 scope 通或参数格式合法，都不能证明 owner 身份正确。

## 影响范围评估（改前必做）

任何改动落地前，先想清楚它波及的**其它平台、其它 CLI、其它会话类型**——本仓库是多 CLI × 多后端 × 多 IM 的横向架构，一处改动很容易踩到共用代码路径。默认「牵一发动全身」，主动排查回归面，别只测自己那条路。

- **跨平台**：改了 macOS 相关逻辑要同时考虑 Linux（daemon 实际跑在 Linux）；涉及路径、shell、进程、PTY、编码的代码尤其要两边都想到
- **跨 CLI**：改某个 CLI 适配器时，确认没动到 `adapters/cli/` 的共用基类/工具（`shared-hints`、`runner-input`、`registry` 等）或 worker 侧共用逻辑，否则可能连带影响其它 20+ 个 CLI。共用改动要在至少一个「别的 CLI」上验证仍可用
- **跨后端 / 跨会话类型**：改动涉及 `PtyBackend` vs `TmuxBackend`、话题会话 vs 群会话 vs adopt/restore、sandbox on vs off、v3 workflow vs 普通会话时，逐一核对受影响的组合
- **改公共层**（`core/`、`config.ts`、`bot-registry.ts`、`im/lark/`）时影响面最大——PR 描述里写清评估结论：动了什么共用路径、哪些平台/CLI/会话类型受影响、各自怎么验证的

## PR 规范

- 标题与 commit message 同格式：`type(scope): 中文描述`
- 描述用**中文说明**：改了什么、为什么、影响面（涉及哪些模块/会话类型）
- 附**实际测试验证**：贴出跑过的命令和关键结果（`bun run build`、`bun run test`、相关 e2e），不要只写「应该没问题」；需要 live 验证的先 `bun run switch:here && bun run daemon:restart` 在飞书里实测并注明结果
- UI 类改动（飞书卡片 / dashboard / web 终端）附**截图示意**，让 reviewer 不用跑代码就能看到效果
- **不写飞书群内真人名字，也不写机器人协作花名/内部 review 编排**：commit message 与 PR 标题/描述进的是**公开 git 历史**，读者不需要知道群里谁参与、谁审的。① 不出现群成员真名——验证描述用中性客观表述（如「矮视口下成员/机器人行都能滚动可见」，而不是「某某/某某两行成员」）；② 不出现 `@Codex`、`Codex 复审`、`双审`、`首审`、`双审收敛` 这类多 bot 协作花名，验证只陈述**做了什么验证、结果如何**的客观事实，不写「谁审的」。（`Co-authored-by` git 署名 trailer 属正常署名规范，不在此列。）

## Git 提交 & 发版规范

- commit message 格式：`type(scope): 中文描述`。`type`（feat/fix/docs/chore 等）和 `scope`（模块名）保留英文，冒号后的描述用中文；同样**不带飞书真人名字与机器人协作花名**（见上「PR 规范」）
- 日常 `git commit` + `git push` 不会触发发版；打 `v*` annotated tag 并 push 才发版（**仅在用户明确要求时**），CI 自动从 tag 提取版本号发布 npm + 创建 GitHub Release
- **不要**手动修改 `package.json` 的 `version` 字段；tag message 用中文撰写，CI 会用作 Release body
- **正式版（latest）必须从 master 出**：CI 校验被打 tag 的 commit 含最新 `origin/master`。非 master 分支灰度用 `-canary.N`/`-beta.N`/`-rc.N` 后缀（CI 自动路由到对应 npm dist-tag，其它 `-` 后缀兜底到 `next`，都不污染 latest）；验证 canary：`npm i -g botmux@canary`
