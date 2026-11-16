# Automatically reclaim topic resources

When enabled, deleting or recalling a topic root ends its Botmux task and releases the worker and session binding. Session history, working directories and Git worktrees are kept.

This setting is per bot and off by default. In Dashboard → Bot configuration → Reply delivery, enable **Automatically reclaim topic resources**, or send:

```sh
/botconfig set topicAutoClose on
```

To disable it:

```sh
/botconfig set topicAutoClose off
```

The corresponding `bots.json` field is `"topicAutoClose": true`. Dashboard and command changes apply immediately without a restart.

## When cleanup happens

| Action or state | Behavior |
| --- | --- |
| Topic root recalled | The recall event starts normal session teardown, including stopping an active task |
| Root deleted, or recall event missed | A startup check and checks every minute reclaim the worker after confirming deletion |
| Ordinary reply recalled | The topic session stays open |
| Timeout, missing permissions or unknown status | Keep the worker and retry on the next check |
| Native Lark “Close current topic” | No confirmed public close event or status is available; use `/close` or the session card first |

One minute is the check interval, not a cleanup deadline. Large session counts, API limits and worker shutdown can add delay. No close notice is posted into the recalled topic. Dashboard shows the closed session; `[topic-gone]` daemon logs record the root and close outcome, including refusals or residual resources.

## Limits

- Supported in ordinary single-replica mode only. Durable primary keeps its existing lifecycle fencing and does not run this cleanup.
- Only this bot's thread sessions bound to the exact root are reclaimed. Chat-scope sessions, other roots and other bots remain active.
- Immediate cleanup requires the published `im.message.recalled_v1` subscription; periodic checks require permission to read the root. Failed reads never prove deletion.
- Turning the switch off prevents new event/check cleanup. It does not undo a close that has already started or change existing `/close` and send-failure close behavior.

[Unavailable topic policy](/en/topic-unavailable-policy) controls sending and fallback destinations; this setting controls resource cleanup. To stop both the task and fallback messages after deletion, enable automatic cleanup together with `topicUnavailablePolicy: "stop"`.
