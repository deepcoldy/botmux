# v3 host executor protocol

Status: implementation contract for host executor support.

## Goal and trust boundary

Run the deterministic side-effecting executors `feishu-send`,
`feishu-reply`, and `botmux-schedule` inside the v3 engine without applying a
goal worker's orphan-drain/requeue semantics. A crash must never turn an
unknown external effect into a fresh attempt with a different idempotency key.

The filesystem integrity checks in this protocol protect against crashes,
torn writes, schema drift, path confusion, accidental cross-attempt reuse, and
ordinary stale recovery artifacts. They are **not a cryptographic boundary
against another arbitrary process running as the same OS user**. The journal,
run envelope, and host artifacts are all writable by that principal. Botmux's
current local deployment therefore treats the daemon and same-UID processes
(including an unsandboxed bypass worker) as part of the local TCB. A malicious
or prompt-injected worker that is allowed arbitrary same-user filesystem/IPC
access can already forge control-plane state outside this feature. Closing that
larger boundary requires mandatory worker filesystem isolation and authenticated
daemon IPC; it remains an explicit follow-up. Result wrappers below are
schema/identity-bound, not signed attestations.

## Node and binding shape

A host node is an outer-DAG node with `type: "host"`, one allowlisted executor,
a JSON input template, and a mandatory `humanGate`. There is no P0 ungated
escape hatch. The only approving option is the reserved `approve` choice;
custom-labelled and `reject` choices can never authorize an effect. Host nodes:

- never carry goal/bot/override/resultSchema/revisit fields;
- are forbidden inside structured loops and revisit cones;
- use the default/explicit `all_success` trigger only;
- may read a result only through an unconditional dependency, so skipped or
  omitted input is never silently bound;
- use exact context refs for every provider target. Send binds app+chat, reply
  binds app+root, and schedule binds app+chat+chatType (plus root when used).

Input templates may use immutable Saved Workflow params/context and a
dependency's validated `result.json`. Exact `{ "$ref": "..." }` objects
preserve JSON types; `${...}` inside strings accepts scalar values only. The
binding language is validated before any async result read.

## Frozen approval object

When a host becomes ready, the runtime reserves the next attempt id, resolves
its template exactly once, parses/canonicalizes it, and writes an attempt-local
0600 `host-input.json`. File and directory durability are established before a
durable `hostInputPrepared` event records:

- run/node/instance/attempt and executor/provider identity;
- a run-relative input reference with byte length and SHA-256;
- canonical input hash and provider idempotency TTL;
- deterministic idempotency key;
- approval digest bound to run/node/instance/attempt/executor/input hash.

P0 rejects parsed provider inputs larger than 8,000 bytes before showing a
gate. The Lark card always renders the complete redacted payload and the full
input hash in `plain_text` fields independent from the authored prompt, so a
long prompt cannot truncate the approved object and an upstream Lark tag cannot
turn card display into a pre-approval notification. Secret-like keys are
redacted in the card but remain in the frozen, hashed sidecar.

The gate wait id includes the host attempt number. Gate resolution is
first-wins, and execution verifies the durable dispatch/resolution, approval
digest, input hash, exact sidecar bytes, and target identity again. A retry
before provider intent gets a fresh attempt, fresh freeze, and fresh gate.

`botmux-schedule` additionally derives relative time into `parsed.runAt` at
freeze time. Immediately before intent, its pure preflight rejects invalid or
stale one-shots (using the scheduler's two-minute grace), invalid recurring
shapes, and P0-unsupported local-only delivery. That block is normally
retryable: a new attempt derives a fresh runAt and asks for approval again.

## Effect protocol

All control events are durable under the journal lock:

1. verify frozen input, target identity, provider registration/TTL, and the
   exact approved hash;
2. publish `hostEffectIntent` with the immutable key/input identity;
3. re-read and verify the sidecar outside the journal lock;
4. invoke the provider with that idempotency key;
5. atomically no-overwrite publish a manifest-valid result wrapper bound to the complete
   run/node/instance/attempt/executor/provider/key/hash/approval identity;
6. append `nodeSucceeded` only while that exact host ledger entry is open.

Host attempts never emit `nodeDispatched`, never arm a worker fence, and never
enter the worker-attempt ledger. `hostEffectIntent` opens the separate host
effect ledger. A matching node verdict or `hostEffectUncertain` closes it.
Duplicate intent identity, close identity, and retry-deferral sequence are
validated during replay.

Provider SDK promises have a referenced response deadline so standalone CLI
execution cannot exit with an open intent. Cancellation can wake the scheduler
before that deadline; once same-key reconciliation closes the effect, the
deadline handle is detached so it does not keep the process alive. Reconciler
lookup/submit calls use the same deadline. Retryable outcomes publish durable,
bounded exponential-backoff records (maximum ten); rollback/overflow clocks
fail to explicit uncertainty instead of writing a corrupt deadline.

## Crash recovery and cancellation

Recovery distinguishes:

- sidecar fsync without prepared event: the exact identity-verified bytes are
  adopted and the durable prepared event is repaired; relative time is never
  reparsed in that crash window;
- prepared without intent: no provider call began; exact bytes can be re-gated,
  or corruption becomes an ordinary pre-intent block and a fresh retry;
- intent without verdict: the external outcome is unknown and generic
  `orphanRecovery -> pending` is forbidden.

Input/result/manifest canonical paths are published from a fully fsync'd temp
inode with atomic no-overwrite linking, so a new crash cannot expose a partial
canonical artifact. A legacy/foreign partial output is never overwritten: if
same-key provider recovery succeeds but close-proof publication conflicts, the
effect closes as `HOST_EFFECT_OUTPUT_UNRECOVERABLE`. Normal runs block for
audit; cancellation still converges with the bounded uncertainty warning.

For an open intent, runtime revalidates the frozen sidecar and uses only the
registered same-provider reconciler with the original key:

- an idempotent submit may be repeated inside its TTL;
- a durable read-only receipt must match the frozen canonical input;
- lookup miss is not treated as proof of non-execution;
- expired TTL, missing/corrupt evidence, definition/provider drift, or exhausted
  retry budget becomes `hostEffectUncertain`.

Schedule receipts rely on a crash-durable store transaction: one cross-process
lock covers force-reload, isolated mutation, O_EXCL temporary write, file fsync,
atomic rename, and parent-directory fsync. The in-memory map is replaced only
after commit. This prevents ghost receipts and stale-writer lost updates before
schedule lookup is accepted as close proof.

Cancellation uses the same ledger. Before intent it can cancel normally. After
intent, recovery must first prove success or close as uncertainty. A cancel
request bypasses an already-persisted backoff deadline; the next retryable or
timed-out provider check closes as `HOST_EFFECT_CANCELLED_DURING_RECOVERY` and
`runCancelled` carries the bounded uncertain identities.

For an ordinary blocked run, generic `/workflow retry` is forbidden after an
uncertain host effect. P0 deliberately has no command that fabricates a
provider receipt or downstream result after manual audit. The operator audits
the target system, then uses `/workflow cancel <runId>` to close the run while
retaining the uncertainty record. A future explicit “confirmed applied / not
applied” protocol would need executor-specific evidence and downstream output
semantics; it must not be approximated by a generic retry button.

## Saved Workflow rules

Saved revisions list the exact host node set in `safety.sideEffects`, retain
the normal gate digest, and validate template bindings even through the lowest
revision-builder entrypoint. Materialization resolves only declared params and
built-in context. Host-only definitions require no bot snapshot. `chatType` is
authenticated from the current session and carried through CLI/IM service
contexts into the immutable run binding; this preserves P2P schedule session
semantics.

## Required verification

1. schema: mandatory gate, exact target refs, all-success/unconditional
   dependencies, no loop/revisit host, and exact side-effect projection;
2. freeze/gate: complete plain-text payload+hash card, fixed approve semantics,
   8KB rejection, first-wins wait, sidecar permission/symlink/tamper checks,
   crash-left sidecar adoption, and fresh attempt after stale schedule;
3. protocol: intent-before-provider, full identity result wrapper, no worker
   fence/orphan requeue, and downstream consumption of a validated host result;
4. recovery: same-key success, lookup mismatch/miss, TTL/clock failure,
   response timeout, durable backoff/budget, and late original-provider settle;
5. cancellation: before/after intent, persisted-backoff bypass, referenced
   timer cleanup, and bounded uncertain terminal warning;
6. schedule: relative-time freeze, invalid/stale rejection before intent,
   P2P identity, durable receipt reload, save-failure rollback, migration scope,
   and stale/concurrent writer preservation;
7. daemon/Saved Workflow: authorized gate reconstruction after restart,
   tampered wait rejection/repair, exact group/P2P context propagation, and
   duplicate drive/click idempotency.
