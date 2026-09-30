# 异步执行中的群消息

`POST /api/trigger` 的 `options.allowChatMessages` 用于已有飞书群会话：调用方通过异步接口读取执行结果，同时允许本轮按请求授权主动发群消息。消息是否需要发送、内容和发送时机由调用方决定；Botmux 不编排业务步骤。

```json
{
  "source": { "type": "ui", "connectorId": "example", "requestId": "request-1" },
  "target": { "kind": "turn", "botId": "APP_ID", "sessionId": "EXISTING_SESSION_ID" },
  "envelope": { "format": "example.v1", "sourceName": "Example", "trusted": false, "payload": {} },
  "instruction": "执行已授权请求；在当前群发送用户需要的消息，并返回完整执行结果。",
  "options": {
    "asyncReturnSessionId": true,
    "allowChatMessages": true,
    "suppressFinalOutput": true,
    "turnIdempotencyKey": "request-1"
  }
}
```

## 参数与范围

- 默认 `false`。开启后，本轮提示词允许按当前请求授权调用 `botmux send`；它不强制发送，也不增加账号权限或提供工具层权限隔离。
- 只支持 `target.kind=turn`、已有 `target.sessionId` 和 `asyncReturnSessionId=true`。当前不支持同步等待、单聊、headless、apiOnly 和 HTTP 虚拟会话。
- daemon 核验会话属于当前机器人、具备真实飞书传输且为群聊。请求另带 chatId 时，必须与会话绑定一致。
- 参数只作用于当前输入，不写入会话配置；后续请求须再次显式开启。

## 结果与重试

`allowChatMessages` 控制显式群消息的提示词约定，`suppressFinalOutput` 控制 daemon 自动转发最终回复，两者独立。异步结果查询和 `BOTMUX_NOTHING_TO_SEND` 语义保持不变。

需要重试时，复用相同 `turnIdempotencyKey` 和完整请求。同一 key 改变 `allowChatMessages` 会产生幂等冲突；该机制保证输入派发不重复，不提供所有下游消息或业务操作的事务保证。
