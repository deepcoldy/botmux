/**
 * Durability, integrity and SCOPE of the mojo launcher-env quarantine.
 *
 * The in-memory ledger closed the within-session windows (restart timeline,
 * double-fork), but the record itself could still vanish or over-reach:
 *
 *   P1  a daemon restart wiped in-memory state, flipping the proof false -> true
 *   P1  an explicit `/close` deletes the row too — and a row that still EXISTS
 *       took the opposite path: mojo is not a persistent backend, so a workerless
 *       mojo row had no persistent target and fell through to `quiescent`
 *   P1  a dangerous key living only in `mojo.env` (backendConfig.env) was never
 *       recorded, so it survived a restart as "clean"
 *   P1  a corrupt first read / failed write / lost update across daemons all made
 *       the security ledger silently disappear
 *   P2  the choke point is shared by EVERY backend, so an ungated call
 *       quarantined codex/tmux sessions as "mojo" forever
 *
 * `MojoBackend.kill()` sends a bare SIGTERM (no escalation, no wait), the worker
 * exits without awaiting the child, and the child can leave detached descendants
 * — so none of these events prove the injected process died.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let liveBotConfig: Record<string, unknown> | undefined = {};
vi.mock('../src/bot-registry.js', () => ({
  getBot: () => {
    if (!liveBotConfig) throw new Error('bot deregistered');
    return { config: liveBotConfig };
  },
}));

import {
  MojoQuarantineUnavailableError,
  quarantinedLauncherEnvKeys,
  quarantinedSessionIds,
  recordQuarantinedLauncherEnvKeys,
} from '../src/core/mojo-launcher-env-quarantine.js';
import {
  appendResidualMojoLauncherEnvSessions,
  buildDeviceIsolationInventory,
  resetDeviceIsolationDaemonForTest,
  resolveRemoteExecutionProven,
  setDeviceIsolationDaemonDependenciesForTest,
  type DeviceIsolationRuntimeSession,
} from '../src/core/device-isolation-daemon.js';
import { rememberAppliedUnprovableEnvKeys } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

const FILE = 'mojo-launcher-env-quarantine.json';
let dir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mojo-quarantine-'));
  // config.session.dataDir is driven by SESSION_DATA_DIR. Without redirecting it
  // the calls that omit an explicit dataDir would write the REAL data dir and
  // leak state across tests.
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dir;
  liveBotConfig = { env: {} };
});
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

/** A mojo DaemonSession; `backendType` is load-bearing for the mojo-only gate. */
function mojoDs(opts: {
  sessionId?: string;
  backendConfig?: Record<string, unknown>;
  mojoIdentity?: Record<string, unknown>;
} = {}): DaemonSession {
  return {
    larkAppId: 'app_x',
    ...(opts.backendConfig
      ? { initConfig: { backendType: 'mojo', backendConfig: opts.backendConfig, env: {} } }
      : {}),
    session: {
      sessionId: opts.sessionId ?? 'sid-1',
      backendType: 'mojo',
      ...(opts.mojoIdentity ? { mojoIdentity: opts.mojoIdentity } : {}),
    },
  } as never as DaemonSession;
}

describe('quarantine durability and integrity', () => {
  it('survives a daemon restart (every read hits disk, no cache to lose)', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    expect(quarantinedLauncherEnvKeys('sid-1', dir)).toEqual(['LD_PRELOAD']);
  });

  it('accumulates and never retracts on a later clean payload', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    recordQuarantinedLauncherEnvKeys('sid-1', ['PATH'], dir);
    recordQuarantinedLauncherEnvKeys('sid-1', [], dir);
    expect([...quarantinedLauncherEnvKeys('sid-1', dir)].sort()).toEqual(['LD_PRELOAD', 'PATH']);
  });

  it('persists key NAMES only, never values', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    const raw = readFileSync(join(dir, FILE), 'utf8');
    expect(raw).toContain('LD_PRELOAD');
    expect(raw).not.toContain('/tmp/hook.so');
  });

  it('THROWS on a corrupt file instead of reporting "nothing quarantined"', () => {
    writeFileSync(join(dir, FILE), '{ this is not json');
    expect(() => quarantinedLauncherEnvKeys('sid-1', dir))
      .toThrow(MojoQuarantineUnavailableError);
    expect(() => quarantinedSessionIds(dir)).toThrow(MojoQuarantineUnavailableError);
  });

  it('THROWS on an unexpected shape rather than silently ignoring it', () => {
    writeFileSync(join(dir, FILE), JSON.stringify({ version: 1, sessions: 'nope' }));
    expect(() => quarantinedLauncherEnvKeys('sid-1', dir))
      .toThrow(MojoQuarantineUnavailableError);
  });

  it('PROPAGATES a write failure instead of logging and swallowing it', () => {
    // Read-only dir => rename/write fails. The caller must learn the risk was not
    // recorded rather than believe it was.
    recordQuarantinedLauncherEnvKeys('sid-seed', ['PATH'], dir);
    chmodSync(dir, 0o500);
    try {
      expect(() => recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir)).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('does a FRESH read inside the lock, so a concurrent daemon is not lost', () => {
    recordQuarantinedLauncherEnvKeys('sid-a', ['LD_PRELOAD'], dir);
    // Simulate another daemon writing between our read and write.
    writeFileSync(join(dir, FILE), JSON.stringify({
      version: 1,
      sessions: { 'sid-a': ['LD_PRELOAD'], 'sid-other': ['PATH'] },
    }));
    recordQuarantinedLauncherEnvKeys('sid-a', ['NODE_OPTIONS'], dir);
    // The other daemon's entry must still be there (no lost update).
    expect([...quarantinedSessionIds(dir)].sort()).toEqual(['sid-a', 'sid-other']);
    expect([...quarantinedLauncherEnvKeys('sid-a', dir)].sort())
      .toEqual(['LD_PRELOAD', 'NODE_OPTIONS']);
  });

  it('uses a unique temp file so two writers cannot clobber each other', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    // A shared `<file>.tmp` name would race; assert none is left behind and that
    // the implementation is not using the fixed name.
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    const src = readFileSync(
      new URL('../src/core/mojo-launcher-env-quarantine.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('`${path}.tmp`');
    expect(src).toContain('randomBytes');
  });

  it('writes nothing for an empty key set', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', [], dir);
    expect(existsSync(join(dir, FILE))).toBe(false);
  });

  it('exposes no clearing API — retention needs process-group termination proof', async () => {
    const mod = await import('../src/core/mojo-launcher-env-quarantine.js');
    const clearing = Object.keys(mod).filter((k) => /clear|remove|delete|forget|release/i.test(k));
    expect(clearing).toEqual([]);
  });
});

describe('the production ledger path records, and only for mojo', () => {
  it('persists the top-level per-bot env through rememberAppliedUnprovableEnvKeys', () => {
    const ds = mojoDs({ sessionId: 'sid-prod' });
    rememberAppliedUnprovableEnvKeys(ds, { LD_PRELOAD: '/tmp/hook.so' });
    expect(ds.mojoAppliedUnprovableEnvKeys).toEqual(['LD_PRELOAD']);
    // In-memory is not enough; a restart drops it.
    expect(quarantinedLauncherEnvKeys('sid-prod')).toEqual(['LD_PRELOAD']);
  });

  it('ALSO persists a key that lives only in mojo.env (backendConfig.env)', () => {
    // The reported P1: the mojo block's env is a peer of the top-level env and
    // wins the merge, but was recorded nowhere.
    const ds = mojoDs({
      sessionId: 'sid-blockenv',
      backendConfig: { cloud: true, env: { LD_PRELOAD: '/tmp/hook.so' } },
    });
    rememberAppliedUnprovableEnvKeys(ds, {});   // top-level clean
    expect(quarantinedLauncherEnvKeys('sid-blockenv')).toEqual(['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(mojoDs({
      sessionId: 'sid-blockenv', backendConfig: { cloud: true },
    }))).toBe(false);
  });

  it('falls back to the LIVE mojo.env when no worker config is frozen yet', () => {
    liveBotConfig = { env: {}, mojo: { env: { NODE_OPTIONS: '--require /tmp/x.js' } } };
    const ds = mojoDs({ sessionId: 'sid-livemojo' });
    rememberAppliedUnprovableEnvKeys(ds, {});
    expect(quarantinedLauncherEnvKeys('sid-livemojo')).toEqual(['NODE_OPTIONS']);
  });

  it('makes the proof fail closed across a simulated daemon restart', () => {
    rememberAppliedUnprovableEnvKeys(mojoDs({ sessionId: 'sid-prod2' }), { PATH: '/tmp/fake' });
    // Fresh DaemonSession with an EMPTY in-memory ledger — post-restart state.
    expect(resolveRemoteExecutionProven(mojoDs({
      sessionId: 'sid-prod2', backendConfig: { cloud: true },
    }))).toBe(false);
  });

  it('ignores the allowlisted credential name on the durable path too', () => {
    rememberAppliedUnprovableEnvKeys(mojoDs({ sessionId: 'sid-jwt' }), { X_JWT_TOKEN: 'a.b.c' });
    expect(quarantinedLauncherEnvKeys('sid-jwt')).toEqual([]);
    expect(resolveRemoteExecutionProven(mojoDs({
      sessionId: 'sid-jwt', backendConfig: { cloud: true },
    }))).toBe(true);
  });

  it('NEGATIVE: a non-mojo session is never quarantined', () => {
    // P2: this choke point is shared by every backend's restart. A tmux/codex bot
    // with LD_PRELOAD in bots.json must not be recorded as a mojo risk — that is
    // cross-backend contamination and permanent unprovability, not a leak.
    for (const backendType of ['pty', 'tmux', 'herdr', 'zellij', 'zmx', 'riff'] as const) {
      const ds = {
        larkAppId: 'app_x',
        session: { sessionId: `sid-${backendType}`, backendType },
      } as never as DaemonSession;
      rememberAppliedUnprovableEnvKeys(ds, { LD_PRELOAD: '/tmp/hook.so' });
      expect(ds.mojoAppliedUnprovableEnvKeys, backendType).toBeUndefined();
      expect(quarantinedLauncherEnvKeys(`sid-${backendType}`), backendType).toEqual([]);
    }
    expect(quarantinedSessionIds()).toEqual([]);
  });

  it('NEGATIVE: a live worker frozen onto a local backend is not quarantined', () => {
    // The frozen worker stamp wins over the row, so a session whose init says pty
    // stays out even if the row still says mojo.
    const ds = {
      larkAppId: 'app_x',
      initConfig: { backendType: 'pty', env: {} },
      session: { sessionId: 'sid-frozen-pty', backendType: 'mojo' },
    } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(ds, { LD_PRELOAD: '/tmp/hook.so' });
    expect(quarantinedLauncherEnvKeys('sid-frozen-pty')).toEqual([]);
  });
});

describe('all three isolation branches consult the durable quarantine', () => {
  it('ACTIVE (fromInit): a persisted key voids the proof after a daemon restart', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(mojoDs({ backendConfig: { cloud: true } }))).toBe(false);
  });

  it('WORKERLESS (mojoIdentity): a persisted key voids the proof', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(mojoDs({ mojoIdentity: { cloud: true } }))).toBe(false);
  });

  it('LEGACY (live bot config only): a persisted key voids the proof', () => {
    liveBotConfig = { mojo: { cloud: true }, env: {} };
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(mojoDs())).toBe(false);
  });

  it('leaves all three provable when nothing was ever recorded', () => {
    expect(resolveRemoteExecutionProven(mojoDs({ backendConfig: { cloud: true } }))).toBe(true);
    expect(resolveRemoteExecutionProven(mojoDs({ mojoIdentity: { cloud: true } }))).toBe(true);
    liveBotConfig = { mojo: { cloud: true }, env: {} };
    expect(resolveRemoteExecutionProven(mojoDs())).toBe(true);
  });

  it('fails CLOSED when the ledger cannot be read', () => {
    writeFileSync(join(dir, FILE), 'corrupt');
    expect(resolveRemoteExecutionProven(mojoDs({ backendConfig: { cloud: true } }))).toBe(false);
  });

  it('scopes the block to the recorded session only', () => {
    recordQuarantinedLauncherEnvKeys('sid-dirty', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(mojoDs({
      sessionId: 'sid-clean', backendConfig: { cloud: true },
    }))).toBe(true);
    expect(resolveRemoteExecutionProven(mojoDs({
      sessionId: 'sid-dirty', backendConfig: { cloud: true },
    }))).toBe(false);
  });
});

describe('quarantined sessions stay blocked whether or not a row survives', () => {
  it('re-admits a quarantined session that has no row at all', () => {
    const merged = appendResidualMojoLauncherEnvSessions([], ['sid-gone']);
    expect(merged).toHaveLength(1);
    expect(merged[0].sessionId).toBe('sid-gone');
    expect(merged[0].mojoLauncherEnvResidual).toBe(true);
    expect(merged[0].remoteExecutionProven).toBe(false);
  });

  it('does not duplicate a session that still has a row', () => {
    const live: DeviceIsolationRuntimeSession[] = [
      { sessionId: 'sid-live', adopted: false, frozenBackend: 'mojo' },
    ];
    const merged = appendResidualMojoLauncherEnvSessions(live, ['sid-live']);
    expect(merged).toHaveLength(1);
    expect(merged[0].mojoLauncherEnvResidual).toBeUndefined();
  });

  it('adds nothing when no session was ever quarantined', () => {
    expect(appendResidualMojoLauncherEnvSessions([], [])).toEqual([]);
  });

  it('BLOCKS a workerless row that still exists (was reported quiescent)', () => {
    // The reported P1. mojo is not a persistent backend, so a workerless mojo row
    // resolves no persistent target and used to fall straight through to
    // `quiescent` — nothing to tear down — while the residual append skipped it
    // precisely BECAUSE the row was already known.
    recordQuarantinedLauncherEnvKeys('sid-workerless', ['LD_PRELOAD']);
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [{
        sessionId: 'sid-workerless',
        adopted: false,
        frozenBackend: 'mojo',
        workerPresent: false,
      }],
    });
    try {
      const inventory = buildDeviceIsolationInventory();
      expect(inventory.entries[0].disposition).toBe('blocked');
      expect(inventory.entries[0].blocker).toBe('mojo_launcher_env_residual');
      expect(inventory.blockers.map((b) => b.blocker)).toContain('mojo_launcher_env_residual');
    } finally {
      resetDeviceIsolationDaemonForTest();
    }
  });

  it('leaves an unquarantined workerless row quiescent (no over-blocking)', () => {
    setDeviceIsolationDaemonDependenciesForTest({
      listSessions: () => [{
        sessionId: 'sid-clean-workerless',
        adopted: false,
        frozenBackend: 'mojo',
        workerPresent: false,
      }],
    });
    try {
      expect(buildDeviceIsolationInventory().entries[0].disposition).toBe('quiescent');
    } finally {
      resetDeviceIsolationDaemonForTest();
    }
  });

  it('refuses to report "no residual" when the ledger is unreadable', () => {
    // The default argument reads the ledger; an unreadable one must abort the
    // activation rather than quietly yield an empty residual set.
    writeFileSync(join(dir, FILE), 'corrupt');
    expect(() => appendResidualMojoLauncherEnvSessions([])).toThrow(/unreadable/);
  });
});
