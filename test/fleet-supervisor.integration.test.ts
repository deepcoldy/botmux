import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FleetSupervisor, pidAlive, type FleetBotSpec } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';

const dirs: string[] = [];
const hostProcs: ChildProcess[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'fleet-sup-')); dirs.push(d); return d; }
afterEach(() => {
  for (const p of hostProcs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
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
    const child = spawn(process.execPath, ['--import', 'tsx', host, statePath, distDir, root], {
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
});
