# PR #803 — Reply to Round-5 Review

Addressed to Odyssey (lead review) and Wallpaper (independent re-review). PUBG
acknowledgement still outstanding at time of writing.

This file is committed to the repository so it can be read independently of any chat
transcript. Round 4 stated that a reply document had passed re-review while that
document lived outside the repository, where Wallpaper could not read it. That was
wrong, and this file existing at a reviewable path is part of the correction. It is
**not** claimed to have passed re-review; it is submitted for review.

Baseline reviewed: `c8122d89`. All four charges are accepted. None is contested.

---

## Where to find everything (round-5 document index)

All round-5 documents share the `docs/pr-803-round5-` prefix and are committed to the
repository, so they can be read from a plain checkout without access to any chat
transcript. Round 4's reply lived outside the repository; that is charge C in part, and
this index exists so the same gap cannot recur silently.

| File | Author | Contents |
|---|---|---|
| `pr-803-round5-reply.md` | Claims | **This file — the reviewer's entry point.** Charge-by-charge status, corrections to the overstated delivery claims, the field-contract mapping. |
| `pr-803-round5-audit.md` | Claims | Repo-wide reverse audit of enforcement claims: method, per-identifier consumer counts, the five false-claim sites and their disposition. |
| `pr-803-round5-claim-a-boundary-proof.md` | BoundaryProof | **NOT DELIVERED THIS ROUND -- this file is absent from the tree.** Charge A's code changes are in the tree and verified (see the Charge A section below and `pr-803-round5-integration-report.md`); only this companion document is missing. |
| `pr-803-round5-claim-b-weak-handle.md` | WeakHandle | Charge B: a clean weak scan no longer authorises a plain closed row; residual retention design. |
| `pr-803-round5-claim-b-mutation-log.md` | WeakHandle | Charge B mutation results. |
| `pr-803-round5-claim-b-probe3-before-after.md` | WeakHandle | Charge B, **real-process reproduction** of the reviewer's third probe shape (setsid + scrubbed nonce + reparented to init), before and after the fix. |
| `pr-803-round5-claim-d-cross-platform.md` | CrossPlatform | Charge D: `procRoot` seam conversion and platform gating, measured counts, and the explicit no-Darwin-hardware statement. Includes its own retraction note for the figures produced by the ineffective probe. |
| `pr-803-round5-integration-report.md` | WeakHandle | Integration and regression report: three-round Linux figures, failing-file set difference, the five mutations re-run on the final tree, and the two defects only integration exposed. |

**Status of this index at the time of writing:** the two Claims documents are committed.
The other five are authored in this round by their owners and are being moved into the
repository under these names; any that is absent from your checkout has not landed yet,
and this index is a manifest of the intended set rather than a claim that all seven are
already present. The integration commit is the point at which all seven must exist — if
one is missing there, this index is the checklist that says so.

**Known gap at the time of writing:** `pr-803-round5-claim-a-boundary-proof.md` had not been
committed. If it is absent from your checkout, that document was not delivered this round;
the charge-A code changes themselves are in the tree and verified, and the missing item is
the write-up, not the fix.

---

## Status of each charge

| Charge | Severity | Owner | Status in this reply |
|---|---|---|---|
| A — `boundaryProof` never reached a production decision point | P1 | BoundaryProof | Accepted. Fix in progress; see note below. |
| B — weak handle released on a clean scan | P1 | WeakHandle | Accepted. Fix in progress; see note below. |
| C — overstated delivery claims | P0.5 | Claims (this document) | **Corrections published below.** |
| D — tests not cross-platform | P0.5 | CrossPlatform | Accepted. Fix in progress; see note below. |

To keep this reply honest about its own scope: sections C and the reverse audit are
complete and are this document's own work. **Charges A, B and D are being fixed by
other contributors in this round, and this document deliberately does not report them
as landed.** Their verification numbers will be added by their owners before the round
is submitted. Nothing here should be read as a claim that A, B or D is finished.

---

## Charge C — corrections to overstated claims

### C.1 The headline claim in `76ef13bc`

`76ef13bc` says:

> A clean scan can no longer authorise a plain closed row.

**Corrected scope.** That sentence is true for exactly two of the three handle classes:

- **cgroup strong handle** — true. An empty `cgroup.procs` is kernel state the
  same-user child cannot forge, unlink or escape.
- **macOS / non-enumerable `unprovable` handle** — true. It can never be released, so
  the blocker is retained.
- **Linux weak (PID/nonce) handle — false.** An empty scan produces `proven: true`,
  `releaseContainmentHandle()` drops the handle, and a plain `closed` row follows.
  This is the reviewer's charge B reproduction path, and the commit message asserted
  the opposite.

`76ef13bc` is already pushed and is **not** being rewritten — no force push, no
history edit. The correction is published here, in the reverse-audit report, and
restated in the new commit message for this round.

### C.2 A second overstatement in the same message, found while auditing

> a proven weak handle maps to diagnostic-clean and may leave the store, but never
> clears the blocker

The second clause is false, and the audit shows why the first clause cannot be
separated from it: the device-isolation blocker *is* handle presence.

```
src/core/device-isolation-daemon.ts:539   hasDurableContainmentHandle -> hasUnprovenContainment
src/core/mojo-containment.ts:701          hasUnprovenContainment -> containmentHandles(...).length > 0
src/core/mojo-containment.ts:733          releaseContainmentHandle -> deletes the handle
```

"Leaving the store" and "clearing the blocker" are the same event. The distinction the
comment draws does not exist in the code. Reported as Finding C-3.

### C.3 "Unrepresentable in the type system" was over-scoped

> Releasing a handle demands a proven quiescence verdict, which makes clearing the
> device-isolation blocker without proof unrepresentable in the type system

Accurately scoped: the type stops a `proven: false` verdict from being spent, and does
so via a runtime `throw`. It does **not** encode evidence *strength* —
`{ proven: true }` is inhabited identically by a cgroup proof and by a scan-only weak
proof, so a weak handle mints the same verdict a kernel-verified one does. Reported as
Finding C-4.

### C.4 One claim in `76ef13bc` audited as accurate

> Only a cgroup handle with an empty procs file can mint boundaryProof true

**Verified true** and retained. All three production mint sites for
`contained-proven` are gated on cgroup-kind handles. Flagged here so the correction
list is not mistaken for a blanket retraction of the commit message.

### C.5 A fourth false claim, found by enumerating instead of reading

`mojo-containment.ts:796` and `:802` claim `containmentQuiescence()` is
"the ONLY source of `boundaryProof: true`" / "the single place in the codebase allowed
to mint" it. There are **three** mint sites:

```
src/core/mojo-containment.ts:830          verdict.handle.kind === 'cgroup'
src/core/mojo-containment.ts:871          allStrong (a different function, same file)
src/adapters/backend/mojo-backend.ts:899  outstanding.every(h => h.kind === 'cgroup')
```

The *safety* property holds — all three are cgroup-gated, which is why C.4 stands. The
*architectural* claim of a single choke point is false, and that is the claim a future
contributor would rely on when adding a fourth site.

This also explains why `test/mojo-containment.test.ts:475`, which asserts containment is
the only source of `boundaryProof: true`, passes while the comment it mirrors is false:
it exercises the containment module and cannot observe the independent mint in
`mojo-backend.ts`.

Disclosed for the record: this reply first cited two of the three sites. The third was
caught by enumerating mint sites mechanically rather than trusting the comment's own
account of itself — the same error class the audit was built to catch, made by the
audit.

### C.6 Test counts restated as Linux-only

Every previously published count was measured on Linux and published without a
platform qualifier:

| Previously reported | Corrected |
|---|---|
| 135/135 mojo suites | 135/135 **on Linux** |
| 558/558 full suite | 558/558 **on Linux** |
| "549 tests all pass" (`530ff22f`) | 549 **on Linux** |
| "551 tests green" (`263bdb95`) | 551 **on Linux** |

Odyssey's 16 failed / 18 passed on `mojo-containment-wiring` and Wallpaper's 38 failed
/ 624 passed are consistent with those counts being Linux-only; they are not evidence
that the Linux counts were wrong. No Darwin machine was available to this round's
contributors, so no macOS figure in this reply is presented as our own measurement.

### C.6b Counts measured this round (charge D)

Measured by CrossPlatform and reproduced verbatim; each figure carries its platform and
how it was obtained.

| Scope | Result | How measured |
|---|---|---|
| `test/mojo-*.test.ts` at baseline `c8122d89`, 3 runs | 548 passed / 3 failed, then 551 / 0, then 551 / 0 | **Linux**, real host |
| `test/mojo-*.test.ts` at the integration tip, 3 runs | 568 / 0, 568 / 0, 567 / 1 failed | **Linux**, real host. One run reproduced independently for this reply (568 / 0). |
| Failing-file set difference, baseline vs integration | **empty** — both sides `{mojo-worker-wiring.integration}` | Set difference over failing files, not over counts |
| Case total | 551 → 568 (+17), `tsc --noEmit` clean with both signature changes present | **Linux** |
| Non-Linux simulation at the integration tip | 540 passed / 28 skipped / **0 failed** | **Simulated, not a Mac.** Measured independently for this reply. See the two warnings below. |
| Previously published 135/135 and 558/558 | unchanged | **Linux-only**, as restated in C.6 |

**The repository-wide suite was not run.** This environment carries a large number of
unrelated UI / Lark / dashboard suites that do not converge in a single pass, so a
three-round full-suite baseline was not feasible. Only the mojo domain was regressed. The
568 figure is a **mojo-domain** number and is not a whole-repository number; a full run
belongs to CI.

**Per-branch numbers, which are the argument for integration testing.** Measured separately
because branch-level green lights are not interchangeable with integration results:

| Branch | Result |
|---|---|
| baseline | 289 / 0 |
| charge B | 299 / 0 |
| charge A | 287 / **10 failed** |
| charge D | 288 / **9 failed** |

Charges A and D are each red in isolation, and neither is at fault: the failures concentrate
in the eight `resolves.toBe(true/false)` assertions in `mojo-containment-wiring`, where the
signature change belongs to A and the assertion update belongs to D. Either one landing
alone is necessarily red. This is the concrete reason all mutations were re-run on the
integration branch rather than credited from branch history.

**A pre-existing flake, newly identified.** The one failing file on both sides is
`mojo-worker-wiring.integration` — a 12-second timeout case that also failed on a baseline
run, so it predates this work and was **absent from the known-flake list** in the brief. It
passed 26/26 on two isolated re-runs. Recorded as a newly identified pre-existing flake
rather than as a regression or a pass.

### Two retractions of simulated non-Linux figures

**First retraction.** Numbers **526, 527, 534 and 543 passed** are **withdrawn**. The probe
that produced them reassigned `readFileSync` on the imported `fs` namespace object, but a
module doing `import { readFileSync } from 'node:fs'` binds the function itself, so the
reassignment was never observed. The suites went on reading the host's real `/proc`: the
probe was **green for the wrong reason**. The disproof came from the probe's own author and
is the convincing part — with **every platform gate deleted**, the containment wiring suite
still passed 34/34. If `/proc` had truly been unavailable, that is impossible. The mock is
now `vi.mock('node:fs')`, which replaces the module record and does intercept named imports.

**Second retraction, found while verifying this reply.** A later non-Linux figure of
**542 passed / 25 skipped / 1 failed** is also **withdrawn**, for the same underlying
reason. It was measured at a sha where `test/helpers/non-linux-probe-setup.ts` still
contained the ineffective `(fs as any).readFileSync = ...` form; the corrected
`vi.mock('node:fs')` version only arrived in a later merge. Verified by reading the setup
file at both shas. The figure was reported in good faith, but it measures the same
non-property the first four did.

The only non-Linux figure this reply stands behind is the one it measured itself at the
delivered tip, with the corrected probe in the tree: **540 passed / 28 skipped / 0 failed**.

**And that 0 must not be read as macOS being fixed.** C-7 is still unfixed at the delivered
sha, verified directly: the criterion remains `opts.procRootOverridden`, both call sites
still pass `procRoot !== undefined`, no `DEFAULT_PROC_ROOT` or `isProcRootOverridden` exists
in `src/`, and the `never set in production` comment is unchanged. The four close-path
failures that previously demonstrated the defect no longer reproduce, and no C-7 repair
landed, so **the defect is now unguarded: nothing in the suite fails because of it.**
Details in the audit. **No claim is made anywhere in this round that cross-platform
behaviour is fixed or that the macOS failures are at zero.**

**No Linux full-suite figure is offered for this branch.** The charge-D work only ran the
targeted mojo suites; the full suite was not re-run on that branch, so no whole-repo
Linux number is claimed here. The full regression belongs to the integration step and is
reported there.

**Gate behaviour is skip, not pass.** Where a case genuinely needs a live child process
and a real `/proc`, it is now explicitly skipped off Linux rather than silently
"succeeding". The 25 skipped cases are that gate working. A previously used pattern,
`if (process.platform !== 'linux') return`, was replaced precisely because it reported
never-executed cases as passes.

Method, as recorded by its author:

> Nine fake-`/proc` cases that read the host's real
> `/proc/sys/kernel/random/boot_id` now inject a synthetic `/proc` through the existing
> `procRoot` seam (new `test/helpers/synthetic-proc.ts`, with a synthetic boot id, and the
> injected value is always a temporary directory and never `'/proc'` itself), so they no
> longer touch the host `/proc` and run on any platform. Cases that genuinely require a
> live child process, real signals, or a readable boot id are gated with explicit
> `describe.runIf` / `it.runIf(process.platform === 'linux')`. Two implicit
> `if (platform !== 'linux') return` early returns became explicit skips, because the old
> form reported cases that never ran as passes. The non-Linux side uses a separate vitest
> project to simulate: it forces `process.platform` to `'darwin'` and uses
> `vi.mock('node:fs')` so that `readFileSync` / `readdirSync` / `statSync` / `existsSync`
> all fail for the real `/proc`. This is a simulation, not real hardware.

Two flakes were observed and are recorded rather than smoothed over: `mojo-cross-boundary`
"concurrently queued credential turns run A/B/C, not A/C/C" (already on the known-flake
list) and `mojo-close-worker-journal` "keeps writes fenced when recovery says retryable
but admission says fenced". Each failed once and passed on individual re-run. They are
logged as flakes, not as passes.

**What we do not claim about the reviewers' macOS numbers.** Odyssey's 16 failed / 18
passed and Wallpaper's 38 failed / 624 passed remain **their** real-hardware
measurements; we did not re-run them. Our own position is narrower and is an
**inference, not a measurement**: cases that failed for want of `/proc` now either go
through the seam or are explicitly skipped, which under simulation appears as skip rather
than fail. **Whether those 38 failures land at exactly zero on real hardware is
unverified by us.**

**What the simulation can and cannot establish.** Stated in its author's terms: the probe
can falsify "we think this is platform-clean but it is not" — a case still reaching for
the host `/proc` goes red under it. It **cannot** establish how real macOS behaves for
filesystem, process, signal or tmux semantics, and it **cannot** show that Wallpaper's 38
failures land at zero on real hardware. Our claim there is an inference, not a
measurement.

**An explicit limit on what the simulation proves.** Applying the same probe to the full
unit suite additionally reddens terminal/tmux/CLI-spawn files (`session-picker`,
`worker-*`, `workflow-cli` and similar). That is an artefact of a probe that fakes the
platform process-wide and severs `/proc`; it is outside charge D, and we make no claim
about those files either way.

### C.7 The reply-document claim itself

Round 4 asserted the reply had been through independent re-review while
`review-reply.md` was untracked. Confirmed at `c8122d89`:

```
git ls-files | grep -iE 'review.?reply|pr-?803'   # no output
```

Retracted. This document is in the repository at `docs/pr-803-round5-reply.md` and is
submitted for review, not presented as already reviewed.

---

## The vulnerability of charge B, caught on live processes

Detail: [`docs/pr-803-round5-claim-b-probe3-before-after.md`](./pr-803-round5-claim-b-probe3-before-after.md).

Charge B was not merely reasoned about and patched. The reviewer's third probe shape was
built for real and run against both trees, so the record shows the hole open and then
closed rather than asserting it is closed.

The survivor is constructed exactly as described in the review: `setsid` into a new
session, `env -u` the tree nonce out of its own environment, and the wrapper exits so
init adopts it. All three signals the scanner unions — PGID, inherited nonce, PPID chain
— are therefore dead, while the process is demonstrably alive.

Measured facts identical on both sides: `handle_kind=tree-identity` (a weak handle, not
`unprovable`), `evader_alive=true`, `evader_ppid=1`, `evader_pgid` differs from the turn
PGID, `evader_has_nonce=false`, `scan_ok=true`, and `scan_members=[]`. The scanner
reports an empty subtree for a process that is running.

| Observation | Baseline `c8122d89` | After charge B `8d764534` |
|---|---|---|
| `verdict_proven` | `true` | `true` |
| `verdict_evidence` | **absent — no evidence field existed** | `scan-clean` |
| `release_threw` | `no` | `no` |
| `release_decision` | `void` (no return value) | `boundaryProof:false`, `releaseAuthorised:false`, `evidence:scan-clean`, `residual.deviceIsolation:true`, `signalsStopped:true` |
| `handles_left` | **0 — handle deleted** | **1 — handle retained** |
| `blocker_retained` | **false** | **true** |
| `evader_still_alive_at_end` | `true` | `true` |

Read the baseline column against the last row: a single clean scan removed device
isolation from a live subtree still holding the injected credential, while
`boundaryProof` was `false` throughout. That is the reviewer's reproduction chain,
confirmed rather than argued with.

Three properties of this evidence are worth stating explicitly:

- `release_threw` is `no` on **both** sides. The fix does not buy safety by making the
  session unclosable — the earlier failure mode that wedged non-Linux hosts. The session
  still closes; only the device-isolation blocker is retained.
- `blocker_retained` is read from `hasUnprovenContainment()`, the function the
  device-isolation daemon itself calls, not from a field in the return value. So this is
  the blocker's real state, not a self-report.
- The only behavioural difference is the release criterion itself. Everything about the
  survivor is byte-for-byte the same scenario on both sides.

This also closes audit finding C-3 empirically. C-3 observed that the blocker's sole
criterion is whether a handle exists, which made the old comment's separation between
"leaving the store" and "clearing the blocker" incoherent. The probe demonstrates that
relationship on real processes: `handles_left=0` coincides with
`blocker_retained=false`, and `handles_left=1` with `blocker_retained=true`. C-3 is
therefore corrected in behaviour, not only in wording.

**Provenance of these numbers.** Both columns were re-run independently by the author of
this reply, in two worktrees (`c8122d89` and `8d764534`), on **Linux**, and the values
above are those runs' output — not figures copied from a teammate's report. The baseline
run requires dropping the `containmentReleaseDecision` import, which does not exist at
`c8122d89`; everything else is the same harness. No Darwin hardware was involved and no
macOS behaviour is claimed here.

---

## The reverse audit

Full report: [`docs/pr-803-round5-audit.md`](./pr-803-round5-audit.md).Round 4 ran an honesty pass and still shipped the largest false claim in the mojo close
path. The methodology gap, stated plainly: it asked whether wording sounded too strong,
and never asked whether a field described as *consulted* had a line of code reading it.

This round inverted the check — start from the claim, demand a production consumer,
treat a missing consumer as a defect equal in severity to a wrong assertion.

**Headline result.** Across the audited set, `boundaryProof` is the only enforcement
claim with **zero production consumers**: 0 reads against 21 construct/typedef sites.
Reproducible at `c8122d89`:

```
git grep -nE '\.boundaryProof' -- src/ | grep -vE ':[0-9]+:\s*(\*|//)'   # empty
```

Five comments asserted a gate that did not exist
(`mojo-process-tree.ts:97`, `mojo-containment.ts:818`, `mojo-backend.ts:227`,
`mojo-backend.ts:603-606`, `mojo-backend.ts:632-636`). The last is three lines above
`return q.kind === 'contained-proven' || q.kind === 'diagnostic-clean'` (`:637`) — the
statement that destroys the very distinction the comment insists callers must observe.

**All five are cleared in the delivery.** Verified at the integration tip: the harness
reports 5/5 removed or reworded. The last to go was `mojo-backend.ts:227`, and it is worth
reading, because the replacement states the fact rather than asserting a gate:

> Evidence class of the last quiescence attempt. DIAGNOSTIC ONLY. The previous wording
> claimed the blocker decision requires `boundaryProof === true` on this value. It did not,
> and still does not: nothing in production reads `TurnQuiescence.boundaryProof`, so that
> was a claim about code that was never written. The real gate is
> `TerminationOutcome.boundaryProven`, which is derived from `containmentReleaseDecision`.

That is the outcome this audit was for: the field's real status is now on the page, and the
comment records that the old claim was false instead of quietly deleting it.

**C-6 is cleared by construction, not by deletion.** The three mint sites for
`boundaryProof: true` are collapsed into one exported factory. Verified at the tip:

```
git grep -n "boundaryProof: true" -- src/
  src/adapters/backend/mojo-process-tree.ts:110   type declaration
  src/core/mojo-containment.ts:982                the only production construction
```

The wording this finding objected to — "the single place in the codebase" — became true
because the code changed to match it.

**Sharper than the charge as filed.** The single production read of
`lastTurnQuiescence` consults `.kind`, not `.boundaryProof`
(`mojo-backend.ts:1065`) — and it sits inside the *false* branch of
`if (!await this.terminateChildProven())`. Since `terminateChildProven()` collapses
`contained-proven` and `diagnostic-clean` into the same `true`, a `diagnostic-clean`
turn never enters that branch at all. The evidence grade was not merely ignored; it
was unreachable on the path that decides the close.

**Three findings the charges did not name:** C-3 (self-contradictory comment), C-4
(`proven: true` carries no evidence grade), and C-6 ("single place in the codebase" is
false — three mint sites).

**A fourth, in a category of its own (C-7):** `mojo-process-tree.ts:182-183` states an
explicit `procRoot` override "is never set in production". It is set on every production
call — `procRoot` is a getter returning `'/proc'` (`mojo-backend.ts:594`) and is passed
at nine call sites. Since the platform gate is
`procRootOverridden: opts.procRoot !== undefined`, `mojoTreeScanSupported()`
short-circuits to `true` on every platform, so the non-Linux refusal at
`mojo-process-tree.ts:319` and `:390` never fires in production. The comment asserts the
one condition that would make the gate work while the wiring guarantees the opposite.
Found by CrossPlatform, independently verified. The concrete consequence is worse than a
mislabelled verdict: with the gate inert, a macOS scan yields `unscannable` instead of
`unsupported-platform`, and those route oppositely — the former latches the admission
fence, the latter does a residual close that keeps the blocker. So the inert gate fences
the session on precisely the hosts where no retry could ever produce a proof, which is the
permanent-wedge behaviour this work was credited with fixing. **Recorded as open, not
fixed:** the repair was implemented and verified by its finder, but it touches a file
owned by another contributor this round, so it was reverted from that branch and
reassigned. Confirmed still unfixed at `cp/claim-d` (`a4b95950`).

Because this is exactly the trap the round is about, the audit measures it rather than
asserting it. At the charge-D tip the mojo suites are 551 passed / 0 failed **while the
gate is still inert**: with `process.platform` forced to `'darwin'`,
`scanMojoTree(pid, nonce, { procRoot: '/proc' })` — precisely what the backend does —
returns `ok` and scans, whereas omitting `procRoot` correctly returns
`unsupported-platform`. The test work is sound and does what it claims; it simply does not
change production behaviour, and was not meant to. **A green suite is therefore not
evidence that C-7 is fixed**, and this reply does not present it as such. The condition
for calling it fixed is fixed in advance: the non-Linux branch must be observed firing
with the default `procRoot`, and reverting the criterion must kill a named test.

**C-7 now has failing tests behind it, not just a code reading.** Once the non-Linux probe
was corrected to actually intercept `/proc`, four cases fail with C-7 unfixed — in
`mojo-backend.test.ts`, `mojo-close-admission-fence.test.ts` (two) and
`mojo-close-failclosed.test.ts` — and applying the one-line fix clears exactly those four.
All four are on the close path, which is where the `unscannable` → `fence` versus
`unsupported-platform` → `residual-close` fork decides the outcome, so the reasoned
consequence and the measured failures agree. Two things follow: C-7 is a real macOS
behaviour defect rather than only a wrong comment, and **test-side seam conversion plus
gating cannot make macOS clean without the production fix.**

**A gate we added, and then checked was necessary.** One mutation on the new platform
gating survived, which would ordinarily be reported as a gap. Instead the charge-D author
treated a surviving mutation as evidence the gate was **over-scoped** — gating cases that
did not need it silently reduces real macOS coverage — and narrowed it. Worth stating
because the failure mode it avoids is the one this round is about: a gate that makes the
suite look clean by declining to test anything.

**How this round avoided publishing a false fix.** After charge B there are two distinct
fields named `boundaryProof`. Stated precisely, because an unqualified version of this
sentence would itself be a new overstatement:

- `ContainmentReleaseDecision.boundaryProof`, added in `mojo-containment.ts`, **is** a
  real production gate: it drives `releaseAuthorised`, which controls handle deletion.
- `TurnQuiescence.boundaryProof`, the field all five false-claim comments name, is a
  **different field of a different type** and its wiring is charge A's work.
- The two must not be counted together by `git grep '\.boundaryProof'`.

The verification command published in the audit returns two hits once charge B is in the
tree, which reads as "consumed, claims resolved". Because those five comments name the
`TurnQuiescence` field, that reading would have been a fresh false claim generated by the
audit's own tooling. The audit now judges those five comments only against the
disambiguated `TurnQuiescence` count, and records the trap so the next reader does not
fall into it.

### The old tests were themselves evidence of the hole

Charge B's diff is worth reading as an admission, not just a fix. Two distinct groups,
kept separate because they prove different things:

**Five assertions across four test cases were deleted.** Each one asserted the handle was
discharged after a clean weak scan — the unsafe behaviour, pinned as an expectation:

- `test/mojo-containment-cross-generation.test.ts:180` — `hasUnprovenContainment(...)` → `false`
- `test/mojo-containment-cross-generation.test.ts:181` — `containmentHandles(...)` → `[]`
- `test/mojo-containment-wiring.test.ts:125` — `containmentHandles(...)` → `[]`
- `test/mojo-containment-wiring.test.ts:270` — `containmentHandles(...)` → `[]`
- `test/mojo-containment-wiring.test.ts:557` — `containmentHandles(...)` → `[]`

Line numbers are at baseline `c8122d89`. Reproduce with:

```
git diff c8122d89 8d764534 -- test/mojo-containment.test.ts \
  test/mojo-containment-cross-generation.test.ts test/mojo-containment-wiring.test.ts \
  | grep '^-' | grep expect
```

**Three call sites were modified rather than deleted**, in
`test/mojo-containment.test.ts`: calls of the form
`releaseContainmentHandle({ proven: true, handle }, dataDir)` now have to carry an
explicit evidence value to release at all. Two were changed to
`evidence: 'boot-id-changed'` to keep releasing, and one new case asserts that
`evidence: 'scan-clean'` does **not** release.

The two groups say different things. The deleted assertions show the old suite had
**pinned the unsafe behaviour as correct**, which is why a green suite gave no warning.
The modified call sites are direct evidence for audit finding C-4: `proven: true` alone
was sufficient to release, exactly as C-4 said the type could not prevent. Together they
are the full evidence chain for C-4, and they are stronger than any prose admission we
could offer.

**Nine of ten audited claims were substantiated,** including one — `edgeResolved` —
that the automated sweep initially scored as a second false claim. It is genuinely
wired via a `switch` discriminant into `state.edges`, which real gating logic reads.
The sweep's regex under-counts string-literal discriminants; every zero-read result was
hand-verified for that failure mode before being called false. Recording this because
an unchecked sweep would have produced a false accusation, and a reverse audit that
manufactures charges is no better than one that misses them.

The audit is recall-limited: 406 comment lines match the broad claim vocabulary, the
identifier-naming filter narrows to 22, and claims not naming an identifier in
backticks are outside the sweep. The report does not assert the repository is now free
of unwired claims.

---

## Two defects that only integration could expose

Both were found after the branches were merged, and neither is visible from any single
branch. They are included because they are the strongest available evidence that the
verification in this round was real rather than ceremonial.

**1. A cross-layer contradiction, lying in the safe-looking direction.**
`proveTurnQuiescence` discarded the return value of `releaseContainmentHandle` and
re-derived the answer from `handle.kind`. For a weak handle whose recorded boot id had
changed, the handle really was released — `handles_left = 0` — while the outcome still
reported `diagnostic-clean` with `residual.deviceIsolation = true`. That asks the daemon to
retain a device-isolation blocker **whose only evidence had just been deleted**.

This is finding C-3 reappearing as a live bug: the blocker *is* the handle, so a residual
claim that outlives the handle is not conservative, it is false. It happens to fail toward
"looks safe", which is exactly the direction that survives review. After the fix, reading
`decision.boundaryProof` instead, the three facts agree: `boundaryProven: true`,
`residual: null`, `handles_left: 0`.

**2. A sixth fail-open assertion.** `test/mojo-backend.test.ts:148` asserted
`toEqual({ ok, taskId })` — requiring the residual to be **absent** — in a case that does
dispatch a turn and has only a clean scan. That is precisely the reviewer's reproduction:
a plain `closed` row for an unproven subtree, pinned as the expected result. It now requires
`residual: 'local_subtree_boundary_unproven'`.

Counting it with the five in charge B, **six assertions in the suite had encoded the unsafe
behaviour as correct.** That is the mechanism behind the round-4 failure, stated plainly: a
green suite was evidence that the code did what the tests expected, and the tests expected
the bug.

## Mutation testing, re-run on the integration tree

Branch-level mutation results were not carried over: merging can resurrect a mutation that
a branch had killed, so all five were re-run on the final tree.

| Mutation | Result | Named failures |
|---|---|---|
| M1 treat scan-clean as boundary proof (restores the original hole) | KILLED | 16 |
| M2 remove the containment release guard | KILLED | 6 |
| M3 let diagnostic-clean claim `boundaryProven: true` | KILLED | 11 |
| M4 revert the cross-layer consistency fix | KILLED | **1** |
| M5 make the sole factory return diagnostic-clean | KILLED | 4 |

M1 rose from 13 named failures on its own branch to 16 after merging, which is the
integration effect working in the useful direction.

**M4 is reported as thin, not as a pass.** One named failure means the guard around the
cross-layer fix rests on a single test. It is a kill, and it is weak, and calling it
anything else would be the behaviour this round is correcting.

---

## Field-contract mapping to the reviewer's proposed shape

The reviewer proposed `{ quiescent, boundaryProof, residualRequired }`. The
implementation uses a superset with an explicit evidence discriminant. The reviewer's
shape is **adopted, not declined** — every field maps one-to-one:

| Reviewer's field | Implemented as | Relationship |
|---|---|---|
| `quiescent` | `ok` | Same meaning: the termination sequence completed without internal error. Explicitly **not** a boundary claim. |
| `boundaryProof` | `boundaryProven` | Same meaning: the real gate. True only for unforgeable kernel evidence. |
| `residualRequired` | `residual !== null` | Same meaning, carrying the payload the boolean implies — `{ deviceIsolation, pids?, reason? }`. |

Two fields were added because the audit showed a three-field shape cannot express the
distinction that failed this round:

- `evidence: 'members-empty' | 'esrch' | 'diagnostic-clean' | 'timeout' | 'unknown'` —
  names *why* the boundary is or is not proven. Without it, `diagnostic-clean` is
  indistinguishable from a real proof at the call site, which is the original defect.
- `signalsStopped: boolean` — lets `diagnostic-clean` stop repeat signalling, which is
  legitimate, without that being mistaken for release authority.

Hard semantics, each carrying an assertion intended to be mutation-killable:

- `evidence === 'diagnostic-clean'` ⇒ `boundaryProven` is `false` **and** `residual` is
  not `null`. A clean scan may set `signalsStopped`, never release.
- `residual.deviceIsolation === true` ⇒ the handle is not released and no plain
  `closed` row is authorised. The session may close; the device-isolation blocker is
  retained.
- `ok === true` with `boundaryProven === false` is legal and common.
  `boundaryProven` is not tied to `ok`.
- Only `boundaryProven === true` may delete a containment handle and lift the blocker.
- Release decisions are made solely in `mojo-containment.ts`; `mojo-backend.ts` does
  not release or rewrite a containment handle.

This is the reviewer's recommended **second** option — `diagnostic-clean` stops
signalling but leaves a local residual and does not authorise a plain `closed` row —
not the first.

---

## Reviewer-approved work left intact

Per the review, the following were not disturbed: the cgroup strong handle as the
correct authority; boot-ID/starttime verification before signalling a weak PID;
non-Linux no longer wedging permanently; a corrupt store no longer taking down the
daemon; admission fencing and durable recovery; and the three post-squash commits
remaining test-only with no production drift.
