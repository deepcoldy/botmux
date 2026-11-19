# 飞书长连接假在线事故

11 月 5 日 03:11 UTC，botmux 3.55.0 的飞书长连接因收不到 pong 而进入重连，随后记录了握手超时、配置请求超时和一条未处理的 `ErrorEvent`。直到 08:01 人工重启，daemon 仍在做定时清理，PID 和 supervisor 重启计数均未变化。以下实验使用 Bun 1.4.3、SDK 1.73.0 和本地回环网关，无需飞书账号。

## 为什么抛错，又为什么进程活着

1. SDK 的 `ws-client/index.ts` 中，`WSClient.connect()` 的握手计时器执行 `removeAllListeners(); terminate(); settleOnce(false)`。对尚在 CONNECTING 的 socket，Bun 的 ws 兼容层稍后才调用 `emit('error', ErrorEvent)`。监听器已被摘除，异常发生在新的事件循环回合。同步 `try/catch` 接不到它。SDK 的 `close()` 也有先摘监听器再关闭的路径。
2. 单文件版的入口有一处关键差异。3.55.0 的 `src/standalone-entry.ts` 顶层执行 `await import('./cli.js')`。随后 `src/cli.ts` 的内部命令分支导入 `index-daemon`，停在下面这个永远不会完成的顶层 await。

   ```ts
   else if (__entrySubcommand === 'daemon') await import('./index-daemon.js');
   // ...其他内部命令分支...
   await new Promise<never>(() => {});
   ```

   在官方 3.55.0 Darwin arm64 单文件版，用隔离的 API-only 配置启动真正的 `__daemon`，等启动完成再注入原生 ws 黑洞异常。进程没有 `uncaughtException` 监听器，打印 `ws:284` 后同一 PID 的 timer 仍然执行。对 3.55.0 源码只将这个 await 改为已完成的 Promise，同一探针就打印 Bun 版本并退出 1。最小入口也复现了这组对照。Bun 1.4.3 在入口模块仍在求值时的错误处理足以解释进程存活。daemon 的 `unhandledRejection` 钩子没有参与这条路径。
3. 在修复后的 daemon 入口重复注入同一异常，stderr 记录 `[FATAL] uncaughtException in daemon`，随后退出 1。业务消息处理中的 promise rejection 继续使用原有策略。

## 为什么不再重试

旧 SDK 的 `WSClient.reConnect() → loopReConnect()` 先执行 `await tryConnect()`，然后才安装下一次 `setTimeout`。其中 `tryConnect()` 先 await `pullConnectConfig()` 再 await `connect()`。配置请求里的 Axios 超时和 WS 握手计时器各自只管一段，创建代理隧道时可以没有生效的超时。

| 假设 | 对照结果 |
| --- | --- |
| (a) 代理卡住配置拉取 | 用真实 SDK、Axios 1.20.0 和 TCP 代理。已有连接断开后，第一次重连握手超时；下一次配置请求发出了 HTTP CONNECT，代理接受后不响应，并允许后续新请求成功。Axios timeout 缩短为 100 ms，2 秒后仍只有 3 次 discovery（含首次成功），状态保持 `reconnecting`。独立 POST 探针也在 400 ms 超时设置下悬挂超过 1.8 秒。 |
| (b) 异步异常打断重试 | 在官方 3.55.0 的真实 `__daemon` 进程中注入同版 SDK 和网关，没有全局 exception 监听器。打印 `ws:284` 后，**下一次**配置请求实际到达代理。这次可复现的停滞发生在那个请求内部。旧循环还缺少捕获 `tryConnect()` 意外 rejection 的边界。 |
| (c) generation 失配 | 同一实验没有调用第二次 `start()` 或 `close()`。源码中显式关闭会递增 generation 并清理 `isConnecting`，旧看门狗只在 `failed` 时调用 `start()`，计数变化不是这条复现的前提。 |

事故现场可以确认到第二次配置请求发生了 Axios 超时。没有第三次请求的跟踪信息，实验能证明 (a) 会造成同样的无限静默，不能反推出当天第三次实际卡在 CONNECT、TLS 或其他具体步骤。此前 warn 级别隐藏了逐次的重试日志。旧 `src/im/lark/transport/connection.ts::startLarkConnection()` 每 60 秒只判断 `state === 'failed'`，持续 `reconnecting` 就永久绕过恢复。

## 修复与运行参数

- `src/im/lark/transport/resilient-ws-client.ts` 在单个 SDK 实例上管理拨号和重试，沿用 SDK 的端点发现、协议、分片缓存、事件处理和 ACK。socket 创建即有永久 error 监听器，握手超时、主动关闭、领导权退出均走安全清理。SDK 私有边界与依赖锁到 1.73.0，升级时需重跑真实代理回归。
- 每次尝试共用 35 秒 deadline，覆盖 HTTPS 配置发现和 WS 握手。超时撤销 HTTP 请求和代理 TCP 建连，过期回调不得写回配置或安装 socket。可重试失败按 1 秒为起点、60 秒为上限的指数退避加抖动继续尝试。一次只有一个请求或一个退避 timer。服务端明确拒绝凭据时保留终止状态，由外层看门狗处置。
- `src/im/lark/transport/connection.ts` 处理长时间未连上和收不到真实入站帧两种情况。重建更换 SDK 实例，注销订阅会撤销整条链路。只有当前实例收到入站帧才能清零连续重建次数。超过预算，daemon 退出 1，由 supervisor 接管。成功、开始尝试和失败原因均进入 botmux 自身日志。
- `botmux status` 同时列出进程和飞书连接状态，Dashboard 监控页列出状态起始时间、尝试次数和最近入站。使用 daemon 现有的 30 秒心跳发布快照；Dashboard 每 10 秒刷新。入站时间只来自真实帧。API-only 实例显示 disabled。

| 可选配置 | 默认 | 含义 |
| --- | --- | --- |
| `BOTMUX_LARK_WS_RECONNECT_STALE_MS` | 300000 | 同一代连接停在 connecting/reconnecting 等未连上状态多久后重建 |
| `BOTMUX_LARK_WS_INBOUND_STALE_MS` | 900000 | 自最近入站或本代启动以来的静默上限，覆盖仍声称 connected 的连接 |
| `BOTMUX_LARK_WS_MAX_REBUILDS` | 3 | 连续重建预算耗尽后，下一次仍不健康就退出 1 |

探测周期取 60 秒与两个阈值的最小值；默认阈值触发与实际处置之间至多相差一个探测周期（事件循环正常调度时）。15 秒的独立握手计时器和发送 ping 后 30 秒无入站的看门狗继续工作。

## 消息补偿边界

`src/im/lark/event-dispatcher.ts::connect()` 在 primary 模式的 `enqueuePrimary` 存在时提前返回，所以不会安装旧 message-listener 的 30 秒轮询。其他模式下该轮询也只处理配置了监听的群、一定时间和分页范围内的历史消息。读历史与 WS 共用出网代理；历史接口也无法重建卡片点击、部分更新和撤回等所有事件。

primary 已经有带领导权检查的 `recoverDurablePrimaryIngressOnce()`，在传输就绪前后按相同事件 ID 扫描和去重。此次让同一次中断的 WS 替换沿用原来的恢复窗口和 ready promise。强行切换旧轮询会绕过这条入队路径，增加乱序和重复投递风险。长时间断网、分页上限或 daemon 重启后，历史仍只按策略窗口恢复，无法据此认定事故期间的所有事件都已补齐。

## 同类路径与验证

- SDK `close({force:true})` 和普通 `close()` 均覆盖。SDK ping 看门狗有意保留 close 监听器，让断线进入重试。仓库 `src/platform/tunnel-client.ts` 的败方清理和 `stop()` 在 `terminate()` 前已装 error 接收器，成功候选切换到 `adoptControl()` 时同步换上正式监听器。交互选择器只摘除 stdin 的 data 监听器。
- SDK 的 `handleEventData() → eventDispatcher.invoke()` 等待持久化完成才 ACK；这个 await 属于业务处理。补偿历史的列表、分页和 settle 有各自的时限。此次只修改连接恢复及同一中断的交接。会话目录 env-stamp、cgroup 文件缺失告警、字体安装器的 405 分别独立跟进。
- `test/lark-ws-blackhole.test.ts` 启动独立 Bun 进程和回环网关，依次接受不响应的 WS upgrade、接受不响应的代理 CONNECT、恢复可达性，检查收到真实入站帧及代理 socket 释放。持续黑洞另行检查客户端替换、非零退出。编译版入口的顶层 await 与原生 WS ErrorEvent 单独验证。
- `test/lark-resilient-ws-client.test.ts`、`test/lark-connection.test.ts` 覆盖单飞、deadline、指数退避、迟到响应、主动关闭、连续重建预算和旧回调。单文件探针也使用了 Bun 1.4.3 的 `--compile --minify`。
- 上游已有握手/关闭清理修复。代理无响应使整个重试循环停住另有独立复现。[SDK PR #219](https://github.com/larksuite/node-sdk/pull/219) · [SDK issue #234](https://github.com/larksuite/node-sdk/issues/234)
