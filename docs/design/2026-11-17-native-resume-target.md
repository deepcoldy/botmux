# 受管原生历史副本的精确换绑

## 与既有能力的边界

复用现有 `RestartCoordinator`、SessionController 生命周期、Worker 精确 resume 与原生 PID/rollout 归属证明，不另建一套 restart 或绕过 native ID 观测。

普通 `/fork` 是 CLI 自己复制同一协议的历史，`/relay` 是会话路由迁移，自动换模续接保留原生会话 ID；这些均不等于把一个不同 provider 的历史转换成原生副本。宿主本次只接受调用者已准备好的副本，不实现特定网关、模型、凭据或 provider 数据转换。

## 管理协议

仅有管理身份的 Dashboard 可调用 `GET/POST /api/sessions/:id/resume-target`；到所属 daemon 的调用须有宿主 HMAC。POST 同时沿用 Dashboard CSRF/origin 闸，不能使用模型回合 capability 代替管理权限。

POST 只接受四个字符串：

```json
{
  "sourceId": "00000000-0000-4000-8000-000000000001",
  "targetId": "00000000-0000-4000-8000-000000000002",
  "sourceSha256": "<原文件 sha256>",
  "targetSha256": "<副本 sha256>"
}
```

不接受路径、模型、effort、提示词或 caller 覆盖。请求由当前会话所属 daemon 接纳。首版只支持本地独占 TraeX 的 PTY/tmux、已初始化且已空闲的 canonical_v1 历史；remote/adopt/隔离/自动换模/工作流节点拒绝。未知状态不等于空闲。

HTTP 202 只是接纳，响应含相关 restart attemptId，不能显示“迁移完成”。调用方随后 GET 读取原生 ID、worker/CLI readiness 及 busy 状态，必须匹配其唯一 targetId、两项 ready 且非 busy 才能确认完成。返回不包含原文、凭据或文件路径。

### 无新消息的冷准备

`POST /api/sessions/:id/resume-target/prepare` 仅接收 `{sourceId}`，用于唤醒已有的
本地受管休眠 tmux 话题。复用宿主 `ensureTerminalWorkerPort`，不创建新会话、
不追加任务文本。精确源 ID、对象归属、管理身份、HMAC、CSRF、输入与生命周期守卫
均不可省略。关闭、远程、adopt、隔离、非 tmux 的冷恢复不在支持范围。

GET 另返回 `cold`、`retiring` 与 `preparation`。尚在退出的 worker 不算可唤醒的
冷会话，不能清掉其引用后再次 fork。准备状态按当前会话对象、源 ID 与尝试记录，
区分 warming、worker_started 和 failed；helper 拒绝、异常或返回 undefined
均为可观测失败，不能永久保持“已接纳”。端口已监听不代表 CLI 已空闲。

Dashboard 将浏览器响应断连与代理 deadline 一起传入 IPC AbortSignal；排在 mutation
gate 后的请求在接纳前再次检查。断连后的 waiter 不得在释放 gate 后迟到唤醒话题。

### 同 ID 运行环境更新

本地受管 Codex tmux 可使用 `POST /api/sessions/:id/resume-target/park`，同样只接收
`{sourceId}`，复用 `suspendWorkerAsync` 的原生后台释放与可恢复历史语义，不使用会
中断回答的普通 restart。管理/HMAC/CSRF、有限排队与断连守卫不变；只在确实空闲、
没有输入、后台任务和未投递答复时接受。在异步主状态落盘后再次校验原对象、worker
代次、原生 ID、当前操作和输入；任何一项变化都不得执行物理休眠。

这是运行环境的原 ID 更新，不包含 Codex provider 转换或历史副本。GET 以独立
`sameIdRuntimeRestartSupported` 能力位区分，准备接口仅为这一已支持范围扩展冷唤醒。
HTTP parked 只证明已休眠，不表示新运行环境已经启动；调用者要单独对账唤醒结果，
不注入新任务。模型、凭据、具体网关版本与恢复配置由经过授权的调用者负责。

## 证明与失败

1. daemon 有界获取 Bot mutation gate，并在物理接纳前复核 HTTP 连接仍有效；超时的 waiter 被移除，代理断连后不得迟到执行。gate 内检查当前身份和未完成输入，拒绝重叠生命周期操作；异步 primary flush 后重新核对 worker 代次。
2. Worker 在物理操作前重新验证当前 PID 只打开预期 source、空 composer、无输入积压、无在途回合。
3. 路径由 Worker 按自己的原生数据根解析，不采纳调用者路径；校验边界、文件大小、完整行、源/副本 hash、header ID、fork 血缘与原生终态。
4. 用已有的受管重启停下源进程，确认其进程树静止后再次验证。此时若出现不确定性或文件变化，停止，不在可能仍存活的源上叠加新进程。
5. 恢复只允许精确 targetId，禁止不存在时降级成空白新会话。
6. 成功回执必须有新进程真实打开目标 rollout 的证据，先发布原生 ID 再确认 restart。argv、HTTP 202、进程存活均不是成功证明。

宿主不修改原稿或副本，也不注入“继续”提示或重放工具。副本的消息/工具内容、模型/provider 兼容和非可移植状态处理，由调用方在显式授权下负责验证。调用方应持久化副本来源及操作记录，daemon 重启后按精确 targetId 与 readiness 对账，不能看到超时就重复建副本或重放原请求。

HTTP 读回的 busy 同时检查待处理人工输入、后继输入、受保护操作、生命周期、消息投递与后台任务，不只依赖屏幕 idle。接纳、读回和代理异常均返回有限错误码，不反射内部路径或异常原文。若副作用已接纳但响应丢失，调用方只能读回对账，不能把网络失败解释为已回滚。

### 控制器与物理身份

SessionController 进入 restart 操作后，公开 ready getter 会被本次操作主动遮蔽。
异步落盘后的二次检查不能因此拒绝自己，也不能忽略后来进入的人工输入。检查绑定
接纳前捕获的真实 RuntimeRef、精确 operation ID 与实际 prompt readiness；
持久化沿用接纳前的 readiness。其它操作或代次仍被拒绝。

新 CLI 的原生 ID 可能在 Worker init 之后才产生，不能只信 init 配置的空 ID。
目标换绑以此刻唯一 PID/rollout 归属证明得到的原生 ID 为准，并与请求 sourceId
逐字匹配；这不会放宽空闲、文件完整性、血缘或进程树静止要求。

## 影响范围

- 既有 restart 默认行为保持不变；新的强校验仅显式 resume-target 请求启用。
- 共享重启函数增加可选的严格 `beforeRespawn` 失败边界，普通可选维护仍按旧合同恢复。
- macOS/Linux 的文件与进程证明均复用现有实现；跨平台实际验证应分别记录，不以一种平台的实测代替另一种。
- 不支持的 CLI/backend/隔离模式明确拒绝，不偷偷放宽沙盒，也不改 Bot 默认模型。
