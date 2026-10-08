# Durable coordination provider runtime

## Goal

BotMux needs to consume a durable coordination implementation without linking a database client or deployment-specific credentials into the public binary. The runtime therefore starts one operator-selected JSONL provider process and exposes it through the existing `DurableCoordinationStore` interface.

The process is a trusted runtime extension, not a plugin for model code. BotMux launches it directly without a shell, never copies provider stderr into protocol errors, and validates every response before it reaches daemon state.

## Protocol

Every line is one JSON request or response with:

- protocol `botmux.durable-coordination-provider`;
- wire version `1`;
- a stable `requestId`;
- an initial `hello` that proves durable contract version `1`;
- a `call` for one public store method.

The provider may respond out of order. BotMux correlates by `requestId`, bounds line size and request time, rejects unknown request ids, and terminates the provider after a timeout or malformed response. Provider failures carry a bounded public code, a redacted message, and explicit retryability; retryability never changes outbox ambiguity rules.

## Configuration

The default remains disabled. The public runtime reads only provider-neutral settings:

| Variable | Meaning |
| --- | --- |
| `BOTMUX_COORDINATION_MODE` | `disabled`, `shadow`, or `primary` |
| `BOTMUX_COORDINATION_PROVIDER_BIN` | Absolute executable path; required outside `disabled` |
| `BOTMUX_COORDINATION_PROVIDER_ARGS_JSON` | Optional JSON string array; no shell parsing |
| `BOTMUX_COORDINATION_PROVIDER_HANDSHAKE_TIMEOUT_MS` | Optional bounded hello timeout |
| `BOTMUX_COORDINATION_PROVIDER_REQUEST_TIMEOUT_MS` | Optional bounded call timeout |

The provider inherits the daemon environment because it is selected by the operator and may need file-based credential references. Provider code must keep secrets out of stdout, stderr, argv, receipts, and durable JSON values.

## CLI state and deployment responsibility

Durable coordination covers BotMux routing, canonical Session snapshots, inbox ownership and single-message outbox settlement. It does not replicate a CLI provider's transcript, auto-memory, working tree, role/knowledge files or other filesystem state. Enabling `primary` therefore does not by itself make an active model turn or provider-native resume portable across replicas.

The first primary release requires one of two deployment policies: keep a live CLI runtime sticky to the replica that owns its provider state, or use an operator-supplied remote runner/filesystem layer that makes the provider state visible after takeover. When a provider buckets resume or memory state by an absolute working-directory path, every eligible replica must expose the same logical state at the same path. `BOTMUX_REMOTE_RUNNER_STATE_ROOT` is only an opaque value forwarded to the selected runner; BotMux neither mounts nor interprets it.

Coordination between different Sessions that write a shared memory or knowledge directory is also outside the Session lease. The deployment's runner/filesystem layer must provide the required isolation, locking or merge policy. Until that layer proves otherwise, replica takeover guarantees routing and delivery recovery only; it must not be described as lossless active-turn or CLI-context failover.

## Rollout boundary

`shadow` starts the provider, verifies the exact public contract, and keeps the process alive through daemon shutdown. After the Lark SDK callback has returned to the ACK path, `im.message.receive_v1` is also mirrored into the durable inbox with a stable message-derived `eventId` and the existing raw chat ingress lane as `partitionKey`.

The mirror runs beside the current SQLite route. A slow or failed provider is logged but does not block that route; a duplicate is accepted, while a conflicting duplicate is surfaced as an error. A boot-unique shadow consumer claims mirrored rows, revalidates the Lark app/message identity and routing partition, and marks valid rows completed. It performs no user-visible routing or output and does not change Session ownership. Invalid envelopes are retried with a bounded delay so schema drift remains visible instead of being acknowledged. Provider failures leave claims recoverable after their lease, and daemon shutdown stops the consumer before closing the provider. Message edits, polling backfill and non-message event families remain outside this ingestion slice.

The shadow runtime also owns a provider-neutral `DurableSessionFacade`. It creates a boot-unique owner, serializes updates per stable session key, coalesces queued snapshots to the newest value, and performs `acquire lease → read revision → CAS write`. Occupied, conflicting and stale writes remain distinct observable outcomes. Different session keys are independent, while graceful shutdown stops admission, bounds the drain and releases retained leases before provider close.

The same facade now exposes a separate exact-write lane for primary admission. Exact writes share the per-Session FIFO but are never coalesced, always perform an independent CAS (including identical retries), and return the actual lease plus record used for the mutation. A current-aware variant builds its value only after the lane has acquired the lease and read the current revision, closing a read-merge-write gap for additive admission state. This prevents two inbox events from sharing one later revision while preserving the existing coalescing behavior for shadow snapshots.

A full primary Session projection wraps the existing persisted `Session` JSON together with a bounded oldest-to-newest history of exact inbox admission identities. The latest single `admission` field remains for version-1 reader compatibility, while the `admissions` list retains at most 64 distinct turns so type-ahead turn N+1 cannot erase turn N's output authority. It contains no runtime-only process object or worker token beyond the existing Session row contract. A primary admission merges this history inside the exact lane and mints the committed receipt only from the returned lease epoch and record revision. Restore parsing recomputes the routing key and rejects mismatched Session/app/event/partition identities. The primary daemon path uses this projection for every admitted message and supported output.

A canonical-dispatch bridge defines the callback seam used by the primary consumer. The canonical handler must explicitly return either an admitted Session snapshot or an ignored reason. Only an exact full-Session CAS can turn the admitted result into committed; aborts, unknown/queued results and Session coordination failures remain retryable errors. The primary daemon path constructs this provider-neutral bridge around the existing router.

Only a narrow versioned projection is eligible for this stage: session id, application id, routing anchor, scope, active/closed status and lifecycle timestamps. Prompt content, titles, identities, paths, attachments, tokens and provider/terminal state are excluded. The daemon invokes this mirror only after an ordinary Lark session has committed to SQLite and won active-session registration. It is therefore shadow evidence, not a complete Session source: restore, close, multi-row transactions, lineage batches and the synchronous Session API remain SQLite-only.

A provider-neutral primary inbox consumer now defines the later claim-to-admission state machine without enabling it. Multiple boot-scoped slots can process independent partitions. Each claim is revalidated before dispatch, renewed while dispatch is active, and completed only after a validated `committed` or explicitly `ignored` receipt. A committed result must carry a versioned durable-admission receipt that binds the claimed event/app/partition to the fenced Session key, lease epoch, record revision and store timestamp. A bare committed marker or a receipt copied from another event is retried instead of completing the inbox row. Dispatch errors retry only while ownership is still proven. A stale/failed renewal aborts the callback and leaves the row for lease-expiry recovery; bounded shutdown likewise never fabricates a completion.

Shadow mode keeps its ACK-after-live-route mirror unchanged. Primary instead constructs the consumer, replaces the live callback with enqueue-before-ACK and completes the claim only after the canonical Session receipt validates. Store-generated inbox sequence and application ingress leadership provide the cross-replica ordering authority.

A provider-neutral durable outbox pump is also present without daemon wiring. It reserves independent Session heads concurrently, commits `attempting` before invoking transport, and accepts only delivered, explicitly safe retry, or ambiguous outcomes. Exceptions, timeouts and malformed retry proofs become ambiguous. Timed-out callbacks may report a late result for reconciliation, but the automatic pump never turns that observation into a delivered receipt.

A settlement bridge follows the authoritative outbox row after fenced enqueue until `delivered` or `ambiguous`. It deliberately polls the shared store instead of trusting a process-local pump callback, so delivery completed by a takeover replica still releases the originating final-output drain. Aborting a local wait never mutates the durable row. Primary ordinary and in-session CLI output both use this bridge.

A Session-output bridge exact-writes the latest full Session snapshot, then enqueues the frozen outbox message with that same fresh lease proof and returns the authoritative settlement. It validates the output Session key before either mutation and never falls back to direct transport on coordination failure.

A final-output bridge synchronously joins the existing daemon final-drain before starting those asynchronous mutations and releases it only after terminal shared-store settlement or a proven pre-enqueue/local-wait failure. Ordinary worker output uses it only in primary; disabled and shadow modes retain direct delivery.

The Lark adapter now defines a frozen, versioned single-message envelope without wiring it into the daemon. It binds the app, send chat or reply parent, reply mode, message type/content, stable provider UUID and JSON hook context. It reuses the existing send/reply clients, Feishu error classifier and one-hour provider TTL. Retry is allowed only for classified retryable failures while the UUID window still has a safety margin; otherwise the result is ambiguous.

Session/epoch authority is revalidated immediately before provider invocation. Protected hook capability is never persisted: the current owner must dynamically provide `beforeHook` and `hookOrigin` for the first attempt. UUID reconciliation suppresses later hooks. A withdrawn reply remains ambiguous instead of silently falling back to top-level send under the same UUID, because provider dedupe does not bind the reply parent. Attachments, multi-message sequences, card patches and non-IM effects remain outside this envelope.

The daemon constructs the adapter only inside primary. Unsupported multi-effect shapes are rejected or suppressed as documented below and never fall back to this adapter's direct transport dependencies.

A provider-neutral primary Lark ingress component now owns the disabled-state admission boundary. It reuses the fenced lease primitive under an application-scoped reserved key, exposes leadership callbacks as the only future WS start/stop boundary, and awaits durable inbox insertion before the SDK callback may ACK. An occupied lease remains standby. A stale renewal, provider failure, conflicting duplicate, or enqueue failure drops local leadership and aborts the lifecycle signal.

Inbox ordering no longer treats caller `createdAt` as cross-leader authority. The store must allocate an insertion sequence transactionally and use it for every per-partition earlier fence. The SQLite reference uses an autoincrement side table with deterministic legacy backfill; remote providers must use a database sequence/identity or equivalent serialization point.

Admission is serialized per raw routing partition at API entry. An ACK timeout rejects the callback but leaves the real enqueue in the partition tail, so redelivery cannot let N+1 overtake N and a later successful first write becomes a duplicate. Graceful stop drains admitted writes and leadership cleanup before lease release, all under one shutdown deadline. Client timestamps only order one process lifetime; the component does not claim a strict total order across leader epochs without a store-generated sequence.

This ingress component is constructed only in `primary` and does not alter disabled or shadow routes.

`DurableLarkPrimaryRuntime` composes the ingress leader, primary inbox consumer, canonical Session admission bridge, durable outbox pump and Session facade around one store. Consumer and pump start before ingress leadership may start WS. Graceful stop uses one absolute budget and orders `ingress/WS cleanup → inbox drain → outbox drain → Session lease release`; fatal termination aborts every component. The runtime factory still requires an explicit in-process proof, and the daemon grants it only at the call site that assembles this complete path.

The daemon builds one reusable Lark event runtime after Session restore, lets only the ingress lease leader connect WS, and makes the WS message callbacks await durable inbox enqueue instead of invoking the legacy route. Both ordinary `im.message.receive_v1` and the first-mention behavior of `im.message.updated_v1` use the same fenced ingress and canonical admission path in primary. Claimed rows re-enter the same routing/permission/canonical handlers without a WS connection and resolve the exact admitted Session snapshot. Leadership loss closes the client before lease release.

Ordinary bridge `final_output` freezes the existing reply target/card/provider UUID, resolves the requesting turn's own bounded admission, exact-writes the current Session snapshot while retaining other in-flight turn admissions, enqueues outbox under that epoch, waits for shared-store settlement, then continues the existing delivery bookkeeping with the provider message id. The per-turn check prevents an ultra-fast final from reusing another input's Session admission without rejecting an earlier type-ahead turn. Legacy/shadow keep the existing direct transport byte-for-byte.

In-session `botmux send` routes its already-rendered single message to the owning daemon over the existing authenticated Session IPC. The daemon revalidates the current admission turn, exact-writes the Session, enqueues the message under the fresh lease epoch and returns only an authoritative delivered provider id. Final sends derive their provider UUID from the logical app/scope/anchor/turn identity rather than the replica-local Session UUID, so a rebuilt local Session conflicts with or reconciles the same outbox row instead of sending a second final. The CLI retries a lost daemon response and bounded startup 5xx responses with the exact same turn, payload and UUID; this closes the process-crash window between the Session transaction and outbox enqueue without pretending the two transactions are atomic. Durable ambiguity, payload conflict and permanent responses remain fail-closed. Progress and auxiliary sends receive a per-command UUID that remains stable for every outbox retry. A lost/stale Session owner therefore cannot bypass fencing through the short-lived CLI.

The first primary release deliberately narrows unsupported multi-effect shapes instead of pretending they are atomic:

1. voice, attachments, urgency, attention and managed-listener output are rejected before any upload/provider effect;
2. dynamic reply-card PATCH is disabled, so a supported send creates one fenced outbox message;
3. sessionless commands and pre-session grant/hall replies are suppressed without side effects and completed as explicitly ignored;
4. delayed forward-followup admission remains disabled: primary requires zero wait, dispatches zero-wait seeds immediately and refuses pending legacy seeds at boot.

These limitations are observable feature gates, never fallback routes. Tests also cover type-ahead output, zero-wait topic seeds and durable message-edit admission. A two-runtime SQLite integration test admits and delivers 100 independent Sessions across ingress-leader shutdown and takeover, while the provider contract suite continues to verify stale lease, claim and outbox fencing independently.

## Shutdown

Graceful daemon shutdown requests provider `close` and bounds the response. Fatal process exit terminates the child synchronously. A provider close failure is logged without provider stderr, the child is terminated, and the daemon continues its existing bounded shutdown.

## Verification

Tests cover handshake compatibility, round-trip calls, redacted retryable errors, malformed results, timeouts, disabled defaults, primary fail-closed behavior, shadow claim/validation/retry, lifecycle cleanup, and recovery after a transient bootstrap poll failure. Session facade tests additionally cover shadow coalescing, exact FIFO writes, cross-key independence, revision CAS, lease proof, occupied/conflict/stale outcomes and bounded stop/release. Primary Session tests cover full snapshot round-trip, routing identity validation, concurrent event revisions, exact retry revisions and receipt payload separation. Primary consumer tests cover committed/ignored receipts, rejection of bare or mismatched committed receipts, invalid envelopes, dispatch retry, claim renewal/loss, abort behavior and bounded shutdown. Admission-receipt tests cover lease/record construction, serialized identity validation and invalid Session proofs. Outbox pump tests cover begin-before-side-effect ordering, delivered receipts, safe retry proofs, ambiguous defaults, timeout/late result fencing, stale reservations and shutdown. Lark adapter tests cover frozen identity, UUID TTL retry, hook fencing/suppression, withdrawn-parent containment, authority aborts and corrupt envelopes. Primary ingress tests cover application lease leadership, occupied standby, configured renewal cadence, identity validation, inserted/duplicate/conflict outcomes, per-partition FIFO, ACK timeout tails, lease loss, activation cleanup, and a single bounded drain/cleanup/release deadline. Primary runtime tests cover component startup, leadership lifecycle ordering, shared shutdown budget and invalid-stop containment. CLI/daemon IPC tests prove primary sends avoid direct Lark delivery and reply-card PATCH, reject unsupported multi-effect shapes before provider calls, and return only authoritative outbox settlement. A two-runtime integration test covers 100 Session admissions, ingress failover, stale-owner output rejection and exactly one delivered outbox row per Session. The existing durable contract suite continues to cover state-machine semantics independently of transport.
