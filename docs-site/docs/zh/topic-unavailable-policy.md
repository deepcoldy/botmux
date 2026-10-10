# 原话题不可用时停止发送

`topicUnavailablePolicy` 按机器人配置，默认 `legacy`。在 Dashboard → 回复投递中选择，或使用：

```sh
/botconfig set topicUnavailablePolicy stop
/botconfig unset topicUnavailablePolicy
```

| 配置 | 行为 |
| --- | --- |
| `legacy` | 保持原有发送和兜底行为，不增加话题查询。 |
| `stop` | 发送前检查原话题／引用目标和显式 `--into` 目标；目标撤回或状态无法确认时暂停发送。 |

配置对后续 CLI 发送与自动最终回复立即生效。显式改发顶层或其他话题仍须检查原目标；无来源话题的广播不增加查询。已经发送成功的消息会直接复用回执，不再查询或发送。

## 拒绝与恢复

- `TOPIC_SEND_BLOCKED`：消息已撤回，包括飞书错误码 `230011`。自动最终回复立即停止重试，在 Dashboard「需要你」中显示阻塞原因。结果保持未投递，不向其他会话补发通知。
- `TOPIC_SEND_CHECK_FAILED`：查询失败或无法确认消息状态。可重试原查询，不能据此改发其他位置。
- CLI 统一输出 `botmux send refused: …` 并以状态码 2 退出。

一次发送内，有效查询最多复用 1 秒；CLI 准备阶段与首次临发检查分别读取最新状态，同一检查阶段的重复调用复用结果。失败和状态不明的结果不缓存。预检后若飞书返回引用已撤回，仍会停止原有的顶层兜底发送。

恢复默认策略可执行 `/botconfig set topicUnavailablePolicy legacy` 或上面的 unset 命令。这项配置不会取消正在执行的业务，也不代表可以删除原任务内容。
