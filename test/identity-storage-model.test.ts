/**
 * Storage-model split and terminal GC for trigger-user identities.
 *
 *  - proven:  identity bodies live in daemon memory only; the session dir holds
 *             no token, and terminal GC forgets every turn outside a retention
 *             set computed from live daemon state.
 *  - single:  one per-tool file, overwritten/removed each turn (legacy paths).
 *  - the two models are mutually exclusive per session dir: initializing one
 *             clears the other's artifacts first.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  ensureSessionIdentityStorage,
  writeSessionIdentity,
  clearAllSessionIdentities,
  recallProvenIdentityContent,
  forgetProvenIdentityContent,
  collectProvenIdentityContents,
  sessionIdentityDataDir,
  sessionIdentityPath,
  sessionIdentityBinDir,
  type CliIdentity,
} from '../src/core/cli-identity.js';
import { resolveIdentityStorageModel } from '../src/core/lark-tool-binding.js';
import { rememberLarkToolDelegation, clearLarkToolDelegations, larkToolDelegationTurnIds } from '../src/core/lark-tool-delegation.js';
import { sessionAuthRequests } from '../src/core/session-auth-requests.js';
import {
  registerActiveIdentityTurn,
  releaseActiveIdentityTurn,
  clearActiveIdentityTurns,
  activeIdentityTurns,
  activeIdentityTurnsSaturated,
} from '../src/core/active-identity-turns.js';
import { collectSessionTurnGarbage } from '../src/core/worker-pool.js';
import { config } from '../src/config.js';

const SESSION = 'model-session';
let dir: string;
let previousDataDir = '';

const aliceBy = (turnId: string): CliIdentity =>
  ({ tool: 'bytedcli', cloudJwt: `jwt-${turnId}`, turnId, openId: 'ou-alice' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-identity-model-'));
  previousDataDir = config.session.dataDir;
  config.session.dataDir = dir;
  clearLarkToolDelegations(dir, SESSION);
  clearActiveIdentityTurns(dir, SESSION);
});
afterEach(() => {
  clearAllSessionIdentities(dir, SESSION);
  clearLarkToolDelegations(dir, SESSION);
  clearActiveIdentityTurns(dir, SESSION);
  if (previousDataDir) config.session.dataDir = previousDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveIdentityStorageModel path matrix', () => {
  it('is proven for a Linux managed session with host-reachable loopback', () => {
    expect(resolveIdentityStorageModel({
      platform: 'linux', binding: true, sandboxEngaged: false, loopbackShared: true,
    })).toBe('proven');
    expect(resolveIdentityStorageModel({
      platform: 'linux', binding: true, sandboxEngaged: true, loopbackShared: true,
    })).toBe('proven');
  });

  it('is single off Linux or without the managed binding', () => {
    expect(resolveIdentityStorageModel({
      platform: 'darwin', binding: true, sandboxEngaged: false, loopbackShared: true,
    })).toBe('single');
    expect(resolveIdentityStorageModel({
      platform: 'linux', binding: false, sandboxEngaged: false, loopbackShared: true,
    })).toBe('single');
  });

  it('is single whenever a sandbox actually engaged cuts the daemon loopback', () => {
    expect(resolveIdentityStorageModel({
      platform: 'linux', binding: true, sandboxEngaged: true, loopbackShared: false,
    })).toBe('single');
  });

  it('never trusts the loopback flag without an engaged sandbox in the other direction', () => {
    // Spawn facts are carried as a pair; the predicate only degrades to single
    // on a REAL network cut (engaged + !shared), never on the config inputs.
    expect(resolveIdentityStorageModel({
      platform: 'linux', binding: true, sandboxEngaged: false, loopbackShared: false,
    })).toBe('proven');
  });
});

describe('proven publication keeps no token on disk', () => {
  it('stores the body in memory and nothing under the session dir', () => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    writeSessionIdentity(dir, SESSION, aliceBy('turn-A'), 'proven');
    writeSessionIdentity(dir, SESSION, { ...aliceBy('turn-B') }, 'proven');

    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toContain('jwt-turn-A');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-B', 'bytedcli')).toContain('jwt-turn-B');

    const dataDir = sessionIdentityDataDir(dir, SESSION);
    expect(existsSync(join(dataDir, 'turns'))).toBe(false);
    // The only files present are the turn marker pair and the layout marker.
    expect(readdirSync(dataDir).sort()).toEqual(['identity-layout', 'turn']);
    // Nothing anywhere in the bin dir contains a token.
    const binDir = sessionIdentityBinDir(dir, SESSION);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
    for (const file of walk(binDir)) {
      expect(file).not.toContain('jwt-turn-A');
    }
  });

  it('requires a turn id (publication without a turn belongs to the single model)', () => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    expect(() => writeSessionIdentity(dir, SESSION,
      { tool: 'bytedcli', cloudJwt: 'jwt' }, 'proven')).toThrow(/turn id/);
  });
});

describe('single publication keeps the legacy one-file layout', () => {
  it('writes one root file that the next turn overwrites', () => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'single');
    writeSessionIdentity(dir, SESSION, aliceBy('turn-A'), 'single');
    const root = join(sessionIdentityDataDir(dir, SESSION), 'bytedcli.env');
    expect(existsSync(root)).toBe(true);
    writeSessionIdentity(dir, SESSION, { ...aliceBy('turn-B') }, 'single');
    const body = readdirSafe(root);
    expect(body).toContain('jwt-turn-B');
    expect(body).not.toContain('jwt-turn-A');
    expect(existsSync(join(sessionIdentityDataDir(dir, SESSION), 'turns'))).toBe(false);
  });
});

function readdirSafe(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync(path, 'utf8');
}

describe('the two models are mutually exclusive per session', () => {
  it('switching single → proven wipes the root file and vice versa', () => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'single');
    writeSessionIdentity(dir, SESSION, aliceBy('turn-A'), 'single');
    expect(existsSync(join(sessionIdentityDataDir(dir, SESSION), 'bytedcli.env'))).toBe(true);

    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    expect(existsSync(join(sessionIdentityDataDir(dir, SESSION), 'bytedcli.env'))).toBe(false);
    writeSessionIdentity(dir, SESSION, aliceBy('turn-A'), 'proven');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toContain('jwt-turn-A');

    // Back to single: proven memory is cleared and a fresh root layout starts.
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'single');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toBeUndefined();
    expect(existsSync(join(sessionIdentityDataDir(dir, SESSION), 'bytedcli.env'))).toBe(true);
  });

  it('re-initializing the same model never truncates a live marker', () => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    writeSessionIdentity(dir, SESSION, aliceBy('turn-A'), 'proven');
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toContain('jwt-turn-A');
  });

  it('markerless first init: single clears only R3 turns/ leftovers and KEEPS the accept-time root file (F2/N1)', () => {
    const dataDir = sessionIdentityDataDir(dir, SESSION);
    // Simulate the real accept→fork order: the daemon writes the opening turn
    // into the single root file BEFORE the worker initializes storage, while an
    // R3 upgrade left a live per-turn token under turns/ — both markerless.
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const stalePath = sessionIdentityPath(dir, SESSION, 'bytedcli', 'turn-from-old-layout');
    mkdirSync(dirname(stalePath), { recursive: true, mode: 0o700 });
    writeFileSync(stalePath, "BYTEDCLI_USER_CLOUD_JWT='LEFTOVER-JWT'\n", { mode: 0o600 });
    writeFileSync(join(dataDir, 'bytedcli.env'), "BYTEDCLI_USER_CLOUD_JWT='OPENING-TURN'\n", { mode: 0o600 });

    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'single');
    // R3 leftover is gone …
    expect(existsSync(join(dataDir, 'turns'))).toBe(false);
    // … but the opening turn the daemon published before the fork survives.
    expect(readFileSync(join(dataDir, 'bytedcli.env'), 'utf8')).toContain('OPENING-TURN');
    expect(readFileSync(join(dataDir, 'identity-layout'), 'utf8').trim()).toBe('single-v1');
  });

  it('markerless first PROVEN init wipes BOTH turns/ leftovers and any root file', () => {
    const dataDir = sessionIdentityDataDir(dir, SESSION);
    rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const stalePath = sessionIdentityPath(dir, SESSION, 'bytedcli', 'turn-from-old-layout');
    mkdirSync(dirname(stalePath), { recursive: true, mode: 0o700 });
    writeFileSync(stalePath, "BYTEDCLI_USER_CLOUD_JWT='LEFTOVER-JWT'\n", { mode: 0o600 });
    // A fail-closed single accept publication that must not survive a proven init.
    writeFileSync(join(dataDir, 'bytedcli.env'), "BYTEDCLI_USER_CLOUD_JWT='EARLY-SINGLE'\n", { mode: 0o600 });
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    expect(existsSync(join(dataDir, 'turns'))).toBe(false);
    expect(readdirSync(dataDir).some(name => name.endsWith('.env'))).toBe(false);
  });
});

describe('collectProvenIdentityContents retention', () => {
  beforeEach(() => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
    for (const turnId of ['turn-A', 'turn-B', 'turn-C', 'turn-D']) {
      writeSessionIdentity(dir, SESSION, aliceBy(turnId), 'proven');
    }
  });

  it('forgets exactly the turns outside the retention set', () => {
    const removed = collectProvenIdentityContents(dir, SESSION, ['turn-A', 'turn-C']);
    expect(removed.sort()).toEqual(['turn-B', 'turn-D']);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toContain('jwt-turn-A');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-B', 'bytedcli')).toBeUndefined();
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-C', 'bytedcli')).toContain('jwt-turn-C');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-D', 'bytedcli')).toBeUndefined();
  });

  it('keeps everything for an empty retention set only when no turns exist', () => {
    expect(collectProvenIdentityContents(dir, SESSION, []).sort()).toEqual(['turn-A', 'turn-B', 'turn-C', 'turn-D']);
    expect(collectProvenIdentityContents(dir, SESSION, ['turn-A'])).toEqual([]);
  });
});

describe('daemon terminal GC retention set (mutation matrix)', () => {
  // Each anchor alone must keep its turn's material; removing the anchor from
  // the live-state object makes that turn collectable. The matrix exists so
  // dropping any retention source fails exactly its own row.
  function dsWith(extra: Record<string, unknown>): any {
    return {
      session: {
        sessionId: SESSION,
        queuedActivationTurnId: undefined,
        deferredScheduleRun: undefined,
        ordinaryTurnRecovery: undefined,
        readonlyTaskContinuation: undefined,
        codexAppDispatchLedger: [],
        ...('sessionExtra' in extra ? extra.sessionExtra : {}),
      },
      larkAppId: 'cli_test',
      chatId: 'oc_test',
      managedTurnOrigin: undefined,
      pendingRawTurnId: undefined,
      scheduledTurnCallers: undefined,
      silentScheduledTurns: undefined,
      ...extra,
    };
  }

  function publish(turnId: string) {
    writeSessionIdentity(dir, SESSION, aliceBy(turnId), 'proven');
    registerActiveIdentityTurn(dir, SESSION, turnId);
  }

  beforeEach(() => {
    ensureSessionIdentityStorage(dir, SESSION, ['bytedcli'], 'proven');
  });

  it('retains the current execution identity (isolation-off opening principal)', () => {
    // envelope is turn-B but the executing identity is still turn-A. B's own
    // accept-time publication is never selected while the adoption holds, so
    // GC may collect it; what MUST survive is the proven identity turn A —
    // dropping A is the review's regression (A\'s in-flight tools go 77).
    const ds = dsWith({ managedTurnOrigin: { turnId: 'turn-B', identityTurnId: 'turn-A' } });
    publish('turn-A'); publish('turn-B');
    releaseActiveIdentityTurn(dir, SESSION, 'turn-A');
    releaseActiveIdentityTurn(dir, SESSION, 'turn-B');
    expect(collectSessionTurnGarbage(ds)).toEqual(['turn-B']);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toContain('jwt-turn-A');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-B', 'bytedcli')).toBeUndefined();
  });

  it('retains a dispatched-but-not-started queued activation turn', () => {
    const ds = dsWith({ session: { queuedActivationTurnId: 'turn-Q' } as any });
    publish('turn-Q');
    releaseActiveIdentityTurn(dir, SESSION, 'turn-Q');
    expect(collectSessionTurnGarbage(ds)).toEqual([]);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-Q', 'bytedcli')).toContain('jwt-turn-Q');
  });

  it('retains a prepared raw-input turn held for the prompt-ready flush', () => {
    const ds = dsWith({ pendingRawTurnId: 'turn-R' });
    publish('turn-R');
    releaseActiveIdentityTurn(dir, SESSION, 'turn-R');
    expect(collectSessionTurnGarbage(ds)).toEqual([]);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-R', 'bytedcli')).toBeDefined();
  });

  it('retains scheduled, recovery and continuation turns', () => {
    const ds = dsWith({
      scheduledTurnCallers: new Map([['schedule:1:uuid', {}]]),
      session: {
        deferredScheduleRun: { turnId: 'turn-deferred' },
        ordinaryTurnRecovery: { currentTurnId: 'turn-recovery' },
        readonlyTaskContinuation: { currentTurnId: 'turn-continuation' },
        codexAppDispatchLedger: [],
      } as any,
    });
    for (const t of ['schedule:1:uuid', 'turn-deferred', 'turn-recovery', 'turn-continuation']) {
      publish(t); releaseActiveIdentityTurn(dir, SESSION, t);
    }
    expect(collectSessionTurnGarbage(ds).sort()).toEqual([]);
    for (const t of ['schedule:1:uuid', 'turn-deferred', 'turn-recovery', 'turn-continuation']) {
      expect(recallProvenIdentityContent(dir, SESSION, t, 'bytedcli')).toBeDefined();
    }
  });

  it('retains a prepared/non-terminal codex app dispatch ledger entry', () => {
    const ds = dsWith({ session: {
      codexAppDispatchLedger: [{ turnId: 'turn-ledger', state: 'prepared' }],
    } as any });
    publish('turn-ledger');
    releaseActiveIdentityTurn(dir, SESSION, 'turn-ledger');
    expect(collectSessionTurnGarbage(ds)).toEqual([]);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-ledger', 'bytedcli')).toBeDefined();
  });

  it('retains every turn targeted by a pending authorization request', () => {
    // A started auth-request on turn-A, while later turns execute: turn-A's
    // material must survive the terminal GC until the grant settles, or the
    // user's tap is silently dropped into the 300s timeout.
    const ds = dsWith({});
    publish('turn-A');
    sessionAuthRequests.set('req-1', {
      sessionId: SESSION, appId: 'cli_app', callerOpenId: 'ou-alice', identityTurnId: 'turn-A',
      isCurrent: () => false,
    } as any);
    releaseActiveIdentityTurn(dir, SESSION, 'turn-A');
    expect(collectSessionTurnGarbage(ds)).toEqual([]);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toContain('jwt-turn-A');
    sessionAuthRequests.delete('req-1');
    expect(collectSessionTurnGarbage(ds)).toEqual(['turn-A']);
  });

  it('retains turns still referenced by an in-memory lark-tool delegation', () => {
    const ds = dsWith({});
    publish('turn-delegated');
    rememberLarkToolDelegation(dir, SESSION, 'turn-delegated', {
      credentialOpenId: 'ou-alice', tools: ['bytedcli'], dispatchRoot: 'om-root',
    });
    releaseActiveIdentityTurn(dir, SESSION, 'turn-delegated');
    expect(larkToolDelegationTurnIds(dir, SESSION)).toContain('turn-delegated');
    expect(collectSessionTurnGarbage(ds)).toEqual([]);
    clearLarkToolDelegations(dir, SESSION);
    expect(collectSessionTurnGarbage(ds)).toEqual(['turn-delegated']);
  });

  it('collects an unreferenced terminal turn even while others are retained', () => {
    const ds = dsWith({ managedTurnOrigin: { turnId: 'turn-B', identityTurnId: 'turn-B' } });
    publish('turn-A'); publish('turn-B');
    releaseActiveIdentityTurn(dir, SESSION, 'turn-A');
    expect(collectSessionTurnGarbage(ds)).toEqual(['turn-A']);
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-B', 'bytedcli')).toContain('jwt-turn-B');
  });

  it('still fail-closes after per-tool forget: a removed tool body is simply absent', () => {
    publish('turn-A');
    forgetProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli');
    expect(recallProvenIdentityContent(dir, SESSION, 'turn-A', 'bytedcli')).toBeUndefined();
  });

  it('a saturated accept ledger retains EVERYTHING (never clears into over-collection)', () => {
    // 257 turns that never terminal: past the defensive cap.
    for (let i = 0; i < 257; i++) {
      writeSessionIdentity(dir, SESSION, aliceBy(`saturated-${i}`), 'proven');
      registerActiveIdentityTurn(dir, SESSION, `saturated-${i}`);
    }
    expect(activeIdentityTurnsSaturated(dir, SESSION)).toBe(true);
    // Direct collection with an empty retention set would remove all, but the
    // daemon GC must skip a saturated session entirely (retain-all).
    const ds = dsWith({});
    expect(collectSessionTurnGarbage(ds)).toEqual([]);
    expect(recallProvenIdentityContent(dir, SESSION, 'saturated-0', 'bytedcli')).toBeDefined();
    expect(recallProvenIdentityContent(dir, SESSION, 'saturated-256', 'bytedcli')).toBeDefined();
    // The low-level helper signals retain-all with null.
    expect(activeIdentityTurns(dir, SESSION)).toBeNull();
  });
});
