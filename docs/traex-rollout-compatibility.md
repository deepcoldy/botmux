# TraeX rollout compatibility

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

Only validated `UserMessage` and `AgentMessage` completions enter the existing
input/mirror and assistant-recovery paths. Raw `items` with `role: user` remain
insufficient input evidence because they also contain runtime injections.

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

The regression fixtures are synthetic. They cover canonical input and final
recovery, output-limit and malformed-function-call failures, mixed-dialect
mirrors, same-offset replay, delayed binding, foreign identities, partial lines,
and existing legacy behavior.
