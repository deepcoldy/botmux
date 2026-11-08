# 无群自动化会话（session / headless）

`botmux session` 让脚本、CI 或定时任务**不进飞书群**也能起一个 AI 会话：发 prompt、等它做完、把结果取回来。需要给人看时，再一条命令把会话发布到新群，或绑定到已有的群 / 话题，大家接着在飞书里聊。

适合这些场景：

- CI 里让 AI 先做一轮代码检查，有问题才拉群通知人；
- 脚本批量跑分析任务，只要文本结果，不想刷屏；
- 先在后台把调查做完，再把「已有上下文 + 总结」一次性交给团队。

> 两套命令的关系：`botmux session` 是**面向自动化的稳定入口**，`botmux headless` 是它底下的实现层。写脚本优先用 `session`；需要更细的控制（比如只发某一轮结果、不搬会话）时再用 `headless`。

## 三步上手

前提：本机 botmux daemon 已经在跑（`botmux start`）。

```bash
# 1. 起会话并跑第一轮，等它做完
botmux session start --headless --bot <机器人名> --working-dir ~/repo \
  --prompt-file task.md --json > start.json
SID=$(jq -r .sessionId start.json)       # hl_ 开头的会话 ID
jq -r '.output.content' start.json       # 第一轮的回复

# 2. 需要的话，继续追问，或者再取一次结果
botmux session send "$SID" --prompt-file followup.md --wait --json
botmux session result "$SID" --json

# 3. 想让人看：建个新群，把会话发布过去
botmux session publish "$SID" --create-group --name "依赖升级排查"
```

第 3 步会做三件事：

1. 用这个机器人新建一个飞书群（`--chat-id` 则直接用已有群）；
2. 在群里开一个话题，把会话**搬进**这个话题；
3. 让 AI **先总结到目前为止的上下文**（做了什么、关键结论和证据、还没解决的问题、建议下一步），再把总结发到话题里。

之后在这个话题里回复，就是在和**同一个会话、同一份记忆**继续对话。

## 会话 ID

起会话后会拿到两个 ID，命令里都能用：

| ID | 样子 | 说明 |
|---|---|---|
| 会话 ID（`sessionId` / `headlessId`） | `hl_` 开头 | 推荐在脚本里保存它 |
| botmux 会话 ID（`botmuxSessionId`） | UUID | 和 `botmux ls` 等其它命令里看到的一致 |

`botmux headless` 的子命令还接受 ID 前缀（要能唯一匹配）；`session publish` 需要完整 ID。

## `session` 命令一览

| 我想… | 命令 |
|---|---|
| 起会话并跑第一轮 | `botmux session start --headless --bot <bot> [--working-dir <dir>] --prompt-file <path>` |
| 在已有会话里再发一轮 | `botmux session send <id> --prompt-file <path> [--wait]` |
| 等当前这一轮跑完 | `botmux session wait <id> [--trigger-id <triggerId>]` |
| 立刻查结果（不等） | `botmux session result <id> [--trigger-id <triggerId>]` |
| 列出本机的 headless 会话 | `botmux session list [--bot <larkAppId>]` |
| 绑定到已有群 / 话题 | `botmux session bind <id> --chat-id <oc_xxx> [--into <om_xxx>]` |
| 总结后发布到新群 | `botmux session publish <id> --create-group --name "任务名"` |
| 总结后发布到已有群 | `botmux session publish <id> --chat-id <oc_xxx> [--name "话题标题"]` |
| 纯模型结构化调用 | `botmux session invoke <start\|result\|cancel\|capabilities> --bot <larkAppId>`，见下文 |

所有命令都支持 `--json`，输出一段 JSON，方便 `jq` 解析。不加时输出精简文本：

- `start`：第一行是会话 ID，后面是回复内容；
- `send --wait` / `wait` / `result`：完成时输出回复内容，否则输出状态（如 `running`）；
- `publish`：第一行是群 ID，第二行是总结那一轮的 `triggerId`。

`send` / `wait` / `result` / `list` / `bind`（以及 `create` / `run`）会原样转给对应的 `botmux headless` 子命令，参数一致。

## 常用参数

| 参数 | 用在 | 说明 |
|---|---|---|
| `--bot` | `start` | 机器人名或 larkAppId。本机只有一个 daemon 在线时可以省略；多个时必须写 |
| `--working-dir` | `start` | 会话的工作目录。不写时用机器人的默认目录，再没有就用 daemon 的当前目录 |
| `--prompt-file` / `--prompt` | `start` / `send` | 提示词来源，二选一；都不写时从 stdin 读。`--prompt-file -` 也表示 stdin |
| `--model` | `start` | 这个会话用的模型 |
| `--reasoning-effort` | `start` | 思考强度：`low` / `medium` / `high` / `xhigh` / `max` / `ultra` |
| `--timeout` | `start` / `send` / `wait` | 命令**最多等多少秒**，范围 1–86400，默认 300 |
| `--name` | `start` / `publish` | `start` 里是会话标题；`publish --create-group` 里是群名（必填），也作为话题标题 |
| `--trigger-id` | `wait` / `result` | 指定某一轮；不写时取最近一轮 |
| `--json` | 全部 | 输出 JSON |

> `--timeout` 只管命令等多久。超时后命令照常退出，AI 那边**还在继续跑**，之后用 `session wait` 或 `session result` 再取。用 `--json` 时，超时的结果里会带 `"timedOut": true`，状态仍是 `running`。

结果状态（`state`）：

| 状态 | 含义 |
|---|---|
| `running` | 还在跑 |
| `completed` | 完成，回复在 `output.content` |
| `failed` | 失败 |
| `interrupted` | 被中断 |
| `not_found` | 找不到这个会话或这一轮 |

退出码：状态为 `failed` 或 `not_found` 时非 0；参数写错时为 2。

> `session start` 失败（退出码非 0）时，输出的是底层 `headless run` 的原始 JSON，不是上面那种精简格式；会话 ID 在 `created.headlessId` 里。

## 发布和绑定：让人接手

| 我想… | 用 | 会话去哪 | 群里会看到 |
|---|---|---|---|
| 交给团队，并先给一份总结 | `session publish` | 搬进新话题 | 话题标题 + AI 现写的总结 |
| 搬进某个已有话题 | `session bind --into <om_xxx>` | 搬进该话题 | 最近一轮的回复 |
| 搬进已有群，新开一个话题 | `session bind --chat-id <oc_xxx>` | 搬进新话题（标题是会话标题） | 最近一轮的回复 |
| 只把某一轮结果贴到群里，不搬会话 | `headless publish` | 留在后台 | 那一轮的回复 |

几点说明：

- **机器人要在目标群里**，否则发不进去。用 `--create-group` 时，群由这个机器人新建，并把这个机器人 `allowedUsers` 里的第一个用户拉进群。
- `--create-group` 建的群会自动绑定到会话的工作目录，之后在群里开新话题也直接用这个目录。
- 换一份总结要求：`publish` 支持 `--summary-prompt "<文本>"` 或 `--summary-prompt-file <路径>` 覆盖默认的总结提示词。
- 搬会话要求它**当前空闲**。AI 正在跑某一轮时会被拒绝，等这一轮结束再试。
- 搬走的是同一个 CLI 进程和同一份记忆，和 [会话接力（Relay）](/relay) 是同一套机制。
- `bind` 默认把最近一轮的回复补发到群里，这时最近一轮必须已经完成、并且有回复内容，否则会被拒绝；不想补发加 `--replay none`。

## `botmux headless`：底层命令

需要更细的控制时直接用它。

| 子命令 | 作用 |
|---|---|
| `create` | 只建会话，不发 prompt。可带 `--bot` `--title` `--working-dir` `--model` `--reasoning-effort` |
| `run` | 发一轮 prompt。不带 `--session` 时先新建会话；加 `--wait` 才会等结果 |
| `send --session <id>` | 往已有会话发一轮（也可以把 ID 写在第一个参数） |
| `wait <id>` | 等某一轮结束，默认最多 300 秒 |
| `result <id>` | 立刻查某一轮结果 |
| `list` / `ls` | 列出会话，可用 `--bot <larkAppId>` 过滤 |
| `publish <id>` | 把某一轮结果作为文本发到群：`--chat-id` 指定群（不写就用已绑定的群），`--into <om_xxx>` 回复到某话题 |
| `bind <id> --chat-id <oc_xxx>` | 把会话搬到群里，见下 |

`bind` 的参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--scope thread\|chat` | `thread` | `thread`：话题会话；`chat`：整个群作为会话 |
| `--into <om_xxx>` | 无 | 绑定到这条消息所在的话题。不写时自动发一条标题消息作为新话题。`--scope chat` 时必须带它（作为定位用的锚点消息） |
| `--title` | 会话标题 | 新话题的标题 |
| `--replay latest\|none` | `latest` | 是否把最近一轮（或 `--trigger-id` 指定的那轮）回复发进群 |

`session start` 等价于 `headless run --wait --json`，只是把输出整理成更短的 JSON（`sessionId`、`triggerId`、`state`、`output`，完整原始响应在 `raw` 里）。

## `session invoke`：纯模型结构化调用

这是另一种用法：**不跑 Agent、不调用任何工具**，只让模型按你给的 JSON Schema 返回结构化结果。适合做分类、抽取这类「问一次、拿 JSON」的任务。

```bash
botmux session invoke capabilities --bot <larkAppId>      # 先看这个机器人支不支持
botmux session invoke start  --bot <larkAppId> --request-file req.json --wait-ms 60000
botmux session invoke result --bot <larkAppId> --request-id job-001 --wait-ms 30000
botmux session invoke cancel --bot <larkAppId> --request-id job-001
```

`req.json` 示例：

```json
{
  "requestId": "job-001",
  "prompt": "判断这段日志是否是网络超时：...",
  "model": "<模型名>",
  "deadlineMs": 60000,
  "outputSchema": {
    "type": "object",
    "properties": { "timeout": { "type": "boolean" }, "reason": { "type": "string" } },
    "required": ["timeout", "reason"],
    "additionalProperties": false
  }
}
```

要点：

- `--bot` 这里要写 **larkAppId**。
- 要求比较严：机器人得是 [Core-only 模式](/api-core-only)的专用机器人，不开沙盒、不配额外环境变量等；目前只有部分 CLI 支持（Claude Code、Codex、OpenCode、Pi 等）。是否可用以 `capabilities` 返回的 `supported` 为准。
- `deadlineMs`（100–300000）到了会真正停止推理；`--wait-ms`（最多 300000）只控制命令等多久。
- Schema 只支持常用关键字（`type` `properties` `required` `additionalProperties` `items` `enum` `description`），对象必须写全 `required` 且 `additionalProperties: false`。
- 输出始终是一行 JSON。状态为 `running` 或 `completed` 时退出码 0，其它为 1。

## 常见问题

**报 `no online botmux daemon` 或 `daemon not online for bot ...`？**
对应机器人的 daemon 没在跑。先 `botmux start`，再用 `botmux status` 确认。

**报 `multiple daemons online; pass --bot`？**
本机跑着多个机器人，`start` 时用 `--bot` 指定一个。

**会话会在飞书里发消息吗？**
不会。发布或绑定之前，会话没有对应的群，不发卡片、不发消息，结果只能通过命令取。这类轮次也不在[轮次结果](/turn-results)接口的收集范围内。

**和 HTTP 触发有什么关系？**
`botmux headless` 底层就是向本机 daemon 发一个 `source.type` 为 `headless` 的任务请求。想直接调 HTTP 接口，看[通过 API 触发任务](/api-task-trigger)。

**publish 失败了，会话还在吗？**
在。`publish` 是「建群 → 绑定 → 总结 → 发总结」依次执行，哪一步失败就停在哪一步并报错。如果已经绑定成功，会话就已经在群里的话题中了，直接去话题里继续即可。

## 相关

- [会话接力（Relay）](/relay)：在群、话题、单聊之间搬会话
- [通过 API 触发任务](/api-task-trigger)：用 HTTP 发起任务、查结果
- [Core-only 模式](/api-core-only)：不接飞书、只开 HTTP 接口的 botmux
- [CLI 命令](/cli-commands)
