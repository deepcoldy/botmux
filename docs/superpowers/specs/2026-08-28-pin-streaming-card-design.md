# Per-Bot Streaming Card Pinning With Per-Chat Opt-Out

## Context

Botmux already keeps one current public live-status card in
`DaemonSession.streamCardId`. The card contains the session controls, including
“Close session”, and is replaced as later turns create a new live card. Older
cards are tracked in `frozenCards`; cards in the same visible reply destination
are eventually recalled, while cards in other topics may remain visible.

Feishu supports pinning and unpinning a message, and the Botmux app manifest
already requests `im:message.pins:read` and
`im:message.pins:write_only`. Botmux does not currently call those APIs. Users
therefore have to search the conversation for the current card before closing a
finished session.

This feature is a quality-of-life aid. Pinning must never become part of the
correctness or availability boundary for creating, running, transferring,
resuming, or closing a session.

## Product contract

- Add a per-bot setting named `pinStreamingCard`.
- The setting defaults to `false`; only an explicit `true` enables it.
- Add a per-chat negative override named `noPinStreamingCardChats`. A chat in
  this list keeps its live card but suppresses automatic Pin. It cannot force
  Pin on while the bot-level master switch is off.
- When enabled, the desired steady state for each active session that has a real
  `streamCardId` is exactly one pinned card: that current `streamCardId`.
- A session without a real `streamCardId` is outside this feature's scope. In
  particular, repo-selection cards identified by `repoCardMessageId` are not
  changed or pinned.
- Private `/card` snapshots, repo-selection cards, adoption-blocked cards, final
  response cards, CoT messages, and other interactive cards are out of scope,
  even when they contain a close action.
- A successful close makes the desired state zero pinned streaming cards for
  that session. A refused close leaves the existing pin state alone.
- Pin and unpin operations are best-effort. Failures are logged but never change
  the result of the primary operation. During Feishu API failures the actual pin
  count may temporarily be zero or greater than one; later lifecycle events and
  hot-setting reconciliation should converge toward the desired state.

The merge request must explicitly ask maintainers whether this opt-in setting
should become default-on in a future release. This change itself keeps the
default off for compatibility and to avoid new API traffic for existing bots.

## Configuration surface

`pinStreamingCard?: boolean` is a normal per-bot card preference in `bots.json`.
It follows the repository's default-false persistence convention:

- `true` is written to disk.
- `false` removes the key.
- An absent or malformed value resolves to `false`.
- The effective value is synchronized into the in-memory `BotConfig` without a
  daemon restart.

The setting is exposed through both existing operator surfaces:

1. Dashboard: Bot Defaults → Cards, as a toggle describing that only the current
   public live-status card is pinned and failures do not interrupt sessions.
2. Chat command: `/botconfig set pinStreamingCard on|off`, with `effect: immediate`.

Both mutation paths trigger the same best-effort reconciliation after the
configuration write succeeds, but only when the effective `pinStreamingCard`
boolean actually changes:

- Off → on: pin each existing real `streamCardId` owned by that bot, then unpin
  its known frozen streaming cards only if pinning the current card succeeds.
- On → off: treat that explicit transition as authority to unpin each known
  current and frozen streaming-card ID captured from the live session snapshot,
  even if a daemon restart or test reset already discarded process-local Pin
  provenance.
- False → false and true → true writes are no-op updates for this feature: they
  persist/synchronize normally but do not trigger reconciliation.

The configuration write succeeds even if any reconciliation request fails.

`noPinStreamingCardChats?: string[]` stores chat IDs whose operators disabled
automatic Pin with `/card pin off`. `/card pin on` removes the current chat
from the list, and an empty result removes the top-level key. `/card pin status`
reports the effective state. These commands reuse `/card`'s existing
`canOperate` gate and work without a live session. They never change
`noCardChats`, so the live card remains visible. The effective policy is:

```ts
bot.config.pinStreamingCard === true
  && !bot.config.noPinStreamingCardChats?.includes(chatId)
```

A per-chat effective on → off transition immediately starts best-effort cleanup
for known current/frozen streaming-card IDs in that chat. Off → on immediately
reconciles active sessions in the chat when the bot-level master switch is on.
Bot-level and per-chat writes share one per-bot serializer and one ordered
reconciliation queue, so rapid mixed writes converge in mutation order.

## Components and interfaces

### Lark transport

`src/im/lark/client.ts` adds two narrow wrappers beside the existing message
update/delete helpers:

```ts
pinMessage(larkAppId: string, messageId: string): Promise<boolean>
unpinMessage(larkAppId: string, messageId: string): Promise<boolean>
```

They call the SDK's singular `client.im.v1.pin` resource:

```ts
client.im.v1.pin.create({ data: { message_id: messageId } })
client.im.v1.pin.delete({ path: { message_id: messageId } })
```

Both wrappers enforce the normal Lark transport boundary, explicitly inspect a
resolved response's `code`, and return `true` only for a successful operation.
SDK throws, transport failures, and non-zero response codes return `false` after
sanitized logging. Unpin is treated as idempotent: Feishu success for an already
unpinned or recalled message is still success. Generic `sendMessage` and
`replyMessage` remain unchanged so unrelated cards cannot be pinned by accident.

### Streaming-card pin policy

`src/core/worker-pool.ts` owns the policy because it already owns
`streamCardId`, `frozenCards`, publication fencing, replacement, transfer, and
close. It exposes focused helpers for the one exceptional resume-card path in
`card-handler.ts` and for configuration reconciliation:

```ts
pinStreamingCardIfEnabled(
  ds: DaemonSession,
  messageId: string,
): Promise<boolean>

reconcileStreamingCardPins(
  ds: DaemonSession,
  enabled: boolean,
): Promise<void>

reconcileBotStreamingCardPins(larkAppId: string, enabled: boolean): void
reconcileChatStreamingCardPins(
  larkAppId: string,
  chatId: string,
  enabled: boolean,
): void
```

`pinStreamingCardIfEnabled` is a no-op that returns `false` when the setting is
off, the ID is empty or is `CARD_POSTING_SENTINEL`, the session is no longer
active, or the captured ID is no longer the session's current `streamCardId`. It
also verifies that the same `DaemonSession` still owns its current registry key.
After a successful Pin API response it repeats those checks. If the preference
was disabled or ownership changed while the request was in flight, it
best-effort Unpins the captured ID as compensation and returns `false`. It never
throws.

`reconcileStreamingCardPins` operates only on a captured real current ID and the
message IDs already present in `frozenCards`. When enabling, it pins the current
ID first and unpins frozen IDs only after that pin succeeds. Ordinary
per-session disable reconciliation remains ownership-based: without an explicit
bot-wide off transition it only unpins IDs recorded in process-local provenance,
so a default-off bot that never enabled stays zero-call and cannot disturb
manual Pins. The explicit bot-wide on → off transition passes a narrower
cleanup-known-ids mode into per-session reconciliation; that mode may unpin the
captured current and frozen IDs without first pinning anything. Frozen-card
unpin selection is session-wide, not filtered by `replyTargetKey`, because Pins
are chat-wide and the invariant is per session. Existing frozen-card recall
remains destination-sensitive and otherwise unchanged.
Close and transfer cleanup continue to use only recorded ownership once the
setting is already off. They may therefore miss a stale pre-restart Pin under
this design's approved no-journal/no-audit caveat; only the explicit on → off
toggle is authoritative for cleaning known current/frozen IDs after provenance
loss.

`reconcileBotStreamingCardPins` snapshots active sessions for the target bot;
`reconcileChatStreamingCardPins` limits that snapshot to the target chat. Both
enqueue ordered reconciliation work with per-session error isolation and a
maximum of 20 concurrent sessions per batch. They are deliberately
fire-and-forget from configuration handlers so Feishu latency cannot delay a
Dashboard, `/botconfig`, or `/card pin` response. Each queued change carries
whether it represents an authoritative effective on → off transition, because
only such a transition may clean known IDs after process-local provenance loss.

The config stores notify a small registered callback only after the local disk
and in-memory update succeeds and only when the effective boolean actually
changes. Registering the callback from daemon startup avoids a
services-to-worker-pool import cycle and makes both Dashboard card-preference
writes and generic `/botconfig` writes share the same hot-toggle behavior
without granting cleanup authority to redundant false writes.

## Lifecycle and ordering

### Publishing or restoring a current card

Every code path that commits a real message ID as `streamCardId` participates:

- immediate turn-start publication (`postTurnStartingCard`);
- explicit public `/card` refresh (`postFreshStreamingCard`);
- worker-ready publication;
- screen-update fallback publication;
- card-button resume repost;
- worker-ready reuse of a persisted card after daemon recovery.

`postTurnStartingCard` already has the full fence described below. The other
publication paths do not all have equivalent fencing today; this feature must
add the missing checks before it can expose their completions to Pin side
effects. This is a targeted correctness prerequisite, not a general card
lifecycle refactor.

For a newly posted card, the ordering is:

1. Post the card through the existing reply path.
2. Re-run the existing ownership, generation, transfer, retirement, and active
   session fences. A stale/orphan result is deleted without any Pin call.
3. Commit and persist the returned message ID as the current `streamCardId`.
4. Start the best-effort Pin(new) → Unpin(known predecessors) chain without
   awaiting it from the publication path.
5. Continue the existing destination-sensitive `recallFrozenCards` and other
   publication effects immediately. Feishu automatically removes the Pin when
   a recalled message is deleted, so this ordering cannot leave a permanent Pin
   solely because recall completed before the detached Pin chain.

All asynchronous completions use captured message IDs and must not reread a
mutable `streamCardId` before performing an Unpin. This prevents an older turn's
completion from unpinning a newer card.

When worker recovery reuses and patches an existing persisted `streamCardId`, it
runs idempotent reconciliation after the patch/reuse ownership checks. This
self-heals a missed Pin after a daemon restart without posting another card or
making recovery noisy in the conversation.

### Replacement and old-card cleanup

`parkStreamCard` continues to copy the old current card into durable
`frozenCards`; it does not perform network I/O. The new current card is always
posted and committed before any old-card Pin is removed.

Cross-topic behavior is intentionally split:

- All known frozen streaming cards are candidates for Unpin, because Feishu Pins
  belong to the containing chat rather than a native thread.
- Only frozen cards selected by the existing `replyTargetKey` rules are recalled.
  Other-topic history remains visible exactly as it does today, but is no longer
  pinned once a successor Pin succeeds.

If Pinning the successor fails, old-card Unpin is skipped. Existing recall still
runs, so same-destination cards may disappear as they do today. Cross-topic old
cards retain their prior Pin until a later reconciliation succeeds.

### Close

`closeSession` snapshots the current real `streamCardId` and all known frozen
streaming-card IDs before the durable close deletes the frozen-card sidecar.
Only after the logical close commits successfully does it launch best-effort
Unpin calls for those captured IDs. The calls are not awaited by the card action
ACK or other close consumers.

- `closed` and `closed_with_residual` both clear Pins because the local session is
  no longer active.
- A teardown refusal or durable-close failure does not clear Pins because the
  session remains active.
- An idempotent re-close may retry Unpin for any IDs still available on the
  stored row, but no durable cleanup journal is added in this feature.

The existing behavior of patching a clicked live card into a closed card or
sending a separate closed card is unchanged. The closed card itself is never
pinned.

### Resume and transfer

Card-button resume captures the resumed session identity, posts a replacement,
and rechecks active status, route ownership, and current card identity before
committing the replacement `streamCardId`. A stale result is deleted and never
pinned. A valid result is persisted, pinned, and only then followed by the
existing best-effort withdrawal of the clicked closed card. CLI/Dashboard resume
relies on the normal worker-ready reuse or publication path.

Transfer snapshots the source `streamCardId`, commits the new route using the
existing fencing, clears source-bound card identity as it does today, and then
best-effort Unpins recorded owned IDs for the source route. A fresh target
`streamCardId` is pinned through the normal publication path. Pin failure does
not change transfer success. If the daemon already lost provenance and the
setting was already off before transfer began, this path may miss a stale old
Pin; the design intentionally accepts that gap instead of adding a durable
journal or chat-wide audit.

## Failure and race semantics

- Pin API failure: keep the newly posted card as the authoritative
  `streamCardId`; do not roll back, repost, or fail the turn.
- Unpin API failure: keep the primary lifecycle result; log enough app/session/ID
  context to diagnose it without exposing credentials.
- Close during card POST: the existing ownership fence rejects the returned
  orphan, deletes it best-effort, and never Pins it.
- Consecutive turns: only a card that still passes the current-ID and session
  ownership checks before and after the API request may remain pinned; a stale
  success is compensated with an Unpin. Cleanup always uses captured predecessor
  IDs.
- Missing permission, admin-only Pin policy, unsupported message types, withdrawn
  messages, rate limits, and transport errors are all non-fatal.
- `apiOnly` and other transport-disabled sessions make no Pin calls.

The minimum-change design intentionally does not add a durable Pin-operation
journal or scan the chat's full Pin list. Consequently, a process crash between
a successful Feishu mutation and its next local lifecycle step, or a combined
Unpin-and-recall failure after the only local predecessor record is removed, can
leave a stale Pin that this version cannot discover. An explicit on → off toggle
can still clean known current/frozen IDs from the live session snapshot after
process-local provenance loss, but if the setting is already off and ownership
has already been forgotten, later close/transfer cleanup may still miss that
stale Pin. This is acceptable for the approved QoL/fail-open scope and must be
called out in the merge request.

## Post-review per-chat unit

The per-chat override is one additional independently reviewable unit after the
core feature and maintainer hardening commits:

- Configuration and command: normalize/persist `noPinStreamingCardChats`, add a
  focused store, and expose `/card pin off|on|status`.
- Policy and hot reconciliation: make every Pin eligibility check chat-aware and
  serialize bot-wide and chat-wide policy changes through the same per-bot queue.
- Documentation and tests: cover effective precedence, immediate cleanup/re-Pin,
  cross-chat isolation, rapid mixed writes, and the fail-open response boundary.

Dashboard support was evaluated separately. It is a medium-complexity full-stack
addition spanning Group Manage UI types/state, public Dashboard routes, daemon
IPC, aggregation, localization, and UI/API tests. The chat command provides a
complete operator escape hatch in this PR; the Dashboard surface is intentionally
deferred to a follow-up PR so this already-reviewed lifecycle change does not
expand into a second UI/API feature.

## Development units

### Unit 1: Configuration contract and operator surfaces

Add `pinStreamingCard` to `BotConfig`, card-preference persistence, bot config
normalization, `/botconfig`, Dashboard IPC/payload/types/UI, and bilingual Dashboard
copy. Verify default-off behavior, true/false round trips, malformed input,
partial-patch preservation, optimistic UI rollback, and immediate in-memory
visibility. Commit this unit independently.

### Unit 2: Lark Pin transport

Add and unit-test `pinMessage` and `unpinMessage`, including exact SDK payloads,
successful and non-zero responses, thrown transport errors, idempotent Unpin, and
the `apiOnly` boundary. This unit shares only the two function signatures above
and can be developed in parallel with Unit 1. Commit it independently.

### Unit 3: Streaming-card lifecycle integration

Add the worker-pool policy helpers and wire every real `streamCardId` publication,
reuse, resume, transfer, and close path. Verify ordering, stale POST suppression,
default-off behavior, Pin failure isolation, successful/residual/refused close,
and cross-topic Unpin versus recall behavior. Commit it independently after
Units 1 and 2 are available.

### Unit 4: Hot-toggle reconciliation and documentation

Register the preference-change callback, reconcile existing active sessions when
the setting changes, document the setting and failure semantics, and add the MR
discussion prompt about a possible future default-on policy. Verify both
Dashboard and `/botconfig` mutation paths. Commit it independently.

## Dependency graph

```text
Unit 1: config contract ───────┐
                              ├─[true blocking]─> Unit 3: lifecycle integration
Unit 2: Lark transport ────────┘

Unit 1: config contract ───────┐
Unit 2: Lark transport ────────┼─[true blocking]─> Unit 4: hot-toggle + docs
Unit 3: lifecycle integration ─┘
```

Units 1 and 2 are independent. The Dashboard UI and `/botconfig` entry share the
same frozen field contract rather than a runtime dependency. Unit 3 depends on
both the resolved setting and the Pin transport. Unit 4 depends on all prior
interfaces because it reconciles already-active sessions.

## Verification and acceptance

Automated verification must include:

- focused config store, Dashboard IPC/payload/UI, and `/botconfig` tests;
- focused Lark Pin wrapper tests;
- streaming-card publication/reuse/replacement tests that assert Pin-before-
  Unpin ordering and no Pin for stale POSTs;
- close tests for success, local residual, refusal, and workerless stored rows;
- resume and transfer tests;
- cross-topic tests proving old cards remain visible while their Pins are
  removed;
- tests proving Pin/Unpin errors do not alter the primary return value or card
  identity;
- per-chat tests proving a chat opt-out leaves its live card intact, cleans only
  that chat's known Pins, and does not affect another chat;
- mixed bot/chat hot-toggle tests proving the ordered queue converges to the
  latest effective policy;
- the full unit suite and `bun run build`.

Live acceptance on a test bot with the setting enabled covers:

1. An existing active session gains a Pin when the setting is turned on.
2. A new turn moves the Pin to the new `streamCardId`; only one current session
   card remains in the chat's Pin area.
3. Closing the session removes its Pin while still completing the close.
4. Turning the setting off removes Pins from existing active sessions.
5. A bot with the setting absent continues today's behavior with no Pin API
   traffic.
6. `/card pin off` removes Pins for the current chat without removing its live
   cards; `/card pin on` restores automatic Pin only when the bot master is on.

The implementation is complete only after each unit has its own verified commit,
the integration branch passes the full checks, and every commit is pushed.

## Out of scope

- Pinning `repoCardMessageId` or adding Close to the repo picker.
- Pinning arbitrary cards based on their JSON contents or presence of a close
  button.
- Pinning private/ephemeral cards, final answers, CoT messages, or closed cards.
- A global default shared by all bots.
- A Dashboard editor for the per-chat override; this is a follow-up after the
  command/API contract stabilizes.
- A durable retry journal, periodic retry worker, or full-chat Pin-list audit.
- Changing the existing destination-sensitive card recall policy.
- Requiring Pin permissions at daemon startup or failing a session when the
  permission is missing.
