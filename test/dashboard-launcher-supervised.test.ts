import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetSupervisor, pidAlive, type FleetBotSpec } from '../src/core/fleet-supervisor.js';
import { readFleetState } from '../src/core/fleet-state-store.js';
import { resolveEntrySpawn, entryForSubcommand, ENTRY_SUBCOMMANDS } from '../src/core/self-spawn.js';
import { resolveDashboardSpec, resolveFleetMembers, DASHBOARD_PROCESS_NAME } from '../src/core/fleet-runtime.js';

/**
 * Regression guard for the dashboard launcher under the built-in supervisor
 * (replaces the pm2-era `index-dashboard-entry.test.ts` pin that asserted the
 * pm2 ecosystem `botmux-dashboard` app). The pm2→supervisor migration deleted
 * ecosystemConfig — the dashboard's ONLY launch path under pm2 — so without a
 * replacement the dashboard never starts on `botmux start`/`restart` and the
 * whole web control plane (Agent Workbench, web terminal, H5 login) is dead.
 * These pins keep the supervisor owning the dashboard as a first-class fleet
 * member with the same crash-restart / graceful-exit machinery as a bot daemon.
 */

const dirs: string[] = [];
const procs: ChildProcess[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'dash-launch-')); dirs.push(d); return d; }
afterEach(() => {
  for (const p of procs.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) { if (fn()) return true; await delay(50); }
  return fn();
}

/** Fake dist whose index-dashboard.js behaves per body, so the supervisor's real
 *  `node dist/index-dashboard.js` spawn (resolveEntrySpawn('dashboard')) runs. */
function fakeDist(root: string, dashboardBody: string): string {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index-dashboard.js'), dashboardBody);
  return dist;
}

const STAY_DASHBOARD = `
// A dashboard that stays up until SIGTERM, exiting 90 (the graceful sentinel).
console.log('dashboard pid=' + process.pid + ' idx=' + process.env.BOTMUX_BOT_INDEX);
process.on('SIGTERM', () => process.exit(90));
setInterval(() => {}, 1000);
`;

const CRASH_DASHBOARD = `
// A dashboard that crashes immediately, to exercise crash-restart.
process.exit(1);
`;

describe('dashboard launcher — wiring (pure, no HOME)', () => {
  it('resolveDashboardSpec is a dashboard-entry member named botmux-dashboard, no bot index', () => {
    const spec = resolveDashboardSpec();
    expect(spec.name).toBe('botmux-dashboard');
    expect(DASHBOARD_PROCESS_NAME).toBe('botmux-dashboard');
    expect(spec.entry).toBe('dashboard');
    expect(spec.logBaseName).toBe('dashboard');
    // Not a bot: no appId, and its index is never used (entry !== 'daemon').
    expect(spec.appId).toBe('');
  });

  it('resolveFleetMembers always includes the dashboard (mirrors pm2 always-on app)', () => {
    // resolveFleetBots is HOME-dependent (bots.json), but the dashboard is
    // appended unconditionally — so whatever the bot set, the dashboard is a
    // supervised member. This is the pin that would have caught the P0.
    const members = resolveFleetMembers();
    const dash = members.filter((m) => m.name === 'botmux-dashboard');
    expect(dash).toHaveLength(1);
    expect(dash[0].entry).toBe('dashboard');
  });

  it('resolveEntrySpawn("dashboard") targets index-dashboard.js on the Node path', () => {
    const { command, args } = resolveEntrySpawn('dashboard', '/somewhere/dist');
    expect(command).toBe(process.execPath);
    expect(args).toEqual([join('/somewhere/dist', 'index-dashboard.js')]);
  });

  it('the __dashboard self-spawn token round-trips to the dashboard entry', () => {
    expect(ENTRY_SUBCOMMANDS.has('__dashboard')).toBe(true);
    expect(entryForSubcommand('__dashboard')).toBe('dashboard');
  });
});

describe('FleetSupervisor manages the dashboard like a bot daemon (live)', () => {
  const dashboardSpec: FleetBotSpec = resolveDashboardSpec();

  it('spawns index-dashboard.js and records it online in fleet-state', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY_DASHBOARD), daemonEnv: {}, cwd: root, log: () => {},
    });
    sup.start([dashboardSpec]);
    const online = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!p && p.status === 'online' && pidAlive(p.pid);
    });
    expect(online).toBe(true);
    await sup.stopAll();
  });

  it('does NOT inject BOTMUX_BOT_INDEX into the dashboard (it is app-agnostic)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    // The dashboard logs its BOTMUX_BOT_INDEX; assert it is undefined, not "-1".
    const logDir = join(root, 'logs');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY_DASHBOARD), daemonEnv: {}, cwd: root, logDir, log: () => {},
    });
    sup.start([dashboardSpec]);
    await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!p && p.status === 'online';
    });
    await delay(200);
    await sup.stopAll();
    // logBaseName 'dashboard' → dashboard-out.log (NOT daemon-<idx>-out.log).
    const out = readFileSync(join(logDir, 'dashboard-out.log'), 'utf-8');
    expect(out).toContain('dashboard pid=');
    expect(out).toContain('idx=undefined');
  });

  it('restarts the dashboard on a crash (same crash-restart as a bot)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, CRASH_DASHBOARD), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    // A crashing dashboard accrues restarts (>=2 proves the restart loop runs).
    const restarted = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return (p?.restarts ?? 0) >= 2;
    });
    expect(restarted).toBe(true);
    await sup.stopAll();
  });

  it('restarts the dashboard on an unsolicited code 90 (self-heals like a bot daemon)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const beats = join(root, 'dash-launches.txt');
    const UNSOLICITED_90 = `
require('fs').appendFileSync(${JSON.stringify(beats)}, 'x');
setTimeout(() => process.exit(90), 100);
`;
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, UNSOLICITED_90), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 20 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    // The child exits 90 on its own WITHOUT a supervisor-initiated stop. The
    // sentinel is no longer trusted as operator intent on an ordinary exit
    // path, so the dashboard self-heals (same contract as a bot daemon).
    const relaunched = await waitFor(() =>
      existsSync(beats) && readFileSync(beats, 'utf-8').length >= 2);
    expect(relaunched).toBe(true);
    expect(await waitFor(() =>
      (readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard')?.restarts ?? 0) >= 1)).toBe(true);
    await sup.stopAll();
    await delay(100); // let the tight crash-loop settle before tmp cleanup
  });

  it('keeps the dashboard stopped when the supervisor itself stops it (graceful sentinel honoured)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const logDir = join(root, 'logs');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, STAY_DASHBOARD), daemonEnv: {}, cwd: root, logDir,
      policy: { maxRestarts: 10, restartDelayMs: 20 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    const online = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return !!p && p.status === 'online' && p.pid > 1;
    });
    expect(online).toBe(true);
    const stoppedPid = readFleetState(statePath)!.procs.find((x) => x.name === 'botmux-dashboard')!.pid;

    await sup.stopAll(); // the supervisor initiates → the 90 sentinel is honoured
    await delay(250);
    const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
    expect(p?.status).toBe('stopped');
    expect(p?.restarts).toBe(0);
    expect(pidAlive(stoppedPid)).toBe(false);
  });
});
