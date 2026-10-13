# 当前执行的只读证明

`botmux execution current --json` 返回调用工具进程所属的当前执行。适用于本机 Linux 的普通消息与机器 Trigger；不要求该轮存在真人 caller 或已验证邮箱。

命令复用 ancestor routing 和 loopback transport，仅发送 sessionId 到 `POST /api/current-execution`。daemon 从真实 TCP socket 确定调用 PID，再核对 Worker/CLI/RPC engine 的进程启动标识、当前代次及本轮之前已存在的进程树。宿主 HMAC、环境中的 TURN_ID、请求自报的 turn、旧进程或其他会话均不能代替这条检查。远程后端、没有可验证本机血缘或不支持进程证明的平台返回 blocked，不退回环境值。

成功响应：

```json
{"schema":"botmux.current-execution.v1","status":"verified","larkAppId":"cli_example","sessionId":"session-example","chatId":"oc_example","turnId":"trigger-example","workerGeneration":7,"dispatchAttempt":2}
```

`dispatchAttempt` 仅在 daemon 的当前执行存在该字段时返回。CLI 校验响应的完整形状与 bot/session；不输出 capability、凭据或真人身份。`capabilities --json` 的 `current_execution_v1` 只声明本地构建能力，不能证明连接的 daemon 已升级或当前调用可验证。

这是即时观察，不能缓存为授权令牌，也不证明输入已提交、业务已完成或真人已批准。消费者仍需关联自己的原请求和当前修订，在每个受保护操作前重新观察，并独立验证权限、输入依据及结果回执。接口不派发、续租、消费事件或修改会话；既有 `actor current` 和身份授权仍要求真人来源。

持久pane与普通PTY使用同一宿主计算的 `BOTMUX_SESSION_SCOPE`。tmux、tmux-pipe、Zellij与Zmx的共享启动包装器在加载shell配置后清掉继承值，再传入当前会话的thread/chat；未提供scope时保持缺省，bots.json的env不能覆盖。该变量仅用于会话路由，不充当当前执行证明；旧已启动pane需在后续受控重建时才能获得此修复。
