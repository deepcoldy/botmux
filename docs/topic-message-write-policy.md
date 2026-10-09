# 消息写入的原话题检查

[官方策略配置](../docs-site/docs/zh/topic-unavailable-policy.md)可以显式设置 `topicUnavailablePolicy: "stop"`。未配置或使用 `"legacy"` 时沿用已有行为，不增加消息状态查询。此策略属于共享飞书客户端的可选能力；不会创建其他群或话题，不修改身份、角色或权限。

reply、整卡 PATCH、forward、urgent、新增表情/置顶和 CardKit 写入会在调用前读取精确消息；若消息属于话题，还读取它的根。必须明确读到匹配 ID 且 `deleted: false`。确认撤回返回 `TOPIC_SEND_BLOCKED`；缺失、重复、状态未知或查询失败返回 `TOPIC_SEND_CHECK_FAILED`。API gate 内的重试会重新查询；删除已有表情/置顶属于清理操作，仍可执行。Pin 维持原来的未确认返回 null 语义。

原消息检查不与远端写入组成原子事务。支持撤回错误码的接口会把写入期间的撤回归为停止错误；不能据此宣称 exactly-once 或自动替换目标。原始错误和确认结果由调用者继续处理。

CardKit 的 cardId 不能证明消息归属。已有 CardStreamStore 在原锁内将其已持久化的 messageId 随 sequence lease 传到 CLI/daemon transport；没有新增数据格式、索引、UUID 或独立调度器。直接调用 CardKit 写接口的调用者必须提供真实 messageId；stop 下缺少证据会拒绝。

`sendMessage`、`replyMessage` 和 `updateMessage` 可接收 `beforeWrite` 回调。它在实际 provider 尝试前执行，失败后不会触发发送后的 outbound hook。回调属于调用者提供的可信上下文，不能来自消息正文。它位于 options 参数：sendMessage 第 7 参数，replyMessage 第 8 参数；hookContext 是另一参数。

CLI `send` 在解析 `--top-level`、`--chat-id`、`--into` 或 `--session-id` 时仍保留进程来源会话和当前 turn 的原话题；来源策略与目标策略分别核验。已完成且请求身份一致的 final 直接返回原 messageId，不重新查询话题或发送。其他请求在新投递前检查来源，并由 `beforeWrite` 带入每次实际传输与限流重试。账本维护/读取可能创建目录与维护标记，不代表预留了投递；被拒绝的请求不能产生投递记录，也不能改写原未决记录。引用被撤回且采用 stop 时不改发顶层；explicit chat 来源没有当前话题时不把历史 root 当成来源。

CLI `report` 的直接消息和 Issue 状态通知同样保留来源会话/turn；选择别的接收会话不改变来源。Issue 已保存的状态独立保留，通知被拒绝不能反推状态保存失败。Daemon 内报告 relay 的派发、自动 fallback、`dispatch` 创建和 workflow 等路线仍需对应调用方保护；该配置不能仅靠共享客户端反推出它们的新建顶层消息来源。

原生 CoT 创建检查冻结来源；追加、结束及孤儿恢复检查已有气泡与根。拒绝时保留原恢复 marker，显式无话题来源保持原位置。上述检查不包含受管 Ask 退休或业务展示规则。

线程来源缺少原消息身份时，CLI send/report 返回 TOPIC_SEND_CHECK_FAILED。明确无话题的群会话保持原行为；延迟调度尚未建立话题的既有生命周期单独处理，不能用可选目标数组过滤来推断来源不存在。

同一次实际 provider 尝试给目的地和来源检查提供共享查询函数；进入限流重试或下一次独立写入时新建缓存。执行权检查位于异步话题查询之后。原卡片 PATCH 也传递最终检查，不依赖排队前的一次旧证明。
