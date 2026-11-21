# Lifecycle Hooks

Hooks let botmux **run your own command** at key moments: a new topic arrives, a session starts or exits, something needs a human, a turn finishes… Use them to send notifications, keep audit logs, auto-update skills, or run a custom check before a message reaches the CLI.

There are two kinds of hooks:

| Kind | How to write it | Does botmux wait? | Good for |
|------|-----------------|-------------------|----------|
| Notification (default) | Omit `mode`, or `"mode": "async"` | No. Failures, timeouts, or a missing command only go to the log and never affect messaging | Push notifications, auditing, metrics, kicking off external flows |
| Gate | `"mode": "sync"`, only on `prompt.submit` and `chat.bot_added` | Yes, it waits for "allow / deny" | Permission or content checks before a message reaches the CLI; deciding whether to auto-start after joining a group |

## 5-minute start: log events to a local file

1. Write a minimal hook script that appends the incoming JSON to a log:

   ```bash
   mkdir -p ~/bin
   cat > ~/bin/botmux-hook-log.sh <<'SH'
   #!/bin/bash
   { echo "== $BOTMUX_HOOK_EVENT $(date)"; cat; echo; } >> /tmp/botmux-hook.log
   SH
   chmod +x ~/bin/botmux-hook-log.sh
   ```

2. Write the config file `~/.botmux/data/hooks.json` (prefer an absolute path for `command`: the hook gets the daemon's `PATH`, which may differ from your terminal's):

   ```bash
   mkdir -p ~/.botmux/data
   cat > ~/.botmux/data/hooks.json <<JSON
   [
     { "event": "session.start", "command": "$HOME/bin/botmux-hook-log.sh" },
     { "event": "turn.finished", "command": "$HOME/bin/botmux-hook-log.sh" }
   ]
   JSON
   ```

3. Send a message in Feishu, then watch the log:

   ```bash
   tail -f /tmp/botmux-hook.log
   ```

Editing `hooks.json` **does not require a daemon restart**: botmux checks the file whenever an event fires and reloads it when it changes.

> The source repo's `examples/hooks/` has ready-made examples: `echo-to-log.sh` (log), `osascript-notify.sh` (macOS Notification Center), `http-webhook.sh` (forward to an HTTP endpoint), `prompt-gate.sh` (sync gate). The npm package does not include this directory; copy them from the GitHub repo if you need them.

## Where the config lives

From highest to lowest precedence; only the first one found is used:

1. Env var `BOTMUX_HOOKS_JSON`: a JSON array inline
2. Env var `BOTMUX_HOOKS_FILE`: path to a JSON file
3. Default file `~/.botmux/data/hooks.json` (or `hooks.json` under `SESSION_DATA_DIR` if that is set)

The content is an array; each item is one hook. You can attach several hooks to the same event. If the JSON fails to parse, none of it takes effect and the log shows `[hooks] Failed to load hook config`.

## Config fields

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

| Field | Required | Description |
|-------|----------|-------------|
| `event` | Yes | Event to subscribe to; see "Events" below. Entries with an unknown event are ignored |
| `command` | Yes | Command to run, with arguments (quotes supported). **No shell**; see "Execution environment" below |
| `timeoutMs` | No | Timeout in ms, default `5000`. On timeout botmux sends `SIGTERM`, then `SIGKILL`, to the whole process group |
| `mode` | No | `async` (default, notification) or `sync` (gate). `sync` only works on `prompt.submit` and `chat.bot_added`; on other events it is treated as `async` with a warning in the log |
| `onError` | No | Only for `sync`: what to do when the hook itself breaks (timeout, command not found, crash). Default `allow`; can be `deny` |
| `filter.larkAppId` | No | Only for one (or several) Bot apps. String or array |
| `filter.chatId` | No | Only for one (or several) chats. String or array |
| `filter.senderOpenId` | No | Only for one (or several) senders. Events without a sender (such as `session.start`) never match |
| `redact.fullContentEvents` | No | Long text is truncated by default; events listed here get full text for this hook |

All conditions in `filter` must **match together**; an array inside one condition means "any of these". If the event lacks the field, that condition does not match.

## Events

| Event | When it fires | Extra fields |
|-------|---------------|--------------|
| `topic.new` | A new topic or new @mention arrives | `messageId`, `senderOpenId`, `senderType`, `msgType`, `content` |
| `thread.reply` | A reply arrives in an existing topic | `messageId`, `rootId`, `parentId`, `senderOpenId`, `senderType`, `msgType`, `sessionId`, `content` |
| `prompt.submit` | A message has passed the built-in permission checks and is **about to be handed to the CLI**. Works as a notification or a gate | `messageId`, `senderOpenId`, `senderUnionId`, `memberUnionId`, `botSender`, `talkReason`, `content`, `attachments` |
| `outbound.send` | After botmux sends a regular message | `messageId`, `msgType`, `uuid`, `content` |
| `outbound.reply` | After botmux replies in a topic | `messageId`, `replyId`, `msgType`, `replyInThread`, `uuid`, `content` |
| `schedule.fired` | A scheduled-task check and submit has finished (ok, skipped, or error) | `id`, `name`, `schedule`, `status`, `error`, `rootMessageId`, `runAt`; multi-chat tasks also carry `chatIds` |
| `session.start` | A session process started (including resume and adopt) | `reason`, `pid`; adopt also has `adoptedFrom` |
| `session.exit` | A session process exited, crashed, or the session was closed | `reason`, `code` |
| `session.idle` | A session enters or leaves idle | `prevState`, `newState`, `transition` (`enter` / `exit`), `source`, `content` (screen text at the time) |
| `session.requires_attention` | Something needs a human (`reason` values below) | `reason`, plus `message`, `kind`, `errorCode`, `turnId` / `logicalTurnId`, etc. depending on the case |
| `turn.finished` | A turn ended (success, failure, or cancel) | `turnId`, `status`, `terminalStatus`, `senderOpenId`, `dispatchAttempt` |
| `chat.bot_added` | The Bot was added to a group (subscribe to `im.chat.member.bot.added_v1` in the Feishu console) | `operatorOpenId` (who added the Bot); the sync gate also gets `chatName`, `chatDescription`, `chatMode`, `chatFetchStatus` |

### Fields on every event

- The payload is written as JSON to the command's **stdin**, and the env var `BOTMUX_HOOK_EVENT=<event name>` is set.
- Every payload has `event` and `emittedAt` (ISO time).
- Most events also carry `larkAppId` and `chatId`; session events (`session.*`) also carry `sessionId`, `chatType`, `scope`, `anchor`, `title`, `cliId`, `workingDir`, `hasHistory`, `spawnedAt`, `lastMessageAt`.

### Long text is truncated

`content`, `message`, `description`, `finalOutput`, and `lastScreenContent` are truncated past **600 characters**. These fields always come with `xxxLength` (original length) and `xxxTruncated` (whether it was cut). For full text, list the event in this hook's `redact.fullContentEvents`. Sync gates are the exception and always get full text (see below).

### Event details

**`session.exit`**: `reason` is `graceful` (exit code 0), `exit_code_<N>`, or `dashboard_close` (the session was closed on purpose, e.g. from the Dashboard; there is no `code` field). Not emitted when the daemon itself shuts down.

**`session.idle`**: fires at most once per session per state within 10 seconds, so flapping doesn't flood you.

**`schedule.fired`**: `status` matches the task's "last status":

| `status` | Meaning |
|----------|---------|
| `ok` | Handed to the executor. It does **not** mean the model finished or the message was delivered |
| `error` | Pre-check or submit failed; the reason is in `error` |
| `skipped` | Pre-conditions not met; the model was not called |

A skip doesn't use up a repeat and doesn't delete the task. A skipped one-shot task stays enabled and is rechecked after at least 30 seconds; recurring tasks continue on their normal schedule. If your script only handles `ok` / `error`, add a `skipped` branch and don't treat it as success.

**`turn.finished`**:

- `status` is the simplified result, `success` or `error`; `terminalStatus` is the raw result, `completed`, `failed`, `cancelled`, or `ambiguous` (use it to tell cancel from failure).
- `senderOpenId` is who started this turn; if unknown, the field is omitted rather than filled with the session owner.
- Each turn (per dispatch attempt) fires once per daemon process; after a daemon restart it may fire again, so dedupe on `sessionId` + `turnId` + `dispatchAttempt`. A retried turn has a different `dispatchAttempt`, and each attempt fires.
- If the session process exits without finishing a turn, no `turn.finished` is sent for it (the exit goes through `session.exit`).
- It only says "this turn ended" and carries no duration or usage. For those, use the `turn.completed` outbound event in the Bot's `feedbackWebhooks` config.
- The same notification also appears on the daemon's local `GET /api/events` stream.

**Meeting (VC) receiver sessions** never trigger `session.*` or `turn.finished` hooks, because they process external meeting content.

### `reason` values for session.requires_attention

| `reason` | Situation |
|----------|-----------|
| `user_notify` | The session process raised something you need to handle, e.g. input could not be submitted to the CLI |
| `agent_request` | The agent raised its hand with `botmux send --attention`; `kind` is `authz` / `decision` / `blocked` / `help`, `message` is the reason |
| `stuck_warning` | The session looks stuck on some screen; also has `elapsedMs`, `matchedPattern` |
| `worker_start_failed`, `worker_fork_error` | The session process failed to start |
| `ordinary_turn_recovery_exhausted` | A turn failed and automatic retries ran out |
| `task_continuation_stopped` | Automatic continuation stopped |
| `claude_terminal_failure_unrecovered` | A turn failed (CLI error or it exited mid-turn) and could not recover automatically. The "claude" in the name is historical; other CLIs send it too |
| `card_content_rejected`, `content_audit_blocked` | Feishu rejected the final reply (card format or content audit) |
| `topic_send_blocked` | The original topic is no longer available and sending stopped (see [Stop sending when the topic is unavailable](/en/topic-unavailable-policy)) |

New `reason` values may be added later; give unknown values a default branch in your script.

### Outbound events can't block anything

`outbound.send` / `outbound.reply` fire **after** Feishu has accepted the message, so it's already in the chat. They don't support `sync` and are notifications only.

## Sync gate: run your check before a message reaches the CLI

Add a `"mode": "sync"` hook on `prompt.submit` and every message headed for the CLI asks it first: allow or deny.

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

`examples/hooks/prompt-gate.sh` in the source repo is a good starting point.

### How to answer "allow / deny"

Either way works; **JSON on stdout wins**:

| Method | How | Notes |
|--------|-----|-------|
| JSON (recommended) | Print `{"decision":"deny","reason":"why"}` to stdout | `decision` is `allow` or `deny`; `reason` is shown to the user (up to 300 chars) |
| Exit code | Print no JSON, just `exit 0` or `exit 1` | 0 allows, non-zero denies; stderr becomes the reason |

stdout must be **entirely** one JSON object to count. A few log lines on stdout fall back to the exit code.

When denied, the user gets "🚫 This message was blocked by a pre-submit check and was not sent to the CLI" in the topic, followed by the reason.

### When it runs

```
Feishu message → built-in permission check → 🚦 prompt.submit gate → charge quota → download attachments
              → create/wake session → type text into CLI + Enter → CLI starts working
```

The gate runs in the daemon, before the CLI has seen this message (for a new topic the CLI hasn't even started). A denied message never reaches the CLI at all.

Note: there is no "text already typed in the CLI input box, before Enter" moment. botmux types the text and presses Enter in one step, with nowhere to insert a check.

### Rules at a glance

| You want to know | What happens |
|------------------|--------------|
| Can it loosen permissions? | No. Built-in checks (`allowedUsers`, grants, oncall, quota) run first; the hook is only asked if they all pass. An `allow` can't let in someone they rejected |
| Does a deny cost quota? | No, the gate runs before quota is charged |
| Several `sync` hooks | All must allow; hooks after the first `deny` don't run |
| The hook itself breaks | `onError` applies, default `allow`. For "deny everything if the checker is down", set `"onError": "deny"`; the user then sees the reason `permission check failed` |
| `timeoutMs: 0` | ⚠️ Not "no limit" but "time out instantly", which means the gate does nothing (default `allow`). A warning is logged on load. Use a real budget like `3000` |
| Does it slow things down? | Yes, gate time is added directly to message intake. Aim for 1–3 s. A slow gate makes later messages in the same topic queue up and may make this Bot's Dashboard actions (closing sessions, editing config) time out. No `sync` hook means zero overhead |
| How much text does it see? | **Full text**, never truncated (otherwise padding past 600 chars would bypass it). ⚠️ So configuring a gate hands the full message to that command |
| Can it see attachments? | Only metadata, `attachments: [{type, name}]`, e.g. `[{"type":"file","name":"prod.env"}]`, enough for "no .env uploads" or "images only"; not the file contents (attachments aren't downloaded yet) |
| Which messages go through it | New topics, topic replies, slash commands that start a session, the first message in a session group, external content matched by a message listener (denials there are only logged, no reply). Saved workflows also pass the gate, but without the text, so only sender-based rules apply |
| Which don't | Prompts sent automatically by scheduled tasks (automation you configured yourself); control messages that never reach the CLI |
| Will it run twice? | No. A config entry that runs as a gate isn't run again as a notification |

### Notify and gate on the same event

`prompt.submit` can also be a plain notification (no `mode`). Both can coexist:

```json
[
  { "event": "prompt.submit", "command": "/root/bin/audit-log.sh" },
  { "event": "prompt.submit", "mode": "sync", "command": "/root/bin/prompt-gate.sh", "timeoutMs": 3000 }
]
```

- Notifications are sent **before** the verdict, so they see denied messages too, which is exactly what an audit of "whose message got blocked" needs.
- Notification hooks get text truncated to 600 chars as usual; only the gate gets full text.
- A notification hook's exit code and output never affect the verdict.

### Try it

```bash
cat > /tmp/gate.sh <<'SH'
#!/bin/bash
cat > /tmp/gate-payload.json
echo '{"decision":"deny","reason":"gate test: not allowed yet"}'
SH
chmod +x /tmp/gate.sh

cat > ~/.botmux/data/hooks.json <<'JSON'
[{ "event": "prompt.submit", "mode": "sync", "command": "/tmp/gate.sh", "timeoutMs": 3000 }]
JSON
```

Send the Bot a message in Feishu. You should get the "blocked by a pre-submit check" reply, and `/tmp/gate-payload.json` will hold the payload. Restore `hooks.json` when you're done.

## Join gate: decide whether to auto-start after being added to a group

If the Bot has join auto-start on (`autoStartOnGroupJoin`, see [bots.json](/en/bots-json)), you can add a `sync` hook on `chat.bot_added` to decide per group. The hook sees the group name `chatName`, description `chatDescription`, group type `chatMode`, and who added the Bot, `operatorOpenId`.

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

Key points:

- It decides **only** join auto-start. Async `chat.bot_added` notifications and `groupJoinCommand` (run a command on join) keep running regardless.
- Scope it with `filter.larkAppId` / `filter.chatId`. **Don't** use `filter.senderOpenId`: join events have no sender, so it never matches. To decide by inviter, read `operatorOpenId` in your script.
- For "do nothing at all unless it's a target group": set `autoStartOnGroupJoinGateRequired: true` on the Bot and give the gate `"onError": "deny"`. Then a missing, unmatched, timed-out, or crashed gate means no auto-start, instead of auto-starting in every new group.
- With `autoStartOnGroupJoinGateRequired: true`, the first-turn prompt also includes a group-join block and the inviter; without it, the first-turn prompt is exactly as before.
- This join info only shows "the Bot was added to this group". It does **not** prove the first-turn caller is an authenticated human, so the first turn doesn't get human-only privileges (such as auto-continuation or creating scheduled tasks directly). If the inviter is an app or bot, it isn't recorded as the session owner either.
- Manual force-start entry points skip this gate.

To give one Bot its own join script (runs directly, no model), `groupJoinCommand` in bots.json is simpler; edit it in the Dashboard under Bot Config → Proactive Start. Its timeout is 10 minutes.

## Execution environment

Before writing your own hook, know how it runs:

- **Any executable works**: bash, Python, Node, a Go binary, an internal CLI, an HTTP forwarder.
- **No shell**: `command` is just split on spaces and quotes into program + arguments. Pipes `|`, redirects `>`, `&&`, and `~` expansion don't work. Use a script, or `bash -c '…'`.
- **Minimal env vars**: only basics such as `PATH`, `HOME`, `TMPDIR`, `SHELL`, `USER`, `LANG`, plus `BOTMUX_HOOK_EVENT`. App secrets and API keys are not passed. `export` anything else you need inside your script.
- **Payload on stdin**: one JSON object. It's fine not to read it.
- **Timeouts kill the whole process group**, including child processes your script started.
- **Nobody reads notification output**: non-zero exit, timeout, or command not found only go to the botmux log and never affect messaging, scheduled tasks, or sessions.

## Recipe: auto-update Skills when a session starts

botmux has built-in skill management (`botmux skills install …` to install, `botmux skills update <name>` to update, `botmux skills list` to list installed ones). With `session.start` you can check for updates every time a new session starts, similar to Claude Code's SessionStart hook.

**Update one skill:**

```json
[
  { "event": "session.start", "command": "botmux skills update my-skill-name", "timeoutMs": 60000 }
]
```

**Update all installed skills**: `botmux skills update` takes a single name (no `*`), so loop in a script:

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

**Call agentbuddy directly to update user-global skills**: hooks run without a shell and with a trimmed environment, so use a wrapper script:

```bash
#!/bin/bash
# ~/bin/agentbuddy-update.sh
export npm_config_registry="https://your-registry.example.com"  # if you use a private npm registry
npx -y agentbuddy update -y 2>/dev/null
```

```json
[
  { "event": "session.start", "command": "/root/bin/agentbuddy-update.sh", "timeoutMs": 120000 }
]
```

Notes:

- **Raise `timeoutMs`**: the 5 s default is rarely enough for a network update; use 60 s or more.
- **Doesn't block the session**: updates run in the background and the current session doesn't wait; results take effect in the next new session.
- **Narrow the scope**: use `filter.chatId` / `filter.larkAppId` to run only for certain chats or Bots.
- **Prefer `botmux skills update`**: it updates the botmux-managed skill version, stays in step with botmux's skill lifecycle, and for skills installed from agentbuddy it strips the embedded usage telemetry.
