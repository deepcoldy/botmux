# 生命周期 Hooks

Hooks 让 botmux 在关键时刻**调用你自己的命令**：收到新话题、会话启动或退出、需要人处理、一轮回复结束……你可以借此发通知、记审计日志、自动更新 skills，或者在消息进入 CLI 前做一道自定义校验。

Hook 分两种：

| 类型 | 写法 | botmux 会不会等它 | 适合做什么 |
|------|------|------------------|-----------|
| 通知（默认） | 不写 `mode`，或 `"mode": "async"` | 不等。命令失败、超时、不存在都只写日志，不影响收发消息 | 推送通知、审计、统计、触发外部流程 |
| 裁决（闸） | `"mode": "sync"`，只有 `prompt.submit`、`chat.bot_added` 支持 | 等它给出「放行 / 拒绝」 | 消息进 CLI 前做权限或内容校验；决定入群后是否自动开工 |

## 5 分钟上手：把事件写进本地日志

1. 写一个最简单的 hook 脚本，把收到的 JSON 追加到日志：

   ```bash
   mkdir -p ~/bin
   cat > ~/bin/botmux-hook-log.sh <<'SH'
   #!/bin/bash
   { echo "== $BOTMUX_HOOK_EVENT $(date)"; cat; echo; } >> /tmp/botmux-hook.log
   SH
   chmod +x ~/bin/botmux-hook-log.sh
   ```

2. 写配置文件 `~/.botmux/data/hooks.json`（`command` 建议写绝对路径，hook 拿到的 `PATH` 是 daemon 的，不一定和你终端里的一样）：

   ```bash
   mkdir -p ~/.botmux/data
   cat > ~/.botmux/data/hooks.json <<JSON
   [
     { "event": "session.start", "command": "$HOME/bin/botmux-hook-log.sh" },
     { "event": "turn.finished", "command": "$HOME/bin/botmux-hook-log.sh" }
   ]
   JSON
   ```

3. 在飞书里发条消息，然后看日志：

   ```bash
   tail -f /tmp/botmux-hook.log
   ```

改 `hooks.json` **不用重启 daemon**：每次触发事件时 botmux 都会检查文件，内容变了就自动重新读取。

> 源码仓库的 `examples/hooks/` 里还有现成示例：`echo-to-log.sh`（写日志）、`osascript-notify.sh`（macOS 通知中心）、`http-webhook.sh`（转发到 HTTP 地址）、`prompt-gate.sh`（同步闸）。npm 安装包里不带这个目录，需要的话从 GitHub 仓库复制。

## 配置写在哪

按优先级从高到低，只取第一个生效的：

1. 环境变量 `BOTMUX_HOOKS_JSON`：直接放一个 JSON 数组
2. 环境变量 `BOTMUX_HOOKS_FILE`：指向某个 JSON 文件
3. 默认文件 `~/.botmux/data/hooks.json`（若设置了 `SESSION_DATA_DIR`，则是该目录下的 `hooks.json`）

文件内容是一个数组，每一项是一条 hook。同一个事件可以挂多条。JSON 解析失败时整份配置都不生效，日志里会有 `[hooks] Failed to load hook config`。

## 配置字段

```json
[
  {
    "event": "session.requires_attention",
    "command": "/absolute/path/to/your-hook --flag value",
    "timeoutMs": 5000,
    "filter": { "chatId": "oc_xxx" },
    "redact": { "fullContentEvents": ["session.requires_attention"] }
  }
]
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `event` | 是 | 订阅的事件名，见下面的「事件一览」。写错的条目会被忽略 |
| `command` | 是 | 要执行的命令，可以带参数（支持引号）。**不经 shell**，见下文「执行环境」 |
| `timeoutMs` | 否 | 超时毫秒数，默认 `5000`。超时后先 `SIGTERM`，再 `SIGKILL` 整个进程组 |
| `mode` | 否 | `async`（默认，通知）或 `sync`（裁决）。`sync` 只对 `prompt.submit`、`chat.bot_added` 有效，写在其它事件上会被当成 `async`，日志里有告警 |
| `onError` | 否 | 只对 `sync` 有用：hook 自己出故障（超时、找不到命令、崩溃）时怎么办。默认 `allow`（放行），可改 `deny`（拒绝） |
| `filter.larkAppId` | 否 | 只对某个（或某几个）Bot 应用生效。字符串或数组 |
| `filter.chatId` | 否 | 只对某个（或某几个）群生效。字符串或数组 |
| `filter.senderOpenId` | 否 | 只对某个（或某几个）发送者生效。没有发送者的事件（如 `session.start`）不会匹配 |
| `redact.fullContentEvents` | 否 | 默认长文本会被截断；列在这里的事件给这条 hook 传全文 |

`filter` 里的多个条件要**同时满足**；一个条件里写数组表示「其中任意一个」。事件里没有对应字段时，该条件不匹配。

## 事件一览

| 事件 | 什么时候触发 | 额外字段 |
|------|-------------|---------|
| `topic.new` | 收到新话题或新的 @ 消息 | `messageId`、`senderOpenId`、`senderType`、`msgType`、`content` |
| `thread.reply` | 已有话题里收到回复 | `messageId`、`rootId`、`parentId`、`senderOpenId`、`senderType`、`msgType`、`sessionId`、`content` |
| `prompt.submit` | 消息通过内置权限检查、**即将交给 CLI 之前**。可当通知，也可当闸 | `messageId`、`senderOpenId`、`senderUnionId`、`memberUnionId`、`botSender`、`talkReason`、`content`、`attachments` |
| `outbound.send` | botmux 发出一条普通消息之后 | `messageId`、`msgType`、`uuid`、`content` |
| `outbound.reply` | botmux 在话题里回复之后 | `messageId`、`replyId`、`msgType`、`replyInThread`、`uuid`、`content` |
| `schedule.fired` | 一次定时任务检查并提交结束（成功、跳过或出错） | `id`、`name`、`schedule`、`status`、`error`、`rootMessageId`、`runAt`；多群任务另有 `chatIds` |
| `session.start` | 会话进程启动成功（含恢复、adopt） | `reason`、`pid`；adopt 时另有 `adoptedFrom` |
| `session.exit` | 会话进程退出、崩溃，或会话被关闭 | `reason`、`code` |
| `session.idle` | 会话进入或离开空闲 | `prevState`、`newState`、`transition`（`enter` / `exit`）、`source`、`content`（当时的屏幕文字） |
| `session.requires_attention` | 出现需要人处理的情况（`reason` 见下文） | `reason`，以及按情况带的 `message`、`kind`、`errorCode`、`turnId` / `logicalTurnId` 等 |
| `turn.finished` | 一轮回复结束（成功、失败或取消） | `turnId`、`status`、`terminalStatus`、`senderOpenId`、`dispatchAttempt` |
| `chat.bot_added` | Bot 被拉进一个群（飞书后台要订阅 `im.chat.member.bot.added_v1`） | `operatorOpenId`（拉 Bot 的人）；同步闸另有 `chatName`、`chatDescription`、`chatMode`、`chatFetchStatus` |

### 每个事件都有的字段

- payload 以 JSON 写到命令的 **stdin**，同时设置环境变量 `BOTMUX_HOOK_EVENT=<事件名>`。
- 都包含 `event`、`emittedAt`（ISO 时间）。
- 大多数事件还带 `larkAppId`、`chatId`；会话类事件（`session.*`）还会带 `sessionId`、`chatType`、`scope`、`anchor`、`title`、`cliId`、`workingDir`、`hasHistory`、`spawnedAt`、`lastMessageAt`。

### 长文本会被截断

`content`、`message`、`description`、`finalOutput`、`lastScreenContent` 超过 **600 字符**时会被截断。这些字段旁边总会附带 `xxxLength`（原长度）和 `xxxTruncated`（是否被截断）。想要全文：把事件写进这条 hook 的 `redact.fullContentEvents`。同步闸例外，总是拿全文（见下文）。

### 几个事件的细节

**`session.exit`**：`reason` 为 `graceful`（退出码 0）、`exit_code_<N>`，或 `dashboard_close`（会话被主动关闭，例如在 Dashboard 里关掉；此时没有 `code` 字段）。daemon 自己停机时不发这个事件。

**`session.idle`**：同一会话、同一状态 10 秒内只发一次，避免抖动刷屏。

**`schedule.fired`**：`status` 取值与任务的「上次状态」一致：

| `status` | 含义 |
|----------|------|
| `ok` | 已交给执行器。**不代表**模型已经做完或消息已送达 |
| `error` | 前置检查或提交时出错，原因在 `error` |
| `skipped` | 前置条件没通过，没有调用模型 |

跳过不消耗重复次数，也不删除任务。一次性任务被跳过后保持启用，至少 30 秒后再检查；周期任务按原周期继续。如果你的脚本只认 `ok` / `error`，记得加上 `skipped` 分支，别把它当成功。

**`turn.finished`**：

- `status` 是简化结果：`success` 或 `error`；`terminalStatus` 是原始结果：`completed`、`failed`、`cancelled` 或 `ambiguous`（取消和失败可以用它区分）。
- `senderOpenId` 是这一轮的发起人；拿不到时字段直接不出现，不会拿会话 owner 顶替。
- 同一轮（同一次投递尝试）在一个 daemon 进程里只发一次；daemon 重启后可能再收到一次，脚本最好按 `sessionId` + `turnId` + `dispatchAttempt` 去重。同一轮重试时 `dispatchAttempt` 会不同，各自都会发。
- 会话进程没正常结束一轮就退出时，不会补发这一条（退出本身走 `session.exit`）。
- 它只是「这一轮结束了」的通知，不带耗时和用量。需要这些信息请用 Bot 配置 `feedbackWebhooks` 里的 `turn.completed` 出站事件。
- 同样的通知也会出现在 daemon 本机的 `GET /api/events` 事件流里。

**会议（VC）接收会话**不会触发 `session.*` 和 `turn.finished` hook，因为它处理的是会议里的外部内容。

### session.requires_attention 的 reason

| `reason` | 什么情况 |
|----------|---------|
| `user_notify` | 会话进程发出需要你处理的提示，例如输入没能提交给 CLI |
| `agent_request` | Agent 用 `botmux send --attention` 举手求助；`kind` 为 `authz` / `decision` / `blocked` / `help`，`message` 是原因 |
| `stuck_warning` | 会话看起来卡在某个界面上，另有 `elapsedMs`、`matchedPattern` |
| `worker_start_failed`、`worker_fork_error` | 会话进程没能启动 |
| `ordinary_turn_recovery_exhausted` | 一轮失败后自动重试用完，仍未成功 |
| `task_continuation_stopped` | 自动续跑停了下来 |
| `claude_terminal_failure_unrecovered` | 这一轮执行失败（CLI 报错或中途退出）且没能自动恢复。名字里的 claude 是历史原因，其它 CLI 也会发 |
| `card_content_rejected`、`content_audit_blocked` | 最终回复被飞书拒收（卡片格式或内容审核） |
| `topic_send_blocked` | 原话题已不可用，消息停止发送（见[原话题不可用时停止发送](/topic-unavailable-policy)） |

以后可能会增加新的 `reason`，脚本里请给未知值留一个默认分支。

### outbound 事件不能用来拦截

`outbound.send` / `outbound.reply` 是在飞书**已经发送成功之后**才触发的，那时消息已在群里。所以它们不支持 `sync`，只能做通知。

## 同步闸：消息进 CLI 前先过你的检查

给 `prompt.submit` 配一条 `"mode": "sync"` 的 hook，每条要交给 CLI 的消息都会先问它：放行还是拒绝。

```json
[
  {
    "event": "prompt.submit",
    "mode": "sync",
    "command": "/root/bin/prompt-gate.sh",
    "timeoutMs": 3000,
    "onError": "allow"
  }
]
```

源码仓库的 `examples/hooks/prompt-gate.sh` 可以直接拿来改。

### 怎么回答「放行 / 拒绝」

两种写法都行，**stdout 里的 JSON 优先**：

| 方式 | 写法 | 说明 |
|------|------|------|
| JSON（推荐） | stdout 打印 `{"decision":"deny","reason":"原因"}` | `decision` 是 `allow` 或 `deny`；`reason` 会回给用户（最多 300 字） |
| 退出码 | 不打印 JSON，直接 `exit 0` 或 `exit 1` | 0 放行，非 0 拒绝；stderr 内容当作原因 |

stdout 必须**整段**就是一个 JSON 对象才算数。只打印了几行日志，会退回去看退出码。

被拒时，用户会在话题里收到「🚫 本条消息被前置校验拦截，未提交给 CLI」，后面附上原因。

### 它在什么时候运行

```
飞书消息 → 内置权限检查 → 🚦 prompt.submit 闸 → 扣额度 → 下载附件
        → 创建/唤起会话 → 把文字输入 CLI 并回车 → CLI 开始工作
```

闸在 daemon 里运行，这时 CLI 还没拿到这条消息（新话题甚至还没启动 CLI）。被拒的消息，CLI 完全不知道它存在过。

注意：不存在「文字已经输进 CLI 输入框、按回车之前」这个时机。botmux 输入文字和回车是一次完成的，中间无法插入检查。

### 规则速查

| 你关心的 | 实际行为 |
|---------|---------|
| 能不能放宽权限 | 不能。内置权限（`allowedUsers`、授权、oncall、额度）先检查，都通过了才问 hook。hook 说 `allow` 也放不进内置检查拒掉的人 |
| 被拒扣不扣额度 | 不扣，闸排在扣额度之前 |
| 配了多条 `sync` | 全部放行才放行；第一条 `deny` 之后的不再执行 |
| hook 自己坏了 | 走 `onError`，默认 `allow`。想「校验器挂了就一律拒绝」，写 `"onError": "deny"`，此时用户看到的原因是 `permission check failed` |
| `timeoutMs: 0` | ⚠️ 不是「不限时」，而是「立刻超时」，等于闸没装（默认 `allow`）。加载时日志会告警。请写一个真实的时间，如 `3000` |
| 会不会变慢 | 会，闸的耗时直接加在收消息路径上。建议 1–3 秒。慢闸会让同一话题的后续消息排队，也可能让这个 Bot 的 Dashboard 操作（关会话、改配置等）超时。没配 `sync` hook 时没有任何额外开销 |
| 能看到多少正文 | **完整正文**，不截断（否则把恶意内容垫到 600 字之后就能绕过）。⚠️ 也就是说，配了闸就等于把完整消息交给那个命令 |
| 能看到附件吗 | 只能看到元信息 `attachments: [{type, name}]`，例如 `[{"type":"file","name":"prod.env"}]`，足够写「禁止上传 .env」「只许图片」；看不到文件内容（闸运行时附件还没下载） |
| 哪些消息会过闸 | 新话题、话题续聊、斜杠命令启动会话、会话群的第一条消息、消息监听器命中的外部内容（被拒时只记日志、不回消息）。保存的 workflow 也会过闸，但不带正文，只能按发送者判断 |
| 哪些不过闸 | 定时任务自动发出的 prompt（这是你预先配置好的自动化）；不会交给 CLI 的控制类消息 |
| 会不会重复执行 | 不会。一条配置作为闸执行后，不会再当通知跑一次 |

### 同一个事件上既通知又裁决

`prompt.submit` 也可以只当通知用（不写 `mode`）。两种可以同时挂：

```json
[
  { "event": "prompt.submit", "command": "/root/bin/audit-log.sh" },
  { "event": "prompt.submit", "mode": "sync", "command": "/root/bin/prompt-gate.sh", "timeoutMs": 3000 }
]
```

- 通知在裁决**之前**发出，所以被拒的消息通知 hook 也能收到，正好用于审计「谁的消息被拦了」。
- 通知 hook 拿到的正文照常截断到 600 字；只有闸拿全文。
- 通知 hook 的退出码和输出不影响放行。

### 动手试一下

```bash
cat > /tmp/gate.sh <<'SH'
#!/bin/bash
cat > /tmp/gate-payload.json
echo '{"decision":"deny","reason":"闸测试：暂时不放行"}'
SH
chmod +x /tmp/gate.sh

cat > ~/.botmux/data/hooks.json <<'JSON'
[{ "event": "prompt.submit", "mode": "sync", "command": "/tmp/gate.sh", "timeoutMs": 3000 }]
JSON
```

在飞书里给 Bot 发条消息，应该收到「本条消息被前置校验拦截」的回复，`/tmp/gate-payload.json` 里能看到这次的 payload。试完记得把 `hooks.json` 改回去。

## 入群闸：决定被拉进群后要不要自动开工

如果 Bot 开启了「入群自动开工」（`autoStartOnGroupJoin`，见 [bots.json 配置](/bots-json)），可以给 `chat.bot_added` 配一条 `sync` hook，由它决定这个群要不要开工。hook 能拿到群名 `chatName`、群描述 `chatDescription`、群类型 `chatMode`，以及拉 Bot 的人 `operatorOpenId`。

```json
[
  {
    "event": "chat.bot_added",
    "mode": "sync",
    "command": "/root/bin/join-gate.sh",
    "timeoutMs": 3000,
    "onError": "deny",
    "filter": { "larkAppId": "cli_xxx" }
  }
]
```

要点：

- 它**只**决定入群自动开工。异步的 `chat.bot_added` 通知、`groupJoinCommand`（入群执行命令）照常运行，不受影响。
- 限定范围用 `filter.larkAppId` / `filter.chatId`。**不要**用 `filter.senderOpenId`：入群事件没有发送者，会导致永远不匹配。要按邀请人判断，在脚本里读 `operatorOpenId`。
- 想做到「不是目标群就完全不动」：给 Bot 设 `autoStartOnGroupJoinGateRequired: true`，再给闸配 `"onError": "deny"`。这样闸没配、没匹配上、超时或崩溃时，一律不开工，而不是对所有新群都开工。
- 设了 `autoStartOnGroupJoinGateRequired: true` 后，首轮提示词里会额外带上入群信息块和邀请人；不设时首轮提示词和以前完全一样。
- 这些入群信息只说明「Bot 被拉进了这个群」，**不能证明**首轮发起人是已认证的真人，所以首轮不会获得只给真人的特权（例如自动续跑、直接创建定时任务）。如果邀请人是应用或机器人，也不会被记成会话 owner。
- 手动强制开工的入口不走这道闸。

只想给某个 Bot 单独配一条入群脚本（不经模型、直接执行）时，用 bots.json 的 `groupJoinCommand` 更方便，在 Dashboard「Bot 配置 → 主动开工」里就能改，超时 10 分钟。

## 执行环境

写自己的 hook 前，先了解它是怎么被运行的：

- **任何可执行文件都行**：bash、Python、Node、Go 二进制、公司内部 CLI、HTTP 转发器。
- **不经 shell**：`command` 只按空格和引号拆成程序 + 参数。管道 `|`、重定向 `>`、`&&`、`~` 展开都不生效。需要这些时写成脚本，或用 `bash -c '…'`。
- **环境变量很少**：只保留 `PATH`、`HOME`、`TMPDIR`、`SHELL`、`USER`、`LANG` 等基础项，外加 `BOTMUX_HOOK_EVENT`。应用密钥、API Key 不会传进来。需要别的变量，在脚本里自己 `export`。
- **payload 走 stdin**：一个 JSON 对象。脚本不读 stdin 也没关系。
- **超时会杀整个进程组**：连带脚本启动的子进程一起结束。
- **通知 hook 的输出没人看**：退出码非 0、超时、找不到命令都只写 botmux 日志，不影响收发消息、定时任务或会话。

## 实践：会话启动时自动更新 Skills

botmux 自带 skill 管理（`botmux skills install …` 安装、`botmux skills update <name>` 更新，`botmux skills list` 列出已安装的）。配合 `session.start`，可以在每次新会话启动时顺手检查更新，效果类似 Claude Code 的 SessionStart Hook。

**更新单个 skill：**

```json
[
  { "event": "session.start", "command": "botmux skills update my-skill-name", "timeoutMs": 60000 }
]
```

**更新全部已安装的 skill**：`botmux skills update` 一次只接受一个名字（不支持 `*`），所以写个脚本循环：

```bash
#!/bin/bash
# ~/bin/botmux-update-all-skills.sh
botmux skills list | cut -f1 | while read -r name; do
  [ -n "$name" ] && botmux skills update "$name"
done
```

```json
[
  { "event": "session.start", "command": "/root/bin/botmux-update-all-skills.sh", "timeoutMs": 120000 }
]
```

**直接调用 agentbuddy 更新用户全局 skills**：hook 不经 shell、环境变量也被精简，所以要写成包装脚本：

```bash
#!/bin/bash
# ~/bin/agentbuddy-update.sh
export npm_config_registry="https://your-registry.example.com"  # 用私有 npm 源时
npx -y agentbuddy update -y 2>/dev/null
```

```json
[
  { "event": "session.start", "command": "/root/bin/agentbuddy-update.sh", "timeoutMs": 120000 }
]
```

注意：

- **一定要调大 `timeoutMs`**：默认 5 秒，联网更新通常不够，建议 60 秒以上。
- **不阻塞会话**：更新在后台跑，当前会话不会等它；更新结果要到下一个新会话才生效。
- **可以缩小范围**：用 `filter.chatId` / `filter.larkAppId` 只对特定群或 Bot 生效。
- **优先用 `botmux skills update`**：它更新的是 botmux 管理的 skill 版本，与 botmux 的 skill 生命周期一致；从 agentbuddy 装的 skill 还会去掉里面内嵌的使用遥测。
