# 当前执行的只读证明

Codex App 的新版独立 runner 使用主干的签名 `appServerProcess` 声明，worker 在本会话 backend 的宿主进程树中核对启动令牌，并通过 `NSpid` 解析命名空间内 PID，随后沿私有 IPC 发布引擎根。该现代证明路径优先于本 PR 的旧协议兼容，不会再被旧根覆盖。

兼容已在运行、尚不带 `appServerProcess` 的旧 runner 时，才沿已认证签名通道处理 `processIdentity`：核对同一 session 的唯一 runner、其直接启动的 RPC 子进程、内核血缘和继承的 stdio。普通 busy/idle 不重新快照工具。旧协议空闲重启在投递前发布 `idle_restart`；旧引擎必须已退出、无待收尾 final 且新身份重新通过内核/stdio 验证，才更新旧根。新版引擎轮换继续使用主干的出生令牌和旧引擎退出检查。

worker 重建后，只有存活 runner 已通过本次 challenge 且为唯一 active 签名代次、正整数签名序号越过该代次的 daemon 持久 ACK（首轮尚无完成记录时高水位为 0）、引擎已证明，且 runner 签名的精确 reply turn 与 daemon 下发的唯一 prepared 记录及恢复队列匹配时，才恢复该记录中的真人轮次。新 runner 在原生 busy state 中上报 `activeReplyTurnId`；旧 runner 可沿已有 thinking 记录的签名 turn 恢复，单凭 busy 不足以恢复。真人来源必须由 daemon 冻结的普通交互标记和 sender 共同证明；不使用 PID marker、最新聊天发送人、callerless/机器人记录或有歧义的队列补身份。

`botmux execution current --json` 返回调用工具进程所属的当前执行。适用于本机 Linux 的普通消息与机器 Trigger；不要求该轮存在真人 caller 或已验证邮箱。

命令复用 ancestor routing 和 loopback transport，向 `POST /api/current-execution` 发送 `sessionId`（新版本 CLI 另按需发送 `fields`，如 `["origin"]`；旧 daemon 不识别该键时直接忽略，旧 CLI 从不发送，返回文档保持不变）。daemon 从真实 TCP socket 确定调用 PID，再核对 Worker/CLI/RPC engine 的进程启动标识、当前代次及本轮之前已存在的进程树。宿主 HMAC、环境中的 TURN_ID、请求自报的 turn、旧进程或其他会话均不能代替这条检查。远程后端、没有可验证本机血缘或不支持进程证明的平台返回 blocked，不退回环境值。

旧 `processIdentity` 兼容路径不适用于 `bwrap --unshare-pid`：旧 runner 读取沙箱内 `/proc`，严格宿主血缘/stdio 检查无法证明该 PID，保持 blocked。新版 `appServerProcess` 已通过主干的命名空间映射路径处理该场景；不将旧协议的限制解释为新版的全局限制。历史跟踪见 [#2383](https://github.com/deepcoldy/botmux/issues/2383)。

`coreOnlyPidNamespaceDegrade()` 去掉 `--unshare-pid` 的降级仅可能出现在 `BOTMUX_CORE_ONLY=1` 且宿主无法创建该命名空间时。core-only 合成的会话为 `apiOnly`，`larkTransportEnabled` 对它直接返回 false，不消费这套执行证明；普通带飞书通道的会话不走该降级。因此同一飞书会话不会因宿主探测结果在这两种证明行为之间翻转。

Codex 的原生 `codex-code-mode-host` 会跨轮复用，属于引擎的工具派发进程。只有它是已证明 Codex 根进程的直接子进程、内核报告的可执行文件位于同一发布目录且没有额外启动参数时，血缘检查才允许本轮新工具经过它；不凭进程名或命令行自报身份。常驻 host 自身、上一轮工具及其后续子进程仍不能取得本轮权限。`actor current` 还要求当前执行具有可信真人 caller。增量授权使用当前执行的 caller 或有效工具委托指定的真人作为授权目标，并核对授权期间的主体与执行变化。

成功响应：

```json
{"schema":"botmux.current-execution.v1","status":"verified","larkAppId":"cli_example","sessionId":"session-example","chatId":"oc_example","turnId":"trigger-example","workerGeneration":7,"dispatchAttempt":2}
```

`dispatchAttempt` 仅在 daemon 的当前执行存在该字段时返回。`identityTurnId` 可选，标识该执行选用的工具身份；补充消息保留原执行者时，它可以与 `turnId` 不同。

### 轮次来源 `origin`

`botmux execution current --json` 还会返回 `origin`，说明这一轮是怎么来的，供按轮次取凭证的外部 shim 区分「真人消息」和「定时任务」等，不必解析 `turnId` 前缀。值只由 daemon 按它自己的记录得出：已证明的当前 turnId（由 daemon 生成、经 worker 私有 IPC 回报）、会话的逐轮记录与恢复标记、Trigger 准入登记。不读取请求方的参数、环境变量或它能写的文件。请求体里自带的 `origin` 等字段会被忽略。

| `origin` | 含义 | 附带字段 |
|---|---|---|
| `im` | 真人在飞书发的消息打开的这一轮（发送者经平台确认是人） | — |
| `dispatch` | 另一个机器人发的消息打开的这一轮（bot@bot 派单、话题派发） | — |
| `schedule` | 定时任务触发的这一轮，包括它失败后的自动续跑 | `scheduleTaskId`：任务 id |
| `trigger` | 经 Trigger 接口提交的这一轮 | `triggerSource`：`webhook` / `ui` / `workflow` / `schedule` / `vc_meeting` / `headless` |
| `recovery` | daemon 为某个非定时任务轮次发起的续跑（普通回合恢复、失败回合 /retry、只读任务续跑），不是新的真人请求 | — |
| `unknown` | daemon 没有这一轮的来源记录，例如 CLI 本地输入、worker 自己生成的轮次，或 daemon 重启后不再登记的 Trigger 轮次 | — |

`unknown` 不代表「真人」，按「不能确定」处理。`dispatch` 只说明发起方是机器人，不说明背后是谁。附带字段只会和对应的 `origin` 同时出现。

```json
{"schema":"botmux.current-execution.v1","status":"verified","larkAppId":"cli_example","sessionId":"session-example","chatId":"oc_example","turnId":"schedule:abcdef12:12345678-1234-1234-1234-123456789abc","workerGeneration":7,"origin":"schedule","scheduleTaskId":"abcdef12"}
```

**这是公开契约字段。schema 保持 `botmux.current-execution.v1`，三个字段都是可选的，没有升到 v2。** 理由：
- 只读原有字段（`turnId` 等）的调用方行为不变。
- 老版本 CLI 对返回的字段做严格白名单校验，多一个键就会报 `current_execution_unverified`。所以新字段是按需返回的：新 CLI 请求时带 `fields: ["origin"]`，daemon 只在收到这个请求时才附上 origin。
  - 老 CLI 不带这个请求，拿到的文档和原来逐字一致。
  - 老 daemon 忽略这个请求，新 CLI 拿到的就是不带 origin 的 v1 文档（字段可选，校验照常通过）。
- 升到 v2 的话，任何一边版本不一致都会被 schema 判不通过，反而会出现不兼容。

`botmux capabilities --json` 的 `current_execution_origin_v1` 表示这个本地构建会请求、也能解析 origin。和 `current_execution_v1` 一样，它不能证明所连接的 daemon 已经升级。对方 daemon 还是旧版本时，返回里就没有 origin。

### 可用范围

- **可用**：本机 Linux 上的 PTY / tmux 等本地后端，包括未开沙盒的会话，以及开了沙盒（bwrap）但与宿主共享网络的会话。
- **不可用**：远程后端、不支持进程证明的平台，返回 blocked（见上文）。
- **不可用**：网络与宿主隔离的沙盒会话，即配了 `sandboxNetworkPolicy`（slirp4netns `--disable-host-loopback`）或 `sandboxNetwork: false`。沙盒里的 127.0.0.1 是它自己网络命名空间的 loopback，连不到 daemon 的 loopback 端口，命令直接因连接失败退出，不会退回环境值。
  - 实测：在 slirp4netns 1.2.0、`--disable-host-loopback` 的命名空间里访问宿主 127.0.0.1 上的 HTTP 端口，127.0.0.1 与网关 10.0.2.2 都连不上；去掉该参数后，经 10.0.2.2 可以连上。
  - 这类会话的受管工具入口改用单快照文件 wrapper（见下文）。

受管工具入口不直接读取该文档接口，而是调用同族窄路由 `POST /api/current-execution-identity`（请求体 `{sessionId, tool}`）：同样的 loopback 血缘证明通过后，daemon 直接返回该执行身份轮次的 env assignment **正文**（schema `botmux.current-execution-identity.v1`，字段 `identityTurnId` 与 `env`），wrapper `eval` 正文后 exec 真实工具；证明失败返回 `current_execution_unverified`，血缘成立但该轮身份材料不存在（未准备/已终态回收/daemon 重启）返回 404 `identity_material_unavailable`，二者都对应 wrapper 退出码 77。会话不在 proven 模型（网络隔离沙盒、adopt/remote/app-server/workflow/非 Linux）时该路由 403，这些路径使用单快照文件 wrapper。CLI 校验响应的完整形状与 bot/session；不输出 capability 或真人身份。`capabilities --json` 的 `current_execution_v1` 只声明本地构建能力，不能证明连接的 daemon 已升级或当前调用可验证。

这是即时观察，不能缓存为授权令牌，也不证明输入已提交、业务已完成或真人已批准。消费者仍需关联自己的原请求和当前修订，在每个受保护操作前重新观察，并独立验证权限、输入依据及结果回执。接口不派发、续租、消费事件或修改会话。机器触发可在没有真人 actor 时凭当前执行证明和有效工具委托申请目标用户授权，委托范围与该用户的实际授权仍须满足工具要求。

持久pane与普通PTY使用同一宿主计算的 `BOTMUX_SESSION_SCOPE`。tmux、tmux-pipe、Zellij与Zmx的共享启动包装器在加载shell配置后清掉继承值，再传入当前会话的thread/chat；未提供scope时保持缺省，bots.json的env不能覆盖。该变量仅用于会话路由，不充当当前执行证明；旧已启动pane需在后续受控重建时才能获得此修复。
