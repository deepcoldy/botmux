# 生命周期 Hooks

botmux 可以在关键生命周期事件发生时调用外部命令。默认是**异步**的：命令失败、超时或不存在只会写日志，不阻塞 botmux 主流程。

另有一类**同步前置校验闸**（`mode: "sync"`，仅 `prompt.submit` 事件支持）：daemon 会等它跑完，并按它的裁决决定这条消息要不要提交给 CLI。见下文[同步前置校验闸](#同步前置校验闸-promptsubmit)。

## 配置位置

按优先级从高到低：

1. `BOTMUX_HOOKS_JSON` 环境变量（直接传 JSON 数组）
2. `BOTMUX_HOOKS_FILE` 指定的文件路径
3. 默认 `~/.botmux/data/hooks.json`

## 快速验证：写入本地日志

仓库内置示例脚本，复制即用：

```bash
chmod +x examples/hooks/echo-to-log.sh
HOOK_CMD="$(pwd)/examples/hooks/echo-to-log.sh"
mkdir -p ~/.botmux/data
cat > ~/.botmux/data/hooks.json <<JSON
[
  {
    "event": "session.requires_attention",
    "command": "$HOOK_CMD",
    "timeoutMs": 5000
  }
]
JSON

tail -f /tmp/botmux-hook.log
```

触发任意 hook 事件后即可在日志里看到 JSON payload。`examples/hooks/` 还附带 macOS Notification Center（`osascript-notify.sh`）和 HTTP webhook（`http-webhook.sh`）示例。

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

| 字段 | 类型 | 说明 |
|------|------|------|
| `event` | string | 必填。订阅的事件名（见下表） |
| `command` | string | 必填。外部可执行命令；支持参数，但不经 shell 执行 |
| `timeoutMs` | number | 可选。默认 5000；超时先 `SIGTERM`，再兜底 `SIGKILL` |
| `mode` | `"sync"`｜`"async"` | 可选。默认 `async`。`sync` **仅** `prompt.submit` 支持，用于前置校验；其它事件写 `sync` 会降级为 `async` 并在日志告警 |
| `onError` | `"allow"`｜`"deny"` | 可选，仅 `mode:"sync"` 有意义。hook 自身失败（超时/找不到命令/崩溃）时的兜底方向，默认 `allow`（fail-open） |
| `filter.chatId` | string｜string[] | 可选。只匹配指定飞书群 / 话题所在 chat |
| `filter.senderOpenId` | string｜string[] | 可选。只匹配指定发送者 open_id |
| `redact.fullContentEvents` | string[] | 可选。默认截断长文本；列入 allowlist 的事件透传全文 |

> **想拦住「要发出去的消息」用 `outbound.pre_send`**（发送前，真能拦）。`outbound.send` / `outbound.reply` 是**发送后通知**——发射点在飞书 API 调用**成功之后**（需先拿到 `messageId`），那一刻消息已经在群里，加 `mode:"sync"` 也只能事后撤回。这两个事件写 `sync` 会降级为 async 并告警。

## 支持事件

| 事件 | 触发时机 |
|------|----------|
| `topic.new` | 收到新话题 / @mention |
| `thread.reply` | 收到已有话题回复 |
| `prompt.submit` | 消息通过内置权限校验、**即将提交给 CLI 之前**。支持 `mode:"sync"` 拦截 |
| `outbound.pre_send` | botmux **即将把消息发到飞书之前**（API 调用之前）。支持 `mode:"sync"` 拦截 |
| `outbound.send` | botmux 发送普通消息成功 |
| `outbound.reply` | botmux 回复话题消息成功 |
| `schedule.fired` | 定时任务执行完成 |
| `session.start` | worker / adopt worker 启动成功 |
| `session.exit` | worker 退出、崩溃或会话被关闭（daemon shutdown 默认静音） |
| `session.idle` | session 进入或离开 idle，按 session + 状态 10s 去重 |
| `session.requires_attention` | TUI prompt 或 worker `user_notify` 需要用户处理 |

## Payload 字段

所有 payload 通过 stdin 写入 hook 命令，同时设置环境变量 `BOTMUX_HOOK_EVENT`。每份 payload 都包含 `event`、`emittedAt`；事件上下文可包含 `sessionId`、`chatId`、`chatType`、`larkAppId`、`scope`、`anchor`、`title`、`cliId`、`workingDir`、`hasHistory`、`spawnedAt`、`lastMessageAt`。

不同事件额外携带：

| 事件 | 额外字段 |
|------|----------|
| `topic.new` | `messageId`、`senderOpenId`、`senderType`、`msgType`、`content` |
| `prompt.submit` | `messageId`、`chatId`、`chatType`、`anchor`、`senderOpenId`、`senderUnionId`、`memberUnionId`、`botSender`、`talkReason`、`content`、`attachments`（`[{type,name}]`，仅元信息） |
| `outbound.pre_send` | `surface`（`sendMessage`｜`replyMessage`｜`sendUserMessage`｜`sendEphemeralCard`）、`larkAppId`、`content`、`msgType`、`chatId`／`toOpenId`／`replyToMessageId`（随 surface 而定）、`uuid` |
| `thread.reply` | `messageId`、`rootId`、`parentId`、`senderOpenId`、`senderType`、`msgType`、`content` |
| `outbound.send` | `messageId`、`msgType`、`uuid`、`content` |
| `outbound.reply` | `messageId`、`replyId`、`msgType`、`replyInThread`、`uuid`、`content` |
| `schedule.fired` | `id`、`name`、`schedule`、`status`、`error`、`rootMessageId`、`runAt` |
| `session.start` | `reason`、`pid`、`adoptedFrom` |
| `session.exit` | `reason`、`code`（worker 退出路径；`dashboard_close` 为 `null`） |
| `session.idle` | `prevState`、`newState`、`transition`、`source` |
| `session.requires_attention` | `reason`、`description`、`optionsCount`、`optionsPreview`、`multiSelect`、`message` |

默认会把 `content`、`message`、`description`、`finalOutput`、`lastScreenContent` 截断到 **600 字符**，并补充 `xxxLength` / `xxxTruncated`；只有 `redact.fullContentEvents` 内的事件透传全文。

## 同步前置校验闸（prompt.submit）

普通 hook 是「通知」——跑完没人看结果。`prompt.submit` + `mode: "sync"` 是「裁决」：daemon 等它、读它、按它放行或拒绝。用于在消息进入 CLI 前做一层**自定义权限校验**（内部权限服务、工作时间限制、高危指令拦截等）。

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

仓库内置可直接改的示例：`examples/hooks/prompt-gate.sh`。

### 触发时机

**闸跑在「prompt 还没送进 CLI 之前」——不是「已经输进输入框、按 Enter 之前」。**

后一种时机在 botmux 里**不存在**：写文本与按 Enter 是**同一次适配器调用中的原子动作**（`writeInput` 逐行打字、末尾那个 Enter 即提交），中间没有可插入的停顿。

```
飞书消息 → 内置权限校验 → 🚦 prompt.submit 闸 → 扣额度 → 下载附件
        → createSession/forkWorker → IPC 到 worker → writeInput（打字+Enter，原子）→ CLI
```

闸执行于 **daemon 进程**，此时 CLI 子进程尚未拿到这一轮输入（新话题下 CLI 甚至还没 fork）。被拒的消息，CLI 完全不知道它存在过。

### 怎么表达裁决

两种写法，**stdout 的 JSON 优先于退出码**：

| 方式 | 写法 | 说明 |
|------|------|------|
| JSON（推荐） | stdout 打印 `{"decision":"deny","reason":"原因"}` | `reason` 会回给用户；`decision` 取 `allow`｜`deny` |
| 退出码 | 不打印 JSON，`exit 0` / `exit 非0` | 0 放行，非 0 拒绝；stderr 内容当作原因 |

stdout 必须是**整段 JSON 对象**才会被当作裁决。打印一行普通日志不会被误判成裁决——那种情况回退到看退出码。

### 边界与保证

- **只能收紧，不能放宽**：内置权限模型（`allowedUsers` / `grant` / oncall / 额度）先跑，全部通过后才会问这个 hook。hook 说 `allow` 不会让内置闸拒掉的人进来。
- **拒绝不扣额度**：闸排在扣费之前，被拒的消息不消耗用户的消息额度。
- **拒绝会明确告诉用户**（附 `reason`），不静默丢弃——有权限却消息凭空消失是最难排查的形态。
- **多个 sync hook 是 AND**：任一 `deny` 即拒绝，第一个 `deny` 之后的 hook 不再执行。
- **hook 坏了不等于拒绝**：超时、找不到命令、崩溃都走 `onError`，默认 `allow`——校验器挂掉不该让整个 bot 变砖头。要反过来就显式写 `onError: "deny"`。
- **延迟直接加在收信路径上**：`timeoutMs` 建议设小（1-3s）。bot 级并发不会因此卡死整个 daemon，但**同一话题**的续聊持有顺序锁——慢闸会让该话题的后续消息排队。别指望用大超时兜住一个慢服务。没配 sync hook 时零开销，不会给每条消息加 spawn。
- **消息监听器（message listener）命中的第三方内容也会过闸**：那类内容来自告警 bot 等外部来源、同样会进 CLI，正是最该校验的。该路径本来就不扣额度，被拒时只记日志、不回消息（没有可回复的真人发送者）。
- **闸拿到的是完整正文，不受 600 字符截断影响**：截断是为通知类 hook 设计的，而闸的判断依据就是内容本身——截断会让它对超长输入结构性失明（把恶意内容垫到 600 字符之后即可绕过）。
  ⚠️ **隐私含义**：配了 sync 闸就等于把**完整消息正文**交给那个命令。异步 hook 仍按原规则截断，未受影响。
- **闸看得到附件的元信息，但看不到附件内容**：`attachments` 字段给出本轮的 `[{type,name}]`（如 `[{"type":"file","name":"prod.env"}]`），足以写「禁止上传 .env」「只许图片」这类策略；但闸跑在**附件下载之前**（下载必须排在授权之后，否则未授权者也能让 bot 去拉文件），所以**无法按文件内容判断**。
- **覆盖范围：只管「人/外部消息进 CLI」这条入口**。新话题、话题续聊、斜杠命令冷启动、会话群出生轮、消息监听器命中——都过闸。但**定时任务与 workflow 自动跑出来的 prompt 不过闸**（那是运维自己预先授权的自动化，不是外部输入）。别把它当成「所有进 CLI 的文本都查过了」。
- 同一条 hook 配置**只会跑一次**：作为闸执行后，不会再作为异步通知重复触发。

### 快速验证

```bash
cat > /tmp/gate.sh <<'SH'
#!/bin/bash
cat >/tmp/gate-payload.json
echo '{"decision":"deny","reason":"闸测试：暂时不放行"}'
SH
chmod +x /tmp/gate.sh

cat > ~/.botmux/data/hooks.json <<'JSON'
[{ "event": "prompt.submit", "mode": "sync", "command": "/tmp/gate.sh", "timeoutMs": 3000 }]
JSON
```

在飞书里发一条消息：应当收到「本条消息被前置校验拦截」的回复，且 `/tmp/gate-payload.json` 里能看到本轮 payload。验证完记得清空 `hooks.json`。

## 发送前校验闸（outbound.pre_send）

与 `prompt.submit` 对称，但方向相反：`prompt.submit` 拦**进来的**消息，`outbound.pre_send` 拦 **botmux 要发出去的**消息。用于防止把密钥、内部信息、越权内容发进飞书群。

未配置该闸时，这层检查是**同步 no-op**：不 spawn 进程，也不在 API 调用前插入任何额外的 microtask，调用时序与本特性存在之前逐字相同。

```json
[
  {
    "event": "outbound.pre_send",
    "mode": "sync",
    "command": "/root/bin/outbound-gate.sh",
    "timeoutMs": 2000,
    "onError": "allow"
  }
]
```

裁决写法与 `prompt.submit` 完全一致（stdout JSON 优先于退出码）。

### 覆盖哪些发送口

| 函数 | 场景 | 过闸 |
|---|---|---|
| `sendMessage` | 群消息（含 `botmux send`） | ✅ |
| `replyMessage` | 话题内回复 | ✅ |
| `sendUserMessage` | 私聊 DM | ✅ |
| `sendEphemeralCard` | 仅本人可见的临时卡片 | ✅ |
| `updateMessage` | **编辑已存在的卡片** | ❌ 不过闸（不是新发送） |

payload 里的 `surface` 字段会告诉你是哪一种，可据此写不同策略。

### 与 `outbound.send` 的区别（重要）

| | `outbound.pre_send` | `outbound.send` / `outbound.reply` |
|---|---|---|
| 时机 | 飞书 API 调用**之前** | API 调用**成功之后** |
| 能否拦截 | ✅ 能，消息不会出现在群里 | ❌ 不能，消息已经发出去了 |
| 有无 `messageId` | 没有（还没发） | 有 |
| 支持 `sync` | ✅ | ❌（写了降级为 async 并告警） |

### 被拦之后会发生什么

<callout emoji="⚠️" background-color="light-yellow">
被拦的发送会**抛出 `OutboundBlockedError`**，而不是静默返回一个假的 messageId——那些函数的返回类型是「消息 id」，编一个假的会让调用方以为发成功了。

调用方的既有错误处理会接住它：入站链路有统一兜底（失败通知本身也在 try/catch 里，不会因为通知同样被拦而循环）。但**这确实是一个行为变化**：配了 `outbound.pre_send` 且真的 deny 时，相关代码路径会走它的错误分支。建议先用 `onError: "allow"` 加只观察不拒绝的脚本跑一段时间，确认命中面之后再开启真正的拒绝。
</callout>

### 示例：拦住疑似密钥外泄

```bash
#!/bin/bash
set -uo pipefail
payload="$(cat)"
command -v jq >/dev/null 2>&1 || { echo '{"decision":"allow"}'; exit 0; }

content="$(printf '%s' "$payload" | jq -r '.content // empty')"
surface="$(printf '%s' "$payload" | jq -r '.surface // empty')"

# AWS key / 私钥 / 常见 token 形态
if printf '%s' "$content" | grep -qE 'AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-[0-9A-Za-z-]{10,}'; then
  echo '{"decision":"deny","reason":"疑似密钥，已拦截"}'
  exit 0
fi

# 例：私聊 DM 不允许发卡片以外的长文本
# [ "$surface" = "sendUserMessage" ] && [ "${#content}" -gt 2000 ] #   && { echo '{"decision":"deny","reason":"DM 长文本请改用群消息"}'; exit 0; }

echo '{"decision":"allow"}'
```

## 实践：用 session.start hook 自动更新 Skills

botmux 原生集成了 agentbuddy 作为 skill 来源（`botmux skills install <agentbuddy命令>` 安装，`botmux skills update <name>` 更新）。配合 `session.start` hook，可以在每次新会话启动时自动检查并更新已安装的 skills，等效于 Relay / Claude Code settings.json 中的 SessionStart Hook。

### 更新单个 skill

```json
[
  {
    "event": "session.start",
    "command": "botmux skills update my-skill-name",
    "timeoutMs": 60000
  }
]
```

### 更新全部已安装 skills

`botmux skills update` 只接受单个 skill 名称，不支持 `*` 或正则。更新全部需要脚本循环：

```bash
#!/bin/bash
# ~/bin/botmux-update-all-skills.sh
botmux skills list | cut -f1 | while read -r name; do
  [ -n "$name" ] && botmux skills update "$name"
done
```

```json
[
  {
    "event": "session.start",
    "command": "/root/bin/botmux-update-all-skills.sh",
    "timeoutMs": 120000
  }
]
```

### 直接调用 agentbuddy CLI 更新用户全局 Skills

如果想直接运行 `npx agentbuddy update`（更新用户全局 skills，而非 botmux 管理的 skills），需要注意 botmux hook 的执行环境限制：`shell: false`（不支持重定向、管道）、环境变量被清洗（只保留 PATH/HOME/TMPDIR/SHELL/USER 等基础项）。建议写成包装脚本：

```bash
#!/bin/bash
# ~/bin/agentbuddy-update.sh
export npm_config_registry="https://your-registry.example.com"  # 如使用私有 npm 源
npx -y agentbuddy update -y 2>/dev/null
```

```json
[
  {
    "event": "session.start",
    "command": "/root/bin/agentbuddy-update.sh",
    "timeoutMs": 120000
  }
]
```

### 注意事项

- **超时**：默认 `timeoutMs` 为 5000ms，agentbuddy update 涉及网络请求通常需要更久，必须显式加大（建议 60s+）。超时后 botmux 会先 `SIGTERM` 再 `SIGKILL` 整个进程组。
- **fire-and-forget**：hook 是异步执行，不会阻塞会话启动；skill 更新完成后需新会话才生效。
- **filter 过滤**：可用 `filter` 限定只对特定 `chatId` 或 `senderOpenId` 生效，避免所有会话都跑更新。
- **推荐方式**：优先使用 `botmux skills update`（方式一），它经过 botmux 的 telemetry 清理（`clearAgentbuddyTelemetry`），更新的是 botmux 注入的 skill 版本，与 botmux skill 生命周期一致。

## 写自己的 hook

hook 命令可以是任意 executable：bash / Python / Node / Go 二进制、公司内部 CLI、HTTP 转发器都行。命令 `exit 0` 视为成功；非 0 / 超时 / 找不到命令只写 botmux 日志，不会影响收发消息、定时任务或 session 生命周期。
