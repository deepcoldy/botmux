# 外部看门狗的受控失败恢复

Botmux 提供失败恢复原语，外部管理员进程负责错误分类、轮询和退避。接口不自行安装或启用看门狗，也不改变普通对话、手动 `/retry` 或已有定时任务。

## 接口与身份

`controlled_failure_recovery_v1` 声明本构建包含这组能力；实际 daemon 是否可用仍须查询接口。以下接口仅接受既有宿主 IPC 鉴权，Worker capability、会话 Owner 和客户端自报的用户身份均不能授权恢复。

- `GET /api/sessions/:sessionId/failure-recovery`：返回最近失败的 `turnId`、`failedAt`、`originalTurnId`、`actorBound` 和恢复回执。不会返回任务正文、用户身份或凭据。
- `POST /api/sessions/:sessionId/failure-recovery`：请求必须恰好包含 `turnId`、`failedAt`、`requestId`、`mode`。`mode=retry` 使用原会话的准确输入；`mode=fresh` 确认旧进程关闭后，在原群和话题建立新的原生上下文，并重新装配 Runtime 输入。

```json
{"turnId":"om_example","failedAt":"2026-10-16T00:00:00.000Z","requestId":"watchdog-example","mode":"fresh"}
```

身份由 daemon 在真实失败终态或原生限流状态冻结。恢复只使用对应轮次已证实的真人／定时创建者，重新检查对话权限，并调用正常的每轮工具身份准备；工具执行时仍检查当前个人凭据与资源权限。定时创建者继续使用既有定时任务 authority，不升级为刚发送消息的真人。Owner 与发起人不同、没有身份快照、用户访问被撤销时，均不借用其他身份。非真人且不能证明原请求者的失败不自动恢复；升级前缺少快照的旧记录也不从 Owner 补齐。

恢复派发使用独立 turn；同一逻辑任务的 `originalTurnId` 不变。看门狗应据此限制整个任务的恢复次数，而非按新 session 重新计数。新生 turn 的授权来源明确标记为恢复或定时创建者，不能借此取得要求刚发生真人操作的管理能力。

## 并发与回执

同一 Bot 的原生 mutation gate 串行化生命周期变更。新 IM 在等待 gate、关闭旧进程和准备工具身份期间到达时，会取消过期恢复；已有新输入、排队输入、运行中的任务或原生恢复同样拒绝重投。仅在最终同步检查通过后接受 Worker 输入。

在关闭或发送前先持久化 `attempting`。同一失败只接受一个请求；相同 `requestId` 重取回执，不重复派发。不同请求 ID、变化的失败引用或 mode 不可覆盖已有请求。关闭残留、崩溃或 IPC 结果不确定时保留 `dispatch_unknown`／`attempting`，不能通过换 ID 重试。

- `accepted`：Runtime 接受了恢复派发，不证明模型完成、工具成功或飞书最终回复。
- `cancelled`：新输入取消了旧恢复，不再提交原任务。
- `attempting`、`dispatch_unknown`：需要核对真实执行，禁止盲目重投。

远程 backend、adopt、退休工作区及专用 principal lane 不通过这个会重建本地生命周期的入口；普通会话的既有机制不变。新上下文保留原话题、工作区、冻结配置和任务输入，不复用损坏的 CLI resume ID。旧会话及回执保留供审计。

## 验证边界

定向测试覆盖宿主 HTTP 鉴权、客户端身份注入拒绝、双用户／Owner 区分、限流快照、输入竞态、权限撤销、并发、重启后的回执和关闭残留。测试与构建不等于已经部署；真实模型、受保护工具和消息回执仍需在目标 Runtime 验收。
