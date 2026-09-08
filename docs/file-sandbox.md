# 文件沙盒（oncall 安全共享）

把某个 bot 的 CLI 会话关进一个**按会话隔离的文件沙盒**，让你能把机器人放心分享给半受信任的人（oncall）：对方只能操作 agent + 一份项目副本，**碰不到你磁盘上的真实文件、密钥、别的会话数据**。

> 调研与威胁模型见 [`sandbox-oncall-research-20260605.md`](./sandbox-oncall-research-20260605.md)。
> 当前 scope = **只隔离文件**（Linux）。网络**不**隔离（`npm install` / `git fetch` 照常）；不防内核级容器逃逸——面向半受信任用户，不是面向恶意攻击者。

## 启用

- **dashboard（推荐）**：bot 默认设置面板（「默认进入 oncall 模式」那块）里的「**文件沙盒**」开关，一键开关、即时落 `bots.json`、下个新会话生效。配 oncall bot 时顺手勾上。
- per-bot 手动：`bots.json` 里给该 bot 加 `"sandbox": true`
- 临时/测试：环境变量 `BOTMUX_SANDBOX=1`（对该 daemon 的所有会话强制开）

Linux 依赖 bubblewrap（bwrap），macOS 用同一份 policy 经 Seatbelt（`sandbox-exec`）落地；两平台统一走 fs-policy 三档白名单。除 riff 外的本地后端（pty/tmux/zellij…）都会包裹。

> ⚠️ **前置条件：这台机器要先做过「lark-cli 按 bot 拆配置」** —— 见 [lark-cli 按 bot 隔离配置](./lark-cli-per-bot.md)。
> 白名单 deny 掉了共享的 `~/.lark-cli`，只放行本 bot 的 `~/.lark-cli-bots/<自己appId>`；没配过的机器上，沙盒内所有 `lark-cli` 命令会以 `not configured` / `operation not permitted` 失败。
> lark-cli 的密钥并**不**在 per-bot 目录里（那里只有 `config.json`），而在各平台共享的 keystore；两平台都是「整目录 deny + 只放行本 bot 自己的 master key 与 `appsecret_<自己>.enc`」，落点和文件名不同，见那篇的「平台差异」一节。

## Codex 的 per-bot 登录态

`codexAuthSync` 控制 Codex 使用全局登录态还是该 bot 的独立登录态：

```json
{
  "cliId": "codex",
  "sandbox": true,
  "codexAuthSync": "isolated"
}
```

- 缺省或 `shared`：保持旧版行为。非沙箱直接使用全局 `~/.codex`；沙箱把
  `CODEX_HOME` 指向 per-bot 目录，并在每次冷启动用全局 `~/.codex/auth.json`
  刷新其中的 auth 副本。全局重新登录后，下次冷启动自动同步。
- `isolated`：无论是否启用沙箱，都把 `CODEX_HOME` 指向
  `<BOTMUX_HOME>/bots/<larkAppId>/codex`，且从不读取或复制全局 auth。首次启动前执行
  `CODEX_HOME=<BOTMUX_HOME>/bots/<larkAppId>/codex codex login --with-api-key`。
  缺少凭证时 worker 只记录路径、策略和明确登录指引，不记录 key/token/auth 内容。

`isolated` 是显式迁移项，不会自动启用；升级后未配置的 bot 继续使用 `shared`。
私有 `auth.json` 在 daemon 重启、会话休眠/恢复和其它冷启动中保持不变。凭证文件
始终为 `0600`，符号链接或逃出 BOT_HOME 的 Codex 目录会被拒绝。

注意：`sandbox: false` 只表示不启用 OS 文件访问隔离。缺省的 `shared` 仍使用
全局 `~/.codex`；显式设置 `codexAuthSync: "isolated"` 则仍会使用独立
`CODEX_HOME`，但不会阻止该 CLI 读取其它宿主文件。

`bots.json` 的 per-bot `env` 在 Linux bwrap 中会随该 pane 的进程环境传入 CLI
（PTY 与 tmux 均覆盖），不会写进共享 tmux server 环境。它可以为自定义 provider
提供 endpoint/key，但不能替代 `requires_openai_auth = true` 时 Codex 选择的登录凭证。

## 工作原理

```
worker spawnCli
  └─ buildFsPolicy(cliId)                   adapters/cli/fs-policy.ts（单一真源，Linux+macOS 共用）
       ├─ baseline 预设（平台）+ 适配器声明的 authPaths/execPaths + botmux 内部注入 + 用户 sandboxPaths
       └─ 产出 deny-by-default 三档白名单：readWrite / readOnly / deny
  └─ prepareDirectSandbox(policy)           adapters/backend/sandbox.ts
       ├─ compileToBwrap()                  白名单编译成 bwrap argv
       ├─ 每会话目录 <dataDir>/sandboxes/<sid>/{outbox,shimbin,empties,empty}
       ├─ 写 botmux shim → /run/sbxbin（PATH 头，让沙盒内 botmux 走本 build 的 relay）
       └─ 预建 deny-mask 挂载点 + 持久化 cleanup manifest（fail-closed）
  └─ bwrap … -- <cli> <原 args>             把 CLI 关进沙盒
  └─ startOutboxWatcher()                   daemon 侧代投递（持凭证）
```

**沙盒模型**（2026-07-16「文件沙盒重构」，取代旧的 overlayfs+landing 模型）：

- 沙盒根是**全新 tmpfs**（`--tmpfs /`），`/tmp` `/run` `/var/tmp` `/dev/shm` 同为全新 tmpfs，`/dev` `/proc` 走 bwrap 原语——**不再把 `$HOME` 整体 overlay 挂回**。
- 只有白名单里的规则路径被 bind 进来：`readWrite` → `--bind`（真实读写直达宿主），`readOnly` → `--ro-bind`。白名单**之外**的一切在沙盒里不存在。
- CLI **直接写宿主真实路径**（在 readWrite 区内），没有 upper changeset、不需要 landing、没有 bridge 重定向——CLI 的 data dir 就是真实宿主路径。
- `deny` 规则用 mode-000 空源 `--ro-bind` 遮罩（真实内容不可读、只读）；outbox 这类「deny 内部的更深 readWrite carve-out」用一层每会话 `--tmpfs` 遮罩承接嵌套 `--bind` 再 `--remount-ro` 收口（tmpfs 写在内存、绝不落宿主）。
- `--unshare-user/pid/ipc/uts`，默认保留网络。

**per-CLI authPaths**：每个适配器用 `authPaths` 声明自己的认证/登录状态目录，沙盒把它们真实 `--bind` 进来，token refresh / login 直接持久化到宿主。默认窄（仅 auth）；CLI 若在 `$HOME` 下放 SQLite DB（codex 系），把整个状态目录加进 `authPaths`（否则该路径不在白名单 → 沙盒里不存在 → DB 打不开或拿不到 fcntl 锁）。macOS 用同一份 policy 经 Seatbelt（`compileToSeatbelt`）落地。

**角色库子树**：开沙盒的 bot 还会拿到 `<角色库根>/<自己 appId>/` 的 `readWrite`。`workingDir` 只覆盖**当前**角色目录，而角色系统要越过它：「有哪些角色 / 切换角色」枚举兄弟角色目录并读各自 `.botmux-dir.json`，「新建角色」写 `users/<openId>/<slug>/` 并复制库根的 `_role-protocol.md`，切换后「沉淀知识」写的是**新**角色目录下的 `knowledge/`。给 `readWrite` 而非 `readOnly` 正是因为最后一条——只读的话枚举和切换都正常，等到写知识才 EPERM。按 appId 限定（不是整个角色库根）：别的 bot 的角色目录、以及其中别的用户的私有角色，仍在白名单外。两道收口：① `botmux-roles` 与 `<appId>` 这**最后两段各自必须是真目录**，任一段是符号链接就不产生规则——否则被预先摆成指向 `~/.ssh` 或别的 bot 角色库的链接时，跟随解析会把链接目标当成本 bot 的子树授 rw（更上层如 `$HOME` 允许是链接，且必须 realpath，否则 canonical 匹配会 fail-open）；② 任何 deny（baseline / 机主 `sandboxPaths.deny` / mandatory）覆盖该子树时这条规则**整条不产生**——source rank 只裁同路径冲突，否则更深的 internal rw 会在被 deny 的库根上重新开个洞。

两件明确不在射程内、也不该只为这条规则加固的：**TOCTOU**（校验后到 spawn/bind 前把目录换成链接）与**挂载点**（末段是 bind/FUSE 挂载点仍算真目录）。两者都需要宿主级写权限，而拿到宿主级写权限的人本来就能改 `bots.json` 关掉沙盒；且策略里每条路径规则（`workingDir`、`botHome`、`cliDataPaths`…）都在同一时点做一次性检查，同样成立。

## botmux send 中转（关键）

`botmux send` 原本**直连飞书**（读 `bots.json` 拿密钥）。沙盒里没有 `bots.json`，所以：

1. 沙盒内 `botmux send` 检测到 `BOTMUX_SEND_RELAY`，把请求（argv + 内容文件 + 附件）写进 `outbox`，**不直连飞书**
2. daemon 侧 `startOutboxWatcher` 拾取请求，在**沙盒外**用真实凭证重跑 `send` 投递，结果写回
3. 附件被拷进 `outbox`（共享路径）后路径改写，host 侧才读得到

→ **所有飞书密钥全程不进沙盒**。

## no-transport 会话（apiOnly / HTTP virtual）跟随本地配置

no-transport 会话（core-only `apiOnly` bot、或 `http_async_*`/`http_wait_*` HTTP virtual 会话）**不被自动强制文件隔离**。它们的磁盘可读写范围和普通聊天会话一样，只由 bot 自己的 `sandbox`/`readIsolation` 配置决定：没配 → 不隔离（以同一 OS 用户身份对宿主文件有完整**读写**权，能读宿主 `bots.json`、也能改写宿主配置）；配了 → 照常隔离。

> 早先版本曾把「会话没有飞书 transport 通道」当作强制隔离条件（no-transport ⇒ 一律关进沙盒）。现已去掉这条写死的强制，改为跟随 owner 自己的配置——单 bot 部署 / 载荷可信时不再被无谓束缚。**多 bot 同机**、且担心某个半受信任的 no-transport 会话横向读到**兄弟 bot 的凭证**（`bots.json` 里各 bot 的 app secret）时，需 owner **显式**给该 bot 开 `sandbox`（或 `readIsolation` / 全局 `BOTMUX_SANDBOX=1`）。不开沙盒时 agent 拿到的是同一 OS 用户的宿主读写能力：不仅能读出各 bot secret，还能据此直接调 Lark API、或改写宿主上的任意配置——这正是「载荷可信」这一前提要承担的信任面。

两条与文件沙盒正交、不受此放宽影响的边界仍在：① **本 bot 自己的 transport secret 不进 CLI 进程 env**（gated on transport 能力）——这只关闭 **Botmux 内建的 transport 调用链**（本 bot 的 send 路径），**不构成恶意代码下的凭证隔离**：不开沙盒时 agent 仍能从磁盘 `bots.json` 读出 secret 自行调 Lark；② enrolled 设备上的 **device-credential 强制隔离**独立生效，与本开关无关。

## 落盘（改动去向）

fs-policy 模型下 agent 在 **readWrite 白名单区（含 workingDir）直接写宿主真实文件**——改动即时落盘，不再是「副本 + 补丁交回」。沙盒的作用是把可写面收敛到白名单：项目目录可写、认证目录可写，白名单之外（别的项目、别的会话、`~/.ssh`/`~/.aws`、`bots.json`、各类密钥）一律读不到写不了。

## 已验证（本机实测）

- 文件隔离：白名单之外的宿主密钥/家目录读不到，未授权路径不存在
- authPaths：codex `~/.codex`（含 SQLite DB）真实 `--bind` 进得去、能起；未授权的兄弟会话/项目进不去
- send 中转：沙盒内 `botmux send`（含文件附件）→ outbox → daemon 代投 → 真实到达飞书，全程零凭证入沙盒
- 真实 worker：codex 经 worker spawn 钩子在 bwrap 内正常启动运行
- macOS：同一份 policy 经 Seatbelt（`sandbox-exec -f <profile>`）落地，deny 路径被挡、正常路径可跑

## 后续

- 沙盒目录 GC / 生命周期
- 出口网络管控（升级到「不止隔离文件」时）
