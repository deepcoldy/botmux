# 生命周期 Hooks

botmux 可以在关键生命周期事件发生时**异步调用外部命令**。命令失败、超时或不存在只会写日志，不阻塞 botmux 主流程。

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
| `filter.chatId` | string｜string[] | 可选。只匹配指定飞书群 / 话题所在 chat |
| `filter.senderOpenId` | string｜string[] | 可选。只匹配指定发送者 open_id |
| `redact.fullContentEvents` | string[] | 可选。默认截断长文本；列入 allowlist 的事件透传全文 |

## 支持事件

| 事件 | 触发时机 |
|------|----------|
| `topic.new` | 收到新话题 / @mention |
| `thread.reply` | 收到已有话题回复 |
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
| `thread.reply` | `messageId`、`rootId`、`parentId`、`senderOpenId`、`senderType`、`msgType`、`content` |
| `outbound.send` | `messageId`、`msgType`、`uuid`、`content` |
| `outbound.reply` | `messageId`、`replyId`、`msgType`、`replyInThread`、`uuid`、`content` |
| `schedule.fired` | `id`、`name`、`schedule`、`status`、`error`、`rootMessageId`、`runAt` |
| `session.start` | `reason`、`pid`、`adoptedFrom` |
| `session.exit` | `reason`、`code`（worker 退出路径；`dashboard_close` 为 `null`） |
| `session.idle` | `prevState`、`newState`、`transition`、`source` |
| `session.requires_attention` | `reason`、`description`、`optionsCount`、`optionsPreview`、`multiSelect`、`message` |

默认会把 `content`、`message`、`description`、`finalOutput`、`lastScreenContent` 截断到 **600 字符**，并补充 `xxxLength` / `xxxTruncated`；只有 `redact.fullContentEvents` 内的事件透传全文。

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
export npm_config_registry="https://bnpm.byted.org"
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
