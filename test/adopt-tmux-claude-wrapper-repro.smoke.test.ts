/**
 * REPRO + regression guard for PR#293 issue #1 — tmux /adopt of a claude-code
 * session that was launched under a COMM_ARGV_LAUNCHER wrapper (node / ttadk /
 * aiden / python…) failed to resolve its sessionId, so the transcript bridge
 * never started and the CLI's replies never returned to Feishu.
 *
 * Real-process smoke test (no fs/proc mocks): builds the exact process trees
 * the paths need and calls the production `discoverAdoptableSessions`.
 *
 * Case A — WRAPPED (the bug):
 *   tmux pane → node <wrap.js> <fake-claude>   (comm=node, argv has "claude")
 *                 └── fake-claude              (comm=claude — the REAL CLI)
 *   Claude keys ~/.claude/sessions/<pid>.json to the REAL claude child pid.
 *   The wrapper's argv contains the literal token "claude", so findCliProcess's
 *   cliIdFromCommArgv matches the WRAPPER pid by argv (matchedByComm=false).
 *   On buggy master, discovery only resolved the real child pid under a launcher
 *   for cliId==='codex', so claude kept the wrapper pid → readClaudeSessionMeta
 *   missed the child-keyed JSON → sessionId undefined → no bridge → no replies.
 *
 * Case B — DIRECT (regression guard):
 *   tmux pane → fake-claude                    (comm=claude, matchedByComm=true)
 *   The common, un-wrapped case. The shared-path fix must NOT disturb it: comm
 *   already names the CLI, so discovery keeps that pid and resolves sessionId.
 *
 * Skipped automatically when tmux OR a real node binary is unavailable (see
 * `resolveRealNode` — the fixtures cannot present a `claude` comm without node).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync, accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { isBunRuntime } from './helpers/ts-runner.js';
import { discoverAdoptableSessions } from '../src/core/session-discovery.js';
import { isProcessAlive } from '../src/core/session-liveness.js';

const SID_WRAPPED = 'adoptwr1-pr02-93aa-bbbb-ccccddddeeee';
const SID_DIRECT = 'adoptdi1-pr02-93aa-bbbb-ccccddddeeee';
// NOTE: session names must NOT start with `bmx-` — discovery skips bmx-* panes
// (already botmux-managed). These simulate a USER's own external tmux sessions.
const TMUX_WRAPPED = 'repro-adopt-claude-wrapped';
const TMUX_DIRECT = 'repro-adopt-claude-direct';

function tmuxAvailable(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

const hasTmux = tmuxAvailable();

/**
 * A REAL node binary to interpret both tmux fixtures — deliberately NOT
 * `process.execPath`.
 *
 * WHY (measured under bun 1.4.0 + node 22.21.1, `bun test` vs `vitest run`):
 * this whole test identifies processes through /proc/<pid>/comm and argv, so the
 * fixture's INTERPRETER decides whether discovery can see it at all. Under
 * `bun test`, `process.execPath` is the bun binary, and that breaks the two
 * fixtures in two INDEPENDENT ways:
 *
 *  1. `process.title = 'claude'` (the fixture below) is a NO-OP under bun.
 *     Same one-liner, both runtimes: node → comm=`claude`; bun → comm=`bun.exe`.
 *     So the DIRECT case can never present the comm=`claude` identity whose
 *     `matchedByComm=true` path it exists to guard.
 *  2. comm is `bun.exe`, not `bun`: `command -v bun` is a symlink into
 *     `lib/node_modules/bun/bin/bun.exe`, and tmux execve's the RESOLVED path.
 *     `COMM_ARGV_LAUNCHERS` (src/core/session-discovery.ts) lists 'bun' but not
 *     'bun.exe', so processExecutableArgvSlots yields argv[0] only and the
 *     argv-slot match never runs — the WRAPPED pane is not even discovered.
 *
 * Adding 'bun.exe' to COMM_ARGV_LAUNCHERS would NOT be enough (measured): it
 * fixes DIRECT only. WRAPPED would stay red because findLaunchedCliPid resolves
 * the real child by comm ONLY — deliberately not argv, since a launcher's argv
 * carries the target name as a literal token — and a bun-spawned child's comm is
 * never `claude`. Two independent blockers; the argv-set tweak addresses one.
 *
 * This is a FIXTURE-IDENTITY artifact, not a product bug: real claude-code is a
 * node program whose comm is `claude`, which discovery already handles. So the
 * fix belongs here, in the test, and supplies node rather than relaxing anything.
 *
 * NOTE: `resolveBunExecutable` from ./helpers/ts-runner.js is the wrong tool here
 * — it finds bun, which is precisely the binary that cannot work.
 */
function resolveRealNode(): string | undefined {
  // Under Node, the running interpreter IS node — cheapest and most faithful.
  if (!isBunRuntime()) return process.execPath;
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node'];
  for (const segment of (process.env.PATH ?? '').split(delimiter)) {
    if (!segment) continue;
    for (const name of names) {
      const candidate = join(segment, name);
      try {
        accessSync(candidate, constants.X_OK);
        // Confirm it is really node, not a bun shim named `node`: bun defines a
        // `Bun` global, node does not. Cheap and decisive.
        const probe = spawnSync(candidate, ['-e', 'process.stdout.write(typeof Bun === "undefined" ? "node" : "bun")'], {
          encoding: 'utf-8',
          timeout: 10_000,
        });
        if (probe.status === 0 && probe.stdout?.trim() === 'node') return candidate;
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return undefined;
}

// CI is fine: the bun-test job runs actions/setup-node@v6 (node 22) BEFORE
// oven-sh/setup-bun@v2, so a real node is on PATH there. When there genuinely is
// none, SKIP explicitly rather than letting the two cases fail or fake-pass.
const nodeBin = resolveRealNode();
const canRun = hasTmux && nodeBin !== undefined;

let dir: string;
let fakeClaude: string;
let sessionsDir: string;
const writtenMetaFiles: string[] = [];
let wrappedClaudePid: number | undefined;
let directClaudePid: number | undefined;
let wrappedWorkDir: string;
let directWorkDir: string;

function waitForPidFile(pidFile: string, deadlineMs: number): Promise<number | undefined> {
  return new Promise(async resolve => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (existsSync(pidFile)) {
        const raw = readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (isProcessAlive(pid)) return resolve(pid);
      }
      await new Promise(r => setTimeout(r, 100));
    }
    resolve(undefined);
  });
}

function writeMeta(pid: number, sessionId: string, cwd: string): void {
  const metaPath = join(sessionsDir, `${pid}.json`);
  writeFileSync(metaPath, JSON.stringify({ sessionId, cwd, startedAt: 1785000000000, updatedAt: 1785000009000 }));
  writtenMetaFiles.push(metaPath);
}

beforeAll(async () => {
  if (!canRun) return;
  dir = mkdtempSync(join(tmpdir(), 'bmx-adopt-repro-'));
  wrappedWorkDir = join(dir, 'wrapped-work');
  directWorkDir = join(dir, 'direct-work');
  mkdirSync(wrappedWorkDir, { recursive: true });
  mkdirSync(directWorkDir, { recursive: true });

  // A portable long-running fixture whose OS process title/comm is literally
  // `claude`. Copying /bin/sleep works on Linux but macOS kills the copied
  // platform binary because it no longer has its trusted system-path identity.
  fakeClaude = join(dir, 'claude');
  writeFileSync(
    fakeClaude,
    `process.title = 'claude';\n` +
      `const i = process.argv.indexOf('--pid-file');\n` +
      `if (i >= 0) require('node:fs').writeFileSync(process.argv[i + 1], String(process.pid));\n` +
      `setTimeout(() => {}, 600_000);\n`,
  );

  // ── Case A: wrapped (node → fake claude) ──────────────────────────────────
  const wrapJs = join(dir, 'wrap.js');
  // The inner interpreter is the resolved node path, NOT `process.execPath`:
  // wrap.js is itself run by node here, so its own `process.execPath` would be
  // correct today — but pinning the path keeps the fixture's identity explicit
  // and independent of who launched the wrapper. The spawned child must be node
  // for `process.title='claude'` to take effect (see resolveRealNode above).
  writeFileSync(
    wrapJs,
    `const { spawn } = require('child_process');\n` +
      `const c = spawn(${JSON.stringify(nodeBin)}, [process.argv[2], '--pid-file', process.argv[4]], { stdio: 'ignore', cwd: process.argv[3] });\n` +
      `process.on('SIGTERM', () => { try { c.kill('SIGKILL'); } catch {} process.exit(0); });\n` +
      `setTimeout(() => {}, 600000);\n`,
  );
  const wrappedPidFile = join(dir, 'wrapped-child.pid');
  // argv: node <wrap.js> <fake-claude> <workDir> <pidFile> — the wrapper's argv
  // thus carries the basename "claude", triggering the argv-match-on-wrapper.
  execFileSync('tmux', [
    'new-session', '-d', '-s', TMUX_WRAPPED, '-x', '200', '-y', '50',
    nodeBin!, wrapJs, fakeClaude, wrappedWorkDir, wrappedPidFile,
  ]);

  // ── Case B: direct (fake claude straight in the pane) ─────────────────────
  // The fixture records its own pid after setting process.title, so the pane has
  // no extra launcher/subshell and discovery must keep this exact pid.
  const directPidFile = join(dir, 'direct-child.pid');
  execFileSync('tmux', [
    'new-session', '-d', '-s', TMUX_DIRECT, '-c', directWorkDir, '-x', '200', '-y', '50',
    nodeBin!, fakeClaude, '--pid-file', directPidFile,
  ]);

  wrappedClaudePid = await waitForPidFile(wrappedPidFile, 5000);
  directClaudePid = await waitForPidFile(directPidFile, 5000);

  // Claude writes ~/.claude/sessions/<REAL claude pid>.json — key both cases
  // to their REAL claude pid exactly as claude-code does.
  sessionsDir = join(homedir(), '.claude', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  if (wrappedClaudePid) writeMeta(wrappedClaudePid, SID_WRAPPED, wrappedWorkDir);
  if (directClaudePid) writeMeta(directClaudePid, SID_DIRECT, directWorkDir);
}, 30_000);

afterAll(() => {
  if (canRun) {
    for (const s of [TMUX_WRAPPED, TMUX_DIRECT]) {
      try { execFileSync('tmux', ['kill-session', '-t', s]); } catch { /* already gone */ }
    }
  }
  for (const f of writtenMetaFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('tmux /adopt claude-code sessionId resolution (PR#293 issue #1)', () => {
  it.skipIf(!canRun)('WRAPPED: resolves the child-keyed sessionId under a node launcher (the bug)', () => {
    expect(wrappedClaudePid, 'wrapped fake-claude child pid should have been captured').toBeDefined();
    const sessions = discoverAdoptableSessions('claude-code');
    const mine = sessions.find(s => s.cwd === wrappedWorkDir || s.tmuxTarget?.startsWith(TMUX_WRAPPED));
    expect(mine, 'the wrapped adoptable claude pane must be discovered').toBeDefined();
    // On buggy master this was undefined: discovery read the session JSON off
    // the WRAPPER pid. The fix resolves the real child pid → the sessionId.
    expect(mine!.sessionId).toBe(SID_WRAPPED);
  });

  it.skipIf(!canRun)('DIRECT: still resolves sessionId for an un-wrapped claude (regression guard)', () => {
    expect(directClaudePid, 'direct fake-claude pid should have been captured').toBeDefined();
    const sessions = discoverAdoptableSessions('claude-code');
    const mine = sessions.find(s => s.cwd === directWorkDir || s.tmuxTarget?.startsWith(TMUX_DIRECT));
    expect(mine, 'the direct adoptable claude pane must be discovered').toBeDefined();
    // comm already names the CLI (matchedByComm=true), so the shared-path fix
    // must leave this pid selection untouched.
    expect(mine!.sessionId).toBe(SID_DIRECT);
  });
});
