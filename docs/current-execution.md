# 当前执行的只读证明

Codex App 的独立 runner 通过已认证的签名 state 上报原生 app-server 的 PID 与启动时间；worker 再核对本会话 backend 血缘及继承的 RPC stdin/stdout 管道，随后沿私有 IPC 发布引擎根。npm 的 Node 启动器不再造成跨轮工具被误判。接管旧 runner 时，只在签名通道认证后识别同一可执行文件、同一 session 的唯一 runner 及其直接启动的 RPC 子进程；歧义或无法证明时仍拒绝。普通 busy/idle 不重新快照正在执行的工具。引擎空闲退出后，runner 在新引擎投递原生轮次前发布签名的 `idle_restart` 边界；只有旧引擎已退出、没有待收尾 final 且新身份重新通过内核和 stdio 验证时，worker 才更新引擎根，不发布额外 prompt-ready。旧工具和旧代次不能获得新轮权限。

worker 重建后，只有存活 runner 已通过本次 challenge 且为唯一 active 签名代次、正整数签名序号越过该代次的 daemon 持久 ACK（首轮尚无完成记录时高水位为 0）、引擎已证明，且 runner 签名的精确 reply turn 与 daemon 下发的唯一 prepared 记录及恢复队列匹配时，才恢复该记录中的真人轮次。新 runner 在原生 busy state 中上报 `activeReplyTurnId`；旧 runner 可沿已有 thinking 记录的签名 turn 恢复，单凭 busy 不足以恢复。真人来源必须由 daemon 冻结的普通交互标记和 sender 共同证明；不使用 PID marker、最新聊天发送人、callerless/机器人记录或有歧义的队列补身份。

`botmux execution current --json` 返回调用工具进程所属的当前执行。适用于本机 Linux 的普通消息与机器 Trigger；不要求该轮存在真人 caller 或已验证邮箱。

命令复用 ancestor routing 和 loopback transport，仅发送 sessionId 到 `POST /api/current-execution`。daemon 从真实 TCP socket 确定调用 PID，再核对 Worker/CLI/RPC engine 的进程启动标识、当前代次及本轮之前已存在的进程树。宿主 HMAC、环境中的 TURN_ID、请求自报的 turn、旧进程或其他会话均不能代替这条检查。远程后端、没有可验证本机血缘或不支持进程证明的平台返回 blocked，不退回环境值。

本机 Linux 的适用范围不包括开启 `bwrap --unshare-pid` 的文件沙箱：runner 读取沙箱内 `/proc`，worker 核对宿主 `/proc`，PID 空间不同，无法将沙箱内的 `processIdentity` 建立为宿主可验证的引擎血缘；这条执行证明不适用，保持 blocked。此限制不是本 PR 引入的回归：PR 前后的沙箱内跨轮工具判定均无法证明该宿主血缘，没有新增放行路径。跨命名空间身份映射需要独立设计宿主/沙箱 PID 对照，不在本 PR 范围，后续跟踪见 [#2383](https://github.com/deepcoldy/botmux/issues/2383)。

`coreOnlyPidNamespaceDegrade()` 去掉 `--unshare-pid` 的降级仅可能出现在 `BOTMUX_CORE_ONLY=1` 且宿主无法创建该命名空间时。core-only 合成的会话为 `apiOnly`，`larkTransportEnabled` 对它直接返回 false，不消费这套执行证明；普通带飞书通道的会话不走该降级。因此同一飞书会话不会因宿主探测结果在这两种证明行为之间翻转。

Codex 的原生 `codex-code-mode-host` 会跨轮复用，属于引擎的工具派发进程。只有它是已证明 Codex 根进程的直接子进程、内核报告的可执行文件位于同一发布目录且没有额外启动参数时，血缘检查才允许本轮新工具经过它；不凭进程名或命令行自报身份。常驻 host 自身、上一轮工具及其后续子进程仍不能取得本轮权限。`actor current` 还要求当前执行具有可信真人 caller。增量授权使用当前执行的 caller 或有效工具委托指定的真人作为授权目标，并核对授权期间的主体与执行变化。

成功响应：

```json
{"schema":"botmux.current-execution.v1","status":"verified","larkAppId":"cli_example","sessionId":"session-example","chatId":"oc_example","turnId":"trigger-example","workerGeneration":7,"dispatchAttempt":2}
```

`dispatchAttempt` 仅在 daemon 的当前执行存在该字段时返回。`identityTurnId` 可选，标识该执行选用的工具身份；补充消息保留原执行者时，它可以与 `turnId` 不同。

受管工具入口不直接读取该文档接口，而是调用同族窄路由 `POST /api/current-execution-identity`（请求体 `{sessionId, tool}`）：同样的 loopback 血缘证明通过后，daemon 直接返回该执行身份轮次的 env assignment **正文**（schema `botmux.current-execution-identity.v1`，字段 `identityTurnId` 与 `env`），wrapper `eval` 正文后 exec 真实工具；证明失败返回 `current_execution_unverified`，血缘成立但该轮身份材料不存在（未准备/已终态回收/daemon 重启）返回 404 `identity_material_unavailable`，二者都对应 wrapper 退出码 77。会话不在 proven 模型（网络隔离沙盒、adopt/remote/app-server/workflow/非 Linux）时该路由 403，这些路径使用单快照文件 wrapper。CLI 校验响应的完整形状与 bot/session；不输出 capability 或真人身份。`capabilities --json` 的 `current_execution_v1` 只声明本地构建能力，不能证明连接的 daemon 已升级或当前调用可验证。

这是即时观察，不能缓存为授权令牌，也不证明输入已提交、业务已完成或真人已批准。消费者仍需关联自己的原请求和当前修订，在每个受保护操作前重新观察，并独立验证权限、输入依据及结果回执。接口不派发、续租、消费事件或修改会话。机器触发可在没有真人 actor 时凭当前执行证明和有效工具委托申请目标用户授权，委托范围与该用户的实际授权仍须满足工具要求。

持久pane与普通PTY使用同一宿主计算的 `BOTMUX_SESSION_SCOPE`。tmux、tmux-pipe、Zellij与Zmx的共享启动包装器在加载shell配置后清掉继承值，再传入当前会话的thread/chat；未提供scope时保持缺省，bots.json的env不能覆盖。该变量仅用于会话路由，不充当当前执行证明；旧已启动pane需在后续受控重建时才能获得此修复。
