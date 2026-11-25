# hc（herdr-core）后端设计

状态：实施中（opt-in，默认后端仍是 tmux）。依据：`/data00/hc-src/eval/01..06-*.md` 六份调研报告；hc 源码 `/data00/hc-src/herdr-core`（0.1.19）。

## 0. 目标与非目标

- 目标：新增 `backendType: 'hc'`，功能与 `TmuxPipeBackend`（tmux pipe 模式）对等；先按 bot 灰度，稳定后另起 PR 切默认。
- 硬约束：已在跑的会话一律不受影响。会话的后端在 spawn 时冻结（`sessionStamp ?? botType ?? defaultType`），本 PR 不改默认值。
- 为什么：tmux server 单线程，200 终端 5fps 下占 32% 单核，叠加轮询 59%；hc 同负载 8%/11%，20fps 下 tmux 66% 封顶，hc 33-36%。
- 非目标：本 PR 不自动下载 hc、不切默认、不迁移存量 tmux 会话。

## 1. 命名与选择

- `BackendType` 加 `'hc'`；bot 级 `backendType: "hc"` 或 `BACKEND_TYPE=hc` 选中。
- 不加进 `detectDefaultBackend()`。hc 不可用（无二进制、版本低于下限、系统不支持）时，selector 硬失败并给出可读原因，和 zmx 的 opt-in 闸门一致（`src/setup/ensure-zmx.ts`）。

## 2. botmux 私有 core

- **二进制发现**：依次尝试 `BOTMUX_HC_BIN` → `<botmux 数据根>/bin/herdr-core` → PATH 上的 `herdr-core` → PATH 上的 `hc`，取第一个 `--version` 输出 `hc X.Y.Z` 且版本 ≥ `HC_MIN_VERSION = 0.1.19` 的。不得用低于下限的二进制，也不得修改用户的 `~/.local/bin/hc`。
- **core 身份**：`HC_SESSION=botmux`，`HC_SOCKET` 优先使用 `$XDG_RUNTIME_DIR/herdr-core/botmux.sock`（要求绝对路径）。未设置时，Linux 用 `/run/user/<uid>/herdr-core/botmux.sock`，macOS 用 `<botmux 数据根>/hc/botmux.sock`，显式传入，并冻结进 target。
- **私有配置**：`XDG_CONFIG_HOME=<botmux 数据根>/hc/config`，其下 `herdr-core/config.toml` 由 botmux 写入：
  - `notes = false`：hc 不自己往终端里打字；
  - `headless = "160x50"`：与 `DEFAULT_RENDER_COLS/ROWS` 一致，daemon 重启的空窗期 CLI 不会被拉到 200x120；
  - `history_mb = 5`。
  用户自己的 `~/.config/herdr-core/config.toml` 不得影响 botmux core，比如其中的 `socket` 键。
- **control env**：`hcControlEnv(base)` 采用与 tmux server 全局 env 相同的清洗（`tmuxEnv()` + 托管键剥离），剥掉全部 `HC_*`，再钉上 `HC_SESSION`、`HC_SOCKET`、`XDG_CONFIG_HOME` 和 `XDG_STATE_HOME`。
  - `XDG_STATE_HOME = hcStateHome(socket)`，即 `<socket 去扩展名>.state`：只由 socket 决定，所有 daemon 对同一 core 算出同一个 state 目录。state 目录不同的 core 会在 bind 前 unlink 正在服务的 socket（上游 #200）。
  - 有意偏离报告 05：provider 凭据（`ANTHROPIC_*` 等）**不额外剥离**。tmux 下 daemon env 会经 server 全局表进入 pane，多剥会导致功能缺失；hc 的 core env 跨 restart 持久，语义与 tmux server 全局表相同。
- **拉起**：只走显式的 `herdr-core server start`，并带 control env。**每一次** hc CLI 调用都用 control env，这样即使触发了 hc 的连不上就自动拉起，env 也是干净的。
  - `XDG_RUNTIME_DIR == /run/user/<uid>` 时，hc 自己用 `systemd-run --user` 起 `hc-serve-*`/`hc-hold-*` 单元，独立于 daemon 的 cgroup，daemon 重启后程序仍在。macOS 由 hc 自己通过 launchd 启动 core。
- **版本**：连上后用 `server.status` 读出运行中 core 的版本；低于下限就拒绝创建，不自动 restart。

## 3. 持久 target

```ts
| { backendType: 'hc'; sessionName: string; hcSession: string; socket: string }
```

- `sessionName = persistentSessionName('hc', sid)`，即 `bmx-<sid8>`，作为 hc 终端名。
- 每个终端打上 labels `botmux=1`、`botmux_sid=<完整 sessionId>`。
- hc 解析名字时，有活的同名终端就取活的，否则取最近一个结束的同名终端。这正好对应 tmux 的 corpse 语义：reattach 到已结束的终端时，能读到 `exit_code`/`signal`。
- kill、rm 或 reattach 一个已存在的终端之前，必须先核对 `labels.botmux_sid === sessionId`。hc 状态丢失后 id 和名字都可能被复用。

## 4. 创建终端

`terminal.run` 的参数：

- `argv` 是 loader 加 pane-launch 私有文件路径。脚本内容与 TmuxBackend 交给 tmux 的完全一致（非 strict 用 wrapper，strict 用 `env -i`），所以秘密不进 argv，也不进 env overlay。hc 会把 argv 落盘并通过 API 公开。
- `cwd` 用绝对路径。
- `name` 和 `labels` 见第 3 节。
- `size` 取 worker 的 cols/rows。
- `no_parent: true`、`no_notify: true`。
- 禁止传 `keep`（丢失的程序会被换成裸 shell）、`rm`、`caller`、`parent`。

重试与接管（`runHcTerminalSync`）：

- 与 TmuxPipeBackend 的 new-session 一样，按 1 s、3 s 退避最多再试两次；只重试没有应答（超时）和 `unavailable`，hc 明确拒绝的（如首次就 `name_taken`）立即报错。`server start` 同样重试。
- core 收到 `terminal.run` 后，即使 client 已因超时被杀，仍会把终端建出来。所以同一次创建的每次尝试都带同一个随机 label `botmux_run`，失败后先按名字 `terminal.get`：带这个 label 的终端就是结果，不再启动第二个 CLI。
- 重试时遇到 `name_taken`，而按名字查到的终端不带本次的 label，就照常报名字被占用。

pane 脚本还要做三件事：

- 非 strict 模式下 unset `HC_SESSION`、`HC_SOCKET`、`HC_TERMINAL_ID`、`HC_TERMINAL_SOCKET`，与 TMUX/TMUX_PANE 同理，这几个键也要加进 `REDACTED_CHILD_ENV_KEYS`；`HC_SCOPE` 保留。
- 把 `XDG_CONFIG_HOME`、`XDG_STATE_HOME` 恢复成 worker 视角的原值；原来没有就 unset（`hcPaneXdgRestore`）。否则 CLI 会读写 botmux core 的私有配置和 state 目录。
- strict 模式靠 `env -i` 白名单，天然满足以上两点。

## 5. worker 侧 HcBackend（pipe 模式，`isPipeMode: true`）

**连接与订阅**
- 每个 worker 一条 framed 长连接：`hello {generation:1, framed:true}`，要求 features 里有 `automatic_input`。
- 对自己的终端做一次非 observe 的 `terminal.attach`，带 worker 的尺寸，`resumed:false`，也就是由 worker 主导尺寸，与 tmux pipe 模式相同。
- 用 `events.subscribe` 订阅自己的终端：`finished`、`lost`、`removed`、`size`、`restarted`。
- 帧格式：9 字节头 `[channel u32 LE][kind u8][len u32 LE]`。消费后对每个 stream 回 CREDIT（窗口 256 KiB），events stream 也要回。RPC 回复按 id 匹配。

**输出**
- attach 的 DATA 先写进进程内的 `@xterm/headless` 镜像（加载 unicode11），再分发给 `onData`。
- 首帧（以 0x18 开头的整屏重绘）只进镜像，不进 `onData`：worker 会用 `captureCurrentScreen` 做种子，与 tmux reattach 一致。
- 重连后的首帧走 `onScreenResync`。
- 之后出现的 paint 表示 core 丢掉了这个 viewer 没读走的输出，以重绘代替：积压超过约 4 MiB（`wire.rs`），或有人用 `hc read` 滚动读取（`stitch.rs`）。它的屏幕部分照常经过 `onData` 修复 worker 的屏幕，状态部分见下。
- 隐藏的 OSC 字节必须原样经过 `onData`，`capabilities.ts` 依赖它们。丢掉的输出补不回来，所以只靠隐藏 OSC 报告完成的 runner CLI 在 hc 上 fail closed（第 7 节第 8 条）。
- 新建终端的程序在首个 attach 之前就结束了（启动即报错退出），它的输出从未进过流：先经同一连接 `terminal.read {lines: 50}` 读出最近的屏幕与历史，写进 worker 日志并作为输出经 `onData` 交出，再按记录触发 exit。这对应 TmuxPipeBackend 的创建即订阅（#3448）与死 pane 带历史读屏（#3539），让 CLI 自己的报错进入 worker 日志尾、`claude_exit.logTail` 与崩溃卡片。只对新建终端这样做：reattach 的终端可能长期存在，与 tmux 相同。

**状态（OSC 7501）**
- 每个 paint 末尾带着程序当前的 7501 记录，包括首帧：无人 attach 时程序报告的状态只存在于这里。
- HcBackend 按 worker 解析器的规则，记下经 `onData` 送出的每条 7501（跨 chunk 的半条也算），即 worker 听到的状态。
- paint 里的记录只转发与之不同的；worker 听到过、paint 里已没有的记录补 `clear:id=…`，根记录没了补裸 `clear`。新实例（含 worker 重启后的 reattach）什么都没听到过，首帧的记录全部转发。
- 原样重复的记录不转发：idle detector 会把它当成刚报告的状态，在 worker 刚提交、程序还没响应时提前判定完成。
- 代价：丢失期间程序走完一轮、又回到 worker 上次听到的状态时，worker 听不到这一轮，由 idle detector 的 15 s 兜底与屏幕判定收尾，不会提前判完成。

**输入**
- `write`、`sendText`、`pasteText`、`sendBracketedPaste`、`submitBracketedPaste`、`sendSpecialKeys` 全部发 AUTOMATIC_INPUT 帧：不抢尺寸，也不触发 hc 的 3 秒安静期。
- tmux 键名在本地翻译成字节，DECCKM 状态取自镜像。bracketed paste 只在镜像里 DEC 2004 打开时才包 `ESC[200~ … ESC[201~`，与 tmux `paste-buffer -p` 一致。
- 首帧之前的输入按顺序排队，且先不编码：首帧之前镜像不知道程序的 DECCKM 与 bracketed paste 状态（reattach 时镜像还是空白的），首帧落地后再按镜像编码发出。
- 禁止在热路径上用 `terminal.send`/`keys`。
- 能证明输入没被接受时（未连接、终端已结束、socket 写失败）返回 false，供 `critical-control-key.ts` 重试。终端的结束由 core 主动推送（CLOSE 帧或 `finished` 事件），收到之后的一切写入与粘贴都返回 false、不发出，对应 tmux 写前拒绝死 pane（#3580/#3610）。
- `submitBracketedPaste` 的回车单独写入，与 TmuxPipeBackend 相同：Codex（crossterm）在边沿触发下每次只读 1024 字节，帧恰好填满一次读取时，同一次 pty 写入里的回车留在 tty 里直到下一次按键。hc 把每个输入帧到达 holder 时各写一次 pty，但两个背靠背的帧仍可能落进同一次读取（实测 Codex 0.167.0 下 9 个边界长度仍有 4 个滞留），所以回车等 core 应答同一连接上帧之后的一次往返（`terminal.get`）再发：core 先转发输入帧、再处理后续请求。这相当于 tmux 两次客户端调用之间的那一次往返；期间写入的输入排在回车之后。
  - 等待中本端 detach（`kill()`，终端继续运行，如 worker 随父进程退出）：回车与排在它后面的输入（如 `/stop` 已返回 true 的 C-c）在关闭 stream 之前按顺序立即写出。没有那次往返，回车可能与粘贴落进同一次读取，但仍会提交；丢掉则粘贴留在输入框里。已知限制（两类，都发生在 detach 与 worker 退出相邻的几毫秒内）：① **短输入也可能丢**——这些帧在 Node 侧虽已写入内核发送缓冲（`writableLength=0`），但 `teardown()` 随即 `socket.destroy()` 拆掉连接，高负载下 core 还没把帧从 socket 读走，回车或 C-c 连同粘贴一起丢失（真实 herdr-core 0.1.21、fence 隔离压测：`destroy()` 下 15 次中 3 次丢 C-c 或 Enter+C-c，含只丢 C-c 的部分丢失；改用 `socket.end()` 并保持事件循环、或 `end()` 后等 `close`，各 12/12 完整送达）。这与粘贴大小无关。② **超过 socket 发送缓冲的大粘贴**（约 200 KiB）——worker 紧接着 `process.exit`，未发出的部分连同粘贴丢失。修法是让 worker 公共关停路径在退出前做 graceful FIN（`socket.end()`）并有界等待 `close`，而不是立即 `destroy()` 或固定 sleep；本 PR 不动该公共路径，记为跟进项。
  - 等待中连接断开：回车与排在它后面的输入随连接丢弃（已返回 true），之后的 detach 也不补发，由 worker 的回执与原生 history 判定是否送达。不经新连接补发：粘贴帧可能已经到达，单独补一个回车可能提交别人此后输入的草稿。

**尺寸**
- `resize` 发 RESIZE 帧，同时调整镜像，并记下这个请求（attach 时的尺寸也算一个）。
- `size` 事件是自己的某个请求时，确认它以及更早的请求；之后还有更新的请求在路上，这个尺寸就已过时，不调整镜像，也不触发 `onPaneSizeChange`。连续两次 resize 时 core 的第一个 `size` 事件会晚于第二次 resize 到达。
- 其他尺寸来自别的 viewer：调整镜像并触发 `onPaneSizeChange`。

**同步读屏**（全部由镜像提供）
- `captureCurrentScreen` 返回历史加屏幕的 ANSI，`captureViewport` 返回可见区 ANSI，输出形态与 tmux `capture-pane -e` 一致。
- `getPaneSize`、`capturePaneInputModes` 和 `captureInputState` 的格式与 TmuxPipeBackend 相同。
- `captureViewportAsync` 直接返回 `Promise.resolve`。
- `captureViewportCells`（#3626）：`ScreenMirror.viewportCells` 用 tmux 那条路径同一个 `parseCapturedScreenRows` 解析镜像的 `capture-pane -e -p` 形态，dim/inverse 保留；镜像跟随 core 的每个尺寸（包括 web 或本地 viewer 改的），闲置压缩与保活判断输入框用的就是 pane 的真实屏幕。首帧前或终端已结束为 null，且不像其它读屏那样欠 worker 一次 resync。
- ANSI 序列化器自己写：cell 转 SGR，覆盖 16/256/RGB 色和宽字符，参考 `src/utils/screenshot-renderer.ts` 的 cell API 用法，不新增依赖。

**退出**
- 来源有两个：core 发来的 CLOSE 帧，载荷 JSON 为 `{reason, exit_code, signal}`；或 `finished` 事件。两者归一后触发一次 sticky 的 `onExit(code, signal)`，晚到的订阅者也会收到回放。
- 以下情况 `exitedBecauseServerReplaced()` 为 true，不消耗第二层 fresh 预算：reason 属于 `holder_lost`/`stopped_by_restart`/`server_stop`/`host_shutdown`；core 换了且没有这个终端（见“断线”）；不可达超时升级。
- 同样这些情况下 `exitedBecauseServerLost()` 给出 `{backend: 'hc', kind, socketName: <core socket>}`，worker 经 `claude_exit.backendLost` 上报，daemon 的 `BackendOutageCoordinator`（#3610）把同一 core 上的全部会话折成一次故障：不计崩溃次数、一个 canary、core 应答后再分批重启、每话题一张卡片、一份 owner 汇总。kind：`holder_lost`、`stopped_by_restart`、换了的 core 没有这个终端为 `replaced`（core 在应答）；`server_stop`、`host_shutdown` 为 `gone`；不可达超时为 `unreachable`。故障按 `backend + socket` 归并，hc core 与 tmux server 即使 socket 字符串相同也不合并；`serverUp` 走 `queryHcCoreStatus`，只连接、从不拉起 core（canary 的 spawn 才会按 control env 拉起）。tmux 的 `gone` 是从空 socket 推断的（server 最后一个会话正常退出也会留下空 socket），需要另一会话旁证；hc 的 `gone` 是 core 自己给的结束原因，core 也不会因最后一个终端结束而退出，所以不需要旁证。

**断线**
- core 崩溃或 restart 时程序仍然活着。按退避重连；socket 连不上就用 control env 执行 `server start`，新 core 会 adopt holder。
- 重连后先 `server.status` 读出 core 的 pid 与 `core.id`（只有 state 被清空才重置），再用 `terminal.get`：终端还活着就重新 attach 并 resync，并记下这个 core；已结束就按记录触发 exit。
- 不存在，或 address 已换成别的终端时，只有应答的 core 不是上次确认终端存活的那个（pid 不同，或 `core.id` 变了）才按 serverReplaced（`replaced`）退出。同一个 core 进程、同一份 state 不会丢终端，说明终端是被人移除的（如断线期间 `hc kill` + `hc rm`），按普通退出处理，不报 server 丢失。首次 attach 与 spawn 时 `server start` 报告的 pid 比较。
- worker 新实例 reattach（spawn 时同步 `terminal.get`）遇到 not_found 没有可比较的 core，仍按 `replaced`。
- 连续 60 秒不可达才升级，对齐 tmux 的 `SERVER_OUTAGE_ESCALATE_MS`。之后若旧终端被 adopt 回来，由孤儿回收负责 kill。

**生命周期**
- `kill()` 只断开连接，终端保留，与 tmux 的 detach 语义相同。
- `destroySession()` 先核对 label，再 `terminal.kill` 和 `terminal.rm`。scope 的 stop 照旧由 worker 负责。
- `getChildPid` 与 `getStablePanePid`（#3600）都返回终端记录里的 `pid`，即 pane 根进程，也就是 scope 监督者 sh；终端结束后返回 null。worker 把 `cliPid` 改写到 wrapper 的后代时它不跟着变，重连核对的也是同一个终端。它是本机进程，worker 的 `process_start` 运行时身份由它推导（真实 hc 测试覆盖）。
- `isPaneAlive` 为“尚未收到退出且已解析出终端 address”。
- hc 没有 copy mode。web 端滚动走 `localTerminalBackend`，浏览器自己保留 scrollback；半页滚动映射成 PgUp/PgDn 或 no-op。

## 6. daemon 侧同步操作

- `probe`、`kill`、`list` 都 spawnSync hc CLI，带 control env、`--json`。
  - probe 用 `get <name>`：live 记为 exists；finished 或 not_found 记为 missing；二进制缺失或 core 起不来记为 unknown。
  - core 不在跑、目录里也没有 holder socket（`hcCoreAbsent`）时不执行 hc，直接答 missing / 空列表：core 退出时删自己的 socket，holder 在最后一个程序结束后删自己的 socket，两者都不在就不可能有程序在跑。否则 hc 会用调用方的 env 拉起一个空 core（CLI 的 `botmux list`、陈旧 target 的探测都会这样），之后该 core 上的每个程序都继承那份 env。
  - socket 残留（core 被杀）或有 holder 时照常执行 hc：连不上就用 control env 拉起，新 core adopt holder，答案仍是权威的。
- 批量 probe 用一次 `ls --all`；列表经 `hc connect` 调 `terminal.list {all, labels: {botmux: '1'}}`，因为 `ls --json` 不带 labels。
- 孤儿回收（daemon 启动时）：只处理 `botmux_sid` 属于本 store 的终端。不属于任何活跃会话、或 CLI 已变更的，核对 label 后 kill+rm；其他 daemon 的终端一律不碰。

## 7. 接线范围（不得静默落入其他后端分支）

每个点名后端的位置都要么有 hc 实现，要么写明 N/A 或通用的理由，要么可读地拒绝；`'hc'` 不得掉进 `else` 被当作 herdr/zmx/zellij。决策：实现＝有 hc 分支；通用＝与 tmux pipe 走同一通用路径（无后端分支，或 hc 已在白名单）；N/A＝不适用；拒绝＝fail closed 并给出原因。

| 位置 | 决策 | 理由 |
|---|---|---|
| `types.ts` `BackendType`、`PersistentBackendTarget`；`herdr-backend.ts` `PersistentBackendType` | 实现 | target 见第 3 节，`HcTarget` 是它的 Extract |
| `persistent-backend.ts` 全部分发（name、target、key、probe、批量 probe、kill、after-kill、resolve、shutdown） | 实现 | key 含 socket；批量 probe 每个 core 一次 `ls --all`；kill 只走 `killHcTerminal`，mismatch/unknown 抛错 |
| `shouldRejectPersistentPostKillProbe`、`isSuspendableBackendType` | 实现 | 与 zmx 同为严格（unknown 也拒绝）；可挂起 |
| `probePersistentSessions(socketDir)` | 通用 | socketDir 只给 zmx；hc 查本 env 的 botmux core |
| selector `selectSessionBackend`、`resolveHcBackendGate`、`backendGateUserMessage` | 实现 | 不可用即硬失败；记录的终端存活或 unknown 时钉在原 core（reattach bias），missing 时换到当前默认 core |
| worker `spawnCli` 闸门、frozen probe、post-kill、read-isolation 重建、`persistentPaneInfo`/`persistentPaneProbe` | 实现 | `resolvedHcSessionProbe` 贯穿；只有 missing 算终端已不在 |
| `read-isolation.ts` 冷机 tie-break | N/A | 只为 tmux 的 unknown；hc 的 missing 已权威（第 6 节） |
| worker strict env 拒绝表（herdr/mojo/riff/remote-runner） | 通用 | hc 与 tmux 同用 pane-launch 的 `env -i` |
| 沙盒：`useBwrapArgsFile`、`isolationCapableBackend`、wrapper-in-sandbox、`buildsSandboxWrapperLaunch`、不可沙盒硬错 | 实现 | hc 与 tmux 同属本地 pane 后端 |
| `restartCliProcess` restart jitter | 实现 | 一个 core 服务全部会话，失联时它们同时重启 |
| follower grid、`applyHerdrWebBindingResult`、web 输入不限速白名单 | 实现 | pipe 模式由 worker 主导尺寸；一次写入是已开连接上的一帧 |
| TraeX 首个 prompt 的原生 viewport | 实现 | `captureViewportAsync` 读镜像 |
| crash 诊断 park/destroy/web attach（worker），回收与 suspend 前核验（worker-pool） | 实现 | `hcDiagnosticTarget`：`bmx-diag-<sid8>` 在会话自己的 core 上，按 label kill |
| web 快照 `relayHcWebSnapshot` | 实现 | 同 tmux 的快照 relay |
| Codex：cleanup archive、native model launch、effort（worker 与 worker-pool）、model selection、deployment continuation、cot resume、`cancelDeploymentForTerminalInput`、app-control 名字与 locator | 实现 | 与 tmux 同 |
| `hcTerminalPanePid`（codex RPC） | 实现 | 只认 live、同名、label 属于本会话的终端 |
| TraeX topic effort restart | 实现 | 与 tmux 同 |
| prompt-cache keepalive、zero-prompt、prompt-hook、auto-compact、workspace metadata、VC 隔离、dispatch launch contract | 实现 | 加入本地后端白名单 |
| worker 中只排除 zmx 的屏幕权威性判断 | 通用 | hc 镜像与 tmux capture 同样权威 |
| `isPipeMode`、`seedBackendScreen`、`getAttachInfo`、`settleCurrentScreen` 的调用方 | 通用 | HcBackend 实现同一接口 |
| program-status relay（OSC 7501 握手）、`relayMayFrontPane` | N/A | hc 自己应答 7501 与 DA1 |
| herdr agent、`forceRemoteScroll`、adopt-picker | N/A | herdr 专属 |
| `codexRpcInput` | 拒绝 | `assertCodexProfileConfig` 对 tmux 与 hc 同样 `unsupported_rpc` |
| 关闭前的 authoritative teardown | 通用 | 只覆盖 zmx；tmux 与 hc 都保留 worker 侧的优雅 teardown |
| daemon 启动清理 `cleanupHcTerminals` | 实现 | 按 core 列 `botmux=1` 终端，只杀 `botmux_sid` 属于本 store 且非活跃（或 CLI 变更）的；socket 不在的 core 不列 |
| orphan-tmux-reaper、daemon 的 tmux server 回收、orphan-session-reaper | N/A | 只管 tmux server；hc core 被全部 daemon 共享，不能按 server 回收 |
| VC meeting、device isolation、dashboard read-isolation probe、explicit backing cleanup、CLI 不一致时关闭 | 实现 | 按 target 探测，按 sessionId kill |
| session-env-host 的 `tmuxSocket` 显示、tmux server 全局 env 视图 | N/A | hc 没有 server 全局表；core env 就是 control env |
| ephemeral-pool 及其他 child env | 通用 | `HC_SESSION`、`HC_SOCKET`、`HC_TERMINAL_ID`、`HC_TERMINAL_SOCKET` 进 `REDACTED_CHILD_ENV_KEYS` |
| bot 配置（store、editor、setup 参数、dashboard 页面、agent profiles、backend-type-store） | 实现 | 可显式选用，不进默认探测 |
| setup 依赖检查、`shouldHardFailStartupForMissingTmux` | 实现 | 全部 bot 都是 hc 时缺 tmux 不阻止启动 |
| `backend-availability` | 实现 | 只查二进制与路径，不拉起 core |
| CLI `list`、离线 delete、`__hc-attach-managed`、picker attach、local-cli-opener | 实现 | 查询直连 socket，不拉起 core；`hc attach` 带一个建不出来的 `XDG_STATE_HOME`：hc 拉起 core 前要先建 state 目录，所以 core 在查询与 attach 之间停掉时 attach 失败，不会用人的交互 env 拉起 core |
| runner CLI（mira、mir、dsh、minimax） | 拒绝 | 见下第 8 条 |
| `session-list-wake` | 拒绝 | probe 为 unknown 时不唤醒：hc 的 attach 身份由 label 决定 |
| MCP gateway 复用 pane | 拒绝 | probe 为 unknown 时拒绝启动（同 zellij、zmx）；tmux 只在 gate 时也是 unknown 才拒绝 |
| Codex 实例池（`normalizeCodexInstancePool`、`refuseUnverifiableInstanceBinding`） | 拒绝 | 见下 |
| core-only 模式（`bot-registry`、`cli`） | 拒绝 | 见下 |
| `captureViewportCells`（#3626 闲置压缩、保活按真实屏幕判断输入框） | 实现 | 见第 5 节“同步读屏”；真实 tmux 对等测试逐 cell 对比 |
| `getStablePanePid`（#3600 wrapper PID 重试围栏） | 实现 | 见第 5 节“生命周期” |
| `exitedBecauseServerLost`、`claude_exit.backendLost`、`BackendOutageCoordinator`、worker-pool 的 `serverUp` 与 `gone` 旁证（#3610） | 实现 | 见第 5 节“退出”；卡片与 owner 汇总写 hc core 而非 tmux server |
| `executionObserverSupported`（#3330 历史轮次观察授权） | 实现 | Codex 在 hc 终端里跨 worker 重启存活，与 tmux 相同；宿主（`runtime.identity.backend`）与 worker（`effectiveBackendType`）用同一谓词，两侧对 hc 都是 `'hc'` |
| `TRAEX_CONTINUATION_BACKENDS`（#3315 自动换模续接当前轮） | 实现 | hc 跑 botmux 自己的 pane 启动器，CLI 是本机进程，`process_start` 身份可证；宿主与 worker 共用同一集合 |
| `supportsKimiCacheExpiryAutoCompact`（#3403） | 实现 | 菜单指针核对读 `captureViewport`，即镜像，属权威屏幕 |
| dashboard `codexArchiveInapplicableReason` | 实现 | 与 daemon 侧 `ownedLocalCodex` 一致，测试对每个后端从两侧取值比较 |
| 冷启秒退保留 CLI 报错（#3539）、创建即订阅启动输出（#3448） | 实现 | 首帧本身带屏幕与 7501 状态；首个 attach 前就结束的新终端见第 5 节“输出” |
| 写前拒绝死 pane、死 pane 拒绝一切粘贴（#3580/#3610） | 通用 | 结束由 core 推送，之后输入一律 false；hc 没有共享 paste buffer，也没有 tmux ≤3.3a 往死 pane 粘贴使整个 server 崩溃的问题，`pane-died` 关输入钩子 N/A |
| 粘贴帧填满 1024 字节时回车单独写入（Codex） | 实现 | 见第 5 节“输入”；真实 Codex 0.167.0 + hc 0.1.19 的 e2e 覆盖 |
| tmux 存活探测降载（#3580 单条异步探测、空闲降频） | N/A | hc 不轮询，结束、尺寸由事件流推送 |
| tmux socketRoot（#3529）、tmux 升级提示、预编译包、切换候选（`tmux-switch-candidates` 只挑 tmux target） | N/A | tmux 专属；hc 的 socket 冻结在 target，control env 取自 worker 自身 env |
| herdr 冷恢复先关旧 pane（#3621）、`retryPaneAgentStart`（#3243）、瞬断保留 pane 身份（#3624）、`herdrPidRetryMaxElapsedMs` | N/A | herdr 专属；hc 的 pid 在创建时同步拿到，重连不变 |
| `getRuntimeIdentity` | N/A | 只有远端后端（riff、mojo）提供；hc 由 worker 按本机 `process_start` 推导 |

**fail closed 的 tmux 专属能力（切默认前要补齐的对等缺口）**

1. Codex 实例池：配置校验拒绝 hc bot，worker 拒绝启动带实例绑定的 hc 会话。HcBackend 还不能在接管终端前核对实例绑定（`HC_INSTANCE_LABEL` 目前只有 HcBackend 读写）。
2. core-only 模式：拒绝 hc。
3. adopt（接管外部 pane）与 copy mode：hc 没有对应物；web 端滚动由浏览器 scrollback 承担。
4. `botmux list` 唤醒 probe 为 unknown 的 hc 会话：拒绝。
5. MCP gateway：pane probe 为 unknown 即拒绝，比 tmux 严。
6. 重启后的历史种子深度：镜像 scrollback 为 `HC_MIRROR_SCROLLBACK_LINES = 3000` 行（每会话约 10 MB），tmux 为 50 000 行。
7. pane 环境：`TERM`/`TERM_PROGRAM` 与 tmux 不同；strict env 不带 `BOTMUX_HC_BIN`。
8. runner CLI（mira、mir、dsh、minimax）：`backendCliCompatibilityError` 拒绝 hc，worker 启动时报出可读原因。它们的 final/thread 事件只走终端输出里的隐藏 OSC 777，而 hc 会丢掉 viewer 没读走的输出（积压超过约 4 MiB、`hc read` 滚动读取、core 重启期间），只用重绘补回屏幕。tmux 的 pipe-pane 不丢。codex-app 走签名 socket（PR #597），不受影响。7501 状态能从重绘里恢复（第 5 节），文本扫描类信号（如 kiro 会话 id）落在丢掉的输出里时同样会丢。

## 8. 测试 fence（先于任何真实 hc 测试落地）

- 每个测试文件准备一个存在的、短的、私有的 `XDG_RUNTIME_DIR`，形如 `/tmp/bmhc-XXXX`，以满足 107 字节限制，同时让 hc 跳过 systemd 路径。
- 设置唯一的 `HC_SESSION`，以及私有的 `XDG_STATE_HOME`、`XDG_CONFIG_HOME` 和 HOME；删除全部 `HC_*`。
- PATH 最前面放 `hc`/`herdr-core` shim：按 hc 的规则解析 socket，凡是落在 `/run/user/<uid>/herdr-core/` 下就拒绝。
- vitest、bun 和 `fenced-run` 三处都要挂，由 `vitest-config-fences.test.ts` 断言。
- `fenced-run` 不再删掉 `XDG_RUNTIME_DIR`，而是换成 fence 的私有目录：删掉的话 hc 会回退到 `/run/user/<uid>`，可能抢走真实 socket（bind 前无条件 unlink）。
- 真实 hc 集成测试通过 `BOTMUX_HC_BIN` 指定二进制；没有满足下限的二进制时 skip。

## 9. 灰度与切默认

- **灰度**：把 hc 二进制放到 `<botmux 数据根>/bin/herdr-core`，给一个 bot 配 `backendType: "hc"`。
  - 先确认该 bot 的活跃会话都已带 `backendType: 'tmux'` stamp。无 stamp 的旧行会跟随 bot 类型变成 hc，reattach 时就丢失 pane；缺的先补。
- **切默认**（另起 PR）：先给所有未关闭且无 stamp 的行补 `'tmux'`；让 tmux reaper 和启动检查与 `config.daemon.backendType` 解耦；补上 ensure-hc 的自动安装（manifest 加 sha256）；最后改 `detectDefaultBackend()`。

## 10. 上游（herdrdev/herdr-core）

- bug 走 PR（先复现、带测试）：
  1. observer 的 attach/detach 无条件调用 `apply_size`，把 run 时指定的尺寸打回 headless（`viewers.rs:94,322,330`）。已提 [herdrdev/herdr-core#199](https://github.com/herdrdev/herdr-core/pull/199)。
  2. bind 前无条件 unlink，state 目录不同的 core 会抢走正在服务的 socket（`platform/unix.rs:61-63`）。已提 [herdrdev/herdr-core#200](https://github.com/herdrdev/herdr-core/pull/200)；在它合入前，botmux 同时固定 `XDG_STATE_HOME` 规避。
  3. attach 带 `history` 时，历史与屏幕接缝处多推一行空行进 scrollback（先 CRLF 再推 rows 个 LF，差一）。待复现后提 PR。
- feature 先开 issue 讨论：禁止自动拉起的开关、`terminal.run` 删除 env、不抢尺寸的 typing viewer、无 viewer 时保留上次尺寸、不丢输出的 viewer（积压时反压而不是丢弃重绘，runner CLI 解禁的前提）。`read --ansi` 已有 #188。

## 11. 基础模块 API

已落地于 `src/setup/ensure-hc.ts` 与 `src/adapters/backend/hc/`。HcBackend 只做组合。下文的协议事实均在 hc 0.1.19 上实测过。

**发现与 core**（`ensure-hc.ts`、`core.ts`）
- `probeHcAvailability({env?}) → {ok:true, bin, version} | {ok:false, reason}`：同步执行，成功结果会缓存，失败 30 秒后重试。下限为 `HC_MIN_VERSION = [0,1,19]`。`isHcEnvKey(key)` 匹配 `HC_*` 和 `_HC_*`。
- `hcCorePaths(env?, {core?}) → {session, socket, holderSocket, runtimeDir, configHome, stateHome}`：
  - 不传 `core` 时返回本 env 的 botmux core。session 固定为 `botmux`，env 里的 `HC_SESSION` 不起作用。
  - 传 `core` 时原样采用 target 冻结的 `socket`/`hcSession`，`runtimeDir` 由 socket 反推。
  - socket 不是绝对路径或超过 107 字节时抛错。
- `hcCoreAddress(paths) → HcCoreAddress {hcSession, socket}`：创建终端时冻结进 target。
- `hcRuntimeError(paths) → string | null`：启动前检查运行目录是否存在，macOS 上也检查 socket 路径是否被普通文件等占用。hc 自动启动会创建缺失的目录，并可能替换已有的路径。旧 core 的路径不可用时，worker 先用 `hcCoreAbsent` 核实 socket 和 holder 都已消失，再考虑迁移到默认 core。
- `hcCoreAbsent(socket) → boolean`：socket 和 holder socket（`<stem>.holder.sock`、`<stem>.holder.<id>.sock`）都不在时为 true，见第 6 节。
- `hcControlEnv(base?, paths?)`：每个 hc 子进程都用这份 env，不得用 CLI child env。
- `ensureHcCore({env?, core?, timeoutMs = 20s}) → HcCoreStatus {bin, session, socket, version, pid, started}`：
  - 先尝试连接；没有 core 在监听时，用 control env 执行 `server start`。
  - 同一进程对同一 socket 只发起一次尝试，并发调用者共享结果。
  - 运行中的 core 版本低于下限时抛错，不会重启它。
- `queryHcCoreStatus(socket, 3s) → running{version, pid} | absent | error`：只连接，绝不拉起 core。

**daemon 侧 CLI**（`cli-ops.ts`，全部同步）
- `HcTarget = Extract<PersistentBackendTarget, {backendType:'hc'}>`，即第 3 节的 target。`hcTerminalName(sid)`、`hcDiagnosticTarget(target, sid)` 给出会话终端与诊断终端的名字。
- 公共行为：
  - 走 target 冻结的 core 和 control env，cwd 为 `/`。
  - 超时 5 秒，kill 为 10 秒。
  - 运行目录不存在时不执行 hc，直接返回 unknown；core 与 holder 都不在时不执行 hc，返回 missing / 空列表。
  - 进程执行与错误解析和 HcBackend 共用 `sync-rpc.ts` 的 `runHcSync`。
- `probeHcTerminal(target) → 'exists' | 'missing' | 'unknown'`：按名字 `get`。live 返回 exists，finished 或 not_found 返回 missing。它不核对 labels，reattach 时由 HcBackend 核对。
- `killHcTerminal(target, sessionId) → killed | removed | missing | mismatch | unknown`：先核对 labels，再按 address 执行 kill 和 rm。
- `probeHcTerminals(core, names) → Map<name, probe>`：一次 `ls --all` 回答多个名字；列表失败或有读不懂的行时全部为 unknown。
- `listBotmuxHcTerminals(core?) → {ok:true, terminals}`：列出全部 `botmux=1` 终端（含 finished），每项带 `sessionId`。`collectBotmuxHcTerminals(cores)` 每个 core 列一次，给出 `{terminals, failures}`。
- `hcOwnerLabels(sid)` 生成 `terminal.run` 的 labels，`isHcTerminalOwnedBy(labels, sid)` 做核对。

**framed 客户端**（`client.ts`）
- `HcClient.connect(socket, {timeoutMs = 10s})`：
  - 自动完成 hello（generation 1，framed）。用 `hasFeature('automatic_input')` 检查能力。
  - 连不上时以 `unreachable` 失败，不会拉起 core，所以先调 `ensureHcCore`。
- `call<T>(method, params, {timeoutMs = 30s})`：失败抛 `HcError`。code 为 `rpc` 时，`kind` 带 hc 的错误类型（如 `not_found`）。
- `attach({terminal, cols, rows, observe?, resizeNotifications?, history?, resumed?, display?}) → HcStream`：
  - `onData(chunk, {paint, firstPaint, paintDone})`：注册第一个监听者之前不派发数据，也不回 CREDIT。attach resolve 后要同步注册，否则 256 KiB 窗口填满后 core 侧继续积压，超过约 4 MiB 会丢弃并重绘。
  - `writeAutomatic`、`writeHuman`、`resize`、`focus`、`facts` 返回 false 表示没发出去：流已关闭、连接已断或 socket 写失败。
  - `onResize`：只有带 `resizeNotifications` 的 observer 会收到。
  - `onClose`：取值为 `ended`（core 发来 CLOSE，携带 `HcEnd {reason, exit_code, signal, finished_ms}`）、`detached`（本端关闭）或 `disconnected`。只触发一次，晚注册的监听者会立即收到。
- `subscribe({terminal?, labels?}, {heartbeatTimeoutMs?}) → HcSubscription`：
  - 提供 `snapshot`、`onEvent`、`onMissed(snapshot)`（订阅者落后时用快照整体替换状态）和 `onHeartbeat`。
  - core 每 15 秒发一次心跳。`heartbeatTimeoutMs` 取其数倍，超时会断开整条连接。
- `onDisconnect({error})`：整条连接失效时触发，所有 stream 和订阅以 `disconnected` 关闭。客户端不会自动重连。

**镜像与按键**（`paint.ts`、`screen-mirror.ts`、`keys.ts`）

```ts
const mirror = new ScreenMirror({ cols, rows });
stream.onData((chunk, { paint, firstPaint, paintDone }) => {
  if (paint) mirror.writePaint(chunk); else mirror.write(chunk);
  if (firstPaint) { if (paintDone) seedFrom(mirror.captureCurrentScreen()); return; }
  emit(chunk);
});
```

- 首帧只能写进新建的镜像，或 `reset()` 过的镜像。重连后的首帧也是这样，然后走 `onScreenResync`。
- 之后出现的 paint（积压丢弃或 `hc read` 滚动读取后的 history=0 重绘）也用 `writePaint`：它替换屏幕，但不把旧屏推进 scrollback。
- `ScreenMirror` 的 `write`/`writePaint` 同步解析。它提供：
  - 与 TmuxPipeBackend 同形的读取方法：`captureCurrentScreen`、`captureViewport`、`viewportText`（对应 `captureViewportAsync`）、`viewportCells`（对应 `captureViewportCells`）、`captureInputState`、`capturePaneInputModes`、`size()`；
  - `-e` 形态的行尾与 tmux 2.8–3.6a 一致。tmux（`grid_string_cells`）逐 cell 输出（擦除的 cell 输出为空格），属性变化处写 SGR，最后裁掉文本末尾的空格，所以只保留到一行最后一次属性变化为止的空白：后面还有默认 cell 的反显光标、带底色的状态条、带颜色擦除的 cell 保留并在其后复位；延伸到最后一列的带样式空白（整行底色条、最后一列的反显光标）整段去掉；已知不一致：tmux 的行分配按 1/4、1/2、整宽三档增长，落在已分配末格的带样式空白也会被 tmux 裁掉，镜像保留（取决于该行历史，不模拟）；宽字符折行留下的最后一格、ICH 插入的格，xterm 与 tmux 填的属性不同。随机差分（tmux 3.5a，160 列）每 2000 行不一致 0–2 行，旧序列化器为 51–71 行；没有找到会因此判断出错的消费方；
  - 模式 getter：`applicationCursorKeys`、`applicationKeypad`、`bracketedPaste`、`altScreen`；
  - `HC_MIRROR_SCROLLBACK_LINES = 3000` 行 scrollback：160 列下每会话约 10 MB（50 000 行约 140 MB）。hc 自己只留 `history_mb = 5`（约 3 600 行），attach 的首帧仍能填满它；web 端从实时输出继续增长自己的 scrollback。
- 尺寸：
  - 自己 `stream.resize(c, r)` 时同步执行 `mirror.resize(c, r)`。
  - 收到 `size` 事件时执行 `mirror.resize` 并触发 `onPaneSizeChange`，除非它是自己一个已被更新请求取代的请求的确认（第 5 节）。
  - 两种情况下非 observer 都收不到重绘，程序的重画作为普通输出到达。
- 按键：
  - `encodeTmuxKeys(names, mirror)`：镜像在结构上满足 `KeyEncodingModes`。
  - `pasteBufferBytes(text, mirror.bracketedPaste)`、`bracketedPasteFrame`；`submitBracketedPaste` 的回车单独发送（第 5 节）。
  - 生成的字节一律经 `writeAutomatic` 发送。

**实测协议事实**
- 首帧以 CAN（0x18）开头。`PaintTracker` 负责切出 paint 段：屏幕、win32-input 模式（`?9001h/l`），以及紧随其后的 OSC 7501 状态；再往后的字节（包括程序写到一半的序列的后续字节）算 live 输出。
- attach 的 `history: N` 会在首帧里重放最多 N 行主屏 scrollback，受 `history_mb` 限制，alt screen 不重放。worker 重启后要让 `captureCurrentScreen` 带上历史就必须传它，否则镜像里只有当前屏。
- 重放 history 时，接缝处会多推一行空行进 scrollback：hc 先发 CRLF 再推 `rows` 个 LF，差一。按行比对内容时要忽略空行。
- AUTOMATIC_INPUT 不抢尺寸，也不算人类输入。DATA（`writeHuman`）和 RESIZE 会让该 viewer 成为尺寸 leader。
- core restart 或崩溃后，holder 约 3 秒（崩溃时约 5.4 秒）把 core 拉回来，程序继续存活。旧连接直接以 `disconnected` 断开，不发 CLOSE。重连后按第 5 节用 `terminal.get` 判断。
- `HcEnd` 由 CLOSE 载荷、`finished` 事件和 `lost` 事件携带。reason 为 `holder_lost`、`stopped_by_restart`、`server_stop` 或 `host_shutdown` 时归为 serverReplaced。
- 测试中，fence 给每个进程一个私有 `XDG_RUNTIME_DIR`，所以生产代码算出的 socket 落在 `<私有目录>/herdr-core/botmux.sock`。
  - 真实 hc 测试需要 `BOTMUX_HC_TEST_BIN`（≥0.1.19），没有时 skip。
  - control env 会剥掉 `BOTMUX*`，所以 shim 在创建时把这个值和 deny log 一起固化进脚本。
  - 直连 socket 的 `HcClient` 和 `queryHcCoreStatus` 不经过 shim，只靠 env 隔离，测试里只能连 fence 目录下的 socket。
