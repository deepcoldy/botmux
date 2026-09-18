# dispatch 话题标识回执

`botmux dispatch` 在原有 JSON 回执上新增 `threadId: string | null`，供调用方构造话题跳转链接。`seedMessageId`、`threadRootId`、派发/接单状态及其他旧字段的值与省略规则不变。`threadRootId` 仍是 `om_...` 消息 ID，继续用于 `--into`、路由和回报绑定；`threadId` 是 `omt_...` 话题 ID，二者不可互换。

## 数据来源

- [获取指定消息的内容](https://open.feishu.cn/document/server-docs/im-v1/message/get)：`data.items[].thread_id` 是消息所属话题 ID，未返回表示该消息不是话题消息。
- [回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply)：`reply_in_thread=true` 表示以话题形式回复；已有话题默认在话题内回复。响应也提供 `thread_id`。
- 仓库锁定的 `@larksuiteoapi/node-sdk` 1.73.0 在 `types/index.d.ts` 的 `im.v1.message.get` 返回类型中声明了 `data.items[].thread_id`，`reply` 也声明了 `reply_in_thread` 与响应 `thread_id`。
- 现有 `src/im/lark/client.ts` 的 `replyMessage` 只返回消息 ID。此次不改它的公共返回类型，而复用同文件 `getMessageThreadId`：通过不带请求体的 GET 读取根消息详情。`src/cli.ts` 的 `resolveDispatchThreadId` 在回复成功后执行这次查询。

普通群的顶层种子不一定已经有话题 ID，因此不能只在发送种子时读取，也不能把 `om_` 前缀替换成 `omt_`。查询结果必须是有效的 `omt_...` 字符串才返回。

## 各模式行为

| 模式 | 已有消息行为（不变） | 新字段的读取时机 |
| --- | --- | --- |
| 新建派发 | 发种子，然后以 `reply_in_thread=true` 发送简报；有 `--repo` 时先发送目录预设 | 回复与原有回执处理完成后读取种子根消息 |
| `--standby --repo` | 发种子和话题内 `/repo` 预设，不发简报，`taskSent=false` | `/repo` 回复后读取种子根消息，仍可获得话题 ID |
| `--into <om_根消息ID>` | 不建新种子，向给定根消息发送话题内追加简报；不新增 `seedMessageId` | 追加回复后读取给定根消息，返回已有话题的 ID |

以上行为对普通群（`normal`）和话题群（`topic`）一致，不依赖群类型缓存。普通群支持话题回复时，原有回复操作即可形成话题；不支持话题回复的群仍按原有发送错误处理，本次不改建群能力或群类型。

查询只用于补充回执，每次派发最多查询一次，网络请求带 2 秒超时与取消信号。权限不足、网络失败、超时、空值、非法格式或话题暂未可读时，JSON 中显式返回 `threadId: null`，不改变已有 `success`、`taskSent`、`errorCode`、接单状态或退出码，也不重复发消息。接单超时但消息已发送的回执仍可带有效 `threadId`。发送失败的结构化错误回执为 `threadId: null`，不额外查询；发送前校验错误保持原输出形态。

`null` 仅表示本次没有拿到可用标识，不证明话题不存在。调用方可稍后只读查询 `threadRootId`，不要为了取 ID 再次 dispatch。通过沙盒 relay 调用时，JSON 由宿主 CLI 产生并透传；宿主 CLI 未更新时仍可能没有新字段。

## 使用

返回示意（只列关联字段）：

```json
{
  "seedMessageId": "om_example",
  "threadRootId": "om_example",
  "threadId": "omt_d4be107c616a",
  "chatId": "oc_example"
}
```

取得非空 `threadId` 后，可用 `chatId` 和 `threadId` 构造链接；仓库内已有 `src/im/lark/lark-hosts.ts` 的 `threadAppLink`，可按飞书/Lark 品牌选择域名。本次不新增 applink 字段，避免引入重复来源。没有 `threadId` 时不要用根消息 ID 代替。

## 验证边界

`test/dispatch-thread-id.test.ts` 执行真实 `cmdDispatch` 与消息详情查询函数，替换外部网络、存储和 daemon IPC；覆盖 normal/topic、新建/待命/追加、旧字段完整对比、异常与空值、请求超时取消、发送失败及接单超时。它不是线上群聊或客户端链接点击验证。
