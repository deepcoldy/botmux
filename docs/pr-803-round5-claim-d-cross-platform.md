# mojo containment tests: platform scope and evidence (指控D)

Baseline: c8122d89. Verified on the integration line (see "Measured results").
All numbers below were produced on THIS devbox, which is **Linux**. There is **no
Darwin hardware available**, so every non-Linux number is an EMULATION and must be
quoted as "procRoot injection plus platform and node:fs mocking, no Darwin
hardware", never as a macOS measurement.

## READ THIS FIRST: test gating does NOT make macOS green

An effective non-Linux probe (see "Correction" below) shows **4 mojo cases still
fail off Linux after all the test work in this document**, and that applying the
one-line production fix in "Handed off" clears exactly those 4, taking the
emulation to 0 failed. So:

- the seam/gating work removes the failures that were caused by tests reaching for
  an instrument that does not exist off Linux;
- the remaining off-Linux failures are a **production defect**, not a test defect,
  and cannot honestly be closed by any change under `test/`.

Any claim that macOS is clean is unsupported until that fix lands.

## What was wrong

1. `test/mojo-containment-wiring.test.ts` seeded 9 fake `/proc` trees by reading
   the host's real `/proc/sys/kernel/random/boot_id`, only so the recorded handle
   would agree with what the scanner reads back. The scanner reads the boot id
   through the `procRoot` seam, so that host read was unnecessary — and it is what
   killed the case off Linux.
2. Neither `mojo-containment-wiring.test.ts` nor `mojo-containment.test.ts` had a
   single platform gate. Cases needing a real live child simply failed off Linux.
   Two cases in `mojo-containment.test.ts` used `if (platform !== 'linux') return`,
   which reports a PASS for work never performed.
3. Production defect found while doing this, in a file this task does not own
   (`src/adapters/backend/mojo-process-tree.ts`), so it was handed over rather
   than landed here — see "Handed off". `mojoTreeScanSupported()` claimed an
   explicit `procRoot` override "is never set in production", but every production
   call site passes `{ procRoot: this.procRoot }` whose default is `'/proc'`. So
   `procRootOverridden` was always true and the non-Linux gate was **dead on the
   whole backend path**: off Linux the scanner reads a `/proc` that does not exist
   and returns `unscannable` (which FENCES the session) where
   `unsupported-platform` (residual close, device-isolation blocker retained) is
   correct.

## Changes

- New `test/helpers/synthetic-proc.ts`: platform-independent synthetic `/proc`
  fixture (`syntheticProcRoot`, synthetic boot id, `addProcess`,
  `addUnparsableProcess`) plus the shared `isLinux` flag. It inspects nothing on
  the host. **The injected `procRoot` is always a fresh temp directory, never the
  string `'/proc'`** — relevant to the handed-off fix, which keys on exactly that.
- `test/mojo-containment-wiring.test.ts`: all 9 fake-`/proc` sites go through the
  fixture + `procRoot` seam. The only remaining real-`/proc` read is inside
  `liveWeakHandle()`, which exists precisely to agree with the REAL kernel; every
  caller of it is gated. A file-header PLATFORM SCOPE block states the rule.
- `test/mojo-containment.test.ts`: header scope block; the two implicit
  early-return skips became explicit `it.runIf(...)`, so a case can no longer
  report a pass for work it never performed.
- Explicit `runIf(isLinux)` gates where the case needs a real live child, real
  signalling, or a readable boot id: `mojo-containment-wiring.test.ts`,
  `mojo-containment.test.ts`, `mojo-task9-probes.test.ts` (PROBE 1 and one PROBE 2
  case), `mojo-close-failclosed.test.ts` (5), `mojo-close-admission-fence.test.ts`
  (2), `mojo-backend.test.ts` (1), `mojo-residual-close-admission.test.ts` (1).
- Assertions updated for the structured `terminateChildProven()` contract: where
  the old assertion was `resolves.toBe(true)` the new one asserts `ok === true`
  **and** `boundaryProven === false`, because those cases all hold a scan-only
  weak handle and can never mint boundary proof.
- One assertion in `mojo-backend.test.ts` used `toEqual` on the whole close
  result, which demanded the ABSENCE of the new boundary-unproven residual
  marker — the fail-open the reviewer reproduced. It now asserts the marker.
- Evidence tooling, not part of `pnpm test`: `vitest.non-linux-probe.config.ts`
  and `test/helpers/non-linux-probe-setup.ts`.

## Correction to a previously reported number (probe was too weak)

The first version of the probe reassigned `fs.readFileSync` on the imported
namespace object. That does **not** intercept `import { readFileSync } from
'node:fs'`, because a named import binds the function directly. Tests therefore
kept reading the host's REAL `/proc` and the probe looked green for the wrong
reason. Proof it was ineffective: with **every gate removed**, the containment
wiring suite still reported 34/34 passed under that probe — impossible if `/proc`
had really been unavailable.

The probe now mocks the module through `vi.mock('node:fs')`, which replaces the
module record and so also intercepts named imports. **The earlier emulation
figures (526 / 527 / 534 / 543 passed) were produced by the ineffective probe and
must not be quoted.** Only the figures below are valid.

## Handed off (NOT fixed here, and macOS is not clean until it lands)

    // "overridden" must mean "not the real /proc", not "a procRoot was passed"
    const DEFAULT_PROC_ROOT = '/proc';
    mojoTreeScanSupported({
      platform,
      procRootOverridden: opts.procRoot !== undefined && opts.procRoot !== DEFAULT_PROC_ROOT,
    })

at both call sites (`scanMojoTree`, `readProcessIdentity`), plus the comment
corrected. Evidence gathered here, then the source change reverted out for
ownership reasons:

- mutation: reverting the guard to `procRoot !== undefined` turned the named case
  "does NOT treat the DEFAULT procRoot as an override" red — KILLED.
- effect measurement under the effective probe, each figure measured twice and
  stable: **4 failed** with the defect present, **0 failed** with the fix applied.
  The 4 cleared cases are in `mojo-backend.test.ts`,
  `mojo-close-admission-fence.test.ts` (2) and `mojo-close-failclosed.test.ts`.
  All four are on the close path, which is exactly where the
  `unscannable` (fence) vs `unsupported-platform` (residual close) fork decides
  the outcome — so the reasoning and the failing cases corroborate each other.

Because the fixture always injects a temp directory as `procRoot`, this fix cannot
break the seam-driven tests: they stay `supported === true`.

## How non-Linux was checked (EMULATION, no Darwin hardware)

The probe forces `process.platform = 'darwin'` and makes `readFileSync`,
`readdirSync`, `statSync` and `existsSync` fail/return false for the real `/proc`.

    npx vitest run --config vitest.non-linux-probe.config.ts test/mojo-*.test.ts

What it DOES establish: no case still depends on the host's `/proc`; a case that
does fails loudly; and the handed-off defect changes off-Linux behaviour in a
measurable way.

What it does NOT establish: anything about real macOS fs semantics, process and
signal behaviour, tmux/terminal behaviour, or the exact failure count on a real
Mac. It is not a Darwin run.

## Measured results

Linux (this devbox), `npx vitest run test/mojo-*.test.ts`:

- baseline c8122d89, unmodified: 30 files, **551 passed / 0 failed**
- this work alone (test-only, cp/claim-d): 30 files, **551 passed / 0 failed**
- integration line with indictments A + B + D: 32 files,
  **568 passed / 0 failed**, `tsc --noEmit` clean
- known flakes seen across rounds, each passing in isolation and on re-run, and
  reported as flakes rather than as passes: `mojo-cross-boundary`
  "1. concurrently queued credential turns run A/B/C, not A/C/C" (on the known
  flake list), `mojo-close-worker-journal` "keeps writes fenced when recovery says
  retryable but admission says fenced", and two `mojo-worker-wiring` cases that
  spawn a real worker under parallel load.
- Linux FULL suite after these changes was **not run by this workstream**; only
  the mojo file set above. No full-suite number is claimed here.

Non-Linux EMULATION, effective probe, same file set, on the integration line.
Both figures re-measured twice and stable:

- with the handed-off defect still present (the state as delivered):
  **536 passed / 28 skipped / 4 failed**
- with the handed-off fix applied locally for measurement:
  **540 passed / 28 skipped / 0 failed**

These are measurements of the EMULATION, not of macOS.

Two corrections to figures I circulated earlier for this same pair, both my
error, both found by a reviewer re-running them rather than by me:

- I reported 535 passed. The correct figure is **536**. My run had a fifth
  failure, the known `mojo-cross-boundary` [A][B][C] flake, and I subtracted it
  from the wrong column (535 + 5 + 28 = 568 = 536 + 4 + 28).
- I reported "540 / 27 skipped / 1 failed" for the with-fix state. The correct
  figure is **540 / 28 / 0**: the one remaining failure was the real-setsid task-9
  probe case, which I gated in the same commit, so it is a skip and not a failure
  at this sha.

Neither correction changes the conclusion; both make it stronger, because the
with-fix state is exactly 0 failed rather than 1.

Scope caveat: running the ENTIRE unit suite under this probe also reddens
terminal/tmux/CLI-spawn files (session-picker, worker-*, workflow-cli, ...). Those
reds are probe artefacts — it fakes `platform` and breaks `/proc` process-wide —
and are outside 指控D. No claim is made about them.

## Honest statement about earlier and reviewer numbers

The previously published 135/135 and 558/558 were **Linux-only** results.

Reviewer-reported macOS figures (Odyssey 16 failed / 18 passed on
mojo-containment-wiring; Wallpaper 38 failed / 624 passed full suite) are THEIR
measurements on real hardware. We have not re-measured them and cannot. Our claim
is narrower and is an INFERENCE: the cases that failed for the absence of `/proc`
are now either seam-driven or explicitly skipped. Whether Wallpaper's 38 reaches
exactly 0 on real hardware is **not verified by us**, and it certainly does not
reach 0 while the handed-off production fix is unlanded.
