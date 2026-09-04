import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectFleetStatus,
  readFleetStatus,
  readFleetDaemonEnvFile,
  waitFleetOnline,
  resolveFleetDaemonEnv,
} from '../src/core/fleet-runtime.js';
import { writeFleetState } from '../src/core/fleet-state-store.js';
import { freshProc, type FleetState } from '../src/core/fleet-supervisor-policy.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'fleet-runtime-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const online = (name: string, pid: number): ReturnType<typeof freshProc> => freshProc(name, `cli_${name}`, pid, 'T');

describe('projectFleetStatus', () => {
  it('reports supervisor + rows, cross-checking liveness with the injected probe', () => {
    const state: FleetState = {
      supervisorPid: 100,
      supervisorStartedAt: '2026-01-01T00:00:00Z',
      procs: [online('botmux-0', 200), online('botmux-1', 201)],
    };
    // Probe says 100 + 200 alive, 201 dead.
    const alive = new Set([100, 200]);
    const status = projectFleetStatus(state, (pid) => alive.has(pid));
    expect(status.supervisorPid).toBe(100);
    expect(status.supervisorAlive).toBe(true);
    expect(status.rows).toHaveLength(2);
    expect(status.rows[0]).toMatchObject({ name: 'botmux-0', pid: 200, status: 'online', alive: true });
    // 201 recorded 'online' but the probe says dead → alive:false (status must
    // never lie about liveness between the supervisor's reconcile ticks).
    expect(status.rows[1]).toMatchObject({ name: 'botmux-1', pid: 201, status: 'online', alive: false });
  });

  it('null state → empty projection', () => {
    const status = projectFleetStatus(null, () => false);
    expect(status.supervisorPid).toBe(0);
    expect(status.supervisorAlive).toBe(false);
    expect(status.rows).toEqual([]);
  });

  it('default probe treats pid 0 / stopped rows as not alive', () => {
    const state: FleetState = {
      supervisorPid: 0,
      supervisorStartedAt: '',
      procs: [{ ...online('botmux-0', 0), status: 'stopped', pid: 0 }],
    };
    const status = projectFleetStatus(state); // real pidAlive
    expect(status.supervisorAlive).toBe(false);
    expect(status.rows[0].alive).toBe(false);
  });
});

describe('readFleetStatus (path-injected)', () => {
  it('reads and projects a state file', () => {
    const p = join(tmp(), 'fleet.json');
    // Use our own pid so the liveness cross-check sees it alive.
    writeFleetState(p, {
      supervisorPid: process.pid,
      supervisorStartedAt: 'T',
      procs: [online('botmux-0', process.pid)],
    });
    const status = readFleetStatus(p);
    expect(status.supervisorAlive).toBe(true);
    expect(status.rows[0]).toMatchObject({ name: 'botmux-0', alive: true, status: 'online' });
  });

  it('absent file → empty, not-alive', () => {
    const status = readFleetStatus(join(tmp(), 'nope.json'));
    expect(status.supervisorPid).toBe(0);
    expect(status.supervisorAlive).toBe(false);
    expect(status.rows).toEqual([]);
  });
});

describe('waitFleetOnline', () => {
  it('empty expected set → healthy immediately', () => {
    const r = waitFleetOnline([], 100, join(tmp(), 'nope.json'));
    expect(r).toMatchObject({ healthy: true, online: 0, expected: 0, pending: [] });
  });

  it('returns healthy at once when the file already shows all online+alive', () => {
    const p = join(tmp(), 'fleet.json');
    // Two DISTINCT live pids (projection identity forbids a shared live pid):
    // our own pid and our parent's, both alive for the duration of the test.
    writeFleetState(p, {
      supervisorPid: process.pid,
      supervisorStartedAt: 'T',
      procs: [online('botmux-0', process.pid), online('botmux-1', process.ppid)],
    });
    const r = waitFleetOnline(['botmux-0', 'botmux-1'], 2000, p);
    expect(r).toMatchObject({ healthy: true, online: 2, expected: 2, pending: [] });
  });

  it('times out reporting the pending (never-online) bots', () => {
    const p = join(tmp(), 'fleet.json');
    // botmux-0 online+alive; botmux-1 recorded but pid dead → stays pending.
    writeFleetState(p, {
      supervisorPid: process.pid,
      supervisorStartedAt: 'T',
      procs: [online('botmux-0', process.pid), { ...online('botmux-1', 999_999), status: 'launching', pid: 0 }],
    });
    const r = waitFleetOnline(['botmux-0', 'botmux-1'], 300, p);
    expect(r.healthy).toBe(false);
    expect(r.expected).toBe(2);
    expect(r.online).toBe(1);
    expect(r.pending).toEqual(['botmux-1']);
  });

  it('times out when the state file is absent', () => {
    const r = waitFleetOnline(['botmux-0'], 300, join(tmp(), 'absent.json'));
    expect(r.healthy).toBe(false);
    expect(r.pending).toEqual(['botmux-0']);
  });
});

describe('resolveFleetDaemonEnv (migration: SESSION_DATA_DIR must survive pm2→supervisor)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('REGRESSION #4: injects SESSION_DATA_DIR so supervised children keep ~/.botmux/data', () => {
    // The old pm2 ecosystem injected `SESSION_DATA_DIR: DATA_DIR` into every bot
    // daemon AND the dashboard. The pm2→supervisor migration deleted the ecosystem
    // and did NOT re-inject it — so daemons/dashboard fell back to <pkg>/data
    // (config.session.dataDir is `SESSION_DATA_DIR ?? packagedDataDir`, and the
    // daemon entrypoints don't run the CLI's `??= resolveDataDir()`), silently
    // moving the data root on upgrade. resolveFleetDaemonEnv must pin it.
    const home = mkdtempSync(join(tmpdir(), 'fleet-home-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', ''); // simulate a clean CLI env (env unset)
    // stubEnv('') sets an empty string; delete it so `??=` sees genuinely-unset.
    delete process.env.SESSION_DATA_DIR;

    const env = resolveFleetDaemonEnv(process.env, '');
    // Resolves to the stable user data dir (~/.botmux/data under the stubbed HOME),
    // NOT the package dir — this is exactly what the old ecosystem's DATA_DIR was.
    expect(env.SESSION_DATA_DIR).toBe(join(home, '.botmux', 'data'));
  });

  it('does NOT override an explicitly-set SESSION_DATA_DIR (??= keeps ambient value)', () => {
    const home = mkdtempSync(join(tmpdir(), 'fleet-home-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('SESSION_DATA_DIR', '/custom/data/root');
    const env = resolveFleetDaemonEnv(process.env, '');
    expect(env.SESSION_DATA_DIR).toBe('/custom/data/root'); // ambient override wins
  });

  it('reloads WEB_HOST from .env before a session-origin restart spawns the supervisor', () => {
    const env = resolveFleetDaemonEnv({
      BOTMUX_SESSION_ID: 'session-1',
      WEB_HOST: '127.0.0.1',
      SESSION_DATA_DIR: '/custom/data/root',
    }, 'WEB_HOST=10.9.9.9');

    expect(env.WEB_HOST).toBe('10.9.9.9');
  });

  it('reloads persisted settings when the caller explicitly requests a refresh', () => {
    const env = resolveFleetDaemonEnv({
      WEB_HOST: '127.0.0.1',
      SESSION_DATA_DIR: '/custom/data/root',
    }, 'WEB_HOST=10.9.9.9', true);

    expect(env.WEB_HOST).toBe('10.9.9.9');
  });

  it('uses only the authenticated detached fallback when .env cannot be read', () => {
    const env = resolveFleetDaemonEnv({
      WEB_HOST: 'must-not-win',
      WEB_EXTERNAL_PORT: '9999',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'failed' }, {
      refreshPersistedEnv: true,
      readFailureFallback: { WEB_HOST: '127.0.0.1', WEB_EXTERNAL_PORT: '9000' },
    });

    expect(env.WEB_HOST).toBe('127.0.0.1');
    expect(env.WEB_EXTERNAL_PORT).toBe('9000');
  });

  it('preserves the legacy boolean refresh fallback on read failure', () => {
    const env = resolveFleetDaemonEnv({
      WEB_HOST: '127.0.0.1',
      WEB_EXTERNAL_PORT: '9000',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'failed' }, true);

    expect(env.WEB_HOST).toBe('127.0.0.1');
    expect(env.WEB_EXTERNAL_PORT).toBe('9000');
  });

  it('preserves an inferred session refresh fallback on read failure', () => {
    const env = resolveFleetDaemonEnv({
      BOTMUX_SESSION_ID: 'session-1',
      WEB_HOST: '127.0.0.1',
      WEB_EXTERNAL_PORT: '9000',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'failed' }, {});

    expect(env.WEB_HOST).toBe('127.0.0.1');
    expect(env.WEB_EXTERNAL_PORT).toBe('9000');
  });

  it('ignores the fallback snapshot when .env is loaded', () => {
    const env = resolveFleetDaemonEnv({
      WEB_HOST: 'inherited',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'loaded', text: 'WEB_HOST=10.9.9.9' }, {
      refreshPersistedEnv: true,
      readFailureFallback: { WEB_HOST: 'fallback' },
    });

    expect(env.WEB_HOST).toBe('10.9.9.9');
  });

  it('ignores the fallback snapshot when .env is confirmed missing', () => {
    const env = resolveFleetDaemonEnv({
      WEB_HOST: 'inherited',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'missing' }, {
      refreshPersistedEnv: true,
      readFailureFallback: { WEB_HOST: 'fallback', WEB_EXTERNAL_PORT: '9000' },
    });

    expect(env.WEB_HOST).toBe('0.0.0.0');
    expect(env.WEB_EXTERNAL_PORT).toBe('');
  });

  it('fails closed on read failure when no validated fallback exists', () => {
    const env = resolveFleetDaemonEnv({
      WEB_HOST: 'untrusted-inherited',
      WEB_EXTERNAL_PORT: '9999',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'failed' }, { refreshPersistedEnv: true });

    expect(env.WEB_HOST).toBe('0.0.0.0');
    expect(env.WEB_EXTERNAL_PORT).toBe('');
  });

  it('keeps the resolved snapshot stable when the supervisor parses a changed file again', () => {
    const first = resolveFleetDaemonEnv({
      WEB_HOST: '127.0.0.1',
      WEB_EXTERNAL_PORT: '9000',
      SESSION_DATA_DIR: '/custom/data/root',
    }, 'WEB_HOST=10.9.9.9\nWEB_EXTERNAL_PORT=9100', true);
    const second = resolveFleetDaemonEnv(
      first,
      'WEB_HOST=192.0.2.10\nWEB_EXTERNAL_PORT=9200',
      false,
    );

    expect(second.WEB_HOST).toBe('10.9.9.9');
    expect(second.WEB_EXTERNAL_PORT).toBe('9100');
  });

  it('pins a complete inherited snapshot after a read failure so supervisor retry cannot drift', () => {
    const first = resolveFleetDaemonEnv({
      WEB_HOST: '127.0.0.1',
      SESSION_DATA_DIR: '/custom/data/root',
    }, { status: 'failed' }, {
      refreshPersistedEnv: true,
      readFailureFallback: { WEB_HOST: '127.0.0.1' },
    });
    const second = resolveFleetDaemonEnv(
      first,
      'WEB_HOST=192.0.2.10\nWEB_EXTERNAL_PORT=9200',
      false,
    );

    expect(second.WEB_HOST).toBe('127.0.0.1');
    expect(second.WEB_EXTERNAL_PORT).toBe('');
  });
});

describe('readFleetDaemonEnvFile', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it('loads a replacement that appears during the bounded ENOENT quiet period', () => {
    let readAttempt = 0;
    const readTextFile = vi.fn(() => {
      readAttempt += 1;
      if (readAttempt < 3) throw errno('ENOENT');
      return 'WEB_HOST=127.0.0.1';
    });
    const statFile = vi.fn(() => { throw errno('ENOENT'); });
    const waits: number[] = [];

    expect(readFleetDaemonEnvFile('/fake/.env', readTextFile, statFile, {
      sleep: delayMs => waits.push(delayMs),
    })).toEqual({
      status: 'loaded',
      text: 'WEB_HOST=127.0.0.1',
    });
    expect(waits).toEqual([10, 25]);
    expect(readTextFile).toHaveBeenCalledTimes(3);
    expect(statFile).toHaveBeenCalledTimes(2);
  });

  it('keeps uninterrupted ENOENT uncertain when no writer barrier can confirm deletion', () => {
    const readTextFile = vi.fn(() => { throw errno('ENOENT'); });
    const statFile = vi.fn(() => { throw errno('ENOENT'); });
    const waits: number[] = [];

    expect(readFleetDaemonEnvFile('/fake/.env', readTextFile, statFile, {
      retryDelaysMs: [4, 9],
      sleep: delayMs => waits.push(delayMs),
    })).toEqual({ status: 'failed' });
    expect(waits).toEqual([4, 9]);
    expect(readTextFile).toHaveBeenCalledTimes(3);
    expect(statFile).toHaveBeenCalledTimes(3);
  });

  it('does not classify the file as missing when any ENOENT round observes it present', () => {
    const readTextFile = vi.fn(() => { throw errno('ENOENT'); });
    const statFile = vi.fn()
      .mockImplementationOnce(() => ({}))
      .mockImplementation(() => { throw errno('ENOENT'); });
    const waits: number[] = [];

    expect(readFleetDaemonEnvFile('/fake/.env', readTextFile, statFile, {
      sleep: delayMs => waits.push(delayMs),
    })).toEqual({ status: 'failed' });
    expect(waits).toEqual([10, 25]);
    expect(readTextFile).toHaveBeenCalledTimes(3);
    expect(statFile).toHaveBeenCalledTimes(3);
  });

  it('reports a non-ENOENT read error immediately without probing or waiting', () => {
    const readTextFile = vi.fn(() => { throw errno('EACCES'); });
    const statFile = vi.fn(() => ({}));
    const waits: number[] = [];

    expect(readFleetDaemonEnvFile('/fake/.env', readTextFile, statFile, {
      sleep: delayMs => waits.push(delayMs),
    })).toEqual({ status: 'failed' });
    expect(statFile).not.toHaveBeenCalled();
    expect(waits).toEqual([]);
  });

  it('reports a non-ENOENT presence-probe error immediately without waiting', () => {
    const readTextFile = vi.fn(() => { throw errno('ENOENT'); });
    const statFile = vi.fn(() => { throw errno('EIO'); });
    const waits: number[] = [];

    expect(readFleetDaemonEnvFile('/fake/.env', readTextFile, statFile, {
      sleep: delayMs => waits.push(delayMs),
    })).toEqual({ status: 'failed' });
    expect(readTextFile).toHaveBeenCalledOnce();
    expect(statFile).toHaveBeenCalledOnce();
    expect(waits).toEqual([]);
  });

  it('returns an immediately loaded file without an initial stat or wait', () => {
    const statFile = vi.fn(() => ({}));
    const waits: number[] = [];

    expect(readFleetDaemonEnvFile('/fake/.env', () => 'WEB_HOST=127.0.0.1', statFile, {
      sleep: delayMs => waits.push(delayMs),
    })).toEqual({
      status: 'loaded',
      text: 'WEB_HOST=127.0.0.1',
    });
    expect(statFile).not.toHaveBeenCalled();
    expect(waits).toEqual([]);
  });
});
