# Lifecycle Hooks

botmux can invoke external commands when key lifecycle events occur. By default they are **asynchronous**: if a command fails, times out, or doesn't exist, it only writes to the log and never blocks botmux's main flow.

There is also a **synchronous pre-submit gate** (`mode: "sync"`, supported only on the `prompt.submit` event): the daemon waits for it and uses its verdict to decide whether the message reaches the CLI. See [Synchronous pre-submit gate](#synchronous-pre-submit-gate-promptsubmit).

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
| `mode` | `"sync"`｜`"async"` | Optional, defaults to `async`. `sync` is supported **only** on `prompt.submit`; declaring it on any other event degrades to `async` with a warning in the log |
| `onError` | `"allow"`｜`"deny"` | Optional, meaningful only with `mode:"sync"`. Fallback direction when the hook itself fails (timeout / missing command / crash). Defaults to `allow` (fail-open) |
| `filter.chatId` | string｜string[] | Optional. Only match the chat of the specified Lark group / topic |
| `filter.senderOpenId` | string｜string[] | Optional. Only match the specified sender open_id |
| `redact.fullContentEvents` | string[] | Optional. Long text is truncated by default; events in this allowlist pass through the full text |

## Supported Events

| Event | Trigger |
|------|----------|
| `topic.new` | A new topic / @mention is received |
| `thread.reply` | A reply to an existing topic is received |
| `prompt.submit` | A message passed the built-in permission checks and is **about to be submitted to the CLI**. The only event that supports `mode:"sync"` blocking |
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
| `prompt.submit` | `messageId`, `chatId`, `chatType`, `anchor`, `senderOpenId`, `senderUnionId`, `memberUnionId`, `botSender`, `talkReason`, `content` |
| `thread.reply` | `messageId`, `rootId`, `parentId`, `senderOpenId`, `senderType`, `msgType`, `content` |
| `outbound.send` | `messageId`, `msgType`, `uuid`, `content` |
| `outbound.reply` | `messageId`, `replyId`, `msgType`, `replyInThread`, `uuid`, `content` |
| `schedule.fired` | `id`, `name`, `schedule`, `status`, `error`, `rootMessageId`, `runAt` |
| `session.start` | `reason`, `pid`, `adoptedFrom` |
| `session.exit` | `reason`, `code` (worker exit path; `null` for `dashboard_close`) |
| `session.idle` | `prevState`, `newState`, `transition`, `source` |
| `session.requires_attention` | `reason`, `description`, `optionsCount`, `optionsPreview`, `multiSelect`, `message` |

By default, `content`, `message`, `description`, `finalOutput`, and `lastScreenContent` are truncated to **600 characters**, with `xxxLength` / `xxxTruncated` added; only events in `redact.fullContentEvents` pass through the full text.

## Synchronous pre-submit gate (prompt.submit)

A regular hook is a *notification* — nothing reads its result. `prompt.submit` with `mode: "sync"` is a *verdict*: the daemon waits for it, reads it, and allows or rejects the message accordingly. Use it to add a custom authorization layer before a message reaches the CLI (an internal permission service, working-hours limits, dangerous-command interception, …).

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

A ready-to-adapt example ships in the repo: `examples/hooks/prompt-gate.sh`.

### Expressing a verdict

Two ways; **JSON on stdout takes precedence over the exit code**:

| Method | How | Notes |
|------|------|------|
| JSON (recommended) | print `{"decision":"deny","reason":"..."}` on stdout | `reason` is shown to the user; `decision` is `allow`｜`deny` |
| Exit code | print no JSON, `exit 0` / non-zero | 0 allows, non-zero denies; stderr is used as the reason |

Stdout must be a **whole JSON object** to count as a verdict. Printing an ordinary log line will not be mistaken for one — that case falls back to the exit code.

### Boundaries and guarantees

- **It can only tighten, never loosen.** The built-in permission model (`allowedUsers` / `grant` / oncall / quota) runs first; the hook is asked only after all of it passes. A hook returning `allow` cannot let in someone the built-in gate rejected.
- **A rejection costs no quota.** The gate sits before the charge, so a denied message does not consume the user's message quota.
- **A rejection tells the user** (with `reason`) instead of dropping silently — an authorized user whose messages vanish is the hardest failure to diagnose.
- **Multiple sync hooks are ANDed.** Any `deny` rejects; hooks after the first `deny` do not run.
- **A broken hook is not a rejection.** Timeout, missing command, and crashes all follow `onError`, which defaults to `allow` — a broken checker should not brick the whole bot. Set `onError: "deny"` explicitly for the opposite.
- **The latency lands directly on the inbound path.** Keep `timeoutMs` small (1–3s). Bot-level admission is concurrent so a slow gate will not stall the whole daemon, but replies **within one topic** hold an ordering lock — a slow gate makes later messages in that topic queue up. Do not lean on a large timeout to paper over a slow service. With no sync hook configured there is zero overhead — no spawn is added per message.
- **Message-listener traffic is adjudicated too.** That content comes from third parties (alert bots and the like) and still reaches a CLI, so it is exactly what a gate should inspect. That path never charges quota; a denial is logged only, with no reply (there is no human sender to answer).
- **A gate receives the full content, exempt from the 600-character truncation.** That truncation exists for notification hooks; for a gate the content *is* the input to the decision, so truncating it makes the gate structurally blind past the limit (pad 600 characters and hide the payload behind them).
  ⚠️ **Privacy implication**: configuring a sync gate hands that command the **full message text**. Async hooks are unaffected and still truncate.
- A given hook entry **runs only once**: after running as the gate, it is not fired again as an async notification.

## Practical: Auto-Update Skills with session.start

botmux natively integrates agentbuddy as a skill source (`botmux skills install <agentbuddy-command>` to install, `botmux skills update <name>` to update). Combined with the `session.start` hook, you can automatically check for and update installed skills on every new session — equivalent to the SessionStart Hook in Relay / Claude Code's settings.json.

### Update a Single Skill

```json
[
  {
    "event": "session.start",
    "command": "botmux skills update my-skill-name",
    "timeoutMs": 60000
  }
]
```

### Update All Installed Skills

`botmux skills update` accepts only a single skill name — no `*` or regex. To update everything, loop in a script:

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

### Call agentbuddy CLI Directly to Update Global Skills

If you prefer running `npx agentbuddy update` directly (updating the user's global skills rather than botmux-managed skills), be aware of botmux's hook execution constraints: `shell: false` (no redirection or piping) and a scrubbed environment (only PATH/HOME/TMPDIR/SHELL/USER and a few other basics are preserved). Use a wrapper script:

```bash
#!/bin/bash
# ~/bin/agentbuddy-update.sh
export npm_config_registry="https://your-registry.example.com"  # if you use a private npm registry
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

### Notes

- **Timeout**: The default `timeoutMs` is 5000ms. agentbuddy update involves network requests and typically takes longer — set it explicitly (60s+ recommended). On timeout, botmux sends `SIGTERM` first, then `SIGKILL` to the entire process group.
- **Fire-and-forget**: Hooks run asynchronously and never block session startup; updated skills take effect in the next session.
- **Filter**: Use `filter` to limit updates to specific `chatId` or `senderOpenId`, avoiding unnecessary updates for every session.
- **Recommended approach**: Prefer `botmux skills update` (first approach) — it goes through botmux's telemetry scrubbing (`clearAgentbuddyTelemetry`) and updates the skill versions botmux injects, staying consistent with botmux's skill lifecycle.

## Writing Your Own Hook

A hook command can be any executable: a bash / Python / Node / Go binary, an internal company CLI, or an HTTP forwarder. A command that does `exit 0` is treated as a success; non-zero exits / timeouts / missing commands only write to the botmux log and never affect message send/receive, scheduled tasks, or the session lifecycle.
