import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMaintenanceTick,
  readMaintenanceStateTo,
  writeMaintenanceStateTo,
  buildRestartLauncher,
  consumeDetachedRestartEnvRefresh,
  DETACHED_RESTART_ENV_REFRESH,
  DETACHED_RESTART_ENV_FALLBACK,
  detachedRestartEnv,
  prepareRestartDriverContext,
  maintenanceRestartLogPath,
  globalInstallUpdateCwd,
  spawnDetachedRestart,
  type MaintenanceDeps,
  type MaintenanceState,
} from '../src/core/maintenance.js';
import type { MaintenanceConfig } from '../src/global-config.js';
import type { RestartIntent } from '../src/services/restart-intent-store.js';
import { claimRestartLeaseTo } from '../src/services/restart-intent-store.js';
import { DASHBOARD_H5_ENV_KEYS, DASHBOARD_H5_ENV_PREFIX, WORKFLOW_WORKER_ENV_KEYS } from '../src/utils/child-env.js';
import { DAEMON_ENV_KEYS } from '../src/cli/daemon-lifecycle-env.js';
import { resolveFleetDaemonEnv } from '../src/core/fleet-runtime.js';
import { legacyDetachedRestartEnv } from './fixtures/legacy-detached-restart-sender.js';
import { spawnSyncTsEvalWithRepoImports, spawnSyncTsScript } from './helpers/ts-runner.js';

function spawnCurrentDetachedRestartSender(
  home: string,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const source = [
    "import { detachedRestartEnv } from './src/core/maintenance.js';",
    `const result = detachedRestartEnv(${JSON.stringify(inherited)});`,
    "process.stdout.write('BOTMUX_RESULT=' + JSON.stringify(result));",
  ].join('\n');
  const result = spawnSyncTsEvalWithRepoImports(source, {
    cwd: join(__dirname, '..'),
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr?.toString()).toBe(0);
  const output = result.stdout.toString();
  const marker = 'BOTMUX_RESULT=';
  const index = output.lastIndexOf(marker);
  expect(index, output).toBeGreaterThanOrEqual(0);
  return JSON.parse(output.slice(index + marker.length)) as NodeJS.ProcessEnv;
}

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
  it('carries the allowlisted runtime snapshot for old and lease-authenticated new receivers', () => {
    const inherited = {
      WEB_HOST: '127.0.0.1',
      WEB_EXTERNAL_HOST: '10.255.64.131',
      WEB_EXTERNAL_PORT: '9000',
      BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      BOTMUX_WORKER_HTTP_HOST: '0.0.0.0',
      BOTMUX_WORKER_HOST: '::',
      BOTMUX_DASHBOARD_EXTERNAL_HOST: '10.255.64.131',
      BOTMUX_DASHBOARD_HOST: '127.0.0.1',
      BOTMUX_DASHBOARD_PORT: '7991',
      BOTMUX_DAEMON_IPC_BASE_PORT: '7992',
      BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      // Mirrors DAEMON_ENV_KEYS: this snapshot is retained only as the safe
      // fallback when ~/.botmux/.env cannot be read. A successful refresh still
      // replaces it before the supervisor starts.
      BOTMUX_PUBLIC_URL: 'http://stale.proxy.example.com',
      ...Object.fromEntries(WORKFLOW_WORKER_ENV_KEYS.map((key) => [key, 'leaked'])),
      BOTMUX_SESSION_ID: 'session-secret',
      BOTMUX_OWNER_OPEN_ID: 'owner-secret',
      __OWNER_OPEN_ID: 'owner-secret',
      BOTMUX_ORIGIN_CHANNEL_ID: 'origin-secret',
      CLAUDE_CONFIG_DIR: '/secret/claude-home',
      CLAUDE_CODE_SESSION_ID: 'claude-secret',
      GITHUB_TOKEN: 'github-secret',
      LARK_APP_SECRET: 'lark-secret',
      [DETACHED_RESTART_ENV_REFRESH]: 'stale-marker',
      [DETACHED_RESTART_ENV_FALLBACK]: 'stale-payload',
      PATH: '/usr/bin',
    };

    const detached = detachedRestartEnv(inherited, { status: 'failed' });
    const expectedSnapshot = resolveFleetDaemonEnv(inherited, { status: 'failed' }, {
      refreshPersistedEnv: true,
      readFailureFallback: Object.fromEntries(DAEMON_ENV_KEYS
        .filter((key) => inherited[key] !== undefined)
        .map((key) => [key, inherited[key]])),
    });
    expect(detached).toMatchObject({
      PATH: '/usr/bin',
      ...Object.fromEntries(DAEMON_ENV_KEYS.map((key) => [key, expectedSnapshot[key]])),
    });
    expect(detached[DETACHED_RESTART_ENV_REFRESH]).toBeUndefined();
    expect(detached[DETACHED_RESTART_ENV_FALLBACK]).toBeUndefined();
    expect(detached.GITHUB_TOKEN).toBe('github-secret');
    expect(detached.LARK_APP_SECRET).toBe('lark-secret');
    expect(inherited.WEB_EXTERNAL_HOST).toBe('10.255.64.131');
    expect(inherited.BOTMUX_WORKFLOW).toBe('leaked');
  });

  it('keeps every lifecycle key in the cross-version outer snapshot', () => {
    const inherited = {
      ...Object.fromEntries(DAEMON_ENV_KEYS.map((key) => [key, 'stale'])),
      PATH: '/usr/bin',
    };

    const detached = detachedRestartEnv(inherited, { status: 'failed' });
    expect(detached).toEqual({
      PATH: '/usr/bin',
      ...Object.fromEntries(DAEMON_ENV_KEYS.map((key) => [
        key, key === 'BOTMUX_WORKER_HOST' ? '' : 'stale',
      ])),
    });
  });

  it('consumes the refresh marker exactly once', () => {
    const env = { [DETACHED_RESTART_ENV_REFRESH]: '1', PATH: '/usr/bin' };

    expect(consumeDetachedRestartEnvRefresh(env)).toBe(true);
    expect(env).toEqual({ PATH: '/usr/bin' });
    expect(consumeDetachedRestartEnvRefresh(env)).toBe(false);
  });

  it('recognizes an old detached sender by a valid lease even without the new marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-old-restart-sender-'));
    const now = Date.now();
    try {
      const leaseId = claimRestartLeaseTo(dir, now)!;
      const env = legacyDetachedRestartEnv({
        BOTMUX_RESTART_LEASE_ID: leaseId,
        BOTMUX_RESTART_LEASE_DIR: dir,
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
        BOTMUX_WORKER_HTTP_HOST: '127.0.0.3',
        PATH: '/usr/bin',
      });

      const context = prepareRestartDriverContext(env, process.pid, now + 1);
      expect(context).toEqual({
        refreshPersistedEnv: true,
        readFailureFallback: {
          WEB_HOST: '127.0.0.1',
          WEB_EXTERNAL_PORT: '9000',
          BOTMUX_WEB_PROXY_BASE_PORT: '8800',
          BOTMUX_WORKER_HTTP_HOST: '127.0.0.3',
        },
      });
      expect(env).toEqual({ PATH: '/usr/bin' });

      const resolved = resolveFleetDaemonEnv(env, [
        'WEB_HOST=10.9.9.9',
        'WEB_EXTERNAL_PORT=9100',
        'BOTMUX_WEB_PROXY_BASE_PORT=8900',
        'BOTMUX_WORKER_HTTP_HOST=127.0.0.2',
      ].join('\n'), context);
      expect(resolved.WEB_HOST).toBe('10.9.9.9');
      expect(resolved.WEB_EXTERNAL_PORT).toBe('9100');
      expect(resolved.BOTMUX_WEB_PROXY_BASE_PORT).toBe('8900');
      expect(resolved.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.2');

      const failed = resolveFleetDaemonEnv(env, { status: 'failed' }, context);
      expect(failed.WEB_HOST).toBe('127.0.0.1');
      expect(failed.WEB_EXTERNAL_PORT).toBe('9000');
      expect(failed.BOTMUX_WEB_PROXY_BASE_PORT).toBe('8800');
      expect(failed.BOTMUX_WORKER_HTTP_HOST).toBe('127.0.0.3');

      const missing = resolveFleetDaemonEnv(env, { status: 'missing' }, context);
      expect(missing.WEB_HOST).toBe('0.0.0.0');
      expect(missing.WEB_EXTERNAL_PORT).toBe('');
      expect(missing.BOTMUX_WEB_PROXY_BASE_PORT).toBe('');
      expect(missing.BOTMUX_WORKER_HTTP_HOST).toBe('0.0.0.0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the outer snapshot only after binding its restart lease', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-new-restart-sender-'));
    const now = Date.now();
    try {
      const leaseId = claimRestartLeaseTo(dir, now)!;
      const detached = detachedRestartEnv(
        {
          WEB_HOST: '127.0.0.1',
          WEB_EXTERNAL_PORT: '9000',
          [DETACHED_RESTART_ENV_REFRESH]: 'stale-marker',
          [DETACHED_RESTART_ENV_FALLBACK]: 'stale-payload',
        },
        { status: 'failed' },
      );
      const env = {
        ...detached,
        BOTMUX_RESTART_LEASE_ID: leaseId,
        BOTMUX_RESTART_LEASE_DIR: dir,
      };

      expect(prepareRestartDriverContext(env, process.pid, now + 1)).toEqual({
        refreshPersistedEnv: true,
        readFailureFallback: expect.objectContaining({
          WEB_HOST: '127.0.0.1',
          WEB_EXTERNAL_PORT: '9000',
          BOTMUX_WORKER_HTTP_HOST: '0.0.0.0',
          BOTMUX_WORKER_HOST: '',
          BOTMUX_DASHBOARD_HOST: '0.0.0.0',
        }),
      });
      expect(env).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a large outer fallback snapshot without a second serialization limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-large-restart-snapshot-'));
    const now = Date.now();
    try {
      const leaseId = claimRestartLeaseTo(dir, now)!;
      const oversizedHost = `127.0.0.1-${'x'.repeat(17 * 1024)}`;
      const env = {
        ...detachedRestartEnv(
          { WEB_HOST: oversizedHost, WEB_EXTERNAL_PORT: '9000' },
          { status: 'failed' },
        ),
        BOTMUX_RESTART_LEASE_ID: leaseId,
        BOTMUX_RESTART_LEASE_DIR: dir,
      };

      expect(env[DETACHED_RESTART_ENV_FALLBACK]).toBeUndefined();
      expect(env.WEB_HOST).toBe(oversizedHost);
      const context = prepareRestartDriverContext(env, process.pid, now + 1);
      expect(context).toEqual({
        refreshPersistedEnv: true,
        readFailureFallback: expect.objectContaining({
          WEB_HOST: oversizedHost,
          WEB_EXTERNAL_PORT: '9000',
        }),
      });
      expect(resolveFleetDaemonEnv(env, { status: 'failed' }, context).WEB_HOST).toBe(oversizedHost);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the sender-resolved file snapshot for legacy receivers when the file was readable', () => {
    const inherited = {
      WEB_HOST: '127.0.0.1',
      WEB_EXTERNAL_PORT: '9000',
      BOTMUX_WEB_PROXY_BASE_PORT: '8800',
    };
    const detached = detachedRestartEnv(inherited, {
      status: 'loaded',
      text: [
        'WEB_HOST=10.9.9.9',
        'WEB_EXTERNAL_PORT=9100',
        'BOTMUX_WEB_PROXY_BASE_PORT=8900',
      ].join('\n'),
    });

    expect(detached).toMatchObject({
      WEB_HOST: '10.9.9.9',
      WEB_EXTERNAL_PORT: '9100',
      BOTMUX_WEB_PROXY_BASE_PORT: '8900',
    });
    expect(detached[DETACHED_RESTART_ENV_REFRESH]).toBeUndefined();
    expect(detached[DETACHED_RESTART_ENV_FALLBACK]).toBeUndefined();
  });

  it('lets a legacy receiver observe the sender-resolved file snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-legacy-loaded-receiver-'));
    const envFile = join(dir, '.botmux', '.env');
    const envFileText = [
      'WEB_HOST=10.9.9.9',
      'WEB_EXTERNAL_PORT=9100',
      'BOTMUX_WEB_PROXY_BASE_PORT=8900',
      '',
    ].join('\n');
    mkdirSync(join(dir, '.botmux'), { recursive: true });
    writeFileSync(envFile, envFileText);
    const detached = {
      ...spawnCurrentDetachedRestartSender(dir, {
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      }),
      BOTMUX_RESTART_LEASE_ID: 'lease-123',
      BOTMUX_RESTART_LEASE_DIR: join(dir, '.botmux', 'data'),
    };
    try {
      const result = spawnSyncTsScript(
        join(__dirname, 'fixtures', 'legacy-restart-env-receiver.ts'),
        [envFile],
        { cwd: join(__dirname, '..'), env: detached, encoding: 'utf8' },
      );
      expect(result.status, result.stderr?.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        WEB_HOST: '10.9.9.9',
        WEB_EXTERNAL_PORT: '9100',
        BOTMUX_WEB_PROXY_BASE_PORT: '8900',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the authenticated fallback when a bare ENOENT cannot prove deletion', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-legacy-missing-receiver-'));
    const envFile = join(dir, '.botmux', '.env');
    const detached = {
      ...spawnCurrentDetachedRestartSender(dir, {
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      }),
      BOTMUX_RESTART_LEASE_ID: 'lease-123',
      BOTMUX_RESTART_LEASE_DIR: join(dir, '.botmux', 'data'),
    };
    try {
      const result = spawnSyncTsScript(
        join(__dirname, 'fixtures', 'legacy-restart-env-receiver.ts'),
        [envFile],
        { cwd: join(__dirname, '..'), env: detached, encoding: 'utf8' },
      );
      expect(result.status, result.stderr?.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scrubs stale one-shot fields and falls back to the current outer snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-stale-restart-payload-'));
    const now = Date.now();
    try {
      const leaseId = claimRestartLeaseTo(dir, now)!;
      const env = {
        BOTMUX_RESTART_LEASE_ID: leaseId,
        BOTMUX_RESTART_LEASE_DIR: dir,
        WEB_HOST: 'current-outer-value',
        [DETACHED_RESTART_ENV_REFRESH]: '1',
        [DETACHED_RESTART_ENV_FALLBACK]: JSON.stringify({
          version: 1,
          leaseId: 'older-generation',
          env: { WEB_HOST: 'stale-payload-value' },
        }),
      };

      expect(prepareRestartDriverContext(env, process.pid, now + 1)).toEqual({
        refreshPersistedEnv: true,
        readFailureFallback: { WEB_HOST: 'current-outer-value' },
      });
      expect(env).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let stale one-shot fields authorize a detached refresh without a lease', () => {
    const env = {
      WEB_HOST: 'shell-value',
      [DETACHED_RESTART_ENV_REFRESH]: '1',
      [DETACHED_RESTART_ENV_FALLBACK]: JSON.stringify({
        version: 1,
        leaseId: 'untrusted-lease',
        env: { WEB_HOST: 'payload-value' },
      }),
    };

    expect(prepareRestartDriverContext(env)).toEqual({ refreshPersistedEnv: false });
    expect(env).toEqual({ WEB_HOST: 'shell-value' });
  });

  it('keeps managed-session manual restart refresh behavior', () => {
    const env = { BOTMUX_SESSION_ID: 'session-1', WEB_HOST: 'session-value' };

    expect(prepareRestartDriverContext(env)).toEqual({
      refreshPersistedEnv: true,
      readFailureFallback: { WEB_HOST: 'session-value' },
    });
    expect(env).toEqual({ BOTMUX_SESSION_ID: 'session-1', WEB_HOST: 'session-value' });
  });

  it('rejects an invalid lease after scrubbing inherited one-shot fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-invalid-restart-lease-'));
    const env = {
      BOTMUX_RESTART_LEASE_ID: 'wrong-id',
      BOTMUX_RESTART_LEASE_DIR: dir,
      [DETACHED_RESTART_ENV_REFRESH]: '1',
      [DETACHED_RESTART_ENV_FALLBACK]: JSON.stringify({
        version: 1,
        leaseId: 'wrong-id',
        env: { WEB_HOST: 'payload' },
      }),
    };
    try {
      expect(() => prepareRestartDriverContext(env)).toThrow('failed to bind restart driver lease');
      expect(env).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores an inherited malformed payload and uses the current outer fallback after lease validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-malformed-restart-payload-'));
    const now = Date.now();
    try {
      const leaseId = claimRestartLeaseTo(dir, now)!;
      const env = {
        BOTMUX_RESTART_LEASE_ID: leaseId,
        BOTMUX_RESTART_LEASE_DIR: dir,
        WEB_HOST: 'must-not-be-revived',
        [DETACHED_RESTART_ENV_REFRESH]: '1',
        [DETACHED_RESTART_ENV_FALLBACK]: '{bad json',
      };

      const context = prepareRestartDriverContext(env, process.pid, now + 1);
      expect(context).toEqual({
        refreshPersistedEnv: true,
        readFailureFallback: { WEB_HOST: 'must-not-be-revived' },
      });
      expect(env).toEqual({});
      expect(resolveFleetDaemonEnv(env, { status: 'failed' }, context).WEB_HOST)
        .toBe('must-not-be-revived');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unpaired restart lease directory before starting the fleet', () => {
    const env = {
      BOTMUX_RESTART_LEASE_DIR: '/tmp/unpaired-restart-lease',
      [DETACHED_RESTART_ENV_REFRESH]: '1',
      [DETACHED_RESTART_ENV_FALLBACK]: JSON.stringify({
        version: 1,
        leaseId: 'unpaired-lease',
        env: { WEB_HOST: 'payload' },
      }),
    };

    expect(() => prepareRestartDriverContext(env)).toThrow('restart driver lease id is missing');
    expect(env).toEqual({});
  });

  it('keeps a new sender read-failure-compatible with a legacy receiver that ignores internal fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-legacy-receiver-'));
    const envFile = join(dir, '.botmux', '.env');
    mkdirSync(join(dir, '.botmux'), { recursive: true });
    mkdirSync(envFile);
    const detached = spawnCurrentDetachedRestartSender(dir, {
      WEB_HOST: '127.0.0.1',
      WEB_EXTERNAL_PORT: '9000',
      BOTMUX_WEB_PROXY_BASE_PORT: '8800',
    });
    try {
      const result = spawnSyncTsScript(
        join(__dirname, 'fixtures', 'legacy-restart-env-receiver.ts'),
        [envFile],
        { cwd: join(__dirname, '..'), env: detached, encoding: 'utf8' },
      );
      expect(result.status, result.stderr?.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not persist one-shot protocol fields through a legacy receiver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-legacy-receiver-env-boundary-'));
    const envFile = join(dir, '.botmux', '.env');
    mkdirSync(join(dir, '.botmux'), { recursive: true });
    mkdirSync(envFile);
    const detached = {
      ...spawnCurrentDetachedRestartSender(dir, {
        WEB_HOST: '127.0.0.1',
        WEB_EXTERNAL_PORT: '9000',
        BOTMUX_WEB_PROXY_BASE_PORT: '8800',
      }),
      BOTMUX_RESTART_LEASE_ID: 'lease-123',
      BOTMUX_RESTART_LEASE_DIR: join(dir, '.botmux', 'data'),
    };
    try {
      const result = spawnSyncTsScript(
        join(__dirname, 'fixtures', 'legacy-restart-env-receiver.ts'),
        [envFile, '--inspect-internal'],
        { cwd: join(__dirname, '..'), env: detached, encoding: 'utf8' },
      );
      expect(result.status, result.stderr?.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        WEB_HOST: '127.0.0.1',
        internalRestartKeys: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips the Dashboard H5 credential family the dashboard dotenv-loaded for itself', () => {
    // The H5 keys are deliberately OFF DAEMON_ENV_KEYS (never
    // included in the shared fleet env), but the DASHBOARD process legitimately
    // holds them: index-dashboard.ts dotenv-loads ~/.botmux/.env. The detached
    // `botmux restart` it spawns (update/restart button) inherits the
    // dashboard's env — the restart driver has no consumer for the family and
    // must not carry the APP_SECRET toward the fleet. Prefix sweep included, so a
    // future H5 knob is covered the day it ships.
    const inherited = {
      ...Object.fromEntries(DASHBOARD_H5_ENV_KEYS.map((key) => [key, 'secret'])),
      [`${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`]: 'secret',
      PATH: '/usr/bin',
    };

    const detached = detachedRestartEnv(inherited, { status: 'failed' });
    expect(detached.PATH).toBe('/usr/bin');
    expect(detached[DETACHED_RESTART_ENV_REFRESH]).toBeUndefined();
    expect(detached[DETACHED_RESTART_ENV_FALLBACK]).toBeUndefined();
    for (const key of [...DASHBOARD_H5_ENV_KEYS, `${DASHBOARD_H5_ENV_PREFIX}FUTURE_KNOB`]) {
      expect(detached[key]).toBeUndefined();
    }
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
      '  marker: process.env.BOTMUX_INTERNAL_REFRESH_DAEMON_ENV,',
      '  payload: process.env.BOTMUX_INTERNAL_RESTART_ENV_FALLBACK,',
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
