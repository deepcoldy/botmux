# CLI 启动失败的重启归属与熔断

## 原因

argv 携带首条任务的 CLI 可以先启动，再写 transcript。进程在这两步之间退出时，
会话契约已有 queued execution，却还没有将它绑定到 runtime。

原退出事件同时携带物理 runtime 与这条 execution；事件网关把“任务还没证明开始”
当成“不能相信进程退出”，以 `execution_scope_unproven` 拒绝 `claude_exit`。
worker 已将 backend 置空，而 daemon 没收到可处理的退出事件，也就没有实际重启者。
后续输入命中 `cliRestartInProgress || !backend`，日志一直说 restarting，
实际上并不证明存在任何重启操作。活着的 Node worker 和遗留 working 状态一起造成
“卡片启动中、observe 工作中”的假象。

物理退出现在仍校验 runtime producer、worker channel 和 execution 引用，但不要求
一个尚未执行的任务已经绑定到退出的 runtime。它不会因此给任务授予执行权；
历史 runtime 的退出、正在进行的物理 replacement、其它 worker 的事件仍受原有围栏约束。

## 启动失败判定与预算

只处理实际观测到的非零退出，不为仍在运行的 CLI 添加启动超时：

- 新起、未就绪的 CLI，或 argv 首轮尚无开始证据，即为启动失败。
- 结构化 CLI 在启动后 30 秒内，仍有排队或在途输入、且没有 native user/final/input-consumed
  证据时退出，也算启动失败。死 pane 的静默画面可能被启发式地识别为 ready，不能以此绕过熔断。
- 已有 native 输入/首轮证据优先：长任务没有出现 idle prompt 不等于启动失败。
- warm reattach、adopt、主动进程切换不走此判定。共享 tmux/hc outage 由 daemon 原有
  outage 协调器先行处理；最后一个 pane 的自然退出导致 server gone 时，仍是单会话退出。
- 首次启动失败允许一次自动重试，沿用 multiplexer 抖动与 500ms respawn 延迟；
  第二次启动失败熔断。计数跨失败时间窗累计，真正 ready 后稳定存活满原健康窗口才重置。
- 正常运行中的退出与已知永久错误，保留原来的重启预算。

## 收敛与恢复

若 CLI 在 backend 退出监听器安装前就结束，沿用致命启动失败路径立即停止，
不等待第二次退出；该路径同样更新原启动卡。tmux 的原始诊断保留在本机，
通过带退出码的错误类型生成安全的公开说明，不把终端尾部直接贴到飞书。

退出一被确认，本地托管 CLI 状态就投影为 `interrupted`，不再用活 worker 推导 working。
重启后的 prompt-ready 或精确匹配的成功回执会清除前一个进程的中断状态。

熔断时保留轻量 worker，但不再起诊断 shell或定时 respawn；终止 ordinary pending 与
carry-over 输入。durable/at-most-once 输入继续由原有 receipt 所有者对账，不在 worker
重新执行。输入结果发送部分失败时，不回滚终态去重器、不重放未知送达结果，而是退出
worker，交 daemon 的既有 worker-exit 路径继续对账。

延迟重启使用 epoch 围栏，覆盖 jitter、teardown、plugin/RPC、spawn 和 title 初始化的
等待边界。熔断会结算被取消重启的 completion callback；旧 continuation 不能在新一轮
重试期间清除它的状态、触发 fatal 或重新拉起旧进程。

失败卡在原启动卡上追加明确说明，保留原有按钮回调语义。说明只包含 CLI 名称和数字退出码，
不向飞书转发原始 stderr/命令；完整诊断留在本机日志。晚完成的 starting-card POST/patch
也不能覆盖这次失败状态。修复安装或配置后，同话题的新消息开启新的有界尝试，不再暗中重放
已失败的队列；显式 `/restart` 仍按既有语义工作。

### 未提交开场任务的恢复

带 `queuedActivationToken` 的未写入 raw/普通开场输入仍由持久 activation journal
持有；熔断不能把它们当成 ordinary 输入清空，也不能伪造 `queued_activation_submitted`。
worker 保留原 payload/token，daemon 保留 `pendingRawInput` 和 ACK gate。
后续新消息先持久追加到 activation tail，再通过已有 restart coordinator 唤醒已停 CLI。
并发到达由同一 attempt 合并；落盘失败不得发送重启，重启发送失败保留 journal 和失败标记。
新一轮只有真正的 adapter submission ACK 才能释放后继，不能让恢复消息越过原开场输入。
若 tokened 开场输入已经进入 in-flight/carry-over、但 adapter 的结果尚未返回，
熔断不在原 worker 盲目重放：退出该 worker，交既有 worker-exit 与 exact activation journal
处理下一次输入触发的恢复，避免既没有 ACK 又没有可执行恢复所有者。
关闭/暂停及转移中的会话不能由这条入口重新拉起。

CLI 物理退出不撤销已经送达的任务结果：没有新输入时仍保留 `delivered`；
后来的输入使旧结果失效时才投影为中断。既有 attention 仍优先于已交付结果。
跨 runtime 的物理退出仍要求可信 producer/channel；本次只补这条已有边界的回归。

`observe` 继续使用 schema v1 已有字段：`turn=interrupted`、
`task.kind=needs_you`、`task.reason=interrupted`，原因通过 attention/detail 给出。
`liveness=alive` 仍只表示桥接 worker 存活，不表示 CLI 正在工作。

## 验证边界

自动化以真实 worker、私有 tmux、真实 SQLite 会话契约和 fake Pi 重现 pane 消失、
非零退出、一次自动重启、失败卡更新、排队收敛、observe 投影和新消息重新启动。
可控时钟探针另覆盖手动取消、半发送、长 await 与取消窗口交叠，并做移除守卫的变异复验。

![启动失败卡片离线示意，非飞书客户端截图](../images/cli-startup-failure.png)

没有部署、重启或修改开发机的在线 daemon。真实飞书渲染、真实 provider 与 macOS
环境仍需要独立端到端验证；不能把离线图或 Linux fake CLI 结果当作这部分已经通过。
