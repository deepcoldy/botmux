# v3 attempt quiescence barrier

Run/node state and worker-process state are separate truths. In particular,
early release and revisit supersession may make an instance logically obsolete
before its outer CLI process has emitted `close`. A run boundary is publishable
only after every dispatched worker attempt has a durable post-close proof.

## Journal ledger

- Open: `nodeDispatched` / `nodeWorkerFenceArmed`.
- Closed: `nodeSucceeded`, `nodeFailed`, `nodeBlocked`, or
  `nodeAttemptDrained`. For one-release compatibility, an attempt-scoped
  `nodeCancelled(reason=runCancelled)` is also a close proof.
- `nodeCancelled(reason=earlyReleaseLoser)` and
  `nodeInstanceSuperseded` are scheduling decisions, not close proof.
- The first post-open close must carry the same `nodeId` / `instanceId` as the
  open record. Close-before-open records are ignored, and a mismatched identity
  fails closed rather than blessing another worker that reused the attempt id.

`nodeAttemptDrained` is appended durably before a worker fence is removed. It
resets only the exact latest attempt that is still the current `running`
instance to `pending`; this also applies beneath a legacy `runBlocked` so its
later retry can re-run the peer. Obsolete, settled, cancelling, and true
run-terminal states are audit-only. Failed/blocked sweeps run before dispatch,
so peer resets cannot overtake the terminal root. A later human retry re-runs
those peers with a new, monotonic attempt number.

## Boundary protocol

The single drive lease is outermost. On failed, blocked, succeeded, suspend, or
obsolete-instance boundaries the owner waits or aborts local peers as the
boundary requires, then fence-drains attempts inherited from a crashed/rolling
daemon. Under the journal lock it replays the latest state, verifies the attempt
ledger is empty, re-derives the terminal action, and only then appends the run
terminal. A concurrent `runCancelRequested` therefore wins by journal order.

Repeated orphan recovery is capped: two automatic requeues per instance are
allowed; the third proven close writes `nodeBlocked` and requires an explicit
human retry.

A blocking/manual gate Promise is not a worker resource, so a failed or blocked
boundary may abandon it instead of waiting for a human. If a later retry reopens
the run, the runtime reattaches a fresh resolver to the durable `gateWaiting`
state. In-process resolver ownership tokens make a callback from the abandoned
Promise stale, preventing it from racing the replacement resolver. Daemon
suspend-mode gates continue to recover through pending wait files and cards.

## Platform posture

Every newly spawned attempt has a durable worker fence and is recoverable on
Linux and macOS. Exact discovery for a historical/malformed attempt whose fence
is missing is Linux-only. On other platforms that exceptional case stays
fail-closed at the boundary rather than claiming a false process close; the
operator must resolve/remove the legacy worker state explicitly.

Lock order remains `drive lease -> journal`; worker-fence locks are leaf locks.
No journal lock is held while probing or signalling a process.
