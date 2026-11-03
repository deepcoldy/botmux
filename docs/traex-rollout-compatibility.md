# TraeX rollout compatibility

## Compatibility contract

The reader supports both legacy and canonical TraeX records without requiring
users to select a version-specific delivery mode. It normalizes their inputs and
outputs into the existing BotMux turn and CoT events.

| Output | Legacy representation | Canonical representation | Normalized behavior |
| --- | --- | --- | --- |
| User input | `user_message` or `item_completed.UserMessage` | `display_completions[].UserMessage` | Bind one input to its turn |
| Final reply | `agent_message`, `item_completed.AgentMessage`, or terminal text | `display_completions[].AgentMessage` or terminal text | Preserve Markdown, newlines, tables, and code blocks |
| Thinking | `reasoning.summary` / `reasoning.content` | `Reasoning.summary_text` / `Reasoning.raw_content` | Prefer visible summaries; emit one same-record mirrored item |
| Tool calls | `items` containing function/custom/web-search calls | The same model/tool `items` | Preserve call identity, order, and subject |
| Tool results | Array-shaped text blocks or text strings | Array-shaped text blocks or text strings | Normalize text blocks without flattening newlines |
| Terminal status | `task_complete` / `turn_aborted` | The same terminal events | Preserve existing success, failure, and cancellation handling |

There is no new notification or delivery mechanism in this change. The `send`
and `transcript` paths keep their existing behavior; failed turns are one
compatibility regression case, not the primary purpose.

## Verified release boundary

Released Linux x86_64 binaries were checked with an isolated CLI home and a
loopback-only Responses fixture. No production model or IM service was used.

| Release | Release date (UTC) | Persisted user-input representation |
| --- | --- | --- |
| 0.207.1 | 2026-09-23 | `event_msg.payload.item` with `type: UserMessage` |
| 0.208.1-alpha.1 | 2026-09-28 | `history_mutation.payload.display_completions` with `history_format: canonical_v1` |
| 0.208.1 | 2026-10-07 | Same canonical representation, also observed in persisted sessions |

`0.208.1-alpha.1` is the earliest confirmed released binary with the new
representation in this investigation. The exact introducing source commit was
not verified. Compatibility is selected by record shape, not a CLI version check.

The alpha binary's compressed artifact SHA-256 was
`4d5b9e33157f7558bce3e6da86f1a14676d614ee4299c742c6b12e22978c3a3e`,
matching its release manifest.

## Canonical records

An appended history mutation may include display completions separately from its
model/tool `items`:

```json
{
  "type": "history_mutation",
  "timestamp": "2026-01-01T00:00:01Z",
  "payload": {
    "operation": "append",
    "turn_id": "native-turn",
    "items": [],
    "display_completions": [
      {
        "thread_id": "native-session",
        "turn_id": "native-turn",
        "item": {
          "type": "UserMessage",
          "id": "user-item",
          "content": [{"type": "text", "text": "Example task"}]
        }
      }
    ]
  }
}
```

Validated `UserMessage` and `AgentMessage` completions enter the existing
input/mirror and assistant-recovery paths. Validated `Reasoning` summaries are
merged with their same-ID model items without duplicate thinking output. Raw
`items` with `role: user` remain insufficient input evidence because they also
contain runtime injections.

`task_complete` remains the terminal boundary. Its non-null `error` produces a
failed turn regardless of whether `last_agent_message` is empty. Once its user
input is bound, the existing failure fallback can report that error in both
`send` and `transcript` delivery modes.

Assistant recovery is scoped to the native turn. Legacy inputs initially use
their stable record location and are rebound when their native identity becomes
known. Same-message mirrors preserve explicit phase classification: commentary
cannot become a final answer merely because another mirror omits `phase`.
Incremental reads retain partial lines, and repeated or mixed-dialect inputs do
not create duplicate turn boundaries.

## Regression checks

```sh
bun run test test/traex-transcript.test.ts \
  test/codex-bridge-queue.test.ts test/bridge-fallback-gate.test.ts
bun run build
```

The regression fixtures are synthetic. They cover normal replies in both
delivery modes; `Text`, `text`, and `output_text` blocks; Markdown tables and code
blocks; thinking-summary preference; array/string tool results; mixed-dialect
mirrors; same-offset replay; delayed binding; foreign identities; partial lines;
and existing success, failure, cancellation, and deliberate-silence behavior.
