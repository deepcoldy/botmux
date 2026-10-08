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

Only a narrow versioned projection is eligible for this stage: session id, application id, routing anchor, scope, active/closed status and lifecycle timestamps. Prompt content, titles, identities, paths, attachments, tokens and provider/terminal state are excluded. The daemon invokes this mirror only after an ordinary Lark session has committed to SQLite and won active-session registration. It is therefore shadow evidence, not a complete Session source: restore, close, multi-row transactions, lineage batches and the synchronous Session API remain SQLite-only.

`primary` fails closed until all three runtime stages are present:

1. a primary inbox handler that replaces, rather than mirrors, the local route;
2. complete asynchronous fenced Session ownership and mutation coverage (the current narrow shadow projection is insufficient);
3. a durable outbox pump with explicit attempt/receipt reconciliation.

This prevents a deployment from enabling multiple independent SQLite writers by setting one premature flag. A later change must remove the `primary` gate only together with the complete data path and its failure tests.

## Shutdown

Graceful daemon shutdown requests provider `close` and bounds the response. Fatal process exit terminates the child synchronously. A provider close failure is logged without provider stderr, the child is terminated, and the daemon continues its existing bounded shutdown.

## Verification

Tests cover handshake compatibility, round-trip calls, redacted retryable errors, malformed results, timeouts, disabled defaults, primary fail-closed behavior, shadow claim/validation/retry, lifecycle cleanup, and recovery after a transient bootstrap poll failure. Session facade tests additionally cover per-key serialization/coalescing, cross-key independence, revision CAS, occupied/conflict/stale outcomes, bounded stop/release, and the audited projection field set. The existing durable contract suite continues to cover state-machine semantics independently of transport.
