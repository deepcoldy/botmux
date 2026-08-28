import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

const GRACEFUL_DASHBOARD = `
// A dashboard that exits 90 (the graceful sentinel) on its own after a beat —
// the supervisor must NOT restart it (operator-initiated shutdown semantics).
setTimeout(() => process.exit(90), 100);
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

describe('dashboard launcher — source pins', () => {
  const read = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf-8');

  it('index-supervisor.ts supervises fleet MEMBERS (bots + dashboard), not bots alone', () => {
    const src = read('index-supervisor.ts');
    // The supervisor must start the member set that includes the dashboard.
    expect(src).toContain('resolveFleetMembers');
    expect(src).toContain('supervisor.start(members)');
    // Guard against a regression back to bots-only supervision.
    expect(src).not.toContain('supervisor.start(bots)');
  });

  it('cli.ts self-spawn dispatcher routes __dashboard to index-dashboard.js', () => {
    const cli = read('cli.ts');
    expect(cli).toContain("__entrySubcommand === 'dashboard') await import('./index-dashboard.js')");
  });

  it('cmdRestart health-gates on fleet MEMBERS so a down dashboard fails the restart', () => {
    const cli = read('cli.ts');
    expect(cli).toContain('fleetMemberNames');
  });

  it('bot-onboarding.ts STATIC-imports qrcode vendor files so the compiled binary embeds them', () => {
    // The compiled (bun --compile) dashboard crashed with "Cannot find module
    // 'qrcode-terminal/vendor/QRCode'" because a `createRequire(...)` of a bare
    // dir path is not traced/embedded by the bundler. Static `.js` imports are.
    // (Verified end-to-end: the fix takes the 1.4 compiled dashboard from
    // crashloop → online.) Guard against a regression back to createRequire.
    const src = read('dashboard/bot-onboarding.ts');
    expect(src).toContain("import QRCode from 'qrcode-terminal/vendor/QRCode/index.js'");
    expect(src).toContain("import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js'");
    // No actual createRequire CALL or dynamic vendor require (the prose comment
    // mentions createRequire, so match the code forms, not the bare word).
    expect(src).not.toContain("createRequire(import.meta");
    expect(src).not.toContain("import { createRequire }");
    expect(src).not.toMatch(/require\(\s*['"]qrcode-terminal\/vendor/);
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

  it('does NOT restart the dashboard on a graceful exit (code 90)', async () => {
    const root = tmp();
    const statePath = join(root, 'fleet.json');
    const sup = new FleetSupervisor({
      statePath, distDir: fakeDist(root, GRACEFUL_DASHBOARD), daemonEnv: {}, cwd: root,
      policy: { maxRestarts: 10, restartDelayMs: 50 }, log: () => {},
    });
    sup.start([dashboardSpec]);
    // The child exits 90 on its own; decideOnExit maps 90 → stop (no restart).
    const stopped = await waitFor(() => {
      const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
      return p?.status === 'stopped';
    });
    expect(stopped).toBe(true);
    // Give a restart-delay window to prove it stays down (no respawn).
    await delay(250);
    const p = readFleetState(statePath)?.procs.find((x) => x.name === 'botmux-dashboard');
    expect(p?.status).toBe('stopped');
    expect(p?.restarts).toBe(0);
    expect(pidAlive(p?.pid ?? 0)).toBe(false);
    await sup.stopAll();
  });
});
