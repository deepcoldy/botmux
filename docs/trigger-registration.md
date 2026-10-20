# 按原幂等键只读查询执行注册

宿主调用公共 CLI（显式 bot/session/原 key，不接受 Worker/relay 上下文）：

    botmux trigger-registration --bot APP --session SESSION --key ORIGINAL_KEY

CLI 使用现有 daemon discovery、host HMAC 和 loopbackFetch；不导入私有状态、创建会话或重新派发。成功结果带 schemaVersion=1 与服务端 larkAppId/sessionId，CLI 核验目标身份后才输出，错路由不返回另一机器人的观察。

也可调用已认证的 daemon IPC：

    GET /api/sessions/:sessionId/trigger-registration?turnIdempotencyKey=<原键>

适用于 POST /api/trigger 在已有会话上的 options.turnIdempotencyKey。
键按原接口 trim，原始长度上限 200。机器人身份取自服务端，不能通过参数选择。
接口沿用 host IPC 认证及启动恢复门禁，不在 core-only 的免认证列表中。

- 200 / state=registered：返回原 triggerId、requestHash、租约状态、
  revision、ownerBootId 和记录时间。attempting 是禁止重复派发的持久屏障，
  本身不能证明输入已经提交或模型仍在运行。
- inputCommitted.state=observed：daemon 收到精确 turn 的真实
  turn_input_committed，并已将 workerGeneration、observedAt 持久写入原租约。
  observedAt 是 daemon 的观察时间，不是模型开始或业务完成时间。
- inputCommitted.state=unknown：没有可证明的输入提交证据。旧版本记录、
  ACK 丢失、提交后落盘前崩溃及存储失败均可能产生此状态。
- result：同一机器人、同一 trigger 的已有持久结果摘要；pending 只是存储状态。
  resultRef 指向现有 trigger-result 接口。查询注册不追踪或回写 steer 链，
  也不自动收敛故障；trigger-result 保持原有行为。
- 200 / state=unknown：原键未保留，或者不属于当前机器人；不能据此判断从未执行。
  保留范围取决于已有记录生命周期，没有额外承诺永久保存或完整历史窗口。
- 503 / observation_unavailable：记录损坏、不可读或服务身份未就绪；
  400 / bad_request：参数无效。不会在错误中返回本地路径。

读取不 claim、不 takeover、不创建会话、不派发、不 GC，也不更新时间或 revision。
结果来自独立持久记录的保守快照，不承诺跨文件事务视图。输入证据写入复用
原租约的文件锁与原子持久写，重复 ACK 不改 revision，过期 boot、turn 或
generation 不覆盖已有证据；缺少证据不会改变 attempting 屏障。

客户端应保存原 session、原 key 和请求内容，比较返回的 requestHash。
unknown / unavailable 不授权换新键重跑；继续查询或进入已有恢复流程。
接口不推断业务状态，也不生成存储中不存在的 dispatch attempt 身份。
