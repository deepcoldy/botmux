# Turn Results (TurnResult)

After a bot answers a question in Feishu, a program on the same machine can call one endpoint to get a **structured result** for that turn: did it finish, what was the final answer, and was it actually delivered to the chat.

The endpoint is **read-only**. It does not rerun the model, send messages, or perform any business action for you.

Typical uses:

- A host program on the same machine wants to know "what did the bot answer to that message, and did it arrive?"
- You want to feed the bot's final answer into your own pipeline (archiving, post-processing) without parsing chat messages.

> To **start** a task from outside and get its result, use the trigger APIs in [Webhook](/en/webhook) or [Core-only API](/en/api-core-only). This page only covers reading results from ordinary Feishu conversations.

## Three separate facts

A turn has three independent facts, recorded separately:

| Field | Question it answers | Values |
|---|---|---|
| `execution.status` | Did the CLI finish this turn? | `completed` / `failed` / `cancelled` / `ambiguous` (cannot tell) |
| `output.status` | Is there a final answer? | `available` (has content) / `empty` (explicitly no output) / `unavailable` |
| `deliveries[].status` | Did the answer reach Feishu? | `delivered` / `partial` / `failed` / `unknown` / `suppressed` (intentionally not sent) |

So "the model finished" does not mean "the message was delivered", and "HTTP 200" does not mean "the task succeeded". Check each field on its own.

## Step 1: enable it for the bot

Add this to the target bot's entry in `bots.json`:

```json
{
  "turnResults": { "enabled": true }
}
```

- Off by default; only an explicit `true` enables it.
- Applies to new turns only; turns from before enabling cannot be read.
- Turning it off clears that bot's cached results.
- `apiOnly` ([Core-only](/en/api-core-only)) bots and bots with read isolation (`readIsolation`) are not supported; lookups return `unsupported_mode`.

## Step 2: identify the turn

You need these IDs:

| Parameter | What it is |
|---|---|
| `sessionId` | The botmux session ID (the session behind the topic) |
| `turnId` | The turn ID: a Feishu message ID starting with `om_`, usually the message that triggered the turn (for a newly started topic it can be the topic's anchor message) |
| `dispatchAttempt` (optional) | Attempt number when the same message was dispatched again; a non-negative integer |

Omitting `dispatchAttempt` means "this turn has no attempt number". It does **not** mean "the latest attempt".

## Step 3: send the request

```text
GET /api/sessions/<sessionId>/turns/<turnId>/result
GET /api/sessions/<sessionId>/turns/<turnId>/result?dispatchAttempt=1
```

Send it to **that bot's own daemon**, signed as a trusted local host:

1. **Find the port**: each online daemon writes a descriptor file into the data directory, by default `~/.botmux/data/dashboard-daemons/<bot App ID>.json`. Its `ipcPort` is the port.
2. **Sign**: same method as the signed Core-only endpoints, with the three headers `X-Botmux-Cli-Ts` / `X-Botmux-Cli-Nonce` / `X-Botmux-Cli-Auth` and the secret in `~/.botmux/.dashboard-secret`. See section 6, "How to sign", in [Core-only API](/en/api-core-only) for the algorithm and reference code.
3. Send it to the local loopback address `http://127.0.0.1:<ipcPort>`. Loopback only gets you connected; access still comes from the signature.

The bot is chosen by the daemon that receives the request; there is no cross-bot parameter. Knowing a result's IDs does not grant access to it; the signature does.

## Reading the response

The HTTP status only says whether the **lookup** worked:

| HTTP | When |
|---|---|
| `200` | Lookup done; check `status` in the body |
| `400` | Bad parameters, e.g. `dispatchAttempt` is not a non-negative integer, or extra query parameters (`reason: invalid_reference`) |
| `401` | Missing or wrong signature |
| `403` | Request did not pass trusted-host checks (`reason: trusted_host_required`) |

`status` in the body:

| `status` | Meaning | What to do |
|---|---|---|
| `ready` | Result is complete; includes a `result` object | Use it |
| `not_ready` | Only some facts are in (e.g. finished but delivery not yet confirmed) | Try again later |
| `unavailable` | Cannot be provided; see `reason` | See the table below |
| `not_found` | No record of this turn, or it expired | Not recovered from history files |

Common `reason` values:

| `reason` | Meaning |
|---|---|
| `disabled` | `turnResults` is not enabled for this bot |
| `unsupported_mode` | The bot or turn uses an unsupported mode (see "Which turns are collected") |
| `result_not_settled` | The result did not come together within 5 minutes and was dropped |
| `result_too_large` | Appears in `output.reason`: content exceeds 1 MiB; no truncated version is returned |

A full `ready` example:

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
      "content": "The complete final answer for this turn"
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

Points that are easy to misread:

- `output.content` is the turn's **final adopted answer**, without thinking or progress text.
- A `failed` execution never exposes a partial answer.
- `messages` lists only messages **confirmed as sent**: `primary` is the main reply, `attachment` is the full Markdown file sent when the answer is too long. An existing card does not prove its last update succeeded.
- If the platform's content audit blocks the answer, this endpoint will not hand you the content either. It cannot be used to bypass the audit.
- Timing fields that were not measured are omitted, not guessed.

## Which turns are collected

Supported: **ordinary turns** triggered by a real message in a Feishu group or topic, with the answer posted back to that chat the normal way.

Not collected (lookups return `unavailable` or `not_found`):

- Meeting assistant, [doc comments](/en/doc-comment), private replies, sandboxed sessions that cannot post cards directly;
- [Silent scheduled tasks](/en/schedule), [adopted](/en/adopt) sessions, headless / HTTP-triggered turns;
- Native CLI commands typed straight into an existing session (raw passthrough), since they have no trusted source message. The first passthrough at cold start may still be collected if it carries a real source message;
- Replies that reuse an old card, or send paths that cannot prove complete delivery. These stay `not_ready` / `unavailable`; nothing is guessed.

The result APIs of [webhooks](/en/webhook), [headless runs](/en/headless-session), and [workflows](/en/workflow) are unchanged; this feature does not replace them.

When a session or turn becomes unsupported, only that one result is removed; other results of the same bot are kept.

## Retention

Results live only in daemon memory:

| Limit | Value |
|---|---|
| Turns kept at once | Up to 128 (including unfinished ones) |
| Total size | 16 MiB; oldest entries are evicted first |
| Single result | Up to 1 MiB |
| Finished results | Kept for 15 minutes |
| Unfinished results | Waited on for up to 5 minutes |

- Reading does not extend retention.
- Everything is cleared when the daemon restarts.
- This is **not** a dedup or recovery ledger: no guarantee of reads across restarts, no automatic redelivery, no exactly-once.
- The existing `turn.completed` webhook and feedback database still store metadata only, not full content.

## Advanced: completion callback for embedding hosts

If you embed botmux as a library, you can pass an optional `onTurnResult(result)` callback to the worker pool. Once a turn's result is complete, it receives the same read-only snapshot the endpoint returns.

- There is no callback by default, and no external command is run.
- If the callback throws or does not finish within 10 seconds, only a log line is written. The original answer is not resent and the model is not retried.
- The timeout does not interrupt your callback code, and it does not prove your business action did not happen.

If you act on a result (create groups, invite people, deploy, change config, forward to other chats), verify identity, target scope, and write permission yourself. Reading a result grants none of those.
