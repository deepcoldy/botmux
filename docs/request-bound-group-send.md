# Request-bound group send

Integrators that must prove "this request produced that visible message" cannot
use `/api/trigger` (no message id, no read-back) or hall announcements (may
skip). These two daemon IPC routes give an at-most-once, provable post from the
daemon's own bot.

## `POST /api/groups/:chatId/messages`

`chatId` is `oc_` plus 1–128 letters, digits, `_` or `-` (underscores and long
ids are valid). Body is exactly
`{ "requestId": "<[A-Za-z0-9_-]{8,64}>", "content": "<plain text ≤ 8192 bytes>" }`.
The JSON body itself is capped at 64KiB before it is parsed.

| Response | Meaning |
|---|---|
| `200 {ok, messageId, requestId, chatId, replayed}` | Sent, or the stored message for this `requestId` replayed. |
| `400 bad_json` | Body is not JSON. |
| `400 invalid_request` | Body or `chatId` shape. |
| `409 request_conflict` | Same `requestId`, different content. Nothing new sent. |
| `409 outcome_unknown` | A previous attempt may have sent but cannot be reconciled any more. Never re-sent; use a new `requestId` only if a duplicate is acceptable. |
| `413 body_too_large` | Body exceeded 64KiB. Nothing sent. |
| `502 send_failed` (`retryable:true`) | Ambiguous provider error (timeout, 5xx, rate limit). Retry the **same** `requestId` within 50 minutes; the Lark `uuid` is reused, so Lark returns the original message instead of a second one. |
| `502 send_failed` (`retryable:false`) | Definite rejection (not in the chat `230002`, content too long `230025`, missing scope `99991672`, and the same class as `230001` / `230011` / `230022`). Nothing was created. Retrying until the window ends only yields `outcome_unknown`. |
| `503 store_full` (`retryable:false`) | The dedupe file is full of unresolved attempts. Nothing new sent. Pending records are not deleted. |
| `503 store_unavailable` (`retryable:true`) | Dedupe store unreadable or unwritable. Retry the **same** `requestId`. Do not mint a new one: if the failure was the save *after* the provider accepted, a new id posts a second visible message. The response does not include the filesystem error. |

Dedupe: a durable per-bot record (`<dataDir>/group-sends-<appId>.json`, 0600,
fsync) is written **before** the provider call; the Lark IM `uuid` is derived
from `(appId, chatId, requestId)` and only reused inside 50 minutes (Lark's
dedupe window is ~1 hour). A record that is missing `uuid` / `firstAttemptAt`,
or whose `uuid` is not that derived value, fails closed and nothing is sent.
The file holds at most 2000 records. Oldest sent records may be dropped to
admit a new attempt; pending records are kept, and a new `requestId` is
refused once they fill the cap.

### `outbound.send`

The route always calls `sendMessage` with `suppressHook: true` and emits
`outbound.send` itself, at most once per `messageId`, only after the sent
record is durable. A crash between that write and the emit drops the hook;
a replay does not emit it again. This is at-most-once, not exactly-once.

The payload carries `messageId`, `msgType` (`text`), `uuid` (`bmxgs-…`), and
`content` (the plain POST string, not `JSON.stringify({text})`), plus
`larkAppId`, `chatId`, and `requestId`. **`larkAppId` and `chatId` are required
for hook filters.** `filterMatches` reads them; a payload that omits either one
silently matches zero hooks that filter on bot or chat. The emit is
`emitHookEventLocal` (in-process). `event` and `emittedAt` are added there.

## `GET /api/groups/:chatId/messages/:messageId`

Independent read-back via the IM message API: `{ok, messageId, chatId, deleted,
msgType, sender:{id,idType,senderType,isSelf}, createTime, text, requestId}`.
`isSelf` is true when `sender.id` is this app and `senderType` is `app` or
`bot` (Lark uses both). `requestId` is non-null only when the durable record
binds it to this message.

| Response | Meaning |
|---|---|
| `200` with `deleted:false` | Message is visible. A successful body may also carry `deleted:true`. |
| `200` with `deleted:true` and empty sender/text | `message.get` rejected with `230011` (withdrawn). The binding is still reported when the store has it. |
| `400 invalid_request` | `chatId` shape. |
| `404 not_found` | No item, or a definite miss (`230002` not in the chat / not visible, `230001`, `230022`). |
| `409 chat_mismatch` | The message belongs to another chat. |
| `502 read_failed` | Any other provider error, including rate limits. Retry the read. |

Both routes require a bound bot (same as other `/api/groups/:chatId/*` routes).
