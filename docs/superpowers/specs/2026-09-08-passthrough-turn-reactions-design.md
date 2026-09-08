# Passthrough 执行轮次 Reaction 修复设计

## 目标

修复所有真正提交给 CLI 的透传指令缺少状态 reaction 的问题，并覆盖待选项目卡片确认后才开始执行的冷启动路径。纯 daemon 管理命令、权限拒绝和无效操作不产生执行状态 reaction。

## 根因

普通用户消息在 daemon 接纳路径调用 `noteTurnReceived`，因此无流式卡片时会登记“已收到” reaction，并由 worker idle 边界的 `finishTurnReactions` 收尾为完成。透传命令在解析后提前进入 raw-input 专用路径；项目卡片回调又直接从 card handler 启动 worker。两类路径都绕过普通消息的接纳点，因此 worker 虽然执行了 turn，却没有登记 `pendingAckReactions`。

## 设计

将 reaction 绑定到“本轮已被 CLI 接纳”的语义，而不是绑定到“看到斜杠”或“点击卡片”入口：

1. **已有会话透传**：`raw_input` 被 worker 接受后，为该透传指令的原始 Lark 消息登记 reaction，再开始 turn。
2. **冷启动透传**：保留原始 `messageId` 作为 `pendingRawTurnId`；直接启动或选择项目后启动时，在 durable/fork 接纳成功的边界登记 reaction。
3. **项目卡片确认**：若卡片提交启动的是普通待处理用户轮次，使用原始 `pendingTurnId`；若启动的是透传轮次，使用 `pendingRawTurnId`。reaction 始终落在原始用户消息，不落在卡片消息上。
4. **收尾不变**：继续复用现有 `finishTurnReactions`，worker 回到 idle 时将处理中 reaction 翻为完成。
5. **失败语义**：权限拒绝、无效命令、worker 未接受、卡片选择未提交成功时不登记 reaction；reaction API 失败仍为 best effort，不阻塞 CLI 执行。

为避免 `card-handler` 反向依赖 daemon，实现通过现有依赖注入接口传入“登记已接纳 turn reaction”的回调，而不复制 reaction 逻辑。

## 影响范围

- 影响：Lark、无流式卡片会话、所有 raw passthrough 指令、待选项目后的首轮提交。
- 不影响：daemon 管理命令、流式卡片开启的普通会话、非 Lark 平台、CLI 命令字节内容及现有 turn 收尾机制。
- `silentTurnReactions` 继续生效。

## 测试

新增或扩展单测，至少覆盖：

- 已有会话任意 passthrough 指令在 worker 接受后登记 reaction。
- worker 拒绝 raw input 时不登记 reaction。
- `/goal` 冷启动直接 fork 后登记原始消息 reaction。
- `/goal` 等待项目选择后，在卡片确认并成功 fork 时登记原始消息 reaction。
- 普通待选项目首轮同样登记原始消息 reaction。
- `silentTurnReactions`、流式卡片开启、重复 message id 的既有行为不回归。

运行定向 Vitest、类型检查/构建；若需要飞书实测，再切换当前 checkout 并重启 daemon，验证处理中到完成的实际表情变化。
