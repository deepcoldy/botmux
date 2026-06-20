import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMaintenanceTick,
  readMaintenanceStateTo,
  writeMaintenanceStateTo,
  buildRestartLauncher,
  maintenanceRestartLogPath,
  type MaintenanceDeps,
  type MaintenanceState,
} from '../src/core/maintenance.js';
import type { MaintenanceConfig } from '../src/global-config.js';
import type { RestartIntent } from '../src/services/restart-intent-store.js';

// 2026-06-07T04:00:00Z === 2026-06-07 12:00 local (Asia/Shanghai)
const NOON = Date.parse('2026-06-07T04:00:00.000Z');
const TODAY = '2026-06-07';

interface Opts {
  init?: MaintenanceState;
  startVer?: string;
  installTo?: string;   // on-disk version after runUpdate (same as startVer ⇒ no change)
  busy?: boolean;
  localDev?: boolean;
  updateThrows?: boolean;
}

function makeDeps(cfg: MaintenanceConfig, opts: Opts = {}) {
  const state: MaintenanceState = JSON.parse(JSON.stringify(opts.init ?? {}));
  const calls = { update: 0, restart: 0, writes: 0, intents: [] as RestartIntent[], logs: [] as string[] };
  let ver = opts.startVer ?? '2.64.0';
  const installTo = opts.installTo ?? '2.65.0';
  const deps: MaintenanceDeps = {
    now: () => NOON,
    readConfig: () => cfg,
    readState: () => state,
    writeState: () => { calls.writes++; },
    anyBusy: () => opts.busy ?? false,
    isLocalDev: () => opts.localDev ?? false,
    currentVersion: () => ver,
    runUpdate: () => { calls.update++; if (opts.updateThrows) throw new Error('npm fail'); ver = installTo; },
    writeIntent: (i) => { calls.intents.push(i); },
    triggerRestart: () => { calls.restart++; },
    log: (m) => { calls.logs.push(m); },
  };
  return { deps, calls, state };
}

describe('runMaintenanceTick', () => {
  it('does nothing when auto-update is disabled (even if auto-restart is on)', () => {
    const { deps, calls } = makeDeps({ autoUpdate: { enabled: false, time: '12:00' }, autoRestart: { enabled: true } });
    runMaintenanceTick(deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it('does nothing when there is no maintenance config', () => {
    const { deps, calls } = makeDeps({});
    runMaintenanceTick(deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
  });

  it('due + new version + auto-restart ON → installs, writes update intent, restarts, marks today', () => {
    const { deps, calls, state } = makeDeps({ autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } });
    runMaintenanceTick(deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(1);
    expect(calls.intents).toEqual([expect.objectContaining({ kind: 'update', oldVersion: '2.64.0', newVersion: '2.65.0' })]);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('due + new version + auto-restart OFF → installs but does NOT restart (applied on next restart)', () => {
    const { deps, calls, state } = makeDeps({ autoUpdate: { enabled: true, time: '12:00' } }); // no autoRestart
    runMaintenanceTick(deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(0);
    expect(calls.intents).toEqual([]);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('due but already on the latest version → installs (no-op), no restart, marks', () => {
    const { deps, calls } = makeDeps(
      { autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } },
      { startVer: '2.65.0', installTo: '2.65.0' }, // install changes nothing
    );
    runMaintenanceTick(deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(0);
    expect(calls.intents).toEqual([]);
  });

  it('due but BUSY → does not even run npm, marks today (slips to next day)', () => {
    const { deps, calls, state } = makeDeps(
      { autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } },
      { busy: true },
    );
    runMaintenanceTick(deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('due on a local-dev install → never runs npm, no restart, marks (skip)', () => {
    const { deps, calls, state } = makeDeps(
      { autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } },
      { localDev: true },
    );
    runMaintenanceTick(deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('already handled today → no install, no restart, no state write', () => {
    const { deps, calls } = makeDeps(
      { autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } },
      { init: { autoUpdate: { lastDate: TODAY } } },
    );
    runMaintenanceTick(deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
    expect(calls.writes).toBe(0);
  });

  it('missed (past grace) → no install, marks today', () => {
    const { deps, calls, state } = makeDeps({ autoUpdate: { enabled: true, time: '10:00' }, autoRestart: { enabled: true } });
    runMaintenanceTick(deps);
    expect(calls.update).toBe(0);
    expect(calls.restart).toBe(0);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });

  it('npm install failure → no restart, no intent (still marked, retries next day)', () => {
    const { deps, calls, state } = makeDeps(
      { autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } },
      { updateThrows: true },
    );
    runMaintenanceTick(deps);
    expect(calls.update).toBe(1);
    expect(calls.restart).toBe(0);
    expect(calls.intents).toEqual([]);
    expect(state.autoUpdate?.lastDate).toBe(TODAY);
  });
});

describe('buildRestartLauncher', () => {
  const NODE = '/usr/bin/node';
  const CLI = '/opt/botmux/dist/cli.js';

  it('uses setsid to start the restart in a new session when available', () => {
    // The auto-restart driver must NOT be a descendant of the daemon it kills,
    // or PM2 tearing down botmux-0 interrupts the restart. setsid → new session.
    expect(buildRestartLauncher(NODE, CLI, true)).toEqual({ cmd: 'setsid', args: [NODE, CLI, 'restart'] });
  });

  it('falls back to a plain detached node spawn when setsid is unavailable', () => {
    expect(buildRestartLauncher(NODE, CLI, false)).toEqual({ cmd: NODE, args: [CLI, 'restart'] });
  });
});

describe('maintenanceRestartLogPath', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('points at ~/.botmux/logs/maintenance-restart.log', () => {
    vi.stubEnv('HOME', '/home/bot');
    expect(maintenanceRestartLogPath()).toBe('/home/bot/.botmux/logs/maintenance-restart.log');
  });
});

describe('maintenance-state store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-mstate-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads {} when absent and round-trips after a write', () => {
    expect(readMaintenanceStateTo(dir)).toEqual({});
    writeMaintenanceStateTo(dir, { autoUpdate: { lastDate: '2026-06-07' } });
    expect(readMaintenanceStateTo(dir)).toEqual({ autoUpdate: { lastDate: '2026-06-07' } });
  });

  it('tolerates a corrupt state file (reads as {})', () => {
    writeMaintenanceStateTo(dir, { autoUpdate: { lastDate: '2026-06-07' } });
    rmSync(join(dir, 'maintenance-state.json'));
    expect(readMaintenanceStateTo(dir)).toEqual({});
  });
});
