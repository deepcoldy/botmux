import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetSupervisor, pidAlive, type FleetBotSpec } from '../src/core/fleet-supervisor.js';
import { readFleetState, mutateFleetState } from '../src/core/fleet-state-store.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const dirs: string[] = [];
const hostProcs: ChildProcess[] = [];
const strayPids: number[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'fleet-sup-')); dirs.push(d); return d; }
/**
 * Queue a pid for SIGKILL at teardown — but ONLY a real one.
 *
 * A stopped/launching proc carries `pid = 0` (fleet-supervisor's markStopped and
 * the reconcile paths all reset it), and several specs read a pid straight out of
 * fleet-state AFTER asserting the bot is stopped. Passing 0 through to
 * `process.kill` is not a harmless no-op: POSIX `kill(0, sig)` signals EVERY
 * process in the CALLER's process group, so the cleanup SIGKILLed vitest itself.
 * That is what made this file die at ~8s with exit 137 (memory flat, no OOM record
 * anywhere — it was never an OOM). Negative pids are worse still: `kill(-N, sig)`
 * targets process GROUP N.
 */
function killLater(pid: number | undefined): void {
  if (typeof pid === 'number' && pid > 0) strayPids.push(pid);
}
afterEach(() => {
  for (const p of hostProcs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  // Defence in depth: the guard above is the contract, but a future spec pushing
  // straight into strayPids must not be able to reintroduce the self-kill.
  for (const pid of strayPids.splice(0)) {
    if (pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a fake distDir whose index-daemon.js behaves per FLEET_TEST_MODE, so the
 *  supervisor's real `node dist/index-daemon.js` spawn path is exercised. */
function fakeDist(root: string, body: string): string {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index-daemon.js'), body);
  return dist;
}

const STAY = `
console.log('daemon pid=' + process.pid + ' idx=' + process.env.BOTMUX_BOT_INDEX);
process.on('SIGTERM', () => process.exit(90));
setInterval(() => {}, 1000);
`;

const bots: FleetBotSpec[] = [
  { name: 'botmux-0', appId: 'cli_a', botIndex: 0 },
  { name: 'botmux-1', appId: 'cli_b', botIndex: 1 },
];

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (fn()) return true; await delay(50); }
  return fn();
}

describe('FleetSupervisor (live, integration)', () => {
  it('starts all bots online, idempotent re-start is a no-op', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {} });
    sup.start(bots);
    await waitFor(() => (readFleetState(statePath)?.procs.filter((p) => p.status === 'online').length ?? 0) === 2);
    const s1 = readFleetState(statePath)!;
    expect(s1.procs.filter((p) => p.status === 'online')).toHaveLength(2);
    const pids1 = s1.procs.map((p) => p.pid).sort();
    expect(pids1.every((pid) => pidAlive(pid))).toBe(true);

    // idempotent: a second start must NOT respawn (same pids)
    sup.start(bots);
    await delay(300);
    const pids2 = readFleetState(statePath)!.procs.map((p) => p.pid).sort();
    expect(pids2).toEqual(pids1);

    await sup.stopAll();
  });

  it('autorestarts a crashed child (new pid, restart count bumped)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online');
    const oldPid = readFleetState(statePath)!.procs[0].pid;

    // Kill the underlying child (simulate crash: SIGKILL → non-graceful)
    process.kill(oldPid, 'SIGKILL');
    // supervisor should observe exit, bump restarts, respawn with a new pid
    const restarted = await waitFor(() => {
      const p = readFleetState(statePath)?.procs[0];
      return !!p && p.status === 'online' && p.pid !== oldPid && p.pid > 1 && p.restarts >= 1;
    });
    expect(restarted).toBe(true);
    expect(pidAlive(readFleetState(statePath)!.procs[0].pid)).toBe(true);

    await sup.stopAll();
  });

  it('does NOT restart a child that exits 90 (graceful)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const GRACEFUL = `console.log('bye'); process.exit(90);`;
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, GRACEFUL), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([bots[0]]);
    // it exits 90 right away → should end up 'stopped', restarts stays 0
    const stopped = await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'stopped');
    expect(stopped).toBe(true);
    await delay(300); // give any (wrong) restart a chance to happen
    const p = readFleetState(statePath)!.procs[0];
    expect(p.status).toBe('stopped');
    expect(p.restarts).toBe(0);
    expect(p.lastExitCode).toBe(90);

    await sup.stopAll();
  });

  it('parks a proc errored after exceeding max_restarts', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const CRASH = `process.exit(1);`;
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, CRASH), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 3, restartDelayMs: 20 }, log: () => {},
    });
    sup.start([bots[0]]);
    const parked = await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'errored', 8000);
    expect(parked).toBe(true);
    // exactly maxRestarts crash-restarts happened before parking
    expect(readFleetState(statePath)!.procs[0].restarts).toBe(3);

    await sup.stopAll();
  });

  it('a fresh operator start resets a parked/crashed proc restart budget (crash respawn preserves it)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    // First: a crash-looper that parks at restarts=3.
    const crashSup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, `process.exit(1);`), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 3, restartDelayMs: 20 }, log: () => {},
    });
    crashSup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'errored', 8000);
    expect(readFleetState(statePath)!.procs[0].restarts).toBe(3);
    await crashSup.stopAll();

    // Now a FRESH operator start (new supervisor, healthy daemon) must give the
    // proc a clean restart budget — not inherit the stale 3 that would park it one
    // crash sooner. Swap the fake daemon to STAY (stays online).
    writeFileSync(join(root, 'dist', 'index-daemon.js'), STAY);
    const freshSup = new FleetSupervisor({
      statePath, distDir: join(root, 'dist'), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 3, restartDelayMs: 20 }, log: () => {},
    });
    freshSup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online');
    const p = readFleetState(statePath)!.procs[0];
    expect(p.status).toBe('online');
    expect(p.restarts).toBe(0); // fresh start reset the budget
    await freshSup.stopAll();
  });

  it('stopAll gracefully stops running children', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {}, killTimeoutMs: 2000 });
    sup.start(bots);
    await waitFor(() => (readFleetState(statePath)?.procs.filter((p) => p.status === 'online').length ?? 0) === 2);
    const pids = readFleetState(statePath)!.procs.map((p) => p.pid);

    await sup.stopAll();
    await delay(200);
    // all children gone
    expect(pids.every((pid) => !pidAlive(pid))).toBe(true);
    // state finalized: every proc marked stopped (pid 0), supervisorPid cleared,
    // so a later `status` read after a clean stop never shows stale 'online' rows.
    const after = readFleetState(statePath)!;
    expect(after.supervisorPid).toBe(0);
    expect(after.procs.every((p) => p.status === 'stopped' && p.pid === 0)).toBe(true);
  });

  it('writes per-bot daemon logs to logDir (daemon-<index>-out.log)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const logDir = join(root, 'logs');
    // STAY prints `daemon pid=<pid> idx=<index>` to stdout on boot.
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, logDir, log: () => {},
    });
    sup.start([bots[0]]); // botIndex 0
    await waitFor(() => existsSync(join(logDir, 'daemon-0-out.log')) &&
      readFileSync(join(logDir, 'daemon-0-out.log'), 'utf-8').includes('idx=0'));
    const out = readFileSync(join(logDir, 'daemon-0-out.log'), 'utf-8');
    expect(out).toContain('idx=0');
    // err file is created even if empty (the child dup'd both fds).
    expect(existsSync(join(logDir, 'daemon-0-err.log'))).toBe(true);
    await sup.stopAll();
  });

  it('startOneBot brings up a single bot; idempotent when already online', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {} });
    sup.start([bots[0]]); // only botmux-0 up
    await waitFor(() => readFleetState(statePath)?.procs.find((p) => p.name === 'botmux-0')?.status === 'online');

    // Bring up botmux-1 without touching botmux-0.
    const pid0 = readFleetState(statePath)!.procs.find((p) => p.name === 'botmux-0')!.pid;
    sup.startOneBot(bots[1]);
    await waitFor(() => readFleetState(statePath)?.procs.find((p) => p.name === 'botmux-1')?.status === 'online');
    const s = readFleetState(statePath)!;
    expect(s.procs.find((p) => p.name === 'botmux-0')!.pid).toBe(pid0); // untouched
    expect(pidAlive(s.procs.find((p) => p.name === 'botmux-1')!.pid)).toBe(true);

    // Idempotent: calling again with botmux-1 already online must not respawn.
    const pid1 = s.procs.find((p) => p.name === 'botmux-1')!.pid;
    sup.startOneBot(bots[1]);
    await delay(200);
    expect(readFleetState(statePath)!.procs.find((p) => p.name === 'botmux-1')!.pid).toBe(pid1);
    await sup.stopAll();
  });

  it('stopOneBot stops exactly one bot and does NOT resurrect it (explicit stop ≠ crash)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start(bots);
    await waitFor(() => (readFleetState(statePath)?.procs.filter((p) => p.status === 'online').length ?? 0) === 2);
    const pid1 = readFleetState(statePath)!.procs.find((p) => p.name === 'botmux-1')!.pid;

    await sup.stopOneBot('botmux-1');
    // botmux-1 must be stopped, its pid dead, and stay stopped (no crash-restart).
    expect(readFleetState(statePath)!.procs.find((p) => p.name === 'botmux-1')).toMatchObject({ status: 'stopped', pid: 0 });
    expect(pidAlive(pid1)).toBe(false);
    await delay(300); // give a (wrong) restart every chance to fire
    const after = readFleetState(statePath)!.procs.find((p) => p.name === 'botmux-1')!;
    expect(after.status).toBe('stopped');
    expect(after.restarts).toBe(0); // explicit stop is not a crash → no restart bump
    // botmux-0 is untouched and still online.
    expect(readFleetState(statePath)!.procs.find((p) => p.name === 'botmux-0')!.status).toBe('online');
    await sup.stopAll();
  });

  it('drainCommands applies queued start-bot / stop-bot in order', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {} });
    sup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs.find((p) => p.name === 'botmux-0')?.status === 'online');

    // Queue: start botmux-1, then stop botmux-0.
    await sup.drainCommands([
      { id: 'a', op: 'start-bot', name: 'botmux-1', appId: 'cli_b', botIndex: 1, at: 'T' },
      { id: 'b', op: 'stop-bot', name: 'botmux-0', appId: 'cli_a', botIndex: 0, at: 'T' },
    ]);
    await waitFor(() => readFleetState(statePath)?.procs.find((p) => p.name === 'botmux-1')?.status === 'online');
    await waitFor(() => readFleetState(statePath)?.procs.find((p) => p.name === 'botmux-0')?.status === 'stopped');
    const s = readFleetState(statePath)!;
    expect(s.procs.find((p) => p.name === 'botmux-1')!.status).toBe('online');
    expect(s.procs.find((p) => p.name === 'botmux-0')!.status).toBe('stopped');
    await sup.stopAll();
  });

  it('REGRESSION: supervisor survives a crash-loop in its OWN process (restart timer keeps the loop alive)', async () => {
    // The restart backoff timer must be ref'd. If it were unref'd, a single
    // crash-looping bot would let the supervisor's event loop drain and the
    // process would EXIT mid-backoff after the first crash — never restarting.
    // The in-process tests above can't catch this (vitest's own handles keep the
    // loop alive), so we run the supervisor in a DEDICATED subprocess whose only
    // live handle is the supervisor's restart timer, and assert it keeps going.
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    // Fake daemon that always crashes (exit 1) → non-graceful → supervisor must
    // keep restarting under the backoff.
    const distDir = fakeDist(root, `process.exit(1);`);
    const host = resolve('test/fixtures/fleet-supervisor-host.ts');
    const child = spawnTsScript(host, [statePath, distDir, root], {
      stdio: 'ignore',
    });
    hostProcs.push(child);

    // Give it time for several crash→backoff→respawn cycles (restartDelayMs=60).
    // If the timer were unref'd, the process would be gone well before this and
    // restarts would be stuck at 1.
    const reachedMany = await waitFor(
      () => (readFleetState(statePath)?.procs[0]?.restarts ?? 0) >= 3,
      6000,
    );
    expect(reachedMany).toBe(true);
    // The host process must still be alive (its loop held by the restart timer).
    expect(child.pid && pidAlive(child.pid)).toBe(true);

    child.kill('SIGKILL');
  });

  it('REGRESSION #1: start-bot during crash-backoff does NOT double-spawn / leak an orphan', async () => {
    // A crashed bot is mid-backoff: status 'launching', pid 0, not in `children`,
    // with a pending restart timer. If startOneBot didn't cancel that timer, it
    // would spawn a fresh child AND the stale timer would later spawn a second —
    // the first becoming an orphan stopAll can never reap (two daemons for one
    // bot). Assert exactly one live child and no orphan survives stopAll.
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 1500 }, log: () => {}, // wide backoff window
    });
    sup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online');
    // Force a crash → the bot enters 'launching' with a pending 1.5s restart timer.
    process.kill(readFleetState(statePath)!.procs[0].pid, 'SIGKILL');
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'launching');

    // start-bot lands INSIDE the backoff window.
    sup.startOneBot(bots[0]);
    const startBotPid = readFleetState(statePath)!.procs[0].pid;
    killLater(startBotPid);
    // Wait past the original timer's deadline: a stale timer, if not cancelled,
    // would fire here and spawn a second child (changing the pid).
    await delay(2000);
    const afterPid = readFleetState(statePath)!.procs[0].pid;
    killLater(afterPid);
    // Single owned (re)spawn: the stale timer was cancelled, so no second spawn.
    expect(afterPid).toBe(startBotPid);

    // stopAll reaps the one child; no orphan is left running.
    await sup.stopAll();
    await delay(300);
    expect(pidAlive(startBotPid)).toBe(false);
  });

  it('REGRESSION #3: a new supervisor taking over a live-but-unowned fleet reclaims it instead of self-exiting', async () => {
    // A prior supervisor died hard (SIGKILL/OOM) while its daemon kept running.
    // The state still says that proc is 'online' with a live pid. A new supervisor
    // must NOT trust that and skip it — if it spawned nothing it would hold no
    // handles and its event loop would drain (the supervisor exits, leaving the
    // fleet unsupervised). It must reclaim the orphan: kill it, respawn under its
    // own ownership, and end up holding a live child.
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    // Orphan daemon from the "previous" supervisor generation (still alive).
    const orphan = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    killLater(orphan.pid!);
    await waitFor(() => pidAlive(orphan.pid!));
    // State records it online, under a prior (now-dead) supervisor pid.
    mutateFleetState(statePath, () => ({
      supervisorPid: 999_999, supervisorStartedAt: 'T-prior',
      procs: [{ name: 'botmux-0', appId: 'cli_a', pid: orphan.pid!, generation: 1, status: 'online', restarts: 0, lastExitCode: null, startedAt: 'T' }],
    }));

    const sup = new FleetSupervisor({ statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root, log: () => {} });
    sup.start([bots[0]]); // takeover
    // The orphan must be reclaimed: a NEW owned child is spawned (different pid),
    // and the supervisor holds a live handle (so its loop won't drain → no self-exit).
    const reclaimed = await waitFor(() => {
      const p = readFleetState(statePath)?.procs[0];
      return !!p && p.status === 'online' && p.pid !== orphan.pid && p.pid > 1 && pidAlive(p.pid);
    });
    expect(reclaimed).toBe(true);
    const newPid = readFleetState(statePath)!.procs[0].pid;
    killLater(newPid);
    expect(newPid).not.toBe(orphan.pid);
    // The old orphan was SIGTERM'd (it was a plain `setInterval` with no SIGTERM
    // handler, so it dies) — no longer running unsupervised.
    await waitFor(() => !pidAlive(orphan.pid!));
    expect(pidAlive(orphan.pid!)).toBe(false);

    await sup.stopAll();
  });

  it('REGRESSION #2: stop-bot on a bot mid-crash-backoff cancels the restart and it stays stopped (no revive)', async () => {
    // Backs the fleet-runtime gate fix: `botmux stop-bot` on a crash-looping bot
    // must actually stop it. The gate now enqueues for 'launching' (not just
    // 'online'), and the supervisor's stopOneBot must cancel the pending restart
    // timer so the bot does NOT come back ~restartDelayMs later. We drive the
    // supervisor side directly (what a drained stop-bot command does) while the
    // bot is in its backoff window, then assert it stays stopped.
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 1500 }, log: () => {}, // wide window
    });
    sup.start([bots[0]]);
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'online');
    // Crash it → enters 'launching' with a pending 1.5s restart timer.
    process.kill(readFleetState(statePath)!.procs[0].pid, 'SIGKILL');
    await waitFor(() => readFleetState(statePath)?.procs[0]?.status === 'launching');

    // stop-bot lands mid-backoff (via the drainCommands path a SIGHUP triggers).
    await sup.drainCommands([{ id: 's', op: 'stop-bot', name: 'botmux-0', appId: 'cli_a', botIndex: 0, at: 'T' }]);
    // Immediately reflected stopped, and the pending restart timer was cancelled.
    expect(readFleetState(statePath)!.procs[0].status).toBe('stopped');
    // Wait well past the original 1.5s backoff: a leaked timer would revive it.
    await delay(2000);
    const after = readFleetState(statePath)!.procs[0];
    killLater(after.pid);
    expect(after.status).toBe('stopped'); // did NOT come back online
    expect(pidAlive(after.pid)).toBe(false);

    await sup.stopAll();
  });
});
