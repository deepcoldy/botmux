# Suspend workers when a topic ends

A deletion or recall event for a topic root terminates its current execution and suspends the bound Botmux worker by default, reclaiming execution-process memory. There is no configuration switch or periodic polling.

The logical session remains active. Its topic binding, saved context, working directory and Git worktree are kept. The next valid task uses the existing cold-resume path to start a fresh CLI for the same session.

## Triggers and feedback

| Action or state | Behavior |
| --- | --- |
| Root deletion/recall delivered as `im.message.recalled_v1` | Suspend immediately, terminating active work without waiting for natural turn completion |
| Ordinary reply recalled | Keep the topic worker running |
| Already suspended with no live worker | Idempotent no-op |
| Native Lark “Close current topic” | An actual subscribable event has not been confirmed; this version does not claim this integration |
| Manual `/close` or session-card close | Preserve existing explicit session-close semantics |

Dashboard shows “Suspended · Topic deleted or recalled”. No additional notification is posted into an unavailable topic. `[topic-suspend]` daemon logs report suspension results; an unconfirmed teardown is recorded as a failure rather than successful suspension.

## Limits

- The existing suspend path supports local tmux, herdr, zellij and zmx backends. PTY and remote backends retain their existing refusal behavior; sessions are not forcibly closed or discarded.
- Only this bot's exact thread binding in the specified chat is affected. Chat-scope sessions, other roots and peer workers remain active.
- The published `im.message.recalled_v1` subscription is required. Only received events are handled; missed events are not recovered by polling.
- Routing transfers, protected execution ownership and unverified backing teardown retain the existing suspend safety gates. Durable primary is not yet integrated with this automatic entry point.
- Unfinished work is terminated. Resume uses saved records and cannot recover an interrupted tool's in-memory state.

[Unavailable topic policy](/en/topic-unavailable-policy) controls sending and fallback destinations independently of this default suspension behavior.
