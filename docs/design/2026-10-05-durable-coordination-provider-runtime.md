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

## Rollout boundary

`shadow` starts the provider, verifies the exact public contract, and keeps the process alive through daemon shutdown. After the Lark SDK callback has returned to the ACK path, `im.message.receive_v1` is also mirrored into the durable inbox with a stable message-derived `eventId` and the existing raw chat ingress lane as `partitionKey`.

The mirror runs beside the current SQLite route. A slow or failed provider is logged but does not block that route; a duplicate is accepted, while a conflicting duplicate is surfaced as an error. A boot-unique shadow consumer claims mirrored rows, revalidates the Lark app/message identity and routing partition, and marks valid rows completed. It performs no user-visible routing or output and does not change Session ownership. Invalid envelopes are retried with a bounded delay so schema drift remains visible instead of being acknowledged. Provider failures leave claims recoverable after their lease, and daemon shutdown stops the consumer before closing the provider. Message edits, polling backfill and non-message event families remain outside this ingestion slice.

The shadow runtime also owns a provider-neutral `DurableSessionFacade`. It creates a boot-unique owner, serializes updates per stable session key, coalesces queued snapshots to the newest value, and performs `acquire lease → read revision → CAS write`. Occupied, conflicting and stale writes remain distinct observable outcomes. Different session keys are independent, while graceful shutdown stops admission, bounds the drain and releases retained leases before provider close.

The same facade now exposes a separate exact-write lane for primary admission. Exact writes share the per-Session FIFO but are never coalesced, always perform an independent CAS (including identical retries), and return the actual lease plus record used for the mutation. This prevents two inbox events from sharing one later revision while preserving the existing coalescing behavior for shadow snapshots.

A full primary Session projection wraps the existing persisted `Session` JSON together with the exact inbox admission identity. It contains no runtime-only process object or worker token beyond the existing Session row contract. A primary admission commits this projection through the exact lane and mints the committed receipt only from the returned lease epoch and record revision. Restore parsing recomputes the routing key and rejects mismatched Session/app/event/partition identities. This service is still not wired into the daemon.

A canonical-dispatch bridge now defines the callback seam used by the primary consumer. The canonical handler must explicitly return either an admitted Session snapshot or an ignored reason. Only an exact full-Session CAS can turn the admitted result into committed; aborts, unknown/queued results and Session coordination failures remain retryable errors. The bridge is provider-neutral and still is not constructed by the daemon.

Only a narrow versioned projection is eligible for this stage: session id, application id, routing anchor, scope, active/closed status and lifecycle timestamps. Prompt content, titles, identities, paths, attachments, tokens and provider/terminal state are excluded. The daemon invokes this mirror only after an ordinary Lark session has committed to SQLite and won active-session registration. It is therefore shadow evidence, not a complete Session source: restore, close, multi-row transactions, lineage batches and the synchronous Session API remain SQLite-only.

A provider-neutral primary inbox consumer now defines the later claim-to-admission state machine without enabling it. Multiple boot-scoped slots can process independent partitions. Each claim is revalidated before dispatch, renewed while dispatch is active, and completed only after a validated `committed` or explicitly `ignored` receipt. A committed result must carry a versioned durable-admission receipt that binds the claimed event/app/partition to the fenced Session key, lease epoch, record revision and store timestamp. A bare committed marker or a receipt copied from another event is retried instead of completing the inbox row. Dispatch errors retry only while ownership is still proven. A stale/failed renewal aborts the callback and leaves the row for lease-expiry recovery; bounded shutdown likewise never fabricates a completion.

The consumer is intentionally not constructed by the daemon. The live Lark path still acknowledges before the shadow enqueue, and the current message router releases its raw lane before the canonical handler proves durable admission. Multi-replica ingress ordering also lacks a single-owner or upstream-sequence proof. These are primary correctness blockers, not rollout toggles.

A provider-neutral durable outbox pump is also present without daemon wiring. It reserves independent Session heads concurrently, commits `attempting` before invoking transport, and accepts only delivered, explicitly safe retry, or ambiguous outcomes. Exceptions, timeouts and malformed retry proofs become ambiguous. Timed-out callbacks may report a late result for reconciliation, but the automatic pump never turns that observation into a delivered receipt.

A settlement bridge follows the authoritative outbox row after fenced enqueue until `delivered` or `ambiguous`. It deliberately polls the shared store instead of trusting a process-local pump callback, so delivery completed by a takeover replica still releases the originating final-output drain. Aborting a local wait never mutates the durable row. The bridge is not wired into the daemon yet.

A Session-output bridge now exact-writes the latest full Session snapshot, then enqueues the frozen outbox message with that same fresh lease proof and returns the authoritative settlement. It validates the output Session key before either mutation and never falls back to direct transport on coordination failure. Daemon/final-drain wiring remains disabled.

The Lark adapter now defines a frozen, versioned single-message envelope without wiring it into the daemon. It binds the app, send chat or reply parent, reply mode, message type/content, stable provider UUID and JSON hook context. It reuses the existing send/reply clients, Feishu error classifier and one-hour provider TTL. Retry is allowed only for classified retryable failures while the UUID window still has a safety margin; otherwise the result is ambiguous.

Session/epoch authority is revalidated immediately before provider invocation. Protected hook capability is never persisted: the current owner must dynamically provide `beforeHook` and `hookOrigin` for the first attempt. UUID reconciliation suppresses later hooks. A withdrawn reply remains ambiguous instead of silently falling back to top-level send under the same UUID, because provider dedupe does not bind the reply parent. Attachments, multi-message sequences, card patches and non-IM effects remain outside this envelope.

The adapter still is not constructed by the daemon. Until ingress admission, complete Session coverage and this envelope are integrated with the pump and existing final-delivery drain, the runtime remains shadow-only.

A provider-neutral primary Lark ingress component now owns the disabled-state admission boundary. It reuses the fenced lease primitive under an application-scoped reserved key, exposes leadership callbacks as the only future WS start/stop boundary, and awaits durable inbox insertion before the SDK callback may ACK. An occupied lease remains standby. A stale renewal, provider failure, conflicting duplicate, or enqueue failure drops local leadership and aborts the lifecycle signal.

Admission is serialized per raw routing partition at API entry. An ACK timeout rejects the callback but leaves the real enqueue in the partition tail, so redelivery cannot let N+1 overtake N and a later successful first write becomes a duplicate. Graceful stop drains admitted writes and leadership cleanup before lease release, all under one shutdown deadline. Client timestamps only order one process lifetime; the component does not claim a strict total order across leader epochs without a store-generated sequence.

This ingress component is not constructed by the daemon and does not alter the live Lark route. `primary` therefore remains fail-closed.

`primary` fails closed until all three runtime stages are present:

1. daemon wiring that starts the sole Lark WS client from the ingress leadership callbacks and replaces, rather than mirrors, the local message route with enqueue-before-ACK admission;
2. complete asynchronous fenced Session ownership and mutation coverage (the current narrow shadow projection is insufficient);
3. full daemon wiring from Session output to the durable Lark envelope/pump and existing final-delivery drain (the adapter remains disabled here).

This prevents a deployment from enabling multiple independent SQLite writers by setting one premature flag. A later change must remove the `primary` gate only together with the complete data path and its failure tests.

## Shutdown

Graceful daemon shutdown requests provider `close` and bounds the response. Fatal process exit terminates the child synchronously. A provider close failure is logged without provider stderr, the child is terminated, and the daemon continues its existing bounded shutdown.

## Verification

Tests cover handshake compatibility, round-trip calls, redacted retryable errors, malformed results, timeouts, disabled defaults, primary fail-closed behavior, shadow claim/validation/retry, lifecycle cleanup, and recovery after a transient bootstrap poll failure. Session facade tests additionally cover shadow coalescing, exact FIFO writes, cross-key independence, revision CAS, lease proof, occupied/conflict/stale outcomes and bounded stop/release. Primary Session tests cover full snapshot round-trip, routing identity validation, concurrent event revisions, exact retry revisions and receipt payload separation. Primary consumer tests cover committed/ignored receipts, rejection of bare or mismatched committed receipts, invalid envelopes, dispatch retry, claim renewal/loss, abort behavior and bounded shutdown. Admission-receipt tests cover lease/record construction, serialized identity validation and invalid Session proofs. Outbox pump tests cover begin-before-side-effect ordering, delivered receipts, safe retry proofs, ambiguous defaults, timeout/late result fencing, stale reservations and shutdown. Lark adapter tests cover frozen identity, UUID TTL retry, hook fencing/suppression, withdrawn-parent containment, authority aborts and corrupt envelopes. Primary ingress tests cover application lease leadership, occupied standby, configured renewal cadence, identity validation, inserted/duplicate/conflict outcomes, per-partition FIFO, ACK timeout tails, lease loss, activation cleanup, and a single bounded drain/cleanup/release deadline. The existing durable contract suite continues to cover state-machine semantics independently of transport.
