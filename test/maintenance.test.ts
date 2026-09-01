import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMaintenanceTick,
  readMaintenanceStateTo,
  writeMaintenanceStateTo,
  buildRestartLauncher,
  detachedRestartEnv,
  maintenanceRestartLogPath,
  globalInstallUpdateCwd,
  spawnDetachedRestart,
  type MaintenanceDeps,
  type MaintenanceState,
} from '../src/core/maintenance.js';
import type { MaintenanceConfig } from '../src/global-config.js';
import type { RestartIntent } from '../src/services/restart-intent-store.js';
import { DASHBOARD_H5_ENV_KEYS, DASHBOARD_H5_ENV_PREFIX, WORKFLOW_WORKER_ENV_KEYS } from '../src/utils/child-env.js';
import { DAEMON_ENV_KEYS } from '../src/cli/daemon-lifecycle-env.js';

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
  const calls = {
    update: 0,
    restart: 0,
    writes: 0,
    locks: 0,
    outsideLock: [] as string[],
    intents: [] as RestartIntent[],
    logs: [] as string[],
  };
  let ver = opts.startVer ?? '2.64.0';
  const installTo = opts.installTo ?? '2.65.0';
  let locked = false;
  const deps: MaintenanceDeps = {
    now: () => NOON,
    readConfig: () => cfg,
    readState: () => state,
    writeState: () => { calls.writes++; },
    anyBusy: () => opts.busy ?? false,
    isLocalDev: () => opts.localDev ?? false,
    withUpdateLock: (fn) => {
      calls.locks++;
      locked = true;
      try { fn(); } finally { locked = false; }
    },
    currentVersion: () => ver,
    runUpdate: () => {
      if (!locked) calls.outsideLock.push('update');
      calls.update++;
      if (opts.updateThrows) throw new Error('npm fail');
      ver = installTo;
    },
    writeIntent: (i) => {
      if (!locked) calls.outsideLock.push('intent');
      calls.intents.push(i);
    },
    triggerRestart: () => {
      if (!locked) calls.outsideLock.push('restart');
      calls.restart++;
    },
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
    expect(calls.locks).toBe(1);
    expect(calls.outsideLock).toEqual([]);
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

describe('runMaintenanceTick — a binary self-replace still triggers the restart', () => {
  /**
   * THE SUBTLE BUG THIS PINS. For a package-manager update the new version lands
   * in the install's package.json, so re-reading it afterwards observes the
   * change, and `after !== before` is what gates the restart.
   *
   * A compiled binary has NO package.json: its version is BAKED IN at compile time
   * and read from the RUNNING process's own env. MEASURED: after swapping the file
   * on disk, `currentVersion()` still returns the OLD version. So the naive tick
   * computes `after === before`, logs "already on the latest version", and never
   * restarts onto the binary it just installed — the update silently does not
   * take effect until something else restarts the fleet.
   *
   * `installedVersion()` is therefore authoritative when set.
   */
  function selfReplaceDeps(reported: string, running = '3.18.4') {
    const calls = { update: 0, restart: 0, intents: [] as RestartIntent[], logs: [] as string[] };
    const deps: MaintenanceDeps = {
      now: () => NOON,
      readConfig: () => ({ autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } }),
      readState: () => ({}),
      writeState: () => {},
      anyBusy: () => false,
      isLocalDev: () => false,
      withUpdateLock: (fn) => fn(),
      // Deliberately CONSTANT: a self-replace cannot change what this process reports.
      currentVersion: () => running,
      runUpdate: () => { calls.update++; },
      installedVersion: () => reported,
      writeIntent: (i) => { calls.intents.push(i); },
      triggerRestart: () => { calls.restart++; },
      log: (m) => { calls.logs.push(m); },
    };
    return { deps, calls };
  }

  it('restarts using the version the self-replace reported, not the re-read one', () => {
    const { deps, calls } = selfReplaceDeps('3.19.0', '3.18.4');
    runMaintenanceTick(deps);
    expect(calls.update).toBe(1);
    // MUTATION CHECK: dropping `installedVersion` from the tick (i.e. going back
    // to `after = deps.currentVersion()`) makes both of these fail — restart 0 and
    // no intent — which is exactly the silent no-op described above.
    expect(calls.restart).toBe(1);
    expect(calls.intents).toEqual([
      { kind: 'update', oldVersion: '3.18.4', newVersion: '3.19.0', at: new Date(NOON).toISOString() },
    ]);
    expect(calls.logs.join('\n')).not.toMatch(/already on the latest/);
  });

  it('an unchanged version still means "already latest" (no spurious restart)', () => {
    // The guard must not fire merely because installedVersion is populated.
    const { deps, calls } = selfReplaceDeps('3.18.4', '3.18.4');
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(0);
    expect(calls.intents).toEqual([]);
    expect(calls.logs.join('\n')).toMatch(/already on the latest/);
  });

  it('the package-manager path is unaffected: an empty report falls back to re-reading', () => {
    // Regression guard for the currently-working npm path — it reports '' and must
    // keep using the before/after comparison.
    const { deps, calls } = makeDeps(
      { autoUpdate: { enabled: true, time: '12:00' }, autoRestart: { enabled: true } },
      { startVer: '2.64.0', installTo: '2.65.0' },
    );
    (deps as MaintenanceDeps).installedVersion = () => '';
    runMaintenanceTick(deps);
    expect(calls.restart).toBe(1);
    expect(calls.intents[0]).toMatchObject({ oldVersion: '2.64.0', newVersion: '2.65.0' });
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

describe('detachedRestartEnv', () => {
  it('drops runtime env snapshots before launching a managed restart', () => {
    const inherited = {
      WEB_EXTERNAL_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: '7991',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7992',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      // Mirrors DAEMON_ENV_KEYS: a baked BOTMUX_PUBLIC_URL must be stripped too,
      // else a detached restart keeps the stale proxy base instead of reloading
      // it from ~/.botmux/.env.
      BOTMUX_PUBLIC_URL: 'http://stale.proxy.example.com',
      ...Object.fromEntries(WORKFLOW_WORKER_ENV_KEYS.map((key) => [key, 'leaked'])),
      PATH: '/usr/bin',
    };

    expect(detachedRestartEnv(inherited)).toEqual({ PATH: '/usr/bin' });
    expect(inherited.WEB_EXTERNAL_HOST).toBe('10.255.64.131');
    expect(inherited.BOTMUX_WORKFLOW).toBe('leaked');
  });

  it('strips every key DAEMON_ENV_KEYS bakes into the PM2 env (mirror guard)', () => {
    // The two lists are deliberately separate literals (maintenance.ts must not
    // import the CLI layer), and the comment on each says they MUST stay
    // mirrored. This is what enforces it: a key added to DAEMON_ENV_KEYS but not
    // to detachedRestartEnv survives a detached restart (dashboard
    // update/restart, maintenance auto-update) as a stale baked value, so the
    // operator's ~/.botmux/.env edit never takes effect — the exact failure that
    // kept a re-keyed H5 APP_SECRET / a revoked open_id allowlist alive.
    const inherited = {
      ...Object.fromEntries(DAEMON_ENV_KEYS.map((key) => [key, 'stale'])),
      PATH: '/usr/bin',
    };

    expect(detachedRestartEnv(inherited)).toEqual({ PATH: '/usr/bin' });
  });

  it('strips the Dashboard H5 credential family the dashboard dotenv-loaded for itself', () => {
    // The H5 keys are deliberately OFF the DAEMON_ENV_KEYS mirror above (never
    // baked into the PM2 env block), but the DASHBOARD process legitimately
    // holds them: index-dashboard.ts dotenv-loads ~/.botmux/.env. The detached
    // `botmux restart` it spawns (update/restart button) inherits the
    // dashboard's env — the restart driver has no consumer for the family and
    // must not carry the APP_SECRET toward pm2. Prefix sweep included, so a
    // future H5 knob is covered the day it ships.
    const inherited = {
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map((key) => [key, 'secret'])),
      [`${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`]: 'secret',
      PATH: '/usr/bin',
    };

    expect(detachedRestartEnv(inherited)).toEqual({ PATH: '/usr/bin' });
    // In place on the copy only — the dashboard keeps its own working env.
    expect(inherited.BOTMUX_DASHBOARD_FEISHU_H5_APP_SECRET).toBe('secret');
  });
});

describe('maintenanceRestartLogPath', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('points at ~/.botmux/logs/maintenance-restart.log', () => {
    vi.stubEnv('HOME', '/home/bot');
    expect(maintenanceRestartLogPath()).toBe('/home/bot/.botmux/logs/maintenance-restart.log');
  });
});

describe('globalInstallUpdateCwd', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('runs npm global updates from HOME instead of inheriting the process cwd', () => {
    vi.stubEnv('HOME', '/home/bot');
    expect(globalInstallUpdateCwd()).toBe('/home/bot');
  });
});

describe('spawnDetachedRestart', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('passes the restart lease to the actual detached CLI driver', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-restart-driver-'));
    const packageRoot = join(dir, 'package');
    const output = join(dir, 'driver.json');
    const dataDir = join(dir, 'data');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(output)}, JSON.stringify({`,
      '  id: process.env.BOTMUX_RESTART_LEASE_ID,',
      '  dir: process.env.BOTMUX_RESTART_LEASE_DIR,',
      '  args: process.argv.slice(2),',
      '}));',
    ].join('\n'));
    vi.stubEnv('HOME', dir);
    vi.stubEnv('SESSION_DATA_DIR', dataDir);

    try {
      const child = spawnDetachedRestart('test', packageRoot, 'lease-123');
      expect(child.pid).toEqual(expect.any(Number));
      for (let i = 0; i < 50 && !existsSync(output); i++) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        id: 'lease-123',
        dir: dataDir,
        args: ['restart'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
