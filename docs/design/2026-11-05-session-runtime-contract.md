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
A re-attached Claude-family CLI may be mid-turn and write nothing until that turn
ends, so its first binding takes the native ID from the process's own pid-state
record (the source a write's session ID comes from) when the record names that
PID with that process birth and agrees with every session file the process holds
open; otherwise the binding stays incomplete, as before.
If an earlier incomplete observation already became selected, a new binding can
recover only a unique unresolved runtime with the same complete fresh identity.
The interval must contain no proven identity transition or unfinished execution;
confirmed bindings and stopped/retired runtimes are never reassigned or revived.
When the selected incomplete runtime itself still has unfinished work, the
complete identity of that same live process completes it instead: the older
runtime stays out of reach, and the re-attached worker is not refused a binding
(which would leave it, and that work, with no runtime).

The host persists a runtime reservation before granting `mayStart`. A worker
awaits that receipt before starting its CLI. Once the backend exists, it reports
its native identity; the host confirms the binding and releases deferred events.
Both permits and assignments recheck IPC ownership after asynchronous waits.
Reserved epochs are never rolled back or reused, including checkpoint restore.
If reservation permission is refused or arrives after the worker's wait expires,
the worker reports `runtime_binding_aborted` before invoking the physical spawn.
The host settles only an unbound reservation owned by that producer. A stopped
reservation cannot grant permission or bind later; the worker restores its
previous binding so recovery commands can still address the surviving executor.
Restoration skips predecessors whose starts were also aborted. The no-spawn
report retains its original binding and retries until the host acknowledges its
durable commit. Observed no-spawn evidence also fences late permits while the
commit is failing; a lost acknowledgement cannot leave the reservation pending.
A spawn that fails before its runtime publishes an identity reports the same
abort: that replacement never became addressable and must not mask the
surviving runtime's exit. When the host refuses a binding (for example while
another control operation owns the session), it stops the unbound reservation,
discards its deferred events and tells the worker, which returns to its previous
binding. Later events of a stopped reservation are rejected, not deferred,
except failure reports (`error`, `worker_error`, a failed `restart_result`):
those are worker-scoped and never deferred behind an unbound reservation, so the
reason a start failed still reaches the user and settles its operation.

Events carry a producer ID, producer sequence, event ID, session reference and
their original runtime/execution/operation scope. Async callbacks keep the scope
they were created under. Live screen callbacks use the current semantic binding
of the same physical source. Native hooks carry the binding ID inherited by the
CLI; MCP calls capture their scope at admission. Neither a later caller nor a
payload's mutable operation ID can replace a captured callback origin.
A CLI started before binding IDs existed has none. Its session-ready and
turn-idle hooks attach to the current runtime only when it is the sole settled
candidate: active lifecycle, no control operation, no pending replacement, a
matching native session when both sides know one, and for turn-idle an attempt
that belongs to that runtime.

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
The full admitted reference is checked before deferral. Permanently rejected
deferred messages are removed when replayed, including records from older boots.
Rejection cleanup matches the recorded message body as well as its event ID;
an unproven envelope cannot discard a different valid deferred event.

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

History is bounded per session: the newest 1024 deduplication records, 256
settled attempts and result facts, and 128 settled operations. Reservation and
binding records, which recovery replays, unsettled work and the result facts of
its turns are never pruned.
Other deduplication records store a digest of the event, so reusing an event ID
for a different event is still a conflict. Unchanged busy/ready samples are
covered by the observation watermark and are not recorded; a turn records one
ready-to-busy edge. Turn lookups use an index instead of scanning all attempts.

Readiness has separate worker-online and prompt-ready facets. `workerReady`,
`cliReady` and `cliReadyGeneration` are compatible read projections. Screen idle,
IPC receipt and prompt readiness do not settle a business execution.

Operations progress through `planned`, `applying`, `confirmed`,
`failed_before_effect`, `rejected` or `uncertain`. They retain their operation ID,
target runtime/attempt and prior lifecycle. Timeout retains an uncertain
operation; concurrent requests join it, and the worker's late receipt, its exit
or a close settles it. A planned restart recovered before its
start claim resumes the same operation, with a single start claim. Close can
supersede another operation; its late success cannot revive a closed selection.
A rejected close restores the previous suspended lifecycle.
If persistence of the restart start claim fails before physical restart is
invoked, the operation settles as `failed_before_effect` and can be retried.
A failure the worker reports after invocation is a known outcome: it settles as
`rejected` and restores the prior lifecycle, so the next restart is a new
attempt. Only a missing outcome remains uncertain.

An unverified suspend retains `uncertain`: the backing verifier has already
attempted teardown, so failure does not prove that no effect occurred. Retrying
suspend reuses the same operation and rechecks the exact selected runtime's
backing. A verified teardown confirms that operation. Restart can supersede an
uncertain suspend or cancel, retaining the old intent and restoring its prior
lifecycle under the new restart fence. Late results settle only the retired
operation. A newly forked worker takes over an uncertain suspend or cancel under
a new restart, so its first runtime may start. Readiness projections stay false
until verification or restart confirmation; ordinary readiness events alone do
not prove a failed teardown harmless.

Control operations do not fence user input. The worker queues messages across
restart and resume, and an unverified suspend or cancel leaves the executor live,
so messages and Stop are still delivered. Only a closing or closed session
refuses input.

During reserve-to-bind replacement, an authorized predecessor exit still records
the physical loss and reconciles its executions, but has historical admission.
It cannot invoke the current executor's crash handling while a newer unbound
reservation belongs to the selected worker. Confirmed bindings, retired workers
and allocator high water alone do not suppress genuine current exits.

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
