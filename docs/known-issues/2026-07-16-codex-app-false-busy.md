# Codex App 会话长时间无进展却持续显示“工作中”

> 状态（2026-07-18 21:30）：**旧工作稿，不是最终 PR / 飞书 Doc，不可直接送审**。ORIGINAL WIP 的 `HEAD=44e4113937080303afca9037aae1bf483dd2982c`，本地 tracking ref `origin/master=6c75d44c4fd942b490dc8648038d89a1541eb7fc`，两者并不相等；另有独立 clean migration target 固定在 `c14b0180cf39cd8c219d5a6a1389b2cd794faf94`，不能与本树混称。当前 `git status --porcelain` 为 137 个 tracked status row、40 个 untracked row，树不 clean。下表除明确标为“2026-07-18 fresh”的 supervisor 增量外，均是旧快照历史记录，不能作为当前整树 PR 证据。当前仍未 commit、push、建 PR、切 live 或做真实飞书 E2E。
> 本次迁移前 include-untracked 快照为 stash `23db3c031d9d83b96bb1decd94721d8673f0e627`；此前 `f46a49c1edae00981e29e0893d0d7d700544066c`、`768f2ec77c4886100761a0f299056feafa0c120f`、`baa211dc93d94e6136e519629d08f6fa9ba6315b` 也仍保留，均 apply、未 pop/drop。
> 记录日期：2026-07-16。

## 问题与原始反馈

Codex App turn 提交后，如果 app-server 或工具链不再产生可观察进展，Botmux 过去仍会因 CLI 未回到 prompt 而无限投影 `working`。飞书卡片和 Dashboard 因而把“没有可观察进展”写成“正常工作中”，用户无法判断应继续等待还是检查当前 Session。

| 项目 | 原始值 / 事实 | 证据层级 |
| --- | --- | --- |
| 本轮缺陷入口 | `om_x100b6ab0f5be6508b1db261a4562aee` | 飞书话题中回读的四问题汇总入口 |
| 用户原始反馈 | `om_x100b6a4d3949dca4deaf50cc4452817`：“一个小时了 什么进度了 什么什么消息都没有” | 飞书 chat history 回读 |
| 关联状态卡 | `om_x100b6a4d36e9a934c4474c3ade214d9`，卡片转录仍为“工作中” | 飞书 chat history；未取得原始 card payload |

历史 Session 缺少可对应的 `sessionId`、Codex App `threadId`、app-server 通知、PTY 时间线和 daemon 日志。因此本文不把原始卡点断言为 MCP、网络、模型服务或工具初始化故障；修复只检测“连续没有可观察进展”。

## 根因

1. `codex-app-runner` 已直接消费 `turn/started`、item 和 `turn/completed`，worker 的状态却主要来自 prompt / screen heuristic；未回到 prompt 就一直是 `working`。
2. 一次 flush 可以向 serial runner 排入多个 turn。turn 1 和 turn 2 之间可能出现短暂真实 prompt；若 turn 2 的 chunked submit 随后失败，旧逻辑不会重放刚才被拒绝的 ready 边界。
3. daemon 重启后，tmux、Herdr 或 Zellij 里的 runner 可以继续存活，但新 worker 的内存队列已经丢失。仅凭 backend 的 `isReattach` 或终端内容，既不能证明它是旧 runner，也不能安全接受 completion/final。
4. OSC 处于用户、模型和工具都能写入的终端数据面。任何仅靠前缀、JSON 字段或共享 nonce 的方案都可被伪造；Herdr/Zellij 的渲染接口也没有给 Codex App 控制帧提供可靠的 raw-byte 传输保证。
5. Mira/Mir 的 terminal marker 路径与本问题无关，继续完整保留上游 `RunnerControlDecoder` 行为，不在本修复中改动其 parser。
6. terminal prompt 仍可能在 PTY、Tmux、Herdr 或 Zellij 的观察链路中延迟或丢失；反过来，它也可能先于 socket final 抵达 worker。若把 terminal prompt 作为 Codex App 的最终 idle 权威，就无法同时保证“prompt 丢失仍恢复 ready”和“final_output 先于 prompt_ready”。
7. worker、CLI 或 daemon 在 turn 的不同阶段退出时，原实现没有一份由 daemon 持久化的完整输入与归属账本。仅恢复 Codex App thread、只看 runner idle，或把下一条输入重新塞入同一 runner，都无法证明上一条输入尚未写入、已经提交还是 final 已送达，可能造成错序、重复执行或永久卡在旧归属上。

## 方案

### 1. 明确的 turn liveness

- runner 在 turn 出队时发 `submitted`，app-server 通知最多每 5 秒发一次 `progress`，完成时发 `completed`；thread 与 final 也走同一控制面。
- worker 为每条已开始提交的消息建立队列槽位。完成只推进队首；后续 turn 从真正成为 runner 当前任务时重新起算超时。
- 当前 turn 90 秒无活动时投影 `stalled`，飞书与 Dashboard 显示“长时间无进展”，同一 turn 只通知一次；后续真实活动恢复 `working`。
- 不自动重启或取消正在执行的 turn。只有仍处于 daemon `accepted`、尚未进入 runner 写入阶段的完整输入可以在 replacement worker 恢复；任何 `prepared` 或写入结果不确定的 turn 都 fail closed，不自动重放，避免重复模型或工具副作用。
- turn 间 prompt 在队列非空时不投影 `idle`。若后续 submit 失败并精确取消、队列已空，则在 flush mutex 释放后重放 deferred ready。
- runner 初始化完成时，以及 serial queue 真正清空时，发送签名 `state { busy:false }`。queue drain 的 idle state 只在所有 queued turns 的 `completed` 与全部 final fragments 已进入可靠控制队列后追加；两条已排队 turn 之间不发送瞬时 idle。
- worker 把签名 idle state 作为 Codex App ready 权威。terminal prompt 在 signed idle 到达前只会被 defer；因此 terminal 渲染完全丢失仍可进入 ready，而正常完成顺序固定为 `final_output → prompt_ready`。

### 2. backend-independent 的非对称控制通道

Codex App 不再通过 OSC 发控制消息。POSIX 使用随机 AF_UNIX endpoint，Windows 使用随机 named-pipe endpoint；runner 通过独立 OOB channel 上报。该路径与 PTY、Tmux、Herdr、Zellij 的终端渲染无关。

- 每次 spawn 尝试生成新的 Ed25519 keypair 与随机 generation。
- worker 只持有、持久化公钥；私钥仅写入一个 `O_EXCL`、精确 `0600` 的 one-shot bootstrap。
- 启动环境只携带 bootstrap **路径**。私钥不进入 env、argv、tmux command、Zellij layout、持久状态或 socket wire。
- runner 在 app-server 启动前删除环境变量，并用单一 `O_NOFOLLOW` fd 校验 owner/mode/link/size；随后先 unlink，再从同一 fd 读取并导入私钥。文件缺失、symlink、hardlink、宽权限、session 不匹配或 unlink 失败均 fail closed。
- app-server 只有在 worker 完成验证并返回 `accepted` 后才启动，所以模型及其工具不会继承 bootstrap path。
- bootstrap 位于 bot 私有目录。POSIX 控制根固定为 owner-only `/tmp/botmux-codex-app-<uid>`：每次 endpoint 使用随机叶子，runner 只从固定、受保护、按 Session 哈希命名的 locator 发现它；locator 校验必须由调用方显式提供 trusted control root，不能从 locator path 反推信任。
- POSIX worker 在触碰 locator 前持有跨进程、进程生命周期级 owner-directory lease。v2 owner / reaper actor record 都绑定创建时目录的精确 bigint `dev + ino`；owner 另带随机 nonce、PID 与 process-start token，reaper 还绑定目标 owner nonce、owner 文件 inode 与进程身份。写后回读且 exact actor CAS 成功才算持有或有权清理。dead actor、过 grace 的 secure partial actor与同目录 losing contender 残留可以恢复；live、unknown、EPERM、无法验证 start token 或多个不一致 candidate 一律 fail closed。replacement directory 中迟到的旧 creator / cleaner 即使停在 publish→CAS 窗口，也不能撤销或毒化 successor。释放只删除本进程 exact actor 并尝试 `rmdir`，`killCli` 和 in-worker restart 都不释放。非 Linux `ps -o lstart` 固定 `LC_ALL=C / LANG=C / TZ=UTC`；同秒 PID 复用只会保守阻塞，不会授权删除 live owner。
- 短控制根使 macOS endpoint 低于约 104-byte 的 AF_UNIX 上限。Linux bwrap 显式绑定 bootstrap、endpoint 与 locator 目录；macOS Seatbelt 的 own BOT_HOME 与 `/tmp` write carve-out覆盖它们。
- bootstrap cleanup、worker challenge proof 和 runner authentication 共用现有 first-prompt hard cap：90 秒。超过 30 秒但未到 90 秒的慢启动不再被提前清理或 fail closed。

Windows 不把 named pipe 当成文件系统 socket，也不假定 named pipe 自身是 owner-only。方案 A 使用两层独立对象：

- 控制根固定在当前用户的 drive-qualified `%LOCALAPPDATA%\\Botmux\\codex-app-control`，缺失时回退 Windows home；UNC 路径直接 fail closed，不采信 `SESSION_DATA_DIR`。根目录及子目录通过绝对 `System32\\whoami.exe` / `icacls.exe`、参数数组和 `shell:false` 去继承、设 owner、仅授予当前 SID 与 SYSTEM full control，并回读 `/save` 的 protected SDDL 做 exact verification。命令失败、未知/继承 ACE、非 canonical ACL 或不支持所需 ACL 的文件系统都 fail closed。
- bootstrap 仍是 hardened root 下 `O_EXCL` 随机叶子；Windows 保留 lstat/open/fstat 的 regular-file、single-link、size 和同一文件 identity 校验，先 unlink 再从同一 fd 读取。只跳过 Windows/Node 不可靠的 `O_NOFOLLOW`、uid、精确 mode、`fchmod`、unlink 后 nlink 与目录 fsync；POSIX 原约束不变。
- public state 与 locator 使用同目录随机 `O_EXCL` temp、file fsync、atomic rename、rename 后回读校验；Windows 不做 directory fsync。v3 state 只持有 public identities，不保存 bootstrap path 或私钥；不兼容或损坏的旧 state 读取失败后 cold start。既有固定 state 文件在信任前再经 exact ACL hardening；新 temp/locator/bootstrap 继承已验证的 restricted parent DACL。
- 每个 worker 的 runner-facing endpoint 是独立 256-bit 随机 `\\\\?\\pipe\\botmux-codex-app-<64 hex>`；另生成独立 256-bit epoch。worker 必须先 bind，再原子发布 `{version, sessionId, epoch, endpoint}` locator，最后才允许 `backend.spawn`。
- daemon 的 kill-then-fork 会短暂重叠进程。为避免旧 worker 在新 worker 之后覆盖固定 locator，每个 Session 另持有 deterministic owner-lease named pipe，直到进程退出才由内核释放；新 worker 对 `EADDRINUSE` 进行 50ms 有界等待，10 秒仍拿不到即 fail closed，其他 bind 错误立即失败。lease 不承载 secret、challenge、accepted 或 runner 流量。
- stop、prepare 与 publish-failure 不对固定 Windows locator 做 read→unlink；那不是 CAS，可能误删 replacement epoch。关闭随机 pipe 后留下的 locator只会指向已失效 endpoint，下一 owner 在新 endpoint bind 成功后原子覆盖。
- runner 从 bootstrap 取得 `locatorPath`，对 missing/corrupt locator 以 250ms 轮询。未 accepted 的 endpoint 可在每次独立 5 秒**绝对** handshake deadline 下重试到共享 90 秒 proof deadline；transport slow-drip 不会续命。accepted 还必须回显 protected locator 的 epoch；一旦 accepted，该 pipe name 永久 burn，关闭后只接受新 locator endpoint。
- authenticated socket 关闭会在 POSIX/Windows 都重新 arm 90 秒 proof deadline，并先 bind+publish 新随机 endpoint，再退休旧 server；若 runner 未在 deadline 内重新完成 challenge proof，generation fail closed，而不是永久停在 proof-gated `working`。
- `accepted` 仍有意不签名：POSIX 权威来自 owner-only fixed root、严格 locator、已 bind 的随机 AF_UNIX endpoint 与独立随机 epoch；Windows 权威来自 restricted locator、已 bind 的随机 named pipe 与独立随机 epoch。runner auth 与所有 marker/ACK 的 Ed25519 challenge、generation、seq 语义不变。

### 3. old reuse 与 fresh start 由密码学证明，不依赖预测

spawn 前，pending 状态同时保留旧 public identity 和 fresh candidate public identity。backend 如果实际复用旧 runner，会忽略新命令/bootstrap；若实际 fresh，则新 runner 消费 candidate bootstrap。

每条连接都由 worker 发送新的 256-bit challenge：

1. runner 对 `session + generation + challenge` 的独立 auth domain 作 Ed25519 签名；
2. worker 只在 pending identities 中找 generation，并用对应公钥验签；
3. old key 验过即证明实际 warm reuse，candidate key 验过即证明实际 fresh；
4. 选中的 identity 被原子折叠为唯一 `active` 状态，之后才接受 marker 和 prompt。

这同时覆盖“存在性 probe 与 backend.spawn 之间发生变化”的竞态。Herdr 的 `isReattach` getter 也改为报告 `agent get` 是否真的复用了 pane，而不是构造参数；但控制面安全不依赖该 getter。

### 4. marker anti-replay 与可靠重连

- 每个 marker 的签名 domain 都包含 `session + generation + connection challenge + seq + event kind + canonical payload`；auth 与 marker 使用不同 domain separator。
- worker 只在已经通过 challenge 的同一 socket 接受 marker；每条连接的第一条 seq 可在 worker replacement 后从任意正整数开始，但随后必须严格连续。连续性 fence 有意先于 generation replay window：这样 ACK 丢失后的完整连续重放可以逐条补 ACK，任何连接内 gap 又不会被后面的累计 ACK 掩盖。旧连接抓到的 auth/marker 因 challenge 不同，不能在新 worker 上重放。
- 普通 marker 独立 ACK；chunked final 由每个认证连接自己的 assembler 接收，并以 `final-end` 作累计 ACK。start/chunk 在完整 assembly 前都留在 runner 队列；id/total/index、严格 base64、chunk 顺序、总大小或 final-end 完整性任一不满足，worker 都清掉该连接的 partial assembly、销毁 socket，且不 commit / ACK 该记录。runner 随后用新 challenge 重签并从 `final-start` 重放完整 transaction，而不是只发送缺少前缀的残片。
- 若完整 `final-end` 已写入 daemon 的 generation highwater，但 ACK 在连接断开前丢失，重连后的 start/chunks/end 都落入 replay window：worker 只补累计 ACK，不重新 assembly，也不再次请求 daemon 投递。外部 provider 已接受、daemon 尚未持久化 settlement 时仍是 at-least-once 窗口；普通飞书消息使用稳定 UUID 在 provider 的 1 小时幂等窗口内去重，不能外推为无限期或全 sink exactly-once。
- 未认证连接有独立 decoder、challenge 和 5 秒 timeout；worker 继续 accept，并在同时未认证连接达到 16 条时直接拒绝新连接，单个冒充客户端不能永久占住通道。
- 控制 line、final 总大小、chunk 数和每连接单一 final transaction 都有硬上限；畸形、重叠或交错输入 fail closed。

### 5. daemon 持久归属、恢复与 final settlement

- daemon 在把 Codex App 输入交给 worker 前生成稳定 `dispatchId`，冻结完整输入、effective turn id、原始 reply root、caller 与 delivery sink，并将 `accepted` ledger 原子写入 Session；持久化失败会回滚本次 acceptance。
- worker 在写 runner 前先占用本地 FIFO，再要求 daemon 将 exact ledger head 从 `accepted` 持久化为 `prepared`。tmux/backend 的 `false`、throw、chunk 或 Enter 失败都不能证明“零字节写入”，因此统一视为 `dirty_unknown`：保留归属、隔离 generation，并让 daemon replacement/fence 接管，而不是取消后重投。
- final 先在 worker 中只做 exact head 校验而不 pop；daemon 再校验 worker、Session、ledger 与 generation，完成可见投递和 durable terminal settlement，原子 pop exact ledger head 并写 cumulative highwater，最后 ACK worker。worker 收到 ACK 后才 pop 本地 FIFO 并 ACK runner。空 final 也走同一事务，不会被当作缺失消息。
- replacement worker 会恢复完整 ledger FIFO。`accepted` 输入可以在新的安全写入前恢复；`prepared` 输入即使来自 warm runner 且收到签名 idle，也不能证明 raw input buffer 未写，因此不自动 reset / replay。只有 runner 重放 final 或 daemon highwater 能关闭该归属；fresh runner 遇到 recovered `prepared` 会立即 fail closed。
- 自然 runner exit、worker SIGKILL、daemon restart、VC receiver expiry/reset、boot recovery 都保留 exact turn/attempt ownership。只有 backing 被权威证明 missing 且旧 ledger exact-retire 已持久化后，runtime fence 才允许下一 attempt；持久化失败继续 gate/reprobe。
- `/restart`、`/cd`、suspend、transfer、native thread/adopt 与 double-fork 在 ledger 非空时拒绝或安全排入既有 FIFO；显式 `/close` 是唯一放弃边界，会原子清 ledger/highwater。read-isolation 切换同样先关闭该 bot 的 admission，并只在 runtime 与持久态均无 active Session、closed Session 的 PID 已消失且所有 owned persistent backing 都证明 missing 后写配置；否则返回冲突，要求关闭会话并稍后重试。
- 普通飞书投递使用稳定 provider UUID `ca_<dispatchId>`，其去重能力受飞书 1 小时窗口限制。doc-comment、HTTP wait/async、silent/suppressed 等 sink 会随 ledger 持久化；若 daemon 重启后原 sink 已不可恢复，final fail closed，不会降级泄漏到普通飞书消息。`botmux send` 的 sink 权限绑定可信 origin Session + turn/attempt，`--session-id`、voice、附件或 relay 不能绕过。

### 6. 状态与 UI

- `ScreenStatus / StreamStatus` 增加 `stalled`；飞书卡片使用 danger header，Dashboard 可筛选并进入需关注列。
- Dashboard 总览仍把 `stalled` 计为 active；Resource Monitor 将其计作 runtime `working`，因为含义是“可能仍执行，但暂无可观察进展”。
- maintenance heartbeat 将 `working / stalled` 都视为 busy，不因展示状态变化而新增全局重启机会。

### 7. PM2 core fleet 的安全停启与首次升级边界

这部分不是 false-busy 状态机本身，而是本修复能否安全合入和升级的关键前置。Codex App / Riff 已把输入归属与 shutdown preparation 持久化后，原来的 PM2 控制方式仍可能在重启途中造成“只停了一半”“停错 PID 的下一代进程”或“旧任务已 prepare、却被下一次重启报告误消费”。因此本轮把 PM2 stop / restart / start / start-bot 一并收敛为可验证的 fleet transaction。

**要解决的问题与根因：**

- PM2 的 `jlist`、God socket 和 `process.kill(pid)` 都不是 PID + process-birth 绑定的授权；检查之后若 PID 被复用，普通 OS signal 可能落到 successor。
- PM2 把进程标成 `online` 早于 daemon 安装 signal handler、注册 shutdown endpoint 并发布 capability；只验 `online` 会把半启动进程当成可安全接管的新 fleet。
- bundled PM2 在 signal-only child exit 上把 `code` 归一成 `code || 0`，因此 SIGKILL / OOM 也可能投影为 `exit_code=0`。若 daemon 的 `stop_exit_codes` 同样使用 0，prepare 中途被硬杀会被误判为 graceful no-restart。
- PM2 达到 `unstable_restarts >= max_restarts` 时会抑制后续 restart，并可能把硬杀后的 row 留在 `errored`。因此“没有 restart timer / status=errored”只能证明 row 暂时静止，不能证明刚才接受 `202` 的 shutdown transaction 已完成。
- 多 bot 启停期间，`bots.json`、PM2 rows、daemon descriptors、restart timers 和 God generation 可能分别变化。一次旧快照或批量 `delete` 无法证明每个实际 mutation 仍指向原对象。
- 首次升级时，磁盘上的新 CLI 已经包含协议，但内存中的旧 daemon 没有 `riff-fleet-prepare-persist-commit-exit42-v2` shutdown capability。把“包已安装”误当成“daemon 已升级”会在 Riff 仍工作时强制停机。
- restart breadcrumb 原先没有完整的 attempt 状态与原子 claim；部分重启或 report 并发可能提前消费一个尚未 verified / committed 的 intent。

**解决方法：**

- 每次 mutation 前重新读取严格语义 `pm2 jlist`，拒绝 malformed row、重复 canonical `pm_id`、重复正 PID、重复 God、未注册的 live descriptor，并以 exact PM2 id + name + PID + process-birth 重新证明对象仍静止后才逐个 stop / delete。
- daemon 只有在 SIGTERM / SIGINT handler 与 exact shutdown handler 都已安装后，才把 shutdown protocol 写入 fresh descriptor。CLI 对全部 live daemon 做 exact-set attestation，再用 route/port-bound HMAC 向 exact app + boot + process-birth 发并发 loopback POST；只有 exact `202` ACK 才算该 generation 接受 shutdown。缺 ACK 即使随后退出也按失败处理，并补偿恢复已退出 peer。
- daemon-only PM2 policy 使用共享的非零 `DAEMON_GRACEFUL_EXIT_CODE=42`；只有 prepare / persist / commit 与 worker teardown 全部完成后才以该 sentinel 退出。signal death 归一出的 0 不在 daemon `stop_exit_codes` 中，必须继续 autorestart；无 Riff lineage 的 Dashboard 保留独立 exit-0 policy。
- PM2 registry 投影保留原始 `stop_exit_codes` 元素，不做 parse / filter；daemon policy 只接受唯一 numeric `42` 或 canonical string `"42"`。因此 `[42,"0foo"]`、`[42,"0x0"]`、`[42,null]` 等会被拒绝，避免 PM2 自身 `parseInt` 语义把隐藏的额外值解释成 0 并抑制 signal-death restart。
- timer-free 判定只用于初始 dormant admission 与失败补偿；post-signal quiet-success 另要求每个 name 的 latest 已 signal generation 在 quiet window **每一轮** fresh projection 中仍有 exact `name + pm_id` terminal row，并由 raw `stop_exit_codes` 接受其 `exit_code`。daemon 的 `errored + exit_code=0 + [42]` 必须进入恢复或 partial-failure，只有 `exit_code=42` 才能成为 graceful terminal proof；一次看到 42 后 row 又缺失也不能成功。只有 fresh 且 OS-live 的 successor row 携带上一代已接受 exit 时才缓存 predecessor；dead different-PID row 的 exit 可能已属于 successor 自身，不能反证上一代。successor 被 signal 后随即成为必须逐轮重证的 latest generation。Dashboard 仍按其独立 `[0]` policy 验证。
- start / restart / start-bot 使用同一 fleet lock 与锁内 `bots.json` snapshot，PM2 start 有总超时、late-publication settle、fresh online + handler-ready exact-set verification；部分启动或验证失败只回滚本 attempt 可证明拥有的 rows。
- restart intent 使用 `prepared → committed` / `aborted` attempt fence，并以原子 claim 取代 `consume + hasPrepared` 竞态；新 fleet 完整 verified 前不会 commit，也不会产生成功重启报告。
- `restart --include-pm2` **不再宣称会重启一个正在运行的 PM2 God**。Node / PM2 没有 generation-bound God signal，因而该选项只允许“命令入场时零 live God”的干净场景；只要发现一个或多个 live God，命令就在 breadcrumb、PM2 RPC、daemon signal 和 fleet mutation 之前零改动拒绝。

**改动规模与兼容性：** 这是一次较大的 supervisor control-plane 改动，涉及 CLI fleet admission、daemon descriptor、loopback shutdown IPC、start rollback 和 restart report；它不改变 Codex App turn / final 的业务协议，也不把不安全的自动 kill 当成兼容降级。外部脚本若绕过 Botmux 直接改 `bots.json` 或直接调用 PM2，不受 advisory lock 保护，仍属于明确的外部边界。

**首次升级操作边界：** 已运行的旧 daemon 没有新 capability 时，普通 `botmux stop` / `botmux restart` 会在任何 daemon signal 前 fail closed；这是预期安全行为，不是可自动忽略的错误。操作者必须先独立确认所有 Session 与 Riff workload 均 idle，在获批维护窗口内一次性运行 `botmux restart --bootstrap-shutdown-protocol --yes`。该显式双确认入口逐个绑定并复核 PM2 `name + pm_id + PID + process birth` 后退役旧 core，再按新协议启动并验证全部配置 row 都 `online` 且发布 handler-ready descriptor；它不会由 upgrade/update 自动调用。自动更新只能报告“新包已安装、restart 已请求或被阻断”；在新 fleet 完整验证并提交 restart attempt 之前，不得宣称更新已应用。

## 修复前后效果

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| turn 正常产生 app-server 活动 | `working` | 保持 `working`，活动刷新 90 秒窗口 |
| turn 连续 90 秒无活动 | 永久 `working` | `stalled`，提示一次并允许后续活动恢复 |
| 一次 flush 排入多个 turn | 无独立生命周期 | 队列化跟踪；等待前序不计作后序无进展 |
| turn 间 prompt 后下一条 submit 失败 | 可能不再 ready | 精确取消槽位并重放 deferred ready |
| terminal prompt 在 backend 观察链路中丢失 | 永远无法进入 idle | 签名 `busy:false` 独立驱动 ready / idle |
| terminal prompt 先于 socket final 抵达 | 可能先 idle、后 final | prompt 先 defer；signed idle 排在 final transaction 后，保证 final-before-ready |
| 用户/agent/tool 输出伪造 OSC | 可能推进状态或伪造 final | Codex App 完全不从终端接受控制消息 |
| worker 重启、旧 runner 存活 | 依赖 backend/屏幕推断 | fresh challenge + old public key 验签后才 warm reattach |
| Herdr 预测 reattach 但实际启动新 agent | `isReattach` 语义错误 | getter 报 actual；candidate key 证明实际 fresh |
| worker 在 final chunk 中途替换 | 已 ACK 前缀丢失后无法重组 final | final 事务到 `final-end` 才累计 ACK；新 worker 收到完整重放 |
| final-end 缺 chunk / total 不一致 | 仍可能累计 ACK 并永久丢 final | 不 commit、不 ACK、销毁连接；新 challenge 下重放完整 transaction |
| final-end settlement 已持久化但 ACK 丢失 | 重连可能重复发布 final | generation highwater 识别连续 duplicate replay，只补 ACK，不再次请求投递 |
| worker 在输入写入边界退出 | 无法区分未写、已写、已提交 | daemon ledger 区分 `accepted / prepared`；只恢复 safe accepted，prepared fail closed |
| daemon 在外部 provider 接受后、ledger commit 前退出 | 可能重复投递或改投其它 sink | 原 sink 与稳定 UUID 持久化；普通飞书在 1 小时窗口内幂等，其他不可恢复 sink fail closed；不宣称无限期 exactly-once |
| A/B 两条 chat-scope turn 排队后回复根变化 | 晚到的 A 可能落群顶层或串到 B | 每条 ledger 冻结 exact plain/thread reply target、caller 与 sink |
| pre-upgrade pane 无 public identity | 无可信 lifecycle | attach 前 fail-closed cold start，不接收 legacy completion/final |

## 安全边界

本设计防止终端正文、agent message、工具 stdout、另一个 socket client或旧连接 transcript 伪造 Codex App lifecycle/final；也避免把可复用私钥放入 env、argv、持久态或控制 wire。

它不宣称能隔离“已经取得同 UID 任意进程读取/调试能力”的攻击者：能够在 trusted runner consume 前抢读 bootstrap、读取 runner 内存、使用 `ptrace`，或持续改写 locator / 干扰 socket 的同 UID 恶意进程，仍可窃取 key 或造成 DoS。该级别需要 OS 级进程隔离或不同 UID，超出本 PR。模型及其新启动工具不会继承 bootstrap path，但预先存在的同 UID 进程不在此保证内。warm reattach 仍会准备一个 fresh candidate bootstrap 以覆盖“预测复用但实际 fresh”的竞态；若旧 runner 真正复用，该文件会在旧 key proof 后清理，期间同样受上述同 UID 边界约束。

Windows named pipe 本身没有在本实现中设置或验证 owner-only DACL，因此不作该声明。跨用户本地进程可以尝试抢占 deterministic owner-lease name、枚举/连接 pipe 或制造连接耗尽，形成可用性 DoS；它拿不到 restricted locator 中的 256-bit epoch，不能据此伪造 accepted。owner lease 与 control pipe 都不承载可复用 secret。UNC root 已拒绝；drive-letter 映射是否为真实本地卷仍需真实 Windows 验证，ACL/rename/readback 任一步不满足都会 fail closed，不能把本机 mock 外推为 SMB/FAT 可用。

Windows 文件删除语义的实现依据是 Node 所用 libuv v1.x `src/win/fs.c::fs__open` 默认包含 `FILE_SHARE_DELETE`，因此 one-shot bootstrap 可以保持同一 handle、unlink 后同 fd 读取；这是源码依据，不是目标 Windows E2E 证明。ACL 命令与 SDDL 语义以 Microsoft `icacls` 文档为准：<https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls>；libuv 源码：<https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/fs.c>。

## Windows 原生验证缺口（实现已落地，不得标 Windows-ready）

方案 A 的代码、纯状态机、文件策略和平台无关 locator orchestration 已落地。本机 integration 使用真实 runner + POSIX 随机 AF_UNIX endpoint 验证 locator polling、重复 challenge、wrong epoch、accepted endpoint burn 与 replacement endpoint re-auth；Windows-shaped endpoint/ACL 仅由纯逻辑和 source contract 覆盖。这不能验证 Windows kernel、NTFS ACL、`icacls /save` 的真实字节、named-pipe libuv 行为或进程退出释放 lease。

仍缺以下 Windows 原生证据：

- 在受支持 Windows/Node 版本上真实执行 `whoami` / `icacls`，覆盖 exact current-SID + SYSTEM DACL、未知/继承 ACE 拒绝、UTF-16 `/save` 输出和 ACL-incapable volume fail closed；
- 真实 bootstrap create→lstat/open/fstat→unlink→same-fd read，确认当前 Node/libuv 的 delete-sharing 与 identity/size/nlink 分支；
- 两个 worker 进程竞争 deterministic owner lease，覆盖旧进程退出释放、新进程 acquire、10 秒超时和非 `EADDRINUSE` fail-fast；
- 真 named pipe 的 bind-before-publish、bind failure不发布、active close A→B、pre-auth retry、wrong epoch、accepted A 不重连，以及 locator atomic replacement；
- Windows CI 或目标开发机至少一层端到端 runner/app-server 验证。

在这些原生证据完成前：

- 不得把本文或实现称为 Windows-ready、已上线或已通过目标机验证；
- 不得把 macOS 上的 mock/integration/full unit/build 外推成真实 Windows 可用；
- 后续若经用户批准创建 Issue1 PR，必须在 PR 中原样保留该证据缺口，并把 Windows CI / 目标开发机验证列为合入或发布前检查，不能宣称 Windows 已验证完成。

## 影响面

| 维度 | 结论 |
| --- | --- |
| CLI | liveness 与非对称 socket 只用于 `cliId=codex-app`。Mira/Mir 继续完整使用上游 canonical `RunnerControlDecoder`，本修复不改动其 terminal marker parser。 |
| backend | socket 是独立 OOB；Pty、Tmux、Herdr、Zellij 不需要传播 OSC。持久 backend 通过公钥 proof 区分 reuse/fresh。 |
| platform | POSIX 使用 fixed protected locator + random AF_UNIX endpoint + process-lifetime owner-directory lease；Windows 使用 hardened locator + random named pipe + kernel-lifetime owner pipe。Windows native E2E 仍是 blocker。 |
| Session | 现代 runner 可在 worker restart 后 challenge re-auth；pre-upgrade/无公钥 pane 会 cold start，可能失去仅在内存中的上下文。 |
| 消息 | `stalled` 不丢弃、不出队、不重投 pending message。final 通过 ACK 队列重连重发。 |
| workflow | 本 PR 不扩展 workflow one-shot event 的结束/通知策略。 |

## 历史验证记录与本轮增量证据

本节保留旧工作稿的历史结果，目的是说明曾覆盖过什么，不是宣称它们已在当前 `HEAD` / dirty WIP 上复跑。只有明确标为“2026-07-18 fresh”的 supervisor focused、TypeScript 和 reconstructed-delta diff check 是本轮增量证据；当前整树的 full unit、build、clean-tree 与最终独立 PASS 仍待 clean target 迁移后重做。Windows 行为测试只证明平台无关 JS 逻辑，原生证据仍按上节保留 blocker。

| 层级 | 内容 | 当前结果 |
| --- | --- | --- |
| 历史：asymmetric protocol / POSIX lease / Windows policy unit | bootstrap single-fd consume、SID/SDDL、strict CSV second-column SID、fixed trusted root、random POSIX/Windows endpoint、v2 directory-bound owner/reaper actors、partial/dead actor recovery、双 contender、delayed creator/cleaner publish→CAS、auth/replay/line bounds、per-connection seq fence、final assembler reject/complete | 旧快照记录：`test/codex-app-control.test.ts` 48/48 passed；另连续复跑 5 次均 48/48；Windows 部分非 native；未在当前整树复跑 |
| 历史：liveness / ready authority | queue timeout/recovery、exact cancellation one-shot late prompt、absent/stale handle不授权、signed idle final-before-ready、new work/state/reset 清 arm | 旧快照记录：`test/codex-app-turn-liveness.test.ts` 23/23 passed；未在当前整树复跑 |
| 历史：runner local integration | accepted 前不启动 app-server、locator retry/burn、slow-drip deadline、signed lifecycle、queue drain idle、endpoint re-auth、chunk 中断完整重放、incomplete final-end 无 ACK 后完整重放、committed final ACK 丢失后只补 ACK、empty final transaction、OSC injection escaping、stable Botmux turn identity | 旧快照记录：`test/codex-app-runner.integration.test.ts` 16/16 passed；POSIX local integration；未在当前整树复跑 |
| 历史：worker + daemon durable recovery focused | N/N+1 FIFO、自然 runner exit、worker SIGKILL、surviving runner replacement、empty final ACK barrier、accepted/prepared ledger、generation highwater、VC runtime/boot exact retirement、frozen reply/sink/origin、mutation admission、CLI sink gate与生命周期冲突 | 旧快照记录：40 files / 1067 tests passed，其中真实 worker + tmux replacement integration 4/4；未在当前整树复跑 |
| PM2 / Riff supervisor safety focused（2026-07-18 fresh rerun） | strict jlist、duplicate God/PID、stale descriptor live-birth authority、raw exact `stop_exit_codes` policy、fresh-per-round overlimit terminal proof、live-successor predecessor proof、nonzero graceful-exit sentinel / signal-death restart、exact per-mutation identity、fleet rollback/late publication、idempotent handler-ready exact-set、restart intent CAS、Riff prepare/abort/restore、signed exact loopback shutdown、bots.json lock 与 maintenance compatibility | 20 files / 233 tests passed；其中真实 `startIpcServer({ authRequired: true, ready })` loopback 覆盖 unsigned 401、未注册 503、wrong boot/birth 409、exact signed tuple 202 |
| 历史：independent code review | 对旧冻结树复核 fatal exit、workerless/boot retirement、reply root/caller/sink、fresh origin、revocable admission lease、terminal/worktree re-admission与 read-isolation close-first proof | 旧快照记录：PASS、12 files / 253 tests passed；不是当前 supervisor frozen review 结论 |
| TypeScript | `./node_modules/.bin/tsc --noEmit` | 2026-07-18 在本轮 supervisor 增量上 fresh rerun，exit 0 |
| 历史：full unit suite | `./node_modules/.bin/vitest run --project unit --reporter=json --outputFile=/private/tmp/botmux-issue1-final-full.json` | 旧快照记录：2267/2269 suites、9207/9296 tests passed，82 failed、7 pending，并曾与当时 clean base 的失败 title 集一致；这些 JSON/hash 不代表当前整树 |
| 历史：build | `./node_modules/.bin/tsc && cp src/setup/lark-scopes.json dist/setup/ && node scripts/build-dashboard.mjs && chmod +x dist/cli.js` | 旧快照记录：exit 0；当前整树未 build，本轮也明确禁止 build |
| 2026-07-18 fresh：supervisor reconstructed-delta diff hygiene | `git diff --check` against the saved pre-supervisor frozen baseline | exit 0；仅证明 supervisor delta 无 whitespace error；ORIGINAL 仍有 137 个 tracked status row 与 40 个 untracked row，不是 clean tree |
| Windows native | 实现已落地，真实 `icacls` / bootstrap unlink / named pipe / process lease / app-server E2E 尚未执行 | 证据缺口；不得标 Windows-ready，后续 PR 必须显式携带并在 CI / 目标机补证 |
| target machine / live daemon / 真实飞书 E2E | 未执行 | 不得报告为已上线或原 Session 已修复 |

## 当前工作树、迁移目标与远端风险

- ORIGINAL WIP 当前 `HEAD=44e4113937080303afca9037aae1bf483dd2982c`，本地 tracking ref `origin/master=6c75d44c4fd942b490dc8648038d89a1541eb7fc`；两者不相等。`git status --porcelain` 当前是 137 个 tracked status row + 40 个 untracked row，改动仍未 commit。clean migration target 另行固定在 `c14b0180cf39cd8c219d5a6a1389b2cd794faf94`，其 PR 文档与验证必须独立生成，不能复用本段旧稿状态。
- 历史恢复点仍包括 include-untracked stash `23db3c031d9d83b96bb1decd94721d8673f0e627`；此前 `f46a49c1edae00981e29e0893d0d7d700544066c`、`768f2ec77c4886100761a0f299056feafa0c120f`、`baa211dc93d94e6136e519629d08f6fa9ba6315b` 也仍保留，均为历史恢复证据，不代表当前 base/clean 状态。
- 本次 upstream 是 PR #470 的会议多 Agent 可靠投递，和 Issue1 有 12 个重叠文件：`src/codex-app-runner.ts`、`src/daemon.ts`、Dashboard i18n/style、CLI i18n、`src/types.ts`、`src/utils/child-env.ts`、`src/worker.ts`、runner integration fixture/test 与 worker source-contract test。
- 三个文本冲突位于 `src/codex-app-runner.ts`、`src/worker.ts`、`test/codex-app-runner.integration.test.ts`。runner 保留上游 `RunnerControlWriter` 只做可见正文/错误转义，Codex lifecycle/final 不再写 terminal marker；worker 保留上游 `RunnerControlDecoder` 供 Mira/Mir 使用，`codex-app` 明确不在 OSC allowlist。
- 上游 #470 的 stable Botmux/native turn identity、worker-owned dispatch attempt、durable terminal drain、backend-exit ambiguous fencing、durable expiry/restart语义均保留。审计还发现并修复一个迁移缺口：`spawnCli` 异步化后，in-worker restart 的 500ms respawn 曾未 `await`；现在 init、crash retry 与 in-worker restart 三条路径都等待 endpoint bind + locator publish，并识别 `CliSpawnSupersededError`。
- 其余 9 个 auto-merge overlap 已逐项对照：daemon 只叠加 `stalled` maintenance busy；types 同时保留 #470 dispatch/receiver schema 与 Issue1 status；child-env 同时保留 dispatch attempt 和 one-shot bootstrap path；fixture 同时保留 #470 OSC injection 与 bootstrap/argv泄漏检查。
- 2026-07-16 本轮远端复核：PR #484 仍为 `OPEN / BLOCKED / REVIEW_REQUIRED`，head `02b58abdd9126b0610c9e124794690cb2cca5169`，无 CI checks，`updatedAt=2026-07-16T08:31:44Z`。它仍与 Herdr/worker 文件级重叠；无论后续状态如何，本修复都不能退回“按 backend.isReattach 认证”，actual getter 只用于 screen seeding，控制面继续依赖公钥 challenge proof。

## 未覆盖项与回滚

- Windows native ACL、named-pipe、owner-lease 和 bootstrap delete-sharing 仍无目标机 E2E；在补证据前仅可报告“实现 + 平台无关行为测试通过”。
- 90 秒是“没有可观察进展”而非故障判定；安静的长工具可能暂时进入 `stalled`。
- 同一 turn 的通知去重在 worker 内存中；worker 重启后同一长任务可能再提醒一次。
- worker 事件循环完全冻结时无法运行状态 tick；这需要 daemon watchdog，超出本 PR。
- 本 PR 不提供自动取消、自动重启或 exactly-once 模型/工具执行。daemon ledger 与 ACK 保证归属、顺序、fail-closed 恢复和已持久化 settlement 的 replay ACK；普通飞书稳定 UUID 仅在 provider 的 1 小时窗口内提供幂等，超出窗口的 crash replay 仍是 at-least-once 边界。
- 显式 doc-comment 成功发送后，`docCommentTargets[turn]` 的进程内条目尚未主动清理；它不会跨 sink 泄漏或覆盖 durable ledger，但会保留到进程结束，后续可单独补清理。
- read-isolation 现在是 close-first / retry 语义：必须关闭该 bot 的全部 Session，并等待 PID 消失及 owned persistent backing 证明 missing 后才能切换。Dashboard 当前会显示后端 409 文本；更友好的专用 UI/i18n 提示可后续补充，不影响安全边界。
- 回滚会移除 liveness、`stalled` UI 与非对称控制通道；回滚版本无法可信接管本版本的现代 runner，应 cold-start persistent Codex App pane。任何 live 切换/重启仍需单独维护窗口与用户确认。
