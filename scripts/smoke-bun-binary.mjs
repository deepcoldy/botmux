#!/usr/bin/env node
/**
 * Smoke-test a compiled Bun single-file botmux binary.
 *
 * WHY THIS EXISTS: the release job used to smoke-test the binary with
 * `capabilities --json` alone. That is a static feature-flag document — it
 * proves the CLI module graph loads, and NOTHING about the parts the Bun
 * migration actually breaks. Two real regressions shipped past it:
 *   • the dashboard crashlooped in the compiled binary because a deep
 *     `require('qrcode-terminal/vendor/QRCode')` was never embedded, and
 *   • the dashboard was not launched at all (no supervisor member for it).
 * Both were invisible to `capabilities --json`. This script exercises the
 * layers that carry real risk under `bun build --compile`:
 *
 *   1. capabilities   — CLI graph loads at all (cheap canary, kept).
 *   1b. version       — the binary reports its own version rather than the
 *                       `unknown` sentinel. Compiled mode has no package.json on
 *                       disk, so every version read failed and 3.18.0-canary.2
 *                       shipped printing `botmux vunknown`.
 *   1d. plugin service — install/start/stop/update/uninstall work with the
 *                       built-in supervisor, without Node/Bun/PM2 on PATH.
 *   2. self-spawn     — the `__supervisor` hidden entry re-execs THIS binary
 *                       (the /$bunfs argv[1] path), starts a fleet, and the
 *                       supervisor stays alive.
 *   3. dashboard      — the supervisor spawns the `__dashboard` member, it
 *                       BOOTS (embedded qrcode vendor tree resolves) and
 *                       reaches `online` in fleet-state instead of crashlooping.
 *   4. http listen    — that dashboard actually serves (a response, any status,
 *                       proves the server bound rather than the process merely
 *                       existing).
 *
 * Deliberately NOT covered: anything needing Feishu credentials or a real bot.
 * Everything here runs against an empty `bots.json` in a scratch HOME, so it is
 * safe on a CI runner and on a developer machine.
 *
 * Usage:  node scripts/smoke-bun-binary.mjs <path-to-binary>
 * Exit 0 = all checks passed; non-zero + a diagnostic on the first failure.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Resolve to an ABSOLUTE path immediately. Every spawn below runs with
// `cwd: home` (a scratch dir, deliberately without node_modules), so a relative
// argument like `dist-bin/botmux-linux-x64` would be resolved against THAT dir
// and die with ENOENT — even though the existsSync check above it passes, since
// that check runs against the script's own cwd. CI passes a repo-relative path,
// which is exactly the case that broke; a local absolute path masked it.
const binary = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!binary) {
  console.error('usage: node scripts/smoke-bun-binary.mjs <path-to-binary>');
  process.exit(2);
}
if (!existsSync(binary)) {
  console.error(`smoke: binary not found: ${binary}`);
  process.exit(2);
}

/** Ports well clear of the default bases (7950/8800/7891) so a smoke run can
 *  never collide with a real fleet on the same machine. */
const PORTS = { ipc: 19950, proxy: 19800, dashboard: 19891 };
const DASHBOARD_ONLINE_TIMEOUT_MS = 30_000;
/** Separate budget for "the HTTP listener is bound": fleet-state `online` only
 *  proves the process spawned, so this waits on the socket after that. */
const DASHBOARD_HTTP_TIMEOUT_MS = 20_000;

const home = mkdtempSync(join(tmpdir(), 'botmux-bun-smoke-'));
mkdirSync(join(home, '.botmux'), { recursive: true });
// An EMPTY bot list: the fleet has no bots, but the dashboard is an
// unconditional supervisor member, so this is exactly the "operator opens the
// dashboard to add their first bot" state — and it needs no credentials.
writeFileSync(join(home, '.botmux', 'bots.json'), '[]');

// Drop every inherited BOTMUX_* variable before layering the scratch config on
// top. When this script runs INSIDE a botmux-managed CLI session (a bot doing a
// local repro), the shell carries the live fleet's BOTMUX_DAEMON_IPC_PORT,
// BOTMUX_LARK_APP_ID, BOTMUX_SESSION_ID, … — and the smoke supervisor inherits
// them, so a scratch-HOME test fleet can end up addressing the REAL daemon's IPC
// port. Measured: a leftover smoke supervisor carried BOTMUX_DAEMON_IPC_PORT=7950
// (the live daemon) while its own base port had been set to 19950.
const inheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('BOTMUX_')
    && !['BOTMUX', 'BOTS_CONFIG', 'SESSION_DATA_DIR', 'PM2_HOME', 'PLUGIN_PM2_HOME', 'BUN_BE_BUN'].includes(k)),
);
const childEnv = {
  ...inheritedEnv,
  HOME: home,
  BOTMUX_DAEMON_IPC_BASE_PORT: String(PORTS.ipc),
  BOTMUX_WEB_PROXY_BASE_PORT: String(PORTS.proxy),
  BOTMUX_DASHBOARD_PORT: String(PORTS.dashboard),
};

let supervisor;
let pluginSupervisorPid;

/**
 * Reap the supervisor AND the members it spawned.
 *
 * WHY THE MEMBERS NEED EXPLICIT HANDLING: cleanup used to SIGKILL only the
 * supervisor. SIGKILL is not catchable, so the supervisor never got to stop its
 * own children — the `__dashboard` member it had spawned survived as an orphan.
 * Observed on EVERY run, including passing ones: the GitHub runner reported
 * `Terminate orphan process: pid (2717) (botmux-linux-x64)` while tearing the
 * job down. Harmless on an ephemeral runner, but on a developer machine it
 * leaves a stray dashboard holding its port, and it means this script does not
 * actually clean up after itself.
 *
 * Order matters: SIGTERM first so the supervisor stops its members the way it
 * normally would, then a bounded wait, then SIGKILL whatever is still alive —
 * members first (read out of fleet-state, which records their pids), so nothing
 * is left parentless. Every step is best-effort: cleanup runs on the failure
 * path too and must never throw over an already-dead process.
 */
const memberPids = () => {
  try {
    const state = JSON.parse(readFileSync(join(home, '.botmux', 'fleet-state.json'), 'utf-8'));
    return (state.procs ?? [])
      .map((p) => p?.pid)
      .filter((pid) => typeof pid === 'number' && pid > 0);
  } catch {
    return []; // no state file yet, or unreadable — nothing we can target
  }
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Block the thread briefly. cleanup() runs from exit paths where an `await`
 *  would never be honoured, so the wait for the supervisor to exit has to be
 *  synchronous. Atomics.wait on a throwaway buffer is the standard way to sleep
 *  without spawning anything. */
const sleepSync = (ms) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — skip the grace period */ }
};

const cleanup = () => {
  const members = memberPids();
  try {
    const state = JSON.parse(readFileSync(join(home, '.botmux', 'plugin-supervisor', 'state.json'), 'utf8'));
    members.push(...state.procs.map(p => p.pid).filter(pid => pid > 1));
    // stopAll clears supervisorPid before the entry itself exits. Retain the
    // observed PID so a failed exit assertion cannot escape failure cleanup.
    pluginSupervisorPid ||= state.supervisorPid;
    if (pluginSupervisorPid > 1 && alive(pluginSupervisorPid)) {
      process.kill(pluginSupervisorPid, 'SIGTERM');
      const deadline = Date.now() + 3_000;
      while (alive(pluginSupervisorPid) && Date.now() < deadline) sleepSync(50);
      if (alive(pluginSupervisorPid)) process.kill(pluginSupervisorPid, 'SIGKILL');
    }
  } catch { /* absent, or already exited */ }
  if (supervisor && supervisor.exitCode === null) {
    // Graceful first: lets the supervisor tear down its own members.
    try { supervisor.kill('SIGTERM'); } catch { /* already gone */ }
    const deadline = Date.now() + 3_000;
    while (supervisor.exitCode === null && Date.now() < deadline) sleepSync(100);
    if (supervisor.exitCode === null) {
      try { supervisor.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  // Sweep any member the supervisor did not manage to stop (it may itself have
  // been SIGKILLed, or died before handling the SIGTERM).
  for (const pid of members) {
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
};
const fail = (step, detail) => {
  console.error(`smoke: FAIL [${step}] ${detail}`);
  cleanup();
  process.exit(1);
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 0. darwin: the Mach-O ad-hoc signature is valid ──────────────────────────
// `bun build --compile` writes an ad-hoc code signature into every darwin
// binary. Bun 1.4.0 wrote an INVALID one (last page hashed zero-padded, stale
// signature bytes left past the new one — oven-sh/bun#39764, fixed in #39837 /
// 1.4.1). Older macOS tolerated it, so the binary still ran here on the
// macos-14 runner and every check below passed, while macOS 27 SIGKILLs the
// process before main() — `botmux upgrade` to 3.18.14 died with `exit SIGKILL`
// and nothing else. Verify the signature explicitly so a release gate never
// again depends on the runner's macOS being lenient. `--strict` is what Apple's
// newer loaders effectively enforce.
if (process.platform === 'darwin') {
  try {
    // codesign reports on stderr even on success; a zero exit is the verdict.
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', binary], {
      encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log('smoke: ✅ codesign — ad-hoc Mach-O signature valid (--strict)');
  } catch (err) {
    const detail = err && typeof err === 'object' && 'stderr' in err && err.stderr
      ? String(err.stderr).trim()
      : (err instanceof Error ? err.message : String(err));
    fail('codesign', `invalid Mach-O signature — newer macOS will SIGKILL this binary before it runs. ` +
      `Check the Bun that compiled it (1.4.0 is known-bad, need >= 1.4.1). codesign said: ${detail}`);
  }
}

// ── 1. capabilities: the CLI graph loads ─────────────────────────────────────
// Run from a scratch cwd with NO node_modules so a missing native/embedded
// module surfaces here instead of being masked by a sibling install.
try {
  const out = execFileSync(binary, ['capabilities', '--json'], {
    cwd: home, env: childEnv, encoding: 'utf-8', timeout: 60_000,
  });
  if (!out.includes('"schemaVersion"')) fail('capabilities', `unexpected output: ${out.slice(0, 200)}`);
  console.log('smoke: ✅ capabilities — CLI graph loads');
} catch (err) {
  fail('capabilities', err instanceof Error ? err.message : String(err));
}

// ── 1b. version: the binary knows what it is ─────────────────────────────────
// Every runtime version lookup ends at a readFileSync of the install root's
// package.json, which DOES NOT EXIST in compiled mode (the module graph is in
// the virtual read-only /$bunfs, and the package-root walk ends at `/`). So
// `botmux --version` printed `unknown` on the published 3.18.0-canary.2 and the
// help banner read `botmux vunknown`. The build bakes the version in via
// `define`; this asserts the baked value actually survives into the binary.
//
// Checked for shape, not a specific number, because this script runs both in
// release (a real tag) and on developer machines (the unbuilt 0.0.0 placeholder).
// The regression was a sentinel string, so rejecting sentinels is what has teeth:
// verified by rebuilding without `define`, which yields exactly `unknown`.
try {
  const raw = execFileSync(binary, ['--version'], {
    cwd: home, env: childEnv, encoding: 'utf-8', timeout: 60_000,
  }).trim();
  if (raw === 'unknown' || raw === '') {
    fail('version', `--version returned the "${raw}" sentinel: the compiled binary cannot read its own version. `
      + 'The build must bake it in (scripts/build-bun-binary.mjs `define`), because compiled mode has no package.json on disk.');
  }
  if (!/^\d+\.\d+\.\d+/.test(raw)) {
    fail('version', `--version output is not a semver-looking string: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  console.log(`smoke: ✅ version — binary reports ${raw} (not the "unknown" sentinel)`);
} catch (err) {
  fail('version', err instanceof Error ? err.message : String(err));
}

// ── 1c. selfcheck: setup-time lark-scopes.json load works in the binary ──────
// The compiled binary keeps its module graph in the read-only virtual /$bunfs,
// so setup code that loaded lark-scopes.json via readFileSync/copyFileSync of a
// __dirname-relative path threw "找不到 botmux lark-scopes.json" — the first
// `botmux setup ... --create-app` from a fresh curl install died right here.
// npm/Node unit tests can't see it (dist/ physically exists there). The hidden
// `__selfcheck` entry runs readDefaultScopeManifest() + writeScopesJsonToConfigDir()
// and prints `{"ok":true,...}`; a non-zero exit or missing ok flag = the /$bunfs
// regression is back. Runs in the scratch HOME, no credentials needed.
try {
  const out = execFileSync(binary, ['__selfcheck'], {
    cwd: home, env: childEnv, encoding: 'utf-8', timeout: 60_000,
  });
  let parsed;
  try { parsed = JSON.parse(out.trim().split('\n').pop()); }
  catch { parsed = null; }
  if (!parsed?.ok || !(parsed.tenant > 0) || !(parsed.user > 0)) {
    fail('selfcheck', `__selfcheck did not confirm the manifest loaded: ${out.slice(0, 300)}`);
  }
  if (!existsSync(join(home, '.botmux', 'lark-scopes.json'))) {
    fail('selfcheck', 'writeScopesJsonToConfigDir did not produce ~/.botmux/lark-scopes.json');
  }
  console.log(`smoke: ✅ selfcheck — lark-scopes manifest loads + writes in the binary (tenant=${parsed.tenant}, user=${parsed.user})`);
} catch (err) {
  fail('selfcheck', err instanceof Error ? err.message : String(err));
}

// ── 1d. A real plugin service, entirely outside the source tree ──────────────
// Removing Node/Bun/PM2 from PATH proves both the supervisor and the installed
// JS service re-exec the compiled binary. HTTP readiness catches a child that
// merely prints CLI help and exits, which a successful spawn cannot detect.
try {
  const plugin = join(home, 'smoke-plugin');
  const marker = join(home, 'plugin-ready.json');
  const pluginState = join(home, '.botmux', 'plugin-supervisor', 'state.json');
  const emptyPath = join(home, 'empty-path');
  mkdirSync(emptyPath);
  const pluginEnv = { ...childEnv, PATH: emptyPath };
  mkdirSync(join(plugin, 'dist', 'service'), { recursive: true });
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: '@botmux-ai/plugin-binary-smoke', version: '1.0.0', keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id: 'binary-smoke', service: { mode: 'manual' } },
  }));
  writeFileSync(join(plugin, 'dist', 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(plugin, 'dist', 'service', 'index.js'), `module.exports = {
    pm2: { script: './service/server.cjs', args: ['argument with spaces'], killTimeoutMs: 500,
      env: { SMOKE_MARKER: ${JSON.stringify(marker)} } }
  };`);
  writeFileSync(join(plugin, 'dist', 'service', 'server.cjs'), `
    if (process.env.BUN_BE_BUN !== undefined) throw new Error('bootstrap env leaked');
    if (require.main !== module) throw new Error('service is not the main module');
    const nested = require('node:child_process').execFileSync(process.execPath, ['capabilities', '--json'],
      { encoding: 'utf8', timeout: 5000 });
    JSON.parse(nested); // nested botmux must not enter Bun CLI or print help
    const server = require('node:http').createServer((req, res) => res.end(process.argv[2]));
    server.listen(0, '127.0.0.1', () => require('node:fs').writeFileSync(process.env.SMOKE_MARKER,
      JSON.stringify({ pid: process.pid, port: server.address().port })));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  const cli = (args, expected = 0) => {
    const result = spawnSync(binary, ['plugin', ...args], {
      cwd: home, env: pluginEnv, encoding: 'utf8', timeout: 40_000,
    });
    if (result.error || result.status !== expected) {
      throw new Error(`${args.join(' ')}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
    }
  };
  const ready = async (previousPid = 0) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        const value = JSON.parse(readFileSync(marker, 'utf8'));
        if (value.pid !== previousPid && alive(value.pid)) {
          const response = await fetch(`http://127.0.0.1:${value.port}`, { signal: AbortSignal.timeout(2_000) });
          if (await response.text() !== 'argument with spaces') throw new Error('service argv corrupted');
          return value.pid;
        }
      }
      await delay(50);
    }
    throw new Error('plugin service did not become ready');
  };
  cli(['install', plugin]);
  cli(['service', 'status']);
  if (existsSync(pluginState)) throw new Error('install/status started a supervisor');
  cli(['service', 'start', 'binary-smoke']);
  const firstPid = await ready();
  pluginSupervisorPid = JSON.parse(readFileSync(pluginState, 'utf8')).supervisorPid;
  cli(['uninstall', 'binary-smoke'], 1); // runtime must remain intact while live
  cli(['service', 'stop', 'binary-smoke']);
  if (alive(firstPid)) throw new Error('stop returned with a live service');
  cli(['install', plugin]); // stopped service permits replacement
  cli(['service', 'start', 'binary-smoke']);
  const secondPid = await ready(firstPid);
  cli(['service', 'stop', 'binary-smoke']);
  cli(['uninstall', 'binary-smoke']);
  await delay(750);
  if (alive(secondPid) || JSON.parse(readFileSync(pluginState, 'utf8')).procs.length !== 0) {
    throw new Error('uninstall left a process or restartable member');
  }
  if ([join(home, '.botmux', 'pm2'), join(home, '.pm2')].some(dir => existsSync(join(dir, 'pm2.pid')))) {
    throw new Error('plugin lifecycle created PM2');
  }
  console.log('smoke: ✅ plugin service — install/start/HTTP/guard/stop/update/uninstall without PM2');

  process.kill(pluginSupervisorPid, 'SIGTERM');
  const shutdownDeadline = Date.now() + 5_000;
  while (alive(pluginSupervisorPid) && Date.now() < shutdownDeadline) await delay(50);
  if (alive(pluginSupervisorPid)) throw new Error('plugin supervisor did not exit after graceful shutdown');
  pluginSupervisorPid = undefined;
  const ownerLock = join(home, '.botmux', 'plugin-supervisor', 'owner.lock');
  if (existsSync(ownerLock)) throw new Error('plugin supervisor exited without releasing its lifetime lock');
  console.log('smoke: ✅ plugin supervisor — graceful exit releases lifetime lock');

  // A malformed desired state fails after the owner lock and fleet timer are
  // acquired. The hidden CLI entry must exit non-zero AFTER both are cleaned up.
  writeFileSync(join(home, '.botmux', 'plugin-supervisor', 'desired.json'), '{}');
  const failedStart = spawnSync(binary, ['__plugin-supervisor'], {
    cwd: home, env: pluginEnv, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
  });
  if (failedStart.error || failedStart.status !== 1
    || !failedStart.stderr.includes('plugin_supervisor_invalid_desired_state')) {
    throw new Error(`plugin supervisor startup failure did not exit 1: ${failedStart.error?.message ?? failedStart.stderr}`);
  }
  if (existsSync(ownerLock)) throw new Error('failed plugin supervisor left its lifetime lock');
  console.log('smoke: ✅ plugin supervisor — startup failure exits 1 and releases lifetime lock');
} catch (error) {
  fail('plugin-service', error instanceof Error ? error.message : String(error));
}

// ── 2/3. self-spawn + dashboard boots and reaches online ─────────────────────
// `__supervisor` is the hidden self-re-exec entry: under a compiled binary this
// takes the /$bunfs argv[1] detection path, so a broken isStandaloneBinary() or
// entry dispatch fails here. The supervisor then spawns the dashboard member.
const statePath = join(home, '.botmux', 'fleet-state.json');
supervisor = spawn(binary, ['__supervisor'], {
  cwd: home, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let supervisorLog = '';
supervisor.stdout?.on('data', (d) => { supervisorLog += d.toString(); });
supervisor.stderr?.on('data', (d) => { supervisorLog += d.toString(); });
supervisor.on('error', (err) => fail('self-spawn', `supervisor spawn error: ${err.message}`));

const readDashboardRow = () => {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    return (state.procs ?? []).find((p) => p.name === 'botmux-dashboard');
  } catch { return undefined; }
};

const deadline = Date.now() + DASHBOARD_ONLINE_TIMEOUT_MS;
let row;
for (;;) {
  if (supervisor.exitCode !== null) {
    fail('self-spawn', `supervisor exited early (code ${supervisor.exitCode})\n--- log ---\n${supervisorLog.slice(-1500)}`);
  }
  row = readDashboardRow();
  if (row && row.status === 'online' && row.pid > 0) break;
  if (Date.now() >= deadline) {
    const errLog = (() => {
      const p = join(home, '.botmux', 'logs', 'dashboard-err.log');
      try { return readFileSync(p, 'utf-8').slice(-1500); } catch { return '(no dashboard-err.log)'; }
    })();
    fail(
      'dashboard',
      `dashboard never reached online within ${DASHBOARD_ONLINE_TIMEOUT_MS}ms `
      + `(row=${JSON.stringify(row ?? null)}). A crashloop here means the compiled `
      + `binary is missing an embedded module.\n--- dashboard-err.log ---\n${errLog}`,
    );
  }
  await delay(250);
}
console.log(`smoke: ✅ self-spawn — supervisor alive, spawned __dashboard (pid ${row.pid})`);
// restarts>0 means it crashed at least once before coming up: still a defect.
if ((row.restarts ?? 0) > 0) {
  fail('dashboard', `dashboard came online but had already restarted ${row.restarts}× (crashloop before settling)`);
}
console.log('smoke: ✅ dashboard — booted clean (0 restarts), embedded modules resolve');

// ── 4. the dashboard actually serves ────────────────────────────────────────
// ANY HTTP status proves the listener bound (an unauthenticated `/` legitimately
// answers 404). A connection error means the process exists but never listened.
//
// MUST POLL, not probe once: fleet-state `status: online` means the supervisor
// SPAWNED the child, not that the child finished binding its socket. A single
// fetch right after `online` loses that race (observed: connection refused, then
// HTTP 404 a moment later — the listener simply wasn't up yet).
const httpDeadline = Date.now() + DASHBOARD_HTTP_TIMEOUT_MS;
let served = null;
let lastHttpError = 'never attempted';
for (;;) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.dashboard}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    served = res.status;
    break;
  } catch (err) {
    lastHttpError = err instanceof Error ? err.message : String(err);
  }
  if (supervisor.exitCode !== null) {
    fail('http', `supervisor died while waiting for the dashboard to serve\n--- log ---\n${supervisorLog.slice(-1500)}`);
  }
  if (Date.now() >= httpDeadline) {
    fail(
      'http',
      `dashboard port ${PORTS.dashboard} never served within ${DASHBOARD_HTTP_TIMEOUT_MS}ms `
      + `(last error: ${lastHttpError}). The process is online but its HTTP listener never bound.`,
    );
  }
  await delay(250);
}
console.log(`smoke: ✅ http — dashboard is serving (status ${served})`);

// ── 4b. the embedded frontend must actually be there ─────────────────────────
// REGRESSION GUARD for a shipped bug this smoke test walked straight past.
//
// Check 4 accepts ANY status, on the reasoning that an unauthenticated `/`
// legitimately 404s. True — but it made the check blind to a 404 with a
// completely different cause: the Dashboard resolves its frontend as
// `join(__dirname, 'dashboard-web')`, which in a compiled binary points inside
// the virtual /$bunfs/ and does not exist, and `bun --compile` embeds nothing it
// cannot trace statically. So EVERY asset 404'd, the post-login redirect to `/`
// answered `{"error":"not_found_yet","path":"/"}`, and the Dashboard was
// unreachable from any compiled binary — while npm/source installs were fine, and
// while this smoke test reported ✅.
//
// Distinguish the two 404s by CAUSE rather than status: `not_found_yet` is the
// server's catch-all miss (no asset), whereas an auth rejection carries the token
// gate's own shape. Asserting on the body is what makes an empty-frontend binary
// fail the build instead of shipping.
const assetProbe = await fetch(`http://127.0.0.1:${PORTS.dashboard}/`, {
  signal: AbortSignal.timeout(5_000),
});
const assetBody = await assetProbe.text();
if (assetBody.includes('not_found_yet')) {
  fail(
    'frontend',
    `dashboard answered its catch-all miss for \`/\` (${assetProbe.status}: ${assetBody.slice(0, 120)}).\n`
    + 'The compiled binary has no embedded Dashboard frontend, so every page and asset 404s.\n'
    + 'Expected the build plugin to inject dist/dashboard-web (scripts/generate-dashboard-embed.mjs) — '
    + 'run `bun run build` before compiling, and check that hook still matches dist/dashboard.js.',
  );
}
console.log(`smoke: ✅ frontend — embedded Dashboard assets resolve (no catch-all miss on /)`);

// ── 5. the wrapper write must NOT destroy an install.sh-style binary ─────────
// REGRESSION GUARD for a shipped bug this smoke test used to walk straight past.
//
// install.sh puts the compiled binary at `~/.botmux/bin/botmux`, and the daemon's
// writePidFile() writes its `botmux` wrapper to that SAME path. Under a compiled
// binary the Node-shaped wrapper content is `exec node "/$bunfs/root/cli.js"` — a
// process-private path — so the write replaced the running executable: a
// 94,582,912-byte ELF became a 47-byte script (inode changed).
//
// Why checks 1-4 could not catch it: they run with `bots.json = '[]'`, so no bot
// daemon ever spawns, and writePidFile lives in the daemon. This check exercises
// the collision directly instead of booting a full bot (which would need real
// Feishu credentials): copy the binary to the wrapper path, run the daemon entry
// there, and assert the file is still the executable afterwards.
const binDir = join(home, '.botmux', 'bin');
mkdirSync(binDir, { recursive: true });
const installedBinary = join(binDir, 'botmux');
copyFileSync(binary, installedBinary);
chmodSync(installedBinary, 0o755);
const sizeBefore = statSync(installedBinary).size;

// Run the DAEMON entry from the installed path so writePidFile() executes with
// process.execPath === the wrapper target. It will exit on its own (no bots /no
// credentials); we only care about the file afterwards, not its exit code.
await new Promise((resolve) => {
  const child = spawn(installedBinary, ['__daemon'], {
    cwd: home, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let settled = false;
  const finish = () => { if (!settled) { settled = true; resolve(); } };
  child.on('exit', finish);
  child.on('error', finish);
  // Cap the wait: if it stays alive (a daemon legitimately might), the wrapper
  // write has long since happened — writePidFile runs during startup.
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    finish();
  }, 15_000);
});

const sizeAfter = statSync(installedBinary).size;
const head = readFileSync(installedBinary).subarray(0, 32).toString('latin1');
if (sizeAfter !== sizeBefore) {
  fail(
    'self-destruct',
    `the daemon REPLACED its own binary at ${installedBinary}: `
    + `${sizeBefore} bytes → ${sizeAfter} bytes. First bytes now: ${JSON.stringify(head)}. `
    + 'The wrapper write must skip a target that is the running executable.',
  );
}
if (head.startsWith('#!')) {
  fail(
    'self-destruct',
    `the binary at ${installedBinary} is now a shell script (${JSON.stringify(head)}) — overwritten by the wrapper write.`,
  );
}
console.log(`smoke: ✅ self-destruct guard — binary intact at the wrapper path (${sizeAfter} bytes)`);

console.log('smoke: all checks passed');
cleanup();
process.exit(0);
