/**
 * Durability of the mojo launcher-env quarantine, and the three isolation paths
 * that must all consult it.
 *
 * The in-memory ledger closed the within-session windows (restart timeline,
 * double-fork), but three holes remained, all with the same shape — the record
 * disappears while the dangerous process may not have:
 *
 *   1. daemon restart wipes in-memory state, so the proof flipped false -> true
 *   2. an explicit `/close` deletes the session row as well
 *   3. the workerless (`mojoIdentity`) and legacy branches never consumed the
 *      ledger at all, so a session reaching them was classified safe_remote
 *      regardless of what env its child had been handed
 *
 * `MojoBackend.kill()` sends a bare SIGTERM (no escalation, no wait), the worker
 * exits without awaiting the child, and the child can leave detached
 * descendants — so none of these events prove the injected process died.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  quarantinedLauncherEnvKeys,
  quarantinedSessionIds,
  recordQuarantinedLauncherEnvKeys,
  resetQuarantineCacheForTest,
} from '../src/core/mojo-launcher-env-quarantine.js';
import {
  appendResidualMojoLauncherEnvSessions,
  resolveRemoteExecutionProven,
  type DeviceIsolationRuntimeSession,
} from '../src/core/device-isolation-daemon.js';
import { rememberAppliedUnprovableEnvKeys } from '../src/core/worker-pool.js';
import type { DaemonSession } from '../src/core/types.js';

let dir: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mojo-quarantine-'));
  // config.session.dataDir is driven by SESSION_DATA_DIR, so point the durable
  // store at a temp dir. Without this the calls that omit an explicit dataDir
  // would write to the real data dir and leak state ACROSS tests — which is how
  // the "nothing recorded" case first failed here.
  previousDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dir;
  liveBotConfig = { env: {} };
  resetQuarantineCacheForTest();
});
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
  resetQuarantineCacheForTest();
});

describe('mojo launcher-env quarantine — durability', () => {
  it('survives a daemon restart (re-read from disk with no cache)', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    // Simulate the daemon process dying: every in-memory trace is gone.
    resetQuarantineCacheForTest();
    expect(quarantinedLauncherEnvKeys('sid-1', dir)).toEqual(['LD_PRELOAD']);
  });

  it('accumulates and never retracts on a later clean payload', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    recordQuarantinedLauncherEnvKeys('sid-1', ['PATH'], dir);
    recordQuarantinedLauncherEnvKeys('sid-1', [], dir);
    resetQuarantineCacheForTest();
    expect([...quarantinedLauncherEnvKeys('sid-1', dir)].sort()).toEqual(['LD_PRELOAD', 'PATH']);
  });

  it('persists key NAMES only, never values', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD'], dir);
    const raw = readFileSync(join(dir, 'mojo-launcher-env-quarantine.json'), 'utf8');
    expect(raw).toContain('LD_PRELOAD');
    // A value would be a credential leak into a plain file.
    expect(raw).not.toContain('/tmp/hook.so');
    expect(raw).not.toContain('secret');
  });

  it('keeps one session id from penalising another', () => {
    recordQuarantinedLauncherEnvKeys('sid-dirty', ['LD_PRELOAD'], dir);
    expect(quarantinedLauncherEnvKeys('sid-clean', dir)).toEqual([]);
    expect(quarantinedSessionIds(dir)).toEqual(['sid-dirty']);
  });

  it('writes nothing for an empty key set', () => {
    recordQuarantinedLauncherEnvKeys('sid-1', [], dir);
    expect(existsSync(join(dir, 'mojo-launcher-env-quarantine.json'))).toBe(false);
  });

  it('exposes no clearing API — retention needs process-group termination proof', async () => {
    // A clear would assert the injected process is gone, which nothing here can
    // prove. Pin the module surface so a future "cleanup" helper cannot be added
    // without revisiting that argument.
    const mod = await import('../src/core/mojo-launcher-env-quarantine.js');
    const clearing = Object.keys(mod).filter((k) => /clear|remove|delete|forget|release/i.test(k));
    expect(clearing).toEqual([]);
  });
});

/** Minimal DaemonSession for each of the three classifier branches. */
function ds(opts: {
  sessionId?: string;
  backendConfig?: Record<string, unknown>;
  mojoIdentity?: Record<string, unknown>;
}): DaemonSession {
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

/**
 * Through the PRODUCTION recording path, not the module directly.
 *
 * The durability cases above call recordQuarantinedLauncherEnvKeys() themselves,
 * so they stay green even if worker-pool stops persisting — the same
 * "tested the module, not the call path" false-green that has bitten this branch
 * before. These assert that rememberAppliedUnprovableEnvKeys (which every
 * restart sender funnels through) actually reaches disk.
 */
describe('the production ledger path persists, not just the in-memory copy', () => {
  it('writes the durable record when a session is handed a dangerous env', () => {
    const live = {
      larkAppId: 'app_x',
      session: { sessionId: 'sid-prod' },
    } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(live, { LD_PRELOAD: '/tmp/hook.so' });

    // In-memory copy is not enough — drop it the way a daemon restart would.
    expect(live.mojoAppliedUnprovableEnvKeys).toEqual(['LD_PRELOAD']);
    resetQuarantineCacheForTest();
    expect(quarantinedLauncherEnvKeys('sid-prod')).toEqual(['LD_PRELOAD']);
  });

  it('makes the proof fail closed across a simulated daemon restart', () => {
    const live = {
      larkAppId: 'app_x',
      session: { sessionId: 'sid-prod2' },
    } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(live, { PATH: '/tmp/fake-mojo' });
    resetQuarantineCacheForTest();

    // Fresh DaemonSession with an EMPTY in-memory ledger — post-restart state.
    expect(resolveRemoteExecutionProven(ds({
      sessionId: 'sid-prod2', backendConfig: { cloud: true },
    }))).toBe(false);
  });

  it('ignores the allowlisted credential name on the durable path too', () => {
    const live = {
      larkAppId: 'app_x',
      session: { sessionId: 'sid-prod3' },
    } as never as DaemonSession;
    rememberAppliedUnprovableEnvKeys(live, { X_JWT_TOKEN: 'a.b.c' });
    resetQuarantineCacheForTest();
    expect(quarantinedLauncherEnvKeys('sid-prod3')).toEqual([]);
    expect(resolveRemoteExecutionProven(ds({
      sessionId: 'sid-prod3', backendConfig: { cloud: true },
    }))).toBe(true);
  });
});

describe('all three isolation branches consult the durable quarantine', () => {
  it('ACTIVE (fromInit): a persisted key voids the proof after a daemon restart', () => {
    // Nothing in memory — exactly the post-restart state.
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(ds({ backendConfig: { cloud: true } }))).toBe(false);
  });

  it('WORKERLESS (mojoIdentity): a persisted key voids the proof', () => {
    // This branch previously ignored the ledger entirely.
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(false);
  });

  it('LEGACY (live bot config only): a persisted key voids the proof', () => {
    liveBotConfig = { mojo: { cloud: true }, env: {} };
    recordQuarantinedLauncherEnvKeys('sid-1', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(ds({}))).toBe(false);
  });

  it('leaves all three provable when nothing was ever recorded', () => {
    // Guards against the durable layer collapsing the proof for everyone.
    expect(resolveRemoteExecutionProven(ds({ backendConfig: { cloud: true } }))).toBe(true);
    expect(resolveRemoteExecutionProven(ds({ mojoIdentity: { cloud: true } }))).toBe(true);
    liveBotConfig = { mojo: { cloud: true }, env: {} };
    expect(resolveRemoteExecutionProven(ds({}))).toBe(true);
  });

  it('scopes the block to the recorded session only', () => {
    recordQuarantinedLauncherEnvKeys('sid-dirty', ['LD_PRELOAD']);
    expect(resolveRemoteExecutionProven(ds({
      sessionId: 'sid-clean', backendConfig: { cloud: true },
    }))).toBe(true);
    expect(resolveRemoteExecutionProven(ds({
      sessionId: 'sid-dirty', backendConfig: { cloud: true },
    }))).toBe(false);
  });
});

describe('closed/residual sessions stay in the isolation inventory', () => {
  it('re-admits a quarantined session that has no row at all', () => {
    // `/close` deleted the row; the SIGTERM-ed child was never proven dead.
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
    // The live row keeps its own classification rather than being overwritten.
    expect(merged[0].mojoLauncherEnvResidual).toBeUndefined();
  });

  it('adds nothing when no session was ever quarantined', () => {
    expect(appendResidualMojoLauncherEnvSessions([], [])).toEqual([]);
  });
});
