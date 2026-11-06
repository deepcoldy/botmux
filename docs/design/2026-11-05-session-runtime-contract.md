# Session runtime and state contract

Every new worker boot negotiates session event protocol v2. The contract covers
ordinary, restored, adopted, headless, terminal, API, document and managed
sessions, including the separate v3 ephemeral workflow pool. Executor admission
is independent of legacy output recovery.

## Identity and admission

`WorkerRef` identifies the IPC process. `RuntimeRef` identifies one executor
binding and contains an immutable runtime ID and a monotonically allocated
epoch. `ExecutionRef` identifies an admitted turn/dispatch attempt. A physical
process can have several semantic bindings after a native conversation change.
Reattachment reuses a runtime only with matching process-start, native generation
or persistent lineage evidence. Opaque identities are not reused across boots.
Busy Traex reattachment can obtain the native ID before the first binding from
a fresh, unambiguous user rollout held by the actual CLI PID. A configured resume
ID is not evidence; lookup rechecks process birth and backend/scope ownership.
If an earlier incomplete observation already became selected, a new binding can
recover only a unique unresolved runtime with the same complete fresh identity.
The interval must contain no proven identity transition or unfinished execution;
confirmed bindings and stopped/retired runtimes are never reassigned or revived.

The host persists a runtime reservation before granting `mayStart`. A worker
awaits that receipt before starting its CLI. Once the backend exists, it reports
its native identity; the host confirms the binding and releases deferred events.
Both permits and assignments recheck IPC ownership after asynchronous waits.
Reserved epochs are never rolled back or reused, including checkpoint restore.

Events carry a producer ID, producer sequence, event ID, session reference and
their original runtime/execution/operation scope. Async callbacks keep the scope
they were created under. Live screen callbacks use the current semantic binding
of the same physical source. Native hooks carry the binding ID inherited by the
CLI; MCP calls capture their scope at admission. Neither a later caller nor a
payload's mutable operation ID can replace a captured callback origin.

`SessionEventGateway` validates the trusted IPC producer and full attempt before
any binding or state mutation. Old readiness, screen and runtime configuration
observations cannot update a replacement. Per-producer observation watermarks
prevent a lower sequence from revoking newer readiness. Proven historical
execution/output/control facts can update their original entities without gaining
current executor control. A physical exit stops all semantic bindings of that
same physical identity, while a different process remains unaffected.

An admitted queued attempt can publish or revoke its managed turn identity on
the current runtime before native execution evidence arrives, including during
reattachment. Identity publication leaves the attempt queued and unbound; stale
runtime/producer or unproven attempt references cannot publish that authority.
Turn-scoped publications and revocations must carry an existing `ExecutionRef`
before any deferred write or attempt inference; they never create admissions.

## Durable state and operations

Contract state, identities, event deduplication, observation watermarks and
deferred events live in the application's existing `sessions.db`. The reducer
commits the Session lifecycle/revision projection in the same SQLite transaction.
Owned and offline close paths borrow the owned row transaction; a failed row
write rolls back the contract, operation and dedup record together.
Lifecycle initialization and schema creation also use that borrowed transaction.
The cached store checks its open state and database file identity; replacement
invalidates it, and retained old instances reject further reads and writes.
Observed allocator high watermarks survive that cache refresh and are persisted
into restored rows without restoring old executor authority. Older checkpoint
files cannot make a known allocated epoch available for a new reservation.

Readiness has separate worker-online and prompt-ready facets. `workerReady`,
`cliReady` and `cliReadyGeneration` are compatible read projections. Screen idle,
IPC receipt and prompt readiness do not settle a business execution.

Operations progress through `planned`, `applying`, `confirmed`,
`failed_before_effect`, `rejected` or `uncertain`. They retain their operation ID,
target runtime/attempt and prior lifecycle. Timeout retains an uncertain
operation; concurrent requests join it. A planned restart recovered before its
start claim resumes the same operation, with a single start claim. Close can
supersede another operation; its late success cannot revive a closed selection.
A rejected close restores the previous suspended lifecycle.

Cancellation records intent first. An interrupt delivery receipt confirms that
the key/command was delivered; it does not claim native cancellation. Native
completion/cancellation settles the original attempt and releases an outstanding
cancel operation. Observer loss remains `reconciling` and can later be resolved
by a real native terminal. Confirmed contradictory terminals are conflicts.
Failed attempts retain available partial output and actual delivery facts.

In durable primary mode, contract checkpoints join the existing canonical
Session facade and its `SessionLease`/revision CAS. Commands and observable state
effects wait for that commit. Lease or revision loss fences the local producer.
Admission/control/checkpoint writers preserve a newer canonical contract rather
than replacing it with an older whole-Session copy.

## Output and result compatibility

The universal output snapshot stores original scope as a sidecar. Scope does not
participate in canonical output bytes, output ID or fingerprint. Provider UUID,
native generation/sequence/dispatch ID and native ACK remain unchanged. A new
carrier uses its own IPC producer and preserves the original execution scope.
Recovery validates the original admitted attempt/binding and the durable output
claim; it never creates a replacement business attempt or activates an old
executor. Legacy snapshots without contract metadata retain their original
output validation and settlement protocol.

`PersistentTurnResultStore` queries the durable attempt, frozen source and output
delivery journal. A result's `resultRevision` changes when either execution or
delivery facts change. Returned snapshots are independent copies. Version 1
keeps its existing result shape with an optional revision and now preserves
available output for failed/reconciling attempts. Authenticated result queries can
request `resultVersion=2` for the full attempt and output journal states, including
execution success while delivery is still pending. Existing result enablement and
read-isolation access policy remain in effect.

## Validation

Regression tests exercise invalid/stale event admission before mutation, queued
ACK attempt identity, callback and operation causality, runtime identity conflicts,
reservation/replacement races, uncertain cancellation, rejected close, epoch
restore, transaction failure, output fingerprint/replay compatibility and result
reconstruction/revision. Existing worker lifecycle, native terminal, workflow,
delivery and durable-primary suites cover the shared integrations. Independent
adversarial probes and guard-removal mutations are required before publication,
as specified in the repository contribution instructions.
