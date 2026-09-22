# 文件沙盒（oncall 白名单 + scratch 一次性）

BotMux 有**两种正交的文件沙盒**，一个开关三档：

| 模式 | 目标 | 可读 | 写 | 平台 |
|---|---|---|---|---|
| `off` | — | 全部 | 直达宿主 | 全 |
| `oncall`（缺省沙盒） | **保密**：分享给半受信任的人 | deny-by-default 白名单 | 白名单内直达宿主、即时落盘 | Linux + macOS |
| `scratch`（2026-09 新增） | **完整可弃**：owner 自己的一次性草稿环境 | 整个真实文件系统 | Linux：全部进 COW upper 宿主永不变；mac：$HOME/项目写进 APFS 克隆副本，系统路径只读 | Linux + macOS |

> scratch **不防恶意载荷**（agent 仍能读到磁盘上的密钥并经网络外发）；它防的是「写污染」——破坏性/试验性操作不影响真实机器。需要保密时用 oncall。

## 三模式的配置

- dashboard：bot 默认设置面板「文件沙盒」三选一分段控件（关闭 / oncall / scratch），scratch 下可选存储（内存即焚 / 磁盘可跨重启续跑）。
- `bots.json`：`"sandbox": true`（=oncall，向后兼容）、`"sandbox": "oncall"`、`"sandbox": "scratch"`、省略/`false`/`"off"`。
- 环境变量：`BOTMUX_SANDBOX=1`（=oncall，向后兼容）、`BOTMUX_SANDBOX=scratch`；未识别取值**报错拒绝启动**（绝不静默关沙盒）。

scratch 专属字段（均可选）：

```json
{
  "sandbox": "scratch",
  "scratchStorage": "tmpfs",
  "scratchTmpfsSizeMb": 0,
  "scratchDenyPaths": []
}
```

- `scratchStorage`：`tmpfs`（默认，upper 在内存，关盒/重启即焚）或 `disk`（upper 落盘，daemon 重启可冷恢复续跑，会话结束时删除）。
- `scratchTmpfsSizeMb`：tmpfs 容量上限（0=内核默认 ≈ 半内存）；大构建可调大或用 disk。
- `scratchDenyPaths`：在「读全盘」之上额外遮罩的路径（mode-000 空源，同 oncall deny 编译）。botmux 自身传输凭证（bots.json 及 sidecar、dashboard secret、每会话沙盒树）**固定遮罩不可配开**；`~/.ssh`/`~/.aws` 不遮（git ssh/云 CLI 要用），需要时自行加。

### macOS 实现（APFS clonefile 软链农场 + Seatbelt，与 Linux 的语义差异）

macOS 没有 per-process 挂载命名空间、Seatbelt 也没有「写重定向」原语。最初尝试整份克隆 \$HOME，在真机（日常 319 万文件账号）上被否：TCC 保护树（Containers/Application Support/CloudDocs）让 `cp` 确定非零退出，`clonefileat(2)` 在 iCloud 在线占位文件上无限挂起。最终用**软链农场 + 选择性 clonefile**：

- 克隆 HOME 里每个顶层条目默认是一条指向真实文件的**符号链接**（读取原生、零拷贝；TCC/iCloud 树永不遍历，挂死/权限问题从根上消失）。
- 只有 CLI 要写的状态做**真实 clonefile 副本**（`cp -c` 无 -p，COW：拷贝零数据块，只占改动）：所有顶层点目录（`.claude`/`.codex`/`.trae`/`.config`/`.cache`/`.npm`/…）和顶层 dotfile（含每次更新的 `.claude.json`）；**botmux 凭证根（\$HOME/.botmux 等）例外，保持软链**，靠 profile 对真实路径的 read+write deny 封口（Seatbelt 按软链解析后的真实路径匹配，11 种 symlink/hardlink 变体真机验证有效，硬链接也被 clonefile 切断）。非点目录（Desktop/Documents/Library）是软链，读原生、写被拒。
- 项目在 \$HOME 外时单独 clonefile 项目目录；跨 APFS 卷 fail-closed（dev 比对，绝不退化成字节拷贝）；每次 `cp` 有 5 分钟超时（云占位挂死不拖垮 worker）+ 按子树逻辑大小校验真 COW（异常大量占盘判失败）。
- 子进程 `HOME` 指克隆农场，`TMPDIR` 指每会话私有临时；Seatbelt 先全局 `(deny file-write*)`，放行克隆树/私有 tmp/真实 outbox，再放行 Foundation/cfprefsd 无视 HOME 硬写的主机缓存（/private/tmp、/private/var/tmp、/private/var/folders、~/Library/{Caches,Application Support,Logs}），**凭证 read+write deny 放最后保证最终匹配生效**。
- **与 Linux 的语义差**：① 系统位置（/etc、brew）写直接 EPERM 不进副本；② `~/Library` 与 /private/var/folders 这类经系统守护进程（cfprefsd/Foundation，走 mach 不经文件策略）落盘的缓存/日志/偏好**可能出现在真机**——不属于即焚保证，其中 claude CLI 的 per-project MCP 流量日志（~/Library/Caches/claude-cli-nodejs，含 sessionId/cwd）已专门加最终 write-deny（claude 对该 EPERM 无感知，真机验证不崩）；需要更强保密用 oncall。
- cleanup 先 `chflags nouchg` + `chmod -RN` 去 flags/ACL 再删（克隆不复制 ACL/flags，残根基本只含软链）；chdirInSandbox 持久化进 meta，reattach 不退化。
- `scratchStorage` 在 mac 上接受但忽略（APFS COW 本身只占改动量）。真机验收：`node scripts/scratch-sandbox-darwin-probe.mjs`（建议再跑一次真 claude E2E）。

## scratch 工作原理（已在 live 机实测）

```
host 侧（spawn 前，root 用内核 mount；非 root 用 fuse-overlayfs）:
  tmpfs 模式: mount -t tmpfs <slot>                          # 独立超级块
              mount -t overlay lowerdir=/ upper=<slot>/upper work=<slot>/work <dataDir>/sandboxes/<sid>/root
  disk  模式: mount -t overlay lowerdir=/ upper=<sRoot>/upper work=<sRoot>/work <…>/root
bwrap:
  --bind <merged> /            # 容器根 = 全根 COW 视图
  新鲜 /proc /dev /tmp /run /var/tmp /dev/shm
  deny masks（固定凭证集 + scratchDenyPaths）
  outbox /run/sbxbin shim / MCP socket 等穿透 bind（与 oncall 同一套）
  -- <cli>
```

关键事实：

1. **子挂载点递归 overlay**：`lowerdir=/` 时 overlayfs **不递归**挂载点（独立数据盘如 `/data00`、bind mount 在 merged 里会变空目录）。scratch 会枚举所有相关子挂载、各挂一层自己的 overlay 再 bind 进主 merged；无法 overlay 的子挂载只读透传，workingDir 落在其上时**硬失败**（绝不把真实项目读写穿透给宿主）。
2. **宿主零写入**：容器内写任何路径（含 `/etc`、`$HOME`、项目）都 copy-up；host 侧只在 `<merged>/…` 可见，真实路径逐项无变化。探针：`node scripts/scratch-sandbox-probe.mjs [--disk]`，真 CLI 端到端：`node scripts/scratch-real-cli-probe.mjs [--codex]`。
3. **daemon 侧读改写**：CLI 在容器里写的 transcript/rollout/events，宿主真实路径看不到，daemon/worker 统一从 `<merged>/<绝对路径>` 读（`scratchHostView`；transcript-resolver 按会话冻结的 scratch 状态自动 remap，unmount 时自然 ENOENT，**不回退读宿主真实路径**）。worker 是每会话进程，CODEX_HOME/TRAE_HOME 在进程内重指 merged、对容器子进程经 `--setenv/--unsetenv` 强制保持原生路径。
4. **resume**：活 pane（tmux 等）reattach 只重接 outbox watcher，绝不重挂；disk 模式重启后用同一 upper/work 重挂可冷恢复（实测数据完整）；tmpfs 模式机器重启后 upper 消亡，会话标记不可恢复，提示开新会话（不伪造新 upper）。
5. **生命周期**：正常关闭/sweep 按「子 bind → 子 overlay → 主 overlay → tmpfs 槽」逆序卸载并删目录；daemon 启动与周期 reconciler 调 `sweepOrphanScratchSandboxes`，/proc cmdline 活进程守卫 + 60s grace（沿用 oncall sweep 的事故教训）。
6. 非 root：自动走 `fuse-overlayfs`（需 /dev/fuse），storage 强制为 disk 语义；依赖缺失自动装失败则**报错不裸跑**。

scratch 与 oncall 共用：`botmux send` outbox 中转（凭证不进沙盒）、seccomp nice 隔离判据、owner env 冻结、proxy/CA env、shim/trusted 命令穿透 bind。互斥项与 oncall 相同（riff 远端、forge-traex、codexBrowser、existingAppServer、Codex instance routing、codexAuthSync: isolated、legacy readIsolation）。

---

# oncall 模式（fs-policy 白名单）详述

把某个 bot 的 CLI 会话关进一个**按会话隔离的文件沙盒**，让你能把机器人放心分享给半受信任的人（oncall）：对方只能操作 agent + 白名单内的项目/数据，**碰不到你磁盘上的真实密钥、别的会话数据**。

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

### Linux 隔离判据

环境变量只是路由提示，不是安全边界。完整 bwrap 和仅凭据隔离 bwrap 在启动 CLI
前都会安装一个很窄的 seccomp 规则：拒绝 `getpriority(PRIO_PROCESS, 1)`，其它
已支持 ABI 的系统调用保持原策略。内核会把规则传给 fork / exec 的后代；清空环境、
替换 HOME / 数据目录或再创建 namespace 都不能移除它。

CLI 通过 `os.getPriority(1)` 查询这个判据，只把成功且位于合法 nice 范围
`[-20, 19]` 的结果视为普通宿主。不能只匹配 EPERM：后代可以叠加 seccomp 规则
替换 errno，但不能恢复真实调用；即使伪造 errno 0，libc 返回的 nice 20 仍会被拒绝。
规则通过匿名管道传给 bwrap，不落可修改的配置文件，也不占用交互终端的 stdin。

确认处于隔离中的 `send` 不能因缺失 capability 或伪造进程标记降级为宿主直发；
daemon 不可达时，`delete` 等命令也不能退回离线写会话库。正常宿主 relay 不安装此
规则，普通宿主命令不依赖 HOME 中是否存在探针文件。

兼容边界：支持 Linux x64 / arm64 及其 i386 / ARM EABI / x32 调用约定；未知 ABI
或无法安装 seccomp 时拒绝启动，不静默关闭保护。查询 PID 1 的 nice 值会被拒绝，
查询当前进程优先级、调整优先级不受此规则影响。如果外层容器策略本来就禁止这个
查询，宿主命令也会按隔离处理，需要先核对外层策略，不能靠环境变量绕过。
隔离 pane 标记版本升至 15，旧 pane 必须冷启动一次才能获得新规则。

这是受信 CLI 的隔离分类防线，不代替文件和凭据隔离，也不承诺阻止修改 CLI 代码、
持有真实凭据后自行调用 API 或内核逃逸。规则继承与叠加语义见
[Linux seccomp 文档](https://docs.kernel.org/userspace-api/seccomp_filter.html)。

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
