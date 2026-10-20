# 空闲清理同步归档 Codex

`sessionCleanup.archiveCodex` 缺省为 false，可在 Dashboard 设置页的空闲清理区域开启；它独立于定时清理的 enabled，同时适用于手动关闭、手动和定时清理。只改配置开关不会扫描或归档历史会话。

Dashboard 两处空闲清理 fanout 向现有 close RPC 传递 `idleCleanup: true`。Daemon 先完成普通关闭，再处理原生归档。Dashboard / CLI close RPC、`/close` 和飞书关闭卡片同样启用归档；休眠、重启、仓库替换和其它自动关闭路径不会归档。飞书卡片异步完成归档并通过话题消息提示失败，避免阻塞回调 ACK。关闭成功但归档失败，响应仍保留 `ok: true` 和独立的 `archiveError`，批量结果统计 `archiveFailed`；手动关闭/清理显示警告，定时清理记录日志。

Worker 在原生 session id 已确认时上报可信目标（thread id、实际 Codex executable、实际 CODEX_HOME）。支持自有本地 Codex CLI / codex-app 的 pty/tmux，包括 Codex RPC input 模式；codex-app 使用实际 Codex executable 而非 runner 的 Node/Bun executable；外部 adopt、existingAppServerEndpoint、wrapper、remote runner、scratch 和缺少目标的历史记录跳过。不从 live bot 配置推测旧会话目录。

归档前持久化 pending journal，成功后改 archived。RPC 失败/超时保留 journal，防止远端已成功但响应丢失造成恢复遗漏。恢复仅由本功能 journal 授权，先 unarchive 成功再激活 Botmux；失败保持 closed，可重试。关闭和恢复的原生操作按 session id 串行。解除开关不会阻止已归档会话恢复。

RPC 复用现有短生命周期 stdio app-server client，采用官方 `thread/archive` / `thread/unarchive`，请求参数为 `{threadId}`。先 `thread/read` 检查 id 和 rollout path 属于冻结 home 的 sessions/archived_sessions；已经处于目标状态时跳过 RPC，支持用户手动恢复和丢失响应后的幂等重试。每个 RPC 阶段有 3 秒期限，finally 关闭子进程。子进程的 owner env 使用 `applySessionOwnerEnv`，ownerless 会话清除继承身份。

官方协议：https://developers.openai.com/codex/app-server/ 。原生 archive 可能同时归档其 spawned descendant；本功能不自行扫描、删除或批量移动文件。

影响面：清理选择器共用于其它 CLI，增加一个独立失败统计字段但保留原关闭统计。其它 CLI 不满足归档资格；两类本地后端共用持久化目标。使用平台无关 path/stdio API，mock 用例在 macOS 验证，Linux 未实机验证。

## 旧会话诊断补充

升级前的记录可能同时缺少 `codexCleanupTarget` 和 `backendType`。开启归档后清理这种记录，只会关闭 Botmux，不能把没有目标证明的跳过当作归档成功。现在返回 `codex_archive_target_unverified` 并在手动清理 UI / 定时日志提示；不会猜测默认 CODEX_HOME，也不会对已关闭的历史记录补发 RPC。恢复并启动 Worker 确认原生身份后，记录即使仍缺少 backendType，也可以使用 Worker 已验证的本地目标。

Daemon 的 close 日志记录 `explicit_close` 或 `idle_cleanup:manual|scheduled|unspecified`，清理日志记录 disabled / archived / not_applicable / 目标校验失败 / rpc_failed，避免以后无法确定触发入口。

## Worker 退出状态与验证

Worker 退出仅表示进程结束，持久会话仍为 active 时，向 Dashboard 发布 dormant 更新；只有真正关闭的会话才发布 session.exited。聚合器和浏览器缓存均验证这一规则，避免启动失败后看板 closed、存储 active 不一致。

已完成构建及 348 项相关 mock / 回归测试，包含清理、恢复、配置校验、其它 CLI 的挂起路径以及 Worker 退出状态投影。一次授权的单条产品验证通过 Dashboard cleanup-idle 指定唯一 sessionIds：匹配 1、关闭 1、归档失败 0；随后由官方 thread/read 确认原生路径进入 archived_sessions，并确认恢复 journal 为 archived、其它会话未改变。验证未发送消息，也未恢复最终归档结果。

真实链路在 Node 24 下通过。此前 Bun/tmux 启动异常在恢复 Node 后未复现，但未证明底层确切原因；本变更不将该异常描述为已经定位或修复的 Bun 缺陷。浏览器视觉检查因现有自动化/截图权限限制未完成，未更改这些权限。


## 手动关闭同步归档

开关开启后，Dashboard 单条/批量关闭、CLI delete 的在线 daemon 路径、`/close`（含已确认的 worktree 关闭）、`/lane close`、飞书关闭按钮及会话详情卡片同样同步归档。关闭失败不归档；外部 adopt 只断开 Botmux。命令、卡片、Web 和 CLI 分别显示归档失败，不把成功的本地关闭误报为失败。CLI 的离线强制清理没有在线 daemon 归档能力，不推测原生目录。

卡片 ACK 不等待原生 RPC；归档任务仍进入同一串行生命周期队列。恢复在队列内重读 owned 记录，避免卡片刚返回时读取到尚无 journal 的旧快照。旧 closed 记录没有本功能 journal 时不补归档；pending 可重试，archived 重复关闭不重发 RPC。

本轮使用隔离 checkout 完成构建及 mock 验证：10 个清理/关闭/恢复/休眠测试文件 185 项通过；手动关闭命令定向测试 13 项通过；会话卡片 dispatch、关闭消费者、删除边界测试 39 项通过。不同命令间存在测试文件重叠，不累加为唯一测试数。本轮未部署、未修改 live 配置、未操作真实 Codex 会话，未进行 UI 视觉验证。


## 路径与关闭时序回归修复

原生路径校验先 realpath home 与 rollout，再检查文件位于 canonical home 的 sessions / archived_sessions 子树；支持软链接 home，同时拒绝文件或目录软链接逃逸。Worker 在实际启动时冻结 executable 的真实路径；codex-app 取 runner 参数中的原生 --codex-bin，RPC 引擎使用同一稳定路径，发布 thread ID 时不再重新解析 PATH 或临时 alias。

卡片关闭仍立即 ACK，但归档进入按 session 串行的生命周期队列后先等待该关闭代的原生释放 ticket；session_close_ready 和 Worker exit code 0 均不能单独证明原生线程已释放；重开也排在同一队列内。不能证明释放时不发归档，归档失败保留恢复 journal 并提示。回归包含真实 closeSession + fake Worker、退出前无 RPC、退出后 archive/unarchive 顺序及 archive 失败后的恢复。

同步上游 master 后，强化异常退出拒绝归档后，24 个完整相关测试文件 1141 项通过（含原生延迟退出、gate 代际替换、超时和无证明退出）；覆盖归档/恢复、路径逃逸、临时 executable alias 删除、关闭命令/飞书路由、配置及其它 CLI 挂起，无测试名过滤。构建在隔离目录使用上游钉住的 Bun 1.4.3 和 Node 24，未部署或操作真实 Codex 会话。


## 原生释放凭据补全

Worker 的 exit code 0 只能证明包装进程退出，不能证明 detached app-server 已释放。显式关闭现在先捕获属于该次启动的 CLI / RPC 原生进程树及进程出生身份，保持 Worker 存活、有界 await RPC stop 和原生进程退出；原生进程退出前不会发送释放证明。丢失、异常、超时或无法读取身份时 fail closed。延迟强杀计时器随原生子进程退出清除，不对已退出的 PID 补发信号。

Daemon 在 pool 实际选择本次关闭对象时生成 session/thread/workerGeneration/nonce 绑定的 ticket，仅接受该 IPC 子进程的匹配证明；干净 Worker exit、旧代或错误 nonce 都不能授权归档。IPC 在 mutation gate 内调用 pool 并获取 ticket，避免 gate 等待期间旧→新或无→新 Worker 的快照过时。卡片仍不 await teardown，归档与重开使用同一生命周期串行队列。

验证过的释放凭据随 pending / archived journal 保存，允许已确认释放后的 RPC 失败重试与幂等关闭；旧 pending 记录或当前无 Worker 且无法证明原生释放的记录不推测凭据，只提示并拒绝归档。历史归档的显式恢复规则保留。所有生产归档入口均由 service 校验凭据，不允许无证明的新归档。

新增真实 CodexRpcEngine + 延迟 1.5 秒退出的 fake app-server，以及真实 IPC / mutation gate 的代际替换回归；覆盖正常证明、异常/超时/无证明、重复关闭、过期代与并发重开。仅 fake 原生进程，无真实会话操作。


本轮验证使用 `bun run test` 显式列出 24 个完整相关测试文件并设置 `--maxWorkers=3`，无 `-t` 过滤，1141 项全部通过；`bun run build` 在 Node 24 / Bun 1.4.3 隔离目录执行。覆盖原生 RPC、释放票据、真实 IPC/gate、session 恢复、命令与卡片、配置和其它 CLI 挂起路径。本轮未部署，未操作真实会话。
