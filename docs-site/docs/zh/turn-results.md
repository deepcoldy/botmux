# 单轮结果（TurnResult）

机器人在飞书里回答完一个问题后，你的本机程序可以通过一个接口，拿到这一轮的**结构化结果**：执行结束了没有、最终回答是什么、有没有真的发到群里。

这个接口**只读**。它不会重新跑模型，不会发消息，也不会替你执行任何业务动作。

适合这样的场景：

- 同一台机器上的宿主程序想知道「刚才那条提问，机器人到底答了什么、送达没有」；
- 想把机器人的最终回答接进自己的后续流程（比如存档、二次处理），又不想去解析群消息。

> 想从外部**发起**任务并拿结果，用 [Webhook 接入](/webhook) 或 [Core-only API](/api-core-only) 的触发接口。本页只负责读取普通飞书对话里已经产生的结果。

## 三件事分开看

一轮对话有三个互相独立的事实，结果里分开记录：

| 字段 | 回答的问题 | 可能的值 |
|---|---|---|
| `execution.status` | CLI 这一轮跑完了吗？ | `completed` 完成 / `failed` 失败 / `cancelled` 被取消 / `ambiguous` 无法确定 |
| `output.status` | 有没有最终回答？ | `available` 有正文 / `empty` 明确没有输出 / `unavailable` 拿不到 |
| `deliveries[].status` | 回答发到飞书了吗？ | `delivered` 已送达 / `partial` 部分送达 / `failed` 失败 / `unknown` 不确定 / `suppressed` 被主动不发 |

所以「模型答完了」不等于「消息送达了」，「接口返回 200」也不等于「任务成功」，要分别看这三个字段。

## 第 1 步：给机器人打开开关

在目标机器人的 `bots.json` 条目里加上：

```json
{
  "turnResults": { "enabled": true }
}
```

- 默认关闭，只有写成 `true` 才算打开。
- 只对之后的新轮次生效，打开前的历史轮次查不到。
- 关掉开关后，这个机器人已缓存的结果会被清空。
- `apiOnly`（[Core-only](/api-core-only)）机器人和开了读隔离（`readIsolation`）的机器人不支持，查询会返回 `unsupported_mode`。

## 第 2 步：找到要查的那一轮

你需要两个 ID：

| 参数 | 是什么 |
|---|---|
| `sessionId` | 会话 ID（话题对应的 botmux 会话） |
| `turnId` | 轮次 ID，是一条 `om_` 开头的飞书消息 ID，通常就是触发这一轮的那条消息（新开话题时可能是话题的锚点消息） |
| `dispatchAttempt`（可选） | 同一条消息被重新派发时的尝试序号，非负整数 |

`dispatchAttempt` 不传，表示「这一轮本来就没有尝试序号」，**不是**「取最新一次」。

## 第 3 步：发请求

```text
GET /api/sessions/<sessionId>/turns/<turnId>/result
GET /api/sessions/<sessionId>/turns/<turnId>/result?dispatchAttempt=1
```

请求要发给**这个机器人自己的 daemon**，并带上本机可信宿主签名：

1. **找端口**：每个在线 daemon 会在数据目录写一个描述文件，默认是 `~/.botmux/data/dashboard-daemons/<机器人 App ID>.json`，里面的 `ipcPort` 就是端口。
2. **签名**：和 Core-only API 的签名接口用同一套方法，三个请求头 `X-Botmux-Cli-Ts` / `X-Botmux-Cli-Nonce` / `X-Botmux-Cli-Auth`，密钥是 `~/.botmux/.dashboard-secret`。具体算法和参考代码见 [Core-only API](/api-core-only) 第 6 节「签名怎么算」。
3. 请求地址是本机回环 `http://127.0.0.1:<ipcPort>`。回环只是能连上，权限仍然靠签名。

查哪个机器人由收到请求的 daemon 决定，没有「跨机器人查询」的参数。知道某个结果的 ID 也不等于有权读它，签名才是权限。

## 读懂返回

HTTP 状态码只说明**查询本身**是否成功：

| HTTP | 什么时候 |
|---|---|
| `200` | 查询完成，具体情况看 body 里的 `status` |
| `400` | 参数不对，比如 `dispatchAttempt` 不是非负整数、带了别的查询参数（`reason: invalid_reference`） |
| `401` | 没签名或签名不对 |
| `403` | 请求没通过可信宿主校验（`reason: trusted_host_required`） |

body 里的 `status`：

| `status` | 含义 | 该怎么办 |
|---|---|---|
| `ready` | 结果齐了，带 `result` 对象 | 直接用 |
| `not_ready` | 只看到一部分事实（比如跑完了但还没确认送达） | 稍后再查 |
| `unavailable` | 拿不到，`reason` 说明原因 | 看下表 |
| `not_found` | 没有这一轮的记录，或已过期被清掉 | 不会从历史文件里恢复 |

常见的 `reason`：

| `reason` | 含义 |
|---|---|
| `disabled` | 这个机器人没开 `turnResults` |
| `unsupported_mode` | 机器人或这一轮属于不支持的模式（见下文「哪些轮次不收集」） |
| `result_not_settled` | 等了 5 分钟仍没凑齐结果，已放弃 |
| `result_too_large` | 出现在 `output.reason`：正文超过 1 MiB，不返回截断版 |

`ready` 时的完整示例：

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

几个容易误解的点：

- `output.content` 是这一轮**最终采用的回答**，不含思考过程和中间进度。
- 执行失败（`failed`）时不会给出半截回答。
- `messages` 只列**确认发送成功**的消息：`primary` 是主回复，`attachment` 是回答太长时另发的完整 Markdown 附件。卡片已经存在不代表最后一次更新成功。
- 如果回答被平台内容审核拦下，这个接口也不会把正文给你，不能用它绕过审核。
- 拿不到的时间、耗时字段直接省略，不会填猜测值。

## 哪些轮次会收集

支持：在飞书群/话题里由真实消息触发的**普通轮次**，回答以普通方式发回原群。

不收集（查询返回 `unavailable` 或 `not_found`）：

- 会议助手、[文档评论](/doc-comment)、私密回复、沙盒里不能直接发卡片的会话；
- [静默定时任务](/schedule)、[接管（adopt）](/adopt) 的会话、headless / HTTP 触发的轮次；
- 在已有会话里直接输入 CLI 原生命令（raw passthrough）的轮次，因为它没有可信的来源消息。冷启动时的首条 passthrough 如果带着真实来源消息，仍可能被收集；
- 回复复用旧卡片、或者无法证明完整送达的发送方式，这类保持 `not_ready` / `unavailable`，不会去猜。

[Webhook](/webhook)、[headless](/headless-session)、[工作流](/workflow) 各自的结果接口保持不变，本功能不替代它们。

某个会话或某一轮变成不支持时，只清掉那一条结果，同一机器人的其它结果不受影响。

## 保留多久

结果只放在 daemon 内存里：

| 限制 | 数值 |
|---|---|
| 同时保留的轮次 | 最多 128 个（含未完成的） |
| 总容量 | 16 MiB，超出时先淘汰最早的 |
| 单个结果 | 最多 1 MiB |
| 已完成结果 | 保留 15 分钟 |
| 未完成结果 | 最多等 5 分钟 |

- 读取不会延长保留时间。
- daemon 重启后全部清空。
- 它**不是**去重或恢复账本：不保证重启后还能读到，不会自动重投，也不保证 exactly-once。
- 现有的 `turn.completed` Webhook 和反馈数据库仍然只记元数据，不会因此多存全文。

## 进阶：嵌入宿主的完成回调

如果你是把 botmux 当库嵌入的宿主，可以给 worker-pool 传一个可选回调 `onTurnResult(result)`。每一轮结果凑齐后，会把和接口里一样的只读快照推给它。

- 默认没有回调，不会执行任何外部命令。
- 回调抛错或 10 秒内没结束，只会记一条日志，不会重发原回答、不会让模型重试。
- 超时不会中断你的回调代码，也不能说明你的业务动作没发生。

拿到结果后要去做别的事（建群、邀请、部署、改配置、转发到别的群），请自己另外核验身份、目标范围和写权限。读到结果不代表拥有这些权限。
