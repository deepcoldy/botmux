# PR #803 — Round-5 Reverse Audit of Enforcement Claims

Baseline audited: `c8122d89` (origin swtxbling/botmux, `xx_develop/mojo_botmux`).
Auditor scope: charge C (overstated delivery claims) + repo-wide reverse audit.
Platform of record for every count in this document: **Linux**. No Darwin machine
was available; see "Platform scope" below.

## Why this audit exists

Round 4 ran an honesty pass that searched for *exaggerated wording* and reported the
strong assertions cleaned up. It still shipped the single largest false claim in the
mojo close path. The root cause is a methodology gap, not carelessness:

> Round 4 asked "does this sentence sound too strong?"
> It never asked "this comment says field X is consulted — **is there a line of
> production code that reads X?**"

A claim can be perfectly measured, calmly worded and still be false, because the
thing it describes is not wired to anything. This audit inverts the direction: start
from the claim, demand a production consumer, and treat absence of a consumer as a
defect of the same severity as a wrong assertion.

## Method

For every comment in `src/` that names an identifier and asserts it is gated on,
consulted, authoritative, or uniquely privileged, classify each occurrence of that
identifier as one of:

- **COMMENT** — prose only, carries no behaviour.
- **CONSTRUCT / TYPEDEF** — the field is *written* into an object literal, or declared
  as a type member. Proves the value can exist; proves nothing about it being read.
- **READ** — the value is *consumed*: property access in a condition, argument,
  return expression, or `switch` discriminant.

A claim of the form "callers gate on X" is **substantiated only by a READ**. Zero
READ sites means the claim is false regardless of how many CONSTRUCT sites exist.

Harvest and verification are scripted so a reviewer can re-run them, rather than
resting on the auditor's reading:

```
git grep -nE '^\s*(\*|//)' -- src/ \
| grep -Ei '(gate[sd]? (the |a |on )|must consult|may consult|ONLY field|is authoritative|the ONLY source|may only be released|must keep the)' \
| grep -E '`[A-Za-z_][A-Za-z0-9_.]*`'
```

That yields 22 claim comments naming a concrete identifier. Each named identifier was
then checked for READ sites with comment lines and `ident:` construct/typedef lines
excluded.

### Four honest caveats about the method

1. **The regex under-counts reads for string-literal discriminants.** `edgeResolved`
   first scored 0 reads and looked like a second false claim. It is not: it is a
   journal event type consumed by `case 'edgeResolved':` in
   `src/workflows/v3/state.ts:354`, folded into `state.edges`, which is genuinely read
   by `readinessFor` / `isFailureRelevant` / `canCancelLoser` in
   `src/workflows/v3/orchestrator.ts`. The claim in `dag.ts:241` is **true**. Every
   zero-read result below was hand-verified for exactly this failure mode before being
   called false. An automated sweep alone would have produced a false accusation here.
2. **The harvest is recall-limited.** 406 comment lines in `src/` match the broad
   claim vocabulary; the identifier-naming filter narrows that to 22. Claims phrased
   without naming an identifier in backticks are outside this sweep. This audit does
   not assert the repo is free of unwired claims — only that the enumerated set below
   was checked.
3. **A dictated number is an unmeasured number.** This audit's own rule was "never
   publish a figure nobody ran". It was still broken twice, in the mildest-looking way
   available: a teammate reported counts verbally, the figures were written into the
   reply as `552 passed` and `527 passed / 25 skipped`, and neither was ever executed.
   Re-running both branches gave `551`, and `526 / 534` for the simulated side — so the
   published numbers were simply wrong. (Those simulated replacements were themselves
   voided later, for an unrelated reason: see caveat 4. The correction chain here is
   relayed → measured → retracted-as-meaningless, which is worth following in full rather
   than tidying into a single right answer.) The lesson generalises past this PR:

   > Relaying a number is indistinguishable, in the document, from measuring it. A
   > reader cannot see the difference, so the writer carries the whole burden. "A
   > colleague told me" is not a weaker form of evidence than "I ran it" — for the
   > purpose of a claim, it is the *same* failure as inventing it.

   Corrected practice, applied to every figure now in these documents: either the author
   of the reply ran it, or the figure carries an explicit attribution naming whose
   measurement it is and on what platform. The `probe3` before/after table and the
   charge-D counts were re-run here for that reason; the reviewers' macOS numbers are
   labelled as theirs precisely because they could not be.

   This caveat is kept in the methodology section rather than buried in a changelog
   because it is the same defect class the whole round is about — a claim that outruns
   its evidence — committed by the document whose job was to find them. Recording it is
   worth more than having avoided it silently.
4. **A passing test can be evidence of nothing.** The mirror image of caveat 3, and it
   cost this round four retracted figures. The non-Linux probe reassigned `readFileSync`
   on the imported `fs` namespace object; because modules bind named imports directly
   (`import { readFileSync } from 'node:fs'`), nothing observed the reassignment and the
   suites kept reading the host's real `/proc`. Every case passed, and the passes meant
   nothing — the probe was **green for the wrong reason**.

   What makes this worth recording is how it was caught. Its author did not re-read the
   mock looking for bugs; he **deleted every platform gate** and re-ran. The suite stayed
   34/34 green, which is impossible if `/proc` were genuinely unavailable. That is a
   falsification test on the instrument itself:

   > Before trusting a green suite as evidence for a property, break the property on
   > purpose. If the suite stays green, it was never measuring that property, and its
   > passes carry no information.

   Stated as a family, this round produced three ways a claim can outrun its evidence,
   and all three occurred:
   - a comment claims a field is consulted, and nothing reads it (findings C-1, C-7);
   - a figure is relayed rather than measured, and is simply wrong (caveat 3);
   - a suite passes without exercising what it purports to (caveat 4).

   None is caught by reading prose for exaggeration, which is why round 4's honesty pass
   missed the largest claim in the tree. Each needs its own falsification step: grep for
   a consumer, re-run the number, break the property.

## Result table

| Identifier | READ sites in `src/` | CONSTRUCT/TYPEDEF | Verdict |
|---|---|---|---|
| `boundaryProof` | **0** | 21 | **FALSE CLAIM — zero consumers** |
| `supportsTypeAhead` | 9 | 13 | substantiated |
| `sandboxRequested` | 22 | 0 | substantiated |
| `readIsolation` | 36 | 18 | substantiated |
| `agentFrozen` | 16 | 0 | substantiated |
| `unionId` | 166 | 39 | substantiated |
| `reliableTurnTerminal` | 18 | 13 | substantiated |
| `claudeDataDir` | 40 | 3 | substantiated |
| `edgeResolved` | 0 by regex → **wired** on inspection | 0 | substantiated (see caveat 1) |
| `sessionAgentConfig` | 4 | 0 | substantiated |

**`boundaryProof` is the only enforcement claim in the audited set with no production
consumer.** Reproduce:

```
git grep -nE '\.boundaryProof' -- src/ | grep -vE ':[0-9]+:\s*(\*|//)'
```

Empty output at `c8122d89`. Every one of the 21 remaining occurrences is a comment, a
union-member type declaration, or a field written into a returned literal. The field
is manufactured 21 times and consulted zero times.

## Finding C-1 — five comments assert a gate that does not exist

| Site | Claim | Status |
|---|---|---|
| `src/adapters/backend/mojo-process-tree.ts:97` | "`boundaryProof` is the ONLY field a blocker decision may consult." | False. No blocker decision consults it. |
| `src/core/mojo-containment.ts:818` | "Callers gate the blocker on `boundaryProof === true` only." | False. Zero callers do. |
| `src/adapters/backend/mojo-backend.ts:227` | "Exposed so the containment/blocker decision can require `boundaryProof === true`" | Misleading. It is exposed; nothing requires it. |
| `src/adapters/backend/mojo-backend.ts:603-606` | "`lastTurnQuiescence.boundaryProof` is the field that says whether a real boundary was established ... Callers that gate a credential blocker must consult that, not this boolean." | False. No caller consults it. |
| `src/adapters/backend/mojo-backend.ts:632-636` | "Whoever decides whether the session's device-isolation blocker may be dropped must consult `lastTurnQuiescence.boundaryProof`" | False, and sited three lines above the very statement that destroys the distinction (`:637`). |

The last two are the sharpest instance of the pattern this audit exists to catch: both
are *instructions to a future reader*, written in the present tense of a *description of
behaviour*. Nothing in the codebase obeys either. The `:632-636` NOTE is especially
stark because it sits directly above

```
src/adapters/backend/mojo-backend.ts:637
    return q.kind === 'contained-proven' || q.kind === 'diagnostic-clean';
```

which collapses the two evidence grades the NOTE has just finished distinguishing.

## Finding C-2 — the one real consumer reads a different field

`lastTurnQuiescence` has exactly one production read:

```
src/adapters/backend/mojo-backend.ts:1065:
  const verdict = classifyUnprovenTermination(this.lastTurnQuiescence?.kind);
```

It consults **`.kind`**, not `.boundaryProof`. This is materially worse than "the
field is unused", because the evidence grade is destroyed one frame earlier:

```
src/adapters/backend/mojo-backend.ts:630-638
private async terminateChildProven(): Promise<boolean> {
    const q = await this.proveTurnQuiescence();
    // ... the :632-636 NOTE quoted in Finding C-1 sits here ...
    return q.kind === 'contained-proven' || q.kind === 'diagnostic-clean';
}
```

`contained-proven` (`boundaryProof: true`) and `diagnostic-clean`
(`boundaryProof: false`) collapse into the same `true`. At the consumption site
(`:1048`, `if (!await this.terminateChildProven())`) the `.kind` read at `:1065` sits
**inside the false branch only**. A `diagnostic-clean` turn returns `true`, never
enters the branch, and proceeds to a plain close — so no evidence grade is examined on
the path that actually matters. The audit trail confirms the reviewer's charge A: the
field is not merely unconsumed, it is unconsumable by construction.

## Finding C-3 — a self-contradictory comment (not in the original charge list)

`src/core/mojo-containment.ts:815-818` states:

> "releasing a weak handle from the durable store is legitimate ... but it must not
> license clearing a device-isolation blocker"

These two clauses contradict each other, because handle presence **is** the blocker:

```
src/core/device-isolation-daemon.ts:539-544
function hasDurableContainmentHandle(sessionId: string): boolean {
  try { return hasUnprovenContainment(sessionId); } catch { return true; }
}

src/core/mojo-containment.ts:701-703
export function hasUnprovenContainment(sessionId, dataDir?): boolean {
    return containmentHandles(sessionId, dataDir).length > 0;
}
```

`releaseContainmentHandle()` deletes the handle from the store
(`mojo-containment.ts:733-738`). Releasing a weak handle therefore *is* the act of
clearing the blocker. The comment describes an intended separation between "leaving
the store" and "clearing the blocker" that the code does not implement. This was
found by the reverse-audit sweep and is not part of charges A–D as filed.

## Finding C-4 — `proven: true` carries no evidence grade

`releaseContainmentHandle`'s docstring (`mojo-containment.ts:705-716`) claims taking a
verdict makes "clear the blocker without proving quiescence" *unrepresentable at the
type level*. Precisely scoped, this is narrower than it reads:

```
export type QuiescenceVerdict =
    | { proven: true; handle: ContainmentHandle; reason?: string }
    | { proven: false; handle: ContainmentHandle; reason: string; residualPids?: number[] };
```

The type prevents spending a `proven: false` verdict — that part is real, and it is a
runtime `throw`, not a compile-time guarantee, at the call site. What it does **not**
do is distinguish a cgroup proof from a scan-only proof: both inhabit
`{ proven: true }`. A weak handle whose scan came back empty mints the same
`proven: true` that a kernel-verified empty `cgroup.procs` mints, and
`mojo-backend.ts:893` spends it. "Unrepresentable" should read "a `proven: false`
verdict cannot be spent; evidence strength is not encoded in this type."

## Finding C-5 — overstatements in the delivered commit message `76ef13bc`

`76ef13bc` is already pushed. It is **not** being rewritten (no force push); the
corrections below are published here and in the round-5 reply, and restated in the
new commit message.

| Claim in `76ef13bc` | Correction |
|---|---|
| "A clean scan can no longer authorise a plain closed row." | Holds for cgroup strong handles and for macOS `unprovable` handles. **Does not hold for a Linux weak handle**: an empty scan yields `proven: true`, `releaseContainmentHandle()` drops the handle, and a plain `closed` row follows. |
| "a proven weak handle maps to diagnostic-clean and may leave the store, but never clears the blocker" | Second half is false. Leaving the store *is* clearing the blocker (Finding C-3). |
| "Releasing a handle demands a proven quiescence verdict, which makes clearing the device-isolation blocker without proof unrepresentable in the type system" | Over-scoped. See Finding C-4: evidence strength is not in the type; a weak scan mints `proven: true`. |
| "Only a cgroup handle with an empty procs file can mint boundaryProof true" | **True.** All three mint sites are cgroup-gated — see Finding C-6 for the full enumeration. Retained as accurate. |

## Finding C-6 — "the single place in the codebase" is false (three mint sites)

`src/core/mojo-containment.ts:796` and `:802` claim:

> `// ── the ONLY source of boundaryProof: true ──`
>
> "This function is the single place in the codebase allowed to mint
> `{ kind: 'contained-proven', boundaryProof: true }`"

`contained-proven` with `boundaryProof: true` is minted at **three** production sites:

| Site | Gate | In `containmentQuiescence()`? |
|---|---|---|
| `src/core/mojo-containment.ts:830` | `verdict.handle.kind === 'cgroup'` | yes — the function the claim describes |
| `src/core/mojo-containment.ts:871` | `allStrong` (every handle `cgroup`) | **no** — `sessionContainmentQuiescence()`, a different function |
| `src/adapters/backend/mojo-backend.ts:899` | `outstanding.every(h => h.kind === 'cgroup')` | **no** — a different *module* |

Reproduce:

```
git grep -n "contained-proven', boundaryProof: true" -- src/
```

So the claim is false twice over: not the single place in the file, and not the single
place in the codebase. Note carefully what is **not** wrong here — every one of the
three sites is correctly gated on cgroup-kind handles, so the *safety* property
("only a cgroup handle can mint boundaryProof true") genuinely holds. What fails is the
*architectural* claim of a single choke point, which is what a future reader would rely
on when adding a fourth site.

### Disposition: resolved on the integration line (measured)

At integration `2ea5e3f6` the three mint sites are collapsed into a single exported
factory, so the claim this finding falsified is now **true**:

```
git grep -nE "contained-proven'[,;] (boundaryProof|boundaryProven): true" 2ea5e3f6 -- src/
  src/core/mojo-containment.ts:982        <- the only production mint, inside the factory
  src/adapters/backend/mojo-process-tree.ts:110   <- type declaration, not a mint

git grep -n containedProvenQuiescence 2ea5e3f6 -- src/
  mojo-containment.ts:981    export function containedProvenQuiescence()
  mojo-containment.ts:995    call
  mojo-containment.ts:1040   call
  mojo-backend.ts:930        call   <- formerly the independent mint at :899/:923
```

The former independent mint in `mojo-backend.ts` now calls the factory instead of building
the verdict itself. One production constructor, three callers. C-6 is **resolved**, and
the "single place in the codebase" wording it objected to has become accurate rather than
being deleted.

Recording the sequence honestly: an earlier measurement of this audit found the fix present
only as **uncommitted working-tree changes** and therefore still reported C-6 as open.
Uncommitted work is not delivered work, on the same principle that a green suite is not a
fixed defect. The reclassification above rests on the committed rev.

This audit initially cited only two of the three sites. That error was caught by
enumerating mint sites mechanically instead of reading the two the comment pointed at
— the same class of mistake this audit exists to find, and the reason the enumeration
command is published above rather than the conclusion alone.

## Platform scope of previously reported counts

Every test count in the round-4 delivery and in the three post-squash commits was
produced on Linux and was published without a platform qualifier. Restated:

| Reported | Corrected |
|---|---|
| 135/135 mojo suites | 135/135 **on Linux** |
| 558/558 full suite | 558/558 **on Linux** |
| "549 tests all pass" (`530ff22f`) | 549 **on Linux** |
| "551 tests green" (`263bdb95`) | 551 **on Linux** |

Independent macOS runs contradict the unqualified reading: Odyssey measured
`mojo-containment-wiring` at 16 failed / 18 passed, and Wallpaper measured 38 failed /
624 passed across the suite. Those macOS numbers are the reviewers' measurements,
reproduced here as reported; this audit did not have a Darwin machine and does not
present any macOS figure as its own observation.

## What this audit does not cover

- It does not verify the round-5 fixes; it audits claims at `c8122d89`, pre-fix.
- It is recall-limited as described in caveat 2.
- `test/` was excluded from the consumer sweep on purpose: a test reading
  `boundaryProof` does not make a production gate exist. Notably
  `test/mojo-containment.test.ts:475` asserts containment is the only source of
  `boundaryProof: true` — which is true and remains true, and is precisely why the
  unwired field went unnoticed: the tests around it all pass.

## Finding C-7 — a claim that inverts reality: "never set in production"

Found by CrossPlatform while converting the fake-`/proc` tests; independently verified
here. This is a **third category** of false claim, distinct from the two above. C-1 was
"claimed consulted, never read". C-3 was self-contradictory. This one asserts a thing
*never* happens when it *always* happens.

`src/adapters/backend/mojo-process-tree.ts:182-183` (baseline `c8122d89`):

> An explicit `procRoot` override opts back in: that is how a test points the scanner at
> a synthetic tree, and **it is never set in production**.

The override is set on **every** production call. Measured:

```
src/adapters/backend/mojo-backend.ts:594
    protected get procRoot(): string { return '/proc'; }
```

`procRoot` is therefore always a defined string, and every production scan passes it —
`mojo-backend.ts:698`, `:740`, `:854`, `:864`, `:870`, `:932`, `:936`, `:950`, `:1402`.
The gate reads:

```
src/adapters/backend/mojo-process-tree.ts:319 (and :390, identically)
  if (!mojoTreeScanSupported({ platform, procRootOverridden: opts.procRoot !== undefined })) {

src/adapters/backend/mojo-process-tree.ts:185-190
  export function mojoTreeScanSupported(
    opts: { platform?: string; procRootOverridden?: boolean } = {},
  ): boolean {
    if (opts.procRootOverridden) return true;
    return (opts.platform ?? process.platform) === 'linux';
  }
```

Because `opts.procRoot !== undefined` is always true on the backend path,
`mojoTreeScanSupported()` short-circuits to `true` **on every platform**, so the
non-Linux refusal at `:319` and `:390` never fires in production. The comment three
lines above the gate describes the one condition that would make the gate work, and
asserts it holds, while the production wiring guarantees it does not.

Reproduce at baseline:

```
git grep -n "never set in production" c8122d89 -- src/
git grep -n "procRoot: this.procRoot" c8122d89 -- src/
git grep -n "get procRoot" c8122d89 -- src/
```

Why this matters beyond the wording: the surrounding docstring justifies refusing
enumeration outright off Linux, on the grounds that a non-Linux `/proc` "either does not
exist or does not mean the same thing" and must not be "allowed to fail its way into a
misleading nothing is running". That safety argument is sound, and the gate implementing
it was inert on the very path it was written to protect.

**The concrete consequence, as identified by the finder.** Because the platform gate never
fires on the backend path, a macOS scan falls through to `unscannable` rather than
`unsupported-platform`. Those two verdicts route to opposite outcomes:

```
src/adapters/backend/destroy-result.ts:201-220  (classifyUnprovenTermination)
  kind === 'unsupported-platform'  ->  outcome: 'residual-close'
  everything else, incl. 'unscannable'  ->  outcome: 'fence'
```

And at the consumption site those outcomes diverge completely:

```
src/adapters/backend/mojo-backend.ts:1065-1082
  residual-close : deliberately does NOT set admissionFenced; logs a residual marker;
                   execution CONTINUES into the remote cancel; the device-isolation
                   blocker is carried by the durable containment handle.
  fence          : this.admissionFenced = true; the close returns ok:false.
```

So the inert gate does not merely mislabel a verdict. It sends macOS down the `fence`
branch on the one class of host where **no retry, no delay and no operator action can
ever produce a proof**, because there is no `/proc` to enumerate. `residual-close` exists
precisely to stop that from happening.

**Severity: this is the round-4 fix undone by its own gate.** The reviewers explicitly
credited this work with "non-Linux 不再永久 wedge" — the permanent-wedge repair is listed
among the parts they told us not to touch. C-7 means that repair is void on macOS: the
verdict which routes to `residual-close` is unreachable, so the wedge behaviour returns.
That is why this finding outranks C-6, which is an architectural-claim defect with the
safety property intact. C-7 is a claimed-and-credited fix that does not hold on the
platform it was written for.

**Status at time of writing: located, repair handed off, NOT YET LANDED.** The finder
implemented and verified a fix (reverting it made the named case go red — a killed
mutation), but `mojo-process-tree.ts` is owned by another contributor this round, so the
change was reverted from the finder's branch and the repair reassigned. Verified at
`cp/claim-d` (`a4b95950`): the `never set in production` comment is still present at
`:183` and neither `DEFAULT_PROC_ROOT` nor `isProcRootOverridden` exists in `src/`. This
finding is therefore recorded as **open**. It must not be read as fixed.

> **状态更新（2026-08-17，head `a8988cb4` 及之后）：C-7 已落地并关闭。**
> 上一段描述的是 `a4b95950` 时点的状态。当前树中
> `src/adapters/backend/mojo-process-tree.ts` 已导出 `DEFAULT_PROC_ROOT` 与
> `isProcRootOverridden`，backend 经 `procRoot` seam 传递平台判定，非 Linux 主机
> 路由到 `unsupported-platform` → `residual-close`。上文列出的四个失败用例在
> Linux 全部转绿。本条不再是 open 项；保留原文仅作审计记录。

### C-7 is a measurable defect — but the measurement no longer reproduces at the delivery sha

This finding first rested on reading the code. It then gained failing tests, once the
non-Linux probe was corrected to actually intercept `/proc` (caveat 4). Measured by the
charge-D author on his branch with **C-7 unfixed**:

```
535 passed / 28 skipped / 4 failed

  test/mojo-backend.test.ts               returns a failed prepare with the exact known
                                          lineage when cancel fails
  test/mojo-close-admission-fence.test.ts does not claim restoration after the session was
                                          already torn down
  test/mojo-close-admission-fence.test.ts still restores admission when the local subtree
                                          was PROVEN gone and only the remote cancel failed
  test/mojo-close-failclosed.test.ts      refuses the close when a dispatched turn never
                                          produced its lineage
```

He reported that applying the one-line C-7 fix locally cleared exactly those four. All four
sit on the close path, which is where the `unscannable` → `fence` versus
`unsupported-platform` → `residual-close` fork decides the outcome, so the reasoned
consequence and the observed failures agreed.

**At the delivered integration tip, those four failures do not reproduce.** Measured by
this audit at `1e66ca04`, mojo suites under the corrected probe:

```
540 passed / 28 skipped / 0 failed
```

The two admission-fence cases were confirmed to **run and pass** (verbose reporter shows
them as `✓`, not skipped), so they were not silenced by gating. And **no C-7 fix landed** —
verified at the same sha: the criterion is still `opts.procRootOverridden`, the two call
sites still pass `procRoot !== undefined` (`mojo-process-tree.ts:474`, `:545`), no
`DEFAULT_PROC_ROOT` / `isProcRootOverridden` exists in `src/`, and the
`never set in production` comment is unchanged at `:338`.

The change is therefore attributable to other work merged in between (residual-assertion
updates on the close path), not to a C-7 repair. This audit did not isolate which commit,
and **does not guess**: the honest statement is that the four failures were real when
measured on that tree, are not reproducible on the delivered tree, and that the inference
"these four are C-7's signature" is consequently **not verified at the delivery sha**.

### The dangerous part: C-7 is now an unguarded defect

Combining the two measurements above:

- the production defect is present at the delivered sha (verified);
- no test in the mojo suites fails because of it, on Linux or under simulation (verified).

So the symptom was cleared while the cause was left in place. That is worse than a visible
failure, because nothing now stands between this defect and a future reader who concludes
from a green suite that the platform gate works. It is caveat 4 recurring — a suite passing
without exercising the property — this time produced by our own legitimate seam conversion
rather than by a broken mock.

Restated as a constraint on the delivery: test-side seam conversion and platform gating
**do not** fix the production gate. They stopped the tests from depending on the host
`/proc`, which was their purpose and which they achieved. Neither they nor a green suite
may be offered as evidence that cross-platform behaviour is fixed, and no document in this
round makes that claim.

### Why a green Linux suite is not evidence here (measured)

The charge-D branch has the mojo suites at 551 passed / 0 failed while this defect is
still live in production code. That combination is the whole reason this audit exists, so
it is worth making unambiguous with a direct measurement rather than an argument.

Probe run by this audit against the charge-D tip (`a4b95950`), forcing
`process.platform` to `'darwin'` and calling `scanMojoTree` two ways:

```
scanMojoTree(pid, nonce, { procRoot: '/proc' })   // exactly what mojo-backend.ts does
  -> ok               (the scan PROCEEDS: the non-Linux gate never fires)

scanMojoTree(pid, nonce, {})                      // if production omitted procRoot
  -> unsupported-platform   (the gate fires correctly)
```

The gate is not broken in itself — it works when it is reachable. It is unreachable from
the backend path, because that path always supplies `procRoot`. A simulated macOS host
therefore enumerates a `/proc` it should have refused to read, and the verdict that
should have been `unsupported-platform` is not produced at all.

**Both facts are true at the same sha: the tests are green and the production gate is
inert.** The test work is legitimate and does what it claims — it stops the suites from
depending on the host `/proc`. It simply does not, and was not intended to, change
production behaviour. Reading the green suite as evidence that C-7 is fixed would repeat
this round's central error at the exact moment of correcting it, so this finding stays
**open** until a production change is measured on the integration branch.

The condition for reclassifying it as fixed is stated in advance, so it cannot be met by
assertion: the non-Linux branch must be shown to fire with the default `procRoot`, and
reverting the criterion back to `procRoot !== undefined` must kill a named test.

## The overloaded-name trap, and how this audit avoided reporting a false fix

After charge B landed, two distinct fields are both named `boundaryProof`:

| Field | Declared | Production reads |
|---|---|---|
| `ContainmentReleaseDecision.boundaryProof` | `mojo-containment.ts:182` (new) | 2 — `:980`, `:1023` |
| `TurnQuiescence.boundaryProof` | `mojo-process-tree.ts:102-106` (original) | 0 |

The verification command published earlier in this document —
`git grep -nE '\.boundaryProof' -- src/` — returns two hits once charge B is in the
tree. Read naively, that says "the field is consumed, the false claims are resolved".

**That reading would have been wrong**, because all five false-claim comments name
`TurnQuiescence.boundaryProof`, which still has zero production consumers. Publishing
"boundaryProof now has consumers" on the strength of the bare grep would have been a
brand-new false claim of precisely the kind this audit exists to catch — manufactured by
the audit's own tooling, one round after the tooling was introduced to prevent it.

The disambiguated checks, which are the ones that decide the five comments:

```
# the field the five comments name - judge them on THIS number
git grep -nE '(lastTurnQuiescence|lastQuiescence|q|quiescence|cleanVerdict)\??\.boundaryProof' -- src/ \
  | grep -vE ':[0-9]+:\s*(\*|//)'

# the new, genuinely wired gate - real, but NOT evidence about the five comments
git grep -nE 'containmentReleaseDecision\([^)]*\)\.boundaryProof' -- src/
```

Two general lessons, recorded because they outlive this PR:

1. **A field name is not an identity.** Consumer-counting by name breaks the moment a
   name is reused across types, and a rename or a new same-named field silently converts
   a true "zero consumers" into a false "now consumed".
2. **A verification command is itself a claim** and decays as the tree moves. The
   commands in this document are published so they can be re-run, which also means they
   must be re-read against the current shape of the code, not trusted because they were
   correct when written.

### The trap has two forms, and the second one caught our own new work

**Form 1 — same name, different type.** The case above: `TurnQuiescence.boundaryProof`
and `ContainmentReleaseDecision.boundaryProof`. A name-based grep merges them and reports
the unwired one as consumed.

**Form 2 — the claim drifts onto the neighbouring field.** Charge A built the real gate as
`TerminationOutcome.boundaryProven` on `lastTermination`, and left the docstring asserting
the gate sitting on `lastQuiescence`, declared on the **immediately preceding line**:

```
private lastQuiescence: TurnQuiescence | null = null;      <- the comment was attached here
private lastTermination: TerminationOutcome | null = null; <- the gate actually reads this
```

Measured: `TurnQuiescence.boundaryProof` still had zero production readers while
`TerminationOutcome.boundaryProven` had four. So the comment was false about the field it
annotated, and true about the one below it — a one-line displacement, invisible to any
check that greps for the *word* `boundaryProof` and finds four hits.

Worth stating explicitly: form 2 was introduced **by this round's own fix**, not inherited
from the baseline, and it was caught by the same consumer-counting discipline applied to our
own work rather than only to the code under review. An audit that can only find other
people's errors is not a control. It has since been corrected in the delivery.

## C-3 confirmed on live processes (post-charge-B)

C-3 argued from code reading that the device-isolation blocker's only criterion is
whether a handle exists, which made the old comment's separation between "leaving the
store" and "clearing the blocker" incoherent. WeakHandle's real-process harness
(`test/probe3-harness.test.ts`) demonstrates that relationship empirically, and both
sides were re-run independently for this audit on Linux:

| | baseline `c8122d89` | after charge B `8d764534` |
|---|---|---|
| `handles_left` | 0 | 1 |
| `blocker_retained` | false | true |
| `evader_still_alive_at_end` | true | true |

`blocker_retained` is read from `hasUnprovenContainment()` — the function the
device-isolation daemon itself calls — so it reflects the blocker's real state rather
than a self-report. Handle presence and blocker presence move together, which is exactly
what C-3 asserted from reading the code. C-3 is therefore reclassified from
"self-contradictory comment" to **corrected in behaviour**, evidenced rather than argued.

## Standing check for future rounds

Any comment asserting that a field gates, authorises, or is consulted by a decision
must ship with a production READ site, or it must not ship. Re-runnable gate for the
specific field this round:

```
test -z "$(git grep -nE '\.boundaryProof' -- src/ | grep -vE ':[0-9]+:\s*(\*|//)')" \
  && echo 'FAIL: boundaryProof still has zero production consumers' \
  || echo 'ok: boundaryProof is consumed'
```
