# Lifecycle Hooks

botmux can **asynchronously invoke external commands** when key lifecycle events occur. If a command fails, times out, or doesn't exist, it only writes to the log and never blocks botmux's main flow.

## Configuration Location

In order of precedence (highest to lowest):

1. The `BOTMUX_HOOKS_JSON` environment variable (pass a JSON array directly)
2. The file path specified by `BOTMUX_HOOKS_FILE`
3. The default `~/.botmux/data/hooks.json`

## Quick Check: Write to a Local Log

The repo ships an example script you can copy and use right away:

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

After any hook event fires, you'll see the JSON payload in the log. `examples/hooks/` also includes examples for macOS Notification Center (`osascript-notify.sh`) and HTTP webhooks (`http-webhook.sh`).

## Configuration Fields

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

| Field | Type | Description |
|------|------|------|
| `event` | string | Required. The event name to subscribe to (see table below) |
| `command` | string | Required. The external executable command; supports arguments, but is not run through a shell |
| `timeoutMs` | number | Optional. Defaults to 5000; on timeout, sends `SIGTERM` first, then falls back to `SIGKILL` |
| `filter.chatId` | string｜string[] | Optional. Only match the chat of the specified Lark group / topic |
| `filter.senderOpenId` | string｜string[] | Optional. Only match the specified sender open_id |
| `redact.fullContentEvents` | string[] | Optional. Long text is truncated by default; events in this allowlist pass through the full text |

## Supported Events

| Event | Trigger |
|------|----------|
| `topic.new` | A new topic / @mention is received |
| `thread.reply` | A reply to an existing topic is received |
| `outbound.send` | botmux successfully sends a regular message |
| `outbound.reply` | botmux successfully replies to a topic message |
| `schedule.fired` | A scheduled task finishes running |
| `session.start` | A worker / adopt worker starts successfully |
| `session.exit` | A worker exits, crashes, or the session is closed (silenced by default on daemon shutdown) |
| `session.idle` | A session enters or leaves idle, deduplicated per session + state over 10s |
| `session.requires_attention` | A TUI prompt or a worker `user_notify` needs the user to act |

## Payload Fields

Every payload is written to the hook command via stdin, and the environment variable `BOTMUX_HOOK_EVENT` is also set. Each payload includes `event` and `emittedAt`; the event context may include `sessionId`, `chatId`, `chatType`, `larkAppId`, `scope`, `anchor`, `title`, `cliId`, `workingDir`, `hasHistory`, `spawnedAt`, and `lastMessageAt`.

Different events carry extra fields:

| Event | Extra fields |
|------|----------|
| `topic.new` | `messageId`, `senderOpenId`, `senderType`, `msgType`, `content` |
| `thread.reply` | `messageId`, `rootId`, `parentId`, `senderOpenId`, `senderType`, `msgType`, `content` |
| `outbound.send` | `messageId`, `msgType`, `uuid`, `content` |
| `outbound.reply` | `messageId`, `replyId`, `msgType`, `replyInThread`, `uuid`, `content` |
| `schedule.fired` | `id`, `name`, `schedule`, `status`, `error`, `rootMessageId`, `runAt` |
| `session.start` | `reason`, `pid`, `adoptedFrom` |
| `session.exit` | `reason`, `code` (worker exit path; `null` for `dashboard_close`) |
| `session.idle` | `prevState`, `newState`, `transition`, `source` |
| `session.requires_attention` | `reason`, `description`, `optionsCount`, `optionsPreview`, `multiSelect`, `message` |

By default, `content`, `message`, `description`, `finalOutput`, and `lastScreenContent` are truncated to **600 characters**, with `xxxLength` / `xxxTruncated` added; only events in `redact.fullContentEvents` pass through the full text.

## Writing Your Own Hook

A hook command can be any executable: a bash / Python / Node / Go binary, an internal company CLI, or an HTTP forwarder. A command that does `exit 0` is treated as a success; non-zero exits / timeouts / missing commands only write to the botmux log and never affect message send/receive, scheduled tasks, or the session lifecycle.
