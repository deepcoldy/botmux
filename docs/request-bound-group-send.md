# Request-bound group send

Integrators that must prove "this request produced that visible message" cannot
use `/api/trigger` (no message id, no read-back) or hall announcements (may
skip). These two daemon IPC routes give an at-most-once, provable post from the
daemon's own bot for as long as that `requestId` is still in the live file or
the bounded archive. A `requestId` evicted from the archive retries as a new send.

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
| `503 store_full` (`retryable:false`) | The live file is full of unresolved attempts, so nothing can be compacted. Neither file is written. Pending records are not deleted. |
| `503 store_unavailable` (`retryable:true`) | Dedupe store unreadable or unwritable. Retry the **same** `requestId`. Do not mint a new one: if the failure was the save *after* the provider accepted, a new id posts a second visible message. The response does not include the filesystem error. |

Dedupe: a durable per-bot record (`<dataDir>/group-sends-<appId>.json`, 0600,
fsync) is written **before** the provider call; the Lark IM `uuid` is derived
from `(appId, chatId, requestId)` and only reused inside 50 minutes (Lark's
dedupe window is ~1 hour). A record that is missing `uuid` / `firstAttemptAt`,
or whose `uuid` is not that derived value, fails closed and nothing is sent.
The live file holds at most 2000 records and is the only file rewritten on
replay or on the post-provider `sent` save. Admitting a new `requestId` past
that cap compacts the oldest sent records (`firstAttemptAt`), at least 200 at
a time, into `<dataDir>/group-sends-<appId>-archive.json`: upsert by key,
fsync the archive, and only then remove those keys from the live file. So the
archive is rewritten once per 200 new `requestId`s, not on every send once the
live file is full. The archive stores the
full record (so both `requestId` → `messageId` and `messageId` → `requestId`
still resolve) and keeps at most 20,000 records, dropping the oldest `sentAt`.
The same key in both files is a single forward answer, and the live record
wins. Reverse read-back scans every entry in both files, so an older message
id still reports its `requestId` after the live row has moved on. Pending
records are never compacted; a new `requestId` is refused once they fill the
live cap. A `requestId` evicted from the archive is outside that retention and
retries as a new send.

### `outbound.send`

The route always calls `sendMessage` with `suppressHook: true` and emits
`outbound.send` itself, at most once per `messageId`, only after the sent
record is durable. A crash between that write and the emit drops the hook.
A replay, including one served from the archive, does not emit it again.
Forward dedupe and reverse read-back both still see archived records. A
`requestId` that has been evicted from the archive is no longer deduped: that
retry is a new send and may emit once for the new message id. This is
at-most-once inside the live file and the 20,000-record archive, not
exactly-once, and not at-most-once after archive eviction.

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
`bot` (Lark uses both). `requestId` is non-null only when the live file or the
archive binds it to this message. Both files are scanned; a message id that
disagrees with the live row is still reported from the archive.

| Response | Meaning |
|---|---|
| `200` with `deleted:false` | Message is visible. A successful body may also carry `deleted:true`. |
| `200` with `deleted:true` and empty sender/text | `message.get` rejected with `230011` (withdrawn). The binding is still reported when the store has it. |
| `400 invalid_request` | `chatId` shape. |
| `404 not_found` | No item, or a definite miss (`230002` not in the chat / not visible, `230001`, `230022`). |
| `409 chat_mismatch` | The message belongs to another chat. |
| `502 read_failed` | Any other provider error, including rate limits. Retry the read. |

Both routes require a bound bot (same as other `/api/groups/:chatId/*` routes).
