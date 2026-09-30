# Delivery when the original topic is unavailable

`topicUnavailablePolicy` is a per-bot setting. Configure it under Dashboard → Reply Delivery, or with `/botconfig topicUnavailablePolicy stop`.

| Value | Behavior |
| --- | --- |
| `legacy` (default) | Keep existing delivery and fallback behavior without an additional lookup. |
| `stop` | Check the original thread or quote and an explicit destination thread before sending. A withdrawn source blocks delivery, including explicit top-level and alternate destination overrides. |

The setting applies immediately to subsequent CLI sends and automatic final replies. Unthreaded broadcasts have no source topic to check. An already-delivered send that the turn ledger replays performs no new publication.

`TOPIC_SEND_BLOCKED` means the queried message is withdrawn. `TOPIC_SEND_CHECK_FAILED` means the query failed or did not prove the message is available; retry the query on the same route. Neither outcome grants permission to publish elsewhere. A provider-side withdrawal after a successful lookup also prevents the existing quote-to-chat fallback in `stop` mode.

Set the value back to `legacy`, or unset it with `/botconfig`, to restore default behavior. This option does not cancel an executing task or prove that its original content should be deleted.
