#!/usr/bin/env node
// Run the unit suite on `bun test` — the only runner that executes test BODIES
// on Bun. `vitest` forks Node workers even when launched via `bun x vitest`
// (measured), so Bun-specific behaviour (its `fetch` error taxonomy, the
// startup-frozen `os.homedir()`, `Bun.file`, compiled-binary paths) is invisible
// to `bun run test` and can only regress silently there.
//
// ONE FILE PER PROCESS, deliberately. `bun test a.ts b.ts …` runs every file in
// a SINGLE process (measured: two files report the same `process.pid`), unlike
// vitest which forks a worker per file. Handing it the whole suite produces
// cascading cross-file interference rather than real failures — measured on this
// repo: 1010 files batched → 933 failures; the same files one-per-process → ~2%
// red; and individual victims (`fleet-supervisor.integration`,
// `ask-custom-reply-candidate`, `dashboard-ipc`) go 23/23, 8/8 and 170/171 green
// in isolation while failing in the batch. A `vi.mock` of a shared module (e.g.
// `utils/logger`) installed by one file stays installed for later files, so a
// deliberately partial mock in file A becomes a `logger.isDebug is not a
// function` crash in file Z. Per-process execution restores the isolation
// boundary vitest gives for free.
//
// The cost is process startup per file (~21 min wall clock for this suite versus
// a few minutes batched). That is the price of trustworthy results; a leg whose
// failures are mostly artefacts is worse than no leg at all.
//
// A subset of files cannot run here yet: `vi.doMock` / `vi.doUnmock` /
// `vi.resetModules`, the `importOriginal` / `importActual` mock-factory callbacks,
// and `vi.hoisted` are module-registry or transform semantics, not missing
// functions. `test/bun-test-shim.ts` deliberately does NOT fake them — a fake
// would report success while silently not mocking (or, for `hoisted`, run the
// factory too late), which is worse than the current red. Those files keep running
// under vitest until they are rewritten to use dependency injection.
//
// The exclusion list is COMPUTED, never hardcoded: a stale literal list would
// quietly start skipping files (or fail on files that have since been fixed).

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir as realTmpdir } from 'node:os';

const TEST_DIR = 'test';

// Mirror vitest's unit include/exclude exactly: `test/**/*.{test,spec}.ts`,
// minus `test/e2e-browser/**` and `*.e2e.ts`. A non-recursive `readdirSync`
// looked right but silently skipped every nested file (measured: 19 files under
// test/desktop/), and the count line would have looked perfectly healthy — the
// worst shape of a miss. Recurse so a newly added subdirectory joins this leg
// automatically instead of quietly sitting out.
const EXCLUDED_DIRS = new Set(['e2e-browser', 'node_modules', 'helpers', 'fixtures', '__snapshots__']);

function collectTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      found.push(...collectTestFiles(full));
    } else if (/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.e2e.ts')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * A scratch dir plus the env that confines a Bun process to it from BIRTH.
 *
 * Bun boots, resolves its preload's imports and touches its user-level caches
 * BEFORE any of our JS runs, so an in-process fence cannot cover that window —
 * only the spawn env can. Every `bun` this script starts must go through here;
 * a single unfenced spawn writes into the developer's real home and defeats the
 * whole point of the leg (measured: an unfenced probe left
 * `.bun/install/cache/@t@/*.pile` in the inherited HOME).
 *
 * Returns the dir so the caller can delete it — `mkdtemp` never reuses a name,
 * so a leaked one accumulates rather than being overwritten.
 */
function mintFencedEnv() {
  const scratch = mkdtempSync(join(realTmpdir(), 'botmux-bun-child-'));
  const childTmp = join(scratch, 'tmp');
  const childHome = join(scratch, 'home');
  mkdirSync(childTmp);
  mkdirSync(childHome);

  const env = {
    ...process.env,
    TMPDIR: childTmp,
    TMP: childTmp,
    TEMP: childTmp,
    HOME: childHome,
    USERPROFILE: childHome,
  };
  // Exact-path pointers at a live Botmux home never go through `homedir()`, so
  // they have to be dropped in the spawn env too — not just in the preload.
  // Mirrors test/helpers/fence-home-env.ts; kept here as well because that file
  // only runs after Bun has started.
  for (const name of ['BOTS_CONFIG', 'PM2_HOME', 'PLUGIN_PM2_HOME']) delete env[name];

  return { scratch, env };
}

// The exclusion selectors live in test/helpers/bun-leg-selectors.ts so that a guard
// can import and exercise the REAL logic (test/bun-runner-selectors.test.ts) instead
// of a hand-copied duplicate that drifts. They are loaded through Bun because this
// script runs under Node, which cannot import TypeScript directly.
//
// Why a subprocess rather than a loader: this script is the thing that launches bun,
// so it is already a hard dependency, and shelling out keeps the runner free of a
// TS-transform requirement of its own.
function loadDeferredSet(files) {
  // The file list goes over STDIN, not argv. At 1159 files it is 42,604 bytes in a
  // single argument: comfortably under Linux's MAX_ARG_STRLEN (131,072) but 130% of
  // Windows' 32,767-character command-line limit, where it would fail outright — and
  // the failure would grow in with the suite rather than showing up in review.
  const probe = [
    "const { isDeferredFromBunLeg } = await import('./test/helpers/bun-leg-selectors.ts');",
    "const { readFileSync } = await import('node:fs');",
    'const out = [];',
    "for (const f of JSON.parse(readFileSync(0, 'utf8') || '[]')) {",
    "  if (isDeferredFromBunLeg(readFileSync(f, 'utf8'))) out.push(f);",
    '}',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n');
  // This spawn happens BEFORE any test runs, so it is the first thing that could
  // pollute the real home — fence it exactly like a test child.
  const { scratch, env } = mintFencedEnv();
  let res;
  try {
    res = spawnSync('bun', ['-e', probe], { encoding: 'utf8', input: JSON.stringify(files), env });
  } finally {
    removeScratch(scratch);
  }
  if (res.status !== 0 || res.error) {
    console.error('Failed to evaluate the bun-leg selectors:');
    console.error(res.stderr || res.error?.message || `exit ${res.status}`);
    exitCleanly(1);
  }
  try {
    return new Set(JSON.parse(res.stdout));
  } catch {
    console.error(`Selector probe returned unparseable output: ${res.stdout.slice(0, 200)}`);
    exitCleanly(1);
  }
}

// Bun's per-test default is 5s, but the unit project runs at vitest's 30s and
// individual files raise it further via `vi.setConfig({ testTimeout })` — up to
// 180s for the mojo suites. `bun test` has no runtime equivalent for that
// per-file call (the shim accepts it as a no-op), so the ceiling comes from the
// CLI. A generous timeout cannot turn a failing test green; it only stops a slow
// one from being cut short.
const TEST_TIMEOUT_MS = 180_000;
// Hard wall per file, above the per-test ceiling: a file that wedges (waiting on
// a pty, a lock, a socket) must not hold the whole leg open.
const FILE_WALL_MS = 240_000;

const all = collectTestFiles(TEST_DIR).sort();

// Parsed before anything spawns bun: the canary home below depends on it, and a `const`
// read before its declaration is a TDZ ReferenceError — the same runtime-only failure
// class that made an earlier commit run 0 of 994 files.
const selfCheck = process.argv.includes('--self-check');

// In self-check mode, point the RUNNER's own home at a fresh empty directory before
// anything spawns bun. Every `bun` this script starts is supposed to get its env from
// `mintFencedEnv()`; if one does not, it inherits this canary and writes `.bun` into
// it, which a cheap top-level listing then catches.
//
// WHY NOT SNAPSHOT THE REAL HOME: that was the first attempt and it was vacuous. A
// top-level name diff only sees a `.bun` that did not exist BEFORE — and CI runs
// `setup-bun` + `bun install` earlier in the job, so `.bun` always exists by then, as
// it does on any developer machine. Measured: with a pre-created empty `.bun/`, an
// unfenced probe wrote `.bun/install/cache/@t@/*.pile` and the top-level diff was
// EMPTY, so the check reported "untouched" and the fence mutation stayed green. A
// recursive snapshot would fix the blindness but is slow and picks up concurrent
// noise from anything else using the home. An empty canary makes the invariant
// top-level and unambiguous, and never touches the live home at all.
const canaryHome = selfCheck ? mkdtempSync(join(realTmpdir(), 'botmux-bun-canary-')) : null;
if (canaryHome) {
  process.env.HOME = canaryHome;
  process.env.USERPROFILE = canaryHome;
}
function canaryEntries() {
  if (!canaryHome) return [];
  try {
    return readdirSync(canaryHome);
  } catch {
    return [];
  }
}
/**
 * Exit, always removing the canary first.
 *
 * Used by EVERY exit path past the canary's creation rather than by each one
 * remembering to clean up: the failure exits (selector probe throwing, no runnable
 * files, the guard being deferred, an incomplete join) are exactly the ones a person
 * adding a new early return forgets, and each leak is a permanent `mkdtemp` directory
 * — the same lifecycle gap that leaked 51 scratch dirs earlier in this work.
 */
function exitCleanly(code) {
  if (canaryHome) removeScratch(canaryHome);
  process.exit(code);
}

const deferred = loadDeferredSet(all);
const allRunnable = all.filter(f => !deferred.has(f));
const skipped = all.filter(f => deferred.has(f));

if (allRunnable.length === 0) {
  console.error('Refusing to report success: no runnable files were found. Is the test/ directory present?');
  exitCleanly(1);
}

const extraArgs = process.argv.slice(2).filter(a => a !== '--self-check');
// `--self-check` runs ONE trivially-passing file instead of the suite, so every code
// path the real run needs — selector probe, fenced spawn env, per-file constants, the
// close handler, the completeness accounting — actually EXECUTES in a few seconds.
//
// WHY THIS EXISTS: a commit of mine deleted `TEST_TIMEOUT_MS`/`FILE_WALL_MS` while
// leaving their uses. `node --check` passes (a missing binding is a RUNTIME
// ReferenceError, verified), the count line still printed `994 files`, and the leg then
// ran **0 of 994** — caught only by CI, on a green-looking headline. The failure lives
// inside `runOne`, so nothing short of launching a child can see it.
const hasOwnTimeout = extraArgs.some(a => a === '--timeout' || a.startsWith('--timeout='));

// In self-check mode, run the guard for the selectors themselves: it is fast, has no
// external dependencies, and asserts a real result — so "the runner works" and "the
// selectors work" are established by the same few seconds.
const SELF_CHECK_FILE = 'test/bun-runner-selectors.test.ts';
if (selfCheck && !allRunnable.includes(SELF_CHECK_FILE)) {
  console.error(
    `Refusing to self-check: ${SELF_CHECK_FILE} is not in the runnable set. `
    + 'Either it was deleted or the selectors now defer it — both mean the leg is unguarded.',
  );
  exitCleanly(1);
}
const runnable = selfCheck ? [SELF_CHECK_FILE] : allRunnable;
// Keep concurrency moderate: many of these files spawn real daemons, ptys and
// bwrap sandboxes, and oversubscribing turns their internal timeouts into
// spurious reds (measured on a busy host). But do not starve a small runner
// either — one process per file means startup cost dominates, and a 4-core CI
// box running 2 at a time cannot finish 1000+ files inside a sane job timeout.
// Hence: at least 4, at most 8, scaled off the core count in between.
const envConcurrency = Number.parseInt(process.env.BOTMUX_BUN_TEST_CONCURRENCY ?? '', 10);
const concurrency = Number.isFinite(envConcurrency) && envConcurrency > 0
  ? envConcurrency
  : Math.max(4, Math.min(8, Math.floor(availableParallelism() / 4)));

console.log(
  selfCheck
    ? `bun test SELF-CHECK: 1 of ${allRunnable.length} runnable files (${SELF_CHECK_FILE}) — `
      + 'exercising the runner itself, NOT a suite result'
    : `bun test: ${runnable.length} files, one process each, ${concurrency} at a time `
      + `(${skipped.length} deferred to vitest — module-registry APIs)`,
);

// Every child currently running, mapped to the scratch dir minted for it, so a
// cancelled run can take both the processes AND their temp trees with it.
const liveChildren = new Map();

/**
 * Remove a scratch tree without ever taking the run down with it.
 *
 * `rmSync({ recursive: true, force: true })` still THROWS `ENOTEMPTY` when
 * something creates a file mid-delete — `force` only suppresses "already gone".
 * A process we just SIGKILLed has not necessarily reaped yet, so the sweep above
 * races it, and an uncaught throw in a `close` handler killed a 994-file run at
 * file 950 (measured). Retry briefly, then give up: a leftover temp dir is a
 * nuisance, losing the whole run's results is not.
 */
function removeScratch(scratch) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (err) {
      if (attempt === 4) {
        process.stderr.write(`[runner] could not remove ${scratch}: ${err?.code ?? err}\n`);
      }
    }
  }
}

/**
 * Signal a child's process GROUP — deliberately not called a "tree".
 *
 * A grandchild that calls `setsid()` or spawns with `detached: true` leaves this
 * group and survives (measured: a fixture server with PID == PGID == SID outlived
 * its group leader). Killing the group covers the common case — a test's spawned
 * server or pty — and is what makes normal-close and cancellation sweeps work; it
 * is not a guarantee against a descendant that deliberately detaches. Those are
 * the test's own responsibility to clean up.
 *
 * POSIX: `detached: true` gave the child its own process group, and a negative pid
 * signals that whole group. Windows has no process groups in this sense and
 * rejects a negative pid, so shell out to `taskkill /T` (which walks the child
 * tree) and fall back to the direct kill only if that is unavailable — a bare
 * `child.kill()` there would leave the servers and ptys the test spawned running.
 */
function killTree(child, signal) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // `spawnSync` reports a missing/unstartable binary through the RETURN VALUE
    // (`{ error: ENOENT, status: null }`), not by throwing — verified. Returning
    // unconditionally here would treat "taskkill never ran" as success and skip the
    // fallback entirely, so check both fields before trusting it.
    let killed = false;
    try {
      const res = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      killed = !res.error && res.status === 0;
    } catch { /* fall through to the direct kill below */ }
    if (killed) return;
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* group already gone, or never created — fall through */ }
  }
  try { child.kill(signal); } catch { /* already gone */ }
}

// Without this, killing the runner (Ctrl-C, an outer timeout, a supervisor) leaves
// its `bun test` children orphaned to PID 1 — they keep holding ports and CPU and
// corrupt whatever runs next. Reap the tree, then exit with the conventional code.
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const [child, scratch] of liveChildren) {
      killTree(child, 'SIGKILL');
      // Cancellation is exactly when these would otherwise accumulate: the close
      // handler that normally removes them never runs.
      removeScratch(scratch);
    }
    // Same for the canary: the check that normally deletes it is past the join.
    if (canaryHome) removeScratch(canaryHome);
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

function runOne(file) {
  return new Promise(resolve => {
    const args = ['test', ...(hasOwnTimeout ? [] : [`--timeout=${TEST_TIMEOUT_MS}`]), ...extraArgs, file];
    // Per-child scratch root, used for BOTH tmp and home.
    //
    // TMPDIR: most `tmpdir()` uses in `src/` go through `mkdtemp`, but a few derive
    // a FIXED name — `botmux-codex-app-control-<uid>` (src/worker.ts) and
    // `bmcp-<uid>-<sessionKey>` (core/plugins/mcp/host.ts) — which collide across
    // concurrently running files under the same user. Not a home escape, just a
    // concurrency flake surface.
    //
    // HOME: the preload fence cannot cover Bun's OWN startup. Bun boots, resolves
    // and loads the preload's static imports, and touches its user-level caches
    // BEFORE any of our JS runs — measured: `.bun/install/cache` appears in the
    // INHERITED home even on a fenced run. Setting HOME here means the fence
    // exists from process birth; the preload then narrows it further and installs
    // the in-process `node:os` override. Child processes inherit this too.
    //
    // Both this and the selector probe go through `mintFencedEnv()` — deliberately
    // ONE definition. They were duplicated at first with identical values, which is
    // the shape that rots: the next variable added to one copy silently leaves the
    // other unfenced, and the self-check's own error text promises a single point.
    const { scratch, env: childEnv } = mintFencedEnv();
    // `detached: true` puts the child in its OWN process group, so a kill can take
    // the whole tree — `child.kill()` alone signals only the Bun parent and leaves
    // servers/ptys it spawned running (measured: cancelling a run left `bun test`
    // children with PPID=1 alive for minutes, competing for ports and load with the
    // next run and silently poisoning its results).
    const child = spawn('bun', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
      detached: process.platform !== 'win32',
    });
    liveChildren.set(child, scratch);
    let out = '';
    const cap = chunk => { if (out.length < 200_000) out += chunk; };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const wall = setTimeout(() => killTree(child, 'SIGKILL'), FILE_WALL_MS);
    child.on('error', err => {
      clearTimeout(wall);
      liveChildren.delete(child);
      removeScratch(scratch);
      resolve({ file, ok: false, out: `failed to launch bun: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(wall);
      liveChildren.delete(child);
      // Sweep whatever is LEFT in the child's process group. A test that spawns a
      // grandchild and only kills the intermediate process leaves the grandchild
      // running when the Bun parent exits — measured with
      // test/session-preview-ownership.test.ts, whose `LISTEN_SCRIPT` server
      // survived a NORMAL file close as a PPID=1 process holding a port. Deleting
      // the scratch dir without this made a directory-based check look clean while
      // the process was still alive, so sweep BEFORE removing the evidence.
      killTree(child, 'SIGKILL');
      removeScratch(scratch);
      // A signal death (wall-clock kill, OOM) leaves code null — never let that
      // coerce into a pass.
      if (code !== 0) {
        resolve({ file, ok: false, out, signal: signal ?? undefined });
        return;
      }
      // `bun test` exits 0 for a file that collected ZERO tests (measured — both
      // an empty file and an all-`.skip` file exit 0). A file that silently ran
      // nothing is indistinguishable from a passing one by exit code alone, so
      // parse the count and fail closed. `Ran N tests` is bun's own summary line.
      const ran = /^Ran (\d+) tests?/m.exec(out);
      if (!ran) {
        resolve({ file, ok: false, out: `${out}\n[runner] no "Ran N tests" summary — cannot confirm this file executed` });
        return;
      }
      if (Number(ran[1]) === 0) {
        resolve({ file, ok: false, out: `${out}\n[runner] collected 0 tests — a file that runs nothing must not report success` });
        return;
      }
      resolve({ file, ok: true, out });
    });
  });
}

const queue = [...runnable];
const failures = [];
let done = 0;

async function worker() {
  for (;;) {
    const file = queue.shift();
    if (!file) return;
    const res = await runOne(file);
    done += 1;
    if (!res.ok) {
      failures.push(res);
      process.stdout.write(`\nFAIL ${res.file}${res.signal ? ` (killed: ${res.signal})` : ''}\n${res.out}\n`);
    }
    if (done % 50 === 0 || done === runnable.length) {
      process.stdout.write(`… ${done}/${runnable.length} files, ${failures.length} failing\n`);
    }
  }
}

// `allSettled`, so one worker blowing up does not discard the verdicts the others
// already collected — but a rejected worker still FAILS the run. There is deliberately
// NO global `uncaughtException` net: it could not distinguish a scratch-cleanup hiccup
// from a bookkeeping bug, and swallowing the latter could let the process exit 0 with
// an incomplete result set — trading a loud crash for a silent false green. Scratch
// removal degrades locally (see removeScratch); everything else fails closed.
const settled = await Promise.allSettled(Array.from({ length: concurrency }, worker));
const workerErrors = settled.filter(r => r.status === 'rejected').map(r => r.reason);

if (failures.length > 0) {
  console.log('\nFailing files:');
  for (const f of failures) console.log(`  ${f.file}`);
}

// Completeness FIRST, then the summary. Printing "N/N files green" before checking
// these would count files that never ran: a worker crash after 2 of 9 files still
// showed a prominent `9/9 files green` with the INCOMPLETE notice below it — the
// exit code was right but the headline contradicted it, and a human or a log
// excerpt reads the headline.
const incomplete = workerErrors.length > 0 || done !== runnable.length;
if (incomplete) {
  console.error(
    `\nbun test: INCOMPLETE — ${done}/${runnable.length} files ran`
    + `, ${done - failures.length} of those green, ${failures.length} failing`,
  );
  for (const err of workerErrors) console.error(`  worker crashed: ${err?.stack ?? err}`);
  if (workerErrors.length === 0) {
    console.error('  no worker crashed, yet files are missing — results cannot be trusted');
  }
  exitCleanly(1);
}

// The fence invariant, checked BEFORE the green summary for the same reason as
// completeness: a headline nobody can contradict is worse than a loud failure.
//
// The canary home starts EMPTY and only this script's own bun spawns could write to
// it, so any entry at all means a spawn inherited the runner's env instead of
// `mintFencedEnv()`. No recursion needed, no live-home noise, no dependence on
// whether the machine has used Bun before.
if (canaryHome) {
  const leaked = canaryEntries();
  removeScratch(canaryHome);
  if (leaked.length > 0) {
    console.error(
      `\nbun test SELF-CHECK FAILED: a bun spawn escaped the home fence and wrote `
      + `${leaked.join(', ')} into the canary home.`,
    );
    console.error(
      '  Every `bun` this script spawns must take its env from mintFencedEnv() — Bun '
      + 'touches its user-level caches before any preload runs, so only the spawn env '
      + 'can prevent this. On a real run that write lands in the developer\'s home.',
    );
    process.exit(1);
  }
  console.log('bun test SELF-CHECK: every bun spawn stayed inside its fence ✓');
}

console.log(`\nbun test: ${runnable.length - failures.length}/${runnable.length} files green, ${failures.length} failing`);
if (failures.length > 0) process.exit(1);
