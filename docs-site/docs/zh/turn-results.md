# 通用单轮结果

`TurnResult` 把执行结束、最终正文和实际投递分开。它用于读取本轮已经产生的结果，不会重新运行模型、发送消息或执行业务动作。

## 启用与权限

在目标机器人的 `bots.json` 中显式启用：

```json
{
  "turnResults": { "enabled": true }
}
```

默认关闭。启用后只收集受支持的普通 IM 轮次；按现有机器人配置加载方式生效。关闭或撤回时，后续读取/收集会清除该机器人的缓存正文。

结果读取仅供具有既有 trusted-host HMAC 权限的宿主调用者使用。该端点不加入 core-only 免鉴权白名单，不接受模型提供的应用身份或当前会话 capability 作为跨会话读取许可。结果引用本身不是权限。

## 读取结果

```text
GET /api/sessions/:sessionId/turns/:turnId/result
GET /api/sessions/:sessionId/turns/:turnId/result?dispatchAttempt=1
```

使用与其他 trusted-host IPC 调用相同的签名方式和 daemon 发现机制。机器人身份取自处理请求的 daemon；不提供跨机器人查询字段。`dispatchAttempt` 缺省表示该轮没有 attempt 值，不表示“最新一次”。

成功查询 HTTP 200；错误参数 HTTP 400，缺少 HMAC HTTP 401，非可信宿主 handler HTTP 403。HTTP 成功只证明查询成功，任务是否成功要看对象内状态。

| `status` | 含义 |
|---|---|
| `ready` | 附带 `result`；已具备本轮执行终态及可证明的最终输出/投递事实 |
| `not_ready` | 仅观察到部分事实，尚不能判定完整结果 |
| `unavailable` | 功能关闭、模式不支持、结果依据过期等；不返回猜测正文 |
| `not_found` | 没有此精确引用，或已经被淘汰；不从历史文件恢复 |

```json
{
  "status": "ready",
  "result": {
    "version": 1,
    "ref": {
      "botId": "example_app",
      "sessionId": "example_session",
      "turnId": "om_example"
    },
    "source": {
      "kind": "im",
      "platform": "lark",
      "chatId": "oc_example",
      "messageId": "om_example"
    },
    "execution": { "status": "completed" },
    "output": {
      "status": "available",
      "format": "markdown",
      "source": "transcript",
      "content": "本轮完整的最终正文"
    },
    "deliveries": [{
      "channel": "im",
      "status": "delivered",
      "platform": "lark",
      "chatId": "oc_example",
      "messages": [
        { "kind": "primary", "messageId": "om_reply" },
        { "kind": "attachment", "messageId": "om_full_answer" }
      ]
    }]
  }
}
```

## 独立状态

- `execution.status`：`completed`、`failed`、`cancelled`、`ambiguous`，来自真实 native terminal；缺失时间/耗时保持缺省。
- `output.status`：`available`、`empty`、`unavailable`。正文是已采用的权威最终回答，不是思考、进度或之后不同的 transcript。明确空输出需要 positive silence evidence。
- `deliveries[].status`：`delivered`、`partial`、`failed`、`unknown`、`suppressed`。`messages` 仅列已证明发送成功的主消息及本轮最终附件。已有卡片并不证明最后 PATCH 成功。

模型完成不等于消息送达；正文被审核拒绝时不通过结果接口绕过审核。失败执行不暴露部分模型答案。超长内容既可能存在于原群独立 Markdown 附件，也可能超过结果接口容量；后者返回 `output.status=unavailable`、`reason=result_too_large`，不截断冒充全文。

## 覆盖与限制

首版支持具有可信 IM 入站来源、当前代次及本次发布回执的普通 transcript final。跨进程 explicit final、已有卡片复用和不能证明完整载体的发送形态保持 unavailable/not_ready；不从 `turn-sends`、旧回复卡、最后消息或历史 transcript 推测正文、代次和全部附件。

已有会话的 raw passthrough（用户直接输入的 CLI 原生命令）不写入可信 `sourceMessageId`，因此该路径的轮次不收集结果。冷启动的初始 passthrough 可携带真实入站消息来源，仍须满足相同模式、所有权及发布回执检查；不从回复目标补造入站来源。

会议接收器、文档、私有回复、沙盒/读隔离、静默任务、adopt、headless/HTTP 结果等特殊路径不通过本功能外发正文。已有 HTTP trigger/headless 和 workflow 结果协议保持原样；本功能不强行合并它们。

单个会话或轮次变为不支持时，只删除该精确结果引用，不清空同一机器人的其他会话或 attempt。关闭功能或撤回机器人级策略时仍清空该机器人的结果。

快照只保留在 daemon 内存中：

- 总计最多 128 个 pending/ready 上下文和 16 MiB 缓存；
- 单个结果最多 1 MiB；
- ready 保留 15 分钟，pending 最多 5 分钟；
- 访问时惰性清理，daemon 重启后不可用；读取不会延长保留期。

该缓存不是副作用去重或恢复账本，不保证跨重启读取、自动重投或 exactly-once。现有 `turn.completed` Webhook 与反馈数据库继续只含元数据，不增加全文。

## 内部完成通知

嵌入宿主可使用 worker-pool 的可选 `onTurnResult(result)` 回调取得同一不可变快照。默认没有消费者，不执行外部命令，不新增公共生命周期广播。

通知在结果会合后发出，异步错误或 10 秒观察超时独立报告，不改变原模型结果、重发原群分析或进入模型重试。超时不代表能够取消任意观察者代码，也不代表业务动作没有发生。

需要使用结果执行其他动作时，应由调用方另行核验身份、目标范围和写权限。读取能力不授权建群、邀请、部署、改配置或任意跨群转发。
