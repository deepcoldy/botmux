/**
 * Integration tests for the idempotency dispatch lease as consumed by
 * trigger-session: the at-most-once decision logic (resolveIdempotencyHit) and
 * the boot reconcile (reconcileIdempotencyLeasesOnBoot), against the REAL
 * idempotency-store + async-trigger-store (temp dir). Mocks only the daemon
 * boundaries the reconcile touches (closeSession) and the modules trigger-session
 * imports at load time.
 *
 * Covers codex's crash-point matrix: attempting-without-live-worker → terminal
 * (never re-dispatched), completed → reuse across restart, reserved same-boot →
 * reuse, reserved older-boot → takeover, and reconcile convergence.
 *
 * Run:  pnpm vitest run test/trigger-session-idempotency.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { DaemonSession } from '../src/core/types.js';

let tempDir: string;

// Real config is used (trigger-session's import chain reads many config fields);
// config.session.dataDir is a getter over process.env.SESSION_DATA_DIR, so we
// point the real stores at a temp dir by setting the env var per test.
vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// closeSession is the only worker-pool symbol the reconcile path calls; stub the
// rest that trigger-session imports at load. getDaemonBootId returns a fixed id.
const mockCloseSession = vi.fn(async () => ({ ok: true, outcome: 'closed', alreadyClosed: false, known: true }));
// Separate spy: cleanup here must go through the BACKGROUND wrapper (which logs a
// residual/refusal), not bare closeSession. Aliasing both to one spy could not
// tell those apart, so a revert to the bare call would have stayed green.
const mockBackgroundClose = vi.fn(async (...a: any[]) => mockCloseSession(a[0] as never));
vi.mock('../src/core/worker-pool.js', () => ({
  closeSession: (...a: any[]) => mockCloseSession(...a),
  closeSessionForBackgroundCleanup: (...a: any[]) => mockBackgroundClose(...a),
  forkWorker: vi.fn(),
  getCurrentCliVersion: vi.fn(() => 'test'),
  sendWorkerInput: vi.fn(() => true),
  setActiveSessionIfActive: vi.fn(() => true),
  getDaemonBootId: () => 'boot-CURRENT',
}));

// session-store: getSession + getOwnedSession are consulted by the decision/
// reconcile paths (getOwnedSession is the owner-scoped read finding #3 requires).
const sessionRows = new Map<string, any>();
vi.mock('../src/services/session-store.js', () => ({
  getSession: (id: string) => sessionRows.get(id),
  getOwnedSession: (id: string) => sessionRows.get(id),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  registerSessionBridgeSendMarkerCleanupFence: vi.fn(),
  cleanupSessionBridgeSendMarkers: vi.fn(),
  cleanupSessionBridgeSendMarkersNow: vi.fn(),
}));

import * as idempotencyStore from '../src/services/idempotency-store.js';
import * as asyncTriggerStore from '../src/services/async-trigger-store.js';
import { resolveIdempotencyHit, reconcileIdempotencyLeasesOnBoot } from '../src/core/trigger-session.js';

const OWNER = 'cli_bot';
function lease(over: Partial<idempotencyStore.IdempotencyRecord> = {}): idempotencyStore.IdempotencyRecord {
  return {
    ownerLarkAppId: OWNER, sessionId: 'sess-1', triggerId: 'trg_1', requestHash: 'sha256:h',
    ownerBootId: 'boot-CURRENT', revision: 1, state: 'reserved', createdAt: 1, updatedAt: 1, ...over,
  };
}

let prevDataDir: string | undefined;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trig-idem-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tempDir;
  sessionRows.clear();
  mockCloseSession.mockClear();
  mockBackgroundClose.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks(); // guarantee any listAllForOwner/etc spy is undone even if an assertion threw
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR; else process.env.SESSION_DATA_DIR = prevDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveIdempotencyHit (at-most-once decisions)', () => {
  const empty = new Map<string, DaemonSession>();
  // A genuinely in-flight session: registered AND holding a non-killed worker.
  // Registry presence alone is NOT liveness (codex #776 round-6 finding #1) —
  // resolveIdempotencyHit requires a live worker to treat a turn as in-flight.
  const liveFor = (sessionId: string, chatId = 'http_async_x') =>
    new Map<string, DaemonSession>([['k', { session: { sessionId }, chatId, worker: { killed: false } } as any]]);
  // Registry-present but worker DEAD (worker exited, ds not yet removed) — the
  // orphan case that must NOT be treated as in-flight.
  const deadWorkerFor = (sessionId: string, chatId = 'http_async_x') =>
    new Map<string, DaemonSession>([['k', { session: { sessionId }, chatId, worker: null } as any]]);

  it('completed async result (SAME owner) → reuse (poll it), regardless of lease state', () => {
    asyncTriggerStore.recordCompleted('sess-1', 'trg_1', 'done', 100, OWNER);
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('reuse');
  });

  it('durable async failed (SAME owner, dispatch_unknown) → terminal (caller sees failed, never rerun)', () => {
    asyncTriggerStore.recordFailedStrict('sess-1', 'trg_1', 200, OWNER, 'dispatch_unknown');
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal');
  });

  it('FINDING #3: a FOREIGN owner completed on the same session/trigger is IGNORED (no suppression of our dispatch)', () => {
    // Bot B writes completed under the same sessionId/triggerId; A resolves its
    // own attempting-orphan hit. The foreign completed must NOT flip A to reuse —
    // A falls through to its own lease state (attempting + not-live → terminal).
    asyncTriggerStore.recordCompleted('sess-1', 'trg_1', 'B answer', 100, 'cli_OTHER_BOT');
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal'); // NOT reuse — foreign evidence ignored
  });

  it('FINDING #3: a FOREIGN owner failed does not terminalize a genuinely-live own turn', () => {
    asyncTriggerStore.recordFailedStrict('sess-1', 'trg_1', 200, 'cli_OTHER_BOT', 'dispatch_unknown');
    // Own turn is live in flight → foreign failed ignored → reuse (poll it).
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', liveFor('sess-1'));
    expect(d.kind).toBe('reuse');
  });

  it('attempting + LIVE worker → reuse (turn genuinely in flight), any boot', () => {
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', liveFor('sess-1'));
    expect(d.kind).toBe('reuse');
  });

  it('FINDING #1: attempting + SAME boot but NO live worker → terminal (orphaned crossed fence, no reuse-forever)', () => {
    // The reuse-forever codex flagged: a same-boot attempting lease whose session
    // was closed (barrier-fail couldn't delete the fence) must NOT be reused.
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal');
  });

  it('FINDING #1: attempting + ds STILL REGISTERED but worker=null (dead) → terminal (registry presence ≠ liveness)', () => {
    // The exact misjudgment: worker exited with no final_output, ds.worker=null but
    // ds still in activeSessions. Registry presence must NOT count as in-flight, or
    // trigger-result/retry poll `running`/`reuse` forever.
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', deadWorkerFor('sess-1'));
    expect(d.kind).toBe('terminal');
  });

  it('attempting + owning boot GONE + no live worker + no completion → terminal (ambiguous crash, NO redispatch)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'attempting', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal');
  });

  it('reserved + same boot + LIVE → reuse (owner mid-dispatch)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'reserved', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', liveFor('sess-1'));
    expect(d.kind).toBe('reuse');
  });

  it('FINDING #1: reserved + same boot but NO live worker → terminal (abandoned pre-dispatch orphan)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'reserved', ownerBootId: 'boot-CURRENT' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('terminal');
  });

  it('reserved + older boot → takeover (provably pre-dispatch, safe to rerun)', () => {
    const d = resolveIdempotencyHit(lease({ state: 'reserved', ownerBootId: 'boot-OLD' }), 'boot-CURRENT', empty);
    expect(d.kind).toBe('takeover');
  });
});

describe('reconcileIdempotencyLeasesOnBoot (crash convergence)', () => {
  // getSession stub driven by sessionRows.
  const getSession = (id: string) => sessionRows.get(id);

  it('attempting orphan → durable async failed(dispatch_unknown) + close + quarantine', async () => {
    const { record } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-att', triggerId: 'trg_att', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-att', now: 1 }) as any;
    idempotencyStore.transition(OWNER, 'k-att', record, { state: 'attempting', now: 2 });
    sessionRows.set('sess-att', { sessionId: 'sess-att', status: 'open' });

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    // Terminal is in the async store (authoritative), not the lease.
    const async = asyncTriggerStore.lookup('sess-att', 'trg_att');
    expect(async?.result.status).toBe('failed');
    expect(async?.result.reason).toBe('dispatch_unknown');
    expect(mockCloseSession).toHaveBeenCalledWith('sess-att');
    expect(quarantined.has('sess-att')).toBe(true);
  });

  it('reserved orphan → lease removed + session closed + quarantine', async () => {
    idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-res', triggerId: 'trg_res', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-res', now: 1 });
    sessionRows.set('sess-res', { sessionId: 'sess-res', status: 'open' });

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    expect(idempotencyStore.lookup(OWNER, 'k-res')).toBeUndefined();
    expect(mockCloseSession).toHaveBeenCalledWith('sess-res');
    expect(quarantined.has('sess-res')).toBe(true);
  });

  it('completed → kept intact, session NOT closed, NOT quarantined', async () => {
    const { record } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-ok', triggerId: 'trg_ok', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-ok', now: 1 }) as any;
    idempotencyStore.transition(OWNER, 'k-ok', record, { state: 'attempting', now: 2 });
    asyncTriggerStore.recordCompleted('sess-ok', 'trg_ok', 'result', 100, OWNER);

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    expect(idempotencyStore.lookup(OWNER, 'k-ok')).toBeDefined();
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(quarantined.size).toBe(0);
  });

  it('CURRENT boot lease → skipped (not treated as previous-boot orphan)', async () => {
    const { record } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-cur', triggerId: 'trg_cur', requestHash: 'h', ownerBootId: 'boot-CURRENT', key: 'k-cur', now: 1 }) as any;
    idempotencyStore.transition(OWNER, 'k-cur', record, { state: 'attempting', now: 2 });
    sessionRows.set('sess-cur', { sessionId: 'sess-cur', status: 'open' });

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    expect(asyncTriggerStore.lookup('sess-cur', 'trg_cur')).toBeUndefined(); // untouched
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(quarantined.size).toBe(0);
  });

  it('OTHER owner lease → never touched (cross-bot isolation)', async () => {
    const { record } = idempotencyStore.claim({ ownerLarkAppId: 'cli_OTHER', sessionId: 'sess-other', triggerId: 'trg_other', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-other', now: 1 }) as any;
    idempotencyStore.transition('cli_OTHER', 'k-other', record, { state: 'attempting', now: 2 });
    sessionRows.set('sess-other', { sessionId: 'sess-other', status: 'open' });

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    // Another bot's lease + session must be byte-untouched.
    expect(idempotencyStore.lookup('cli_OTHER', 'k-other')?.state).toBe('attempting');
    expect(asyncTriggerStore.lookup('sess-other', 'trg_other')).toBeUndefined();
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(quarantined.size).toBe(0);
  });

  it('FINDING #3: a FOREIGN completed on our attempting lease is NOT trusted as convergence, and does NOT abort startup', async () => {
    // Bot B occupies our sessionId/triggerId async slot with a completed record
    // (globally-unique sessionId ⇒ adversarial/corrupt). Reconcile must: (a) NOT
    // treat that foreign completed as our lease converging good (no early
    // continue), (b) NOT clobber B's evidence, and (c) NOT abort A's startup over
    // it (that would be the finding-#4 cross-bot DoS shape). At-most-once still
    // holds: our orphan is quarantined + closed, and the retry/poll paths
    // owner-gate the foreign record independently.
    const { record } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-fc', triggerId: 'trg_fc', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-fc', now: 1 }) as any;
    idempotencyStore.transition(OWNER, 'k-fc', record, { state: 'attempting', now: 2 });
    asyncTriggerStore.recordCompleted('sess-fc', 'trg_fc', 'B answer', 100, 'cli_OTHER_BOT');
    sessionRows.set('sess-fc', { sessionId: 'sess-fc', status: 'open' });

    // Does NOT throw (no startup abort).
    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    // B's evidence is byte-untouched (owner-proof refused to clobber; we skipped).
    const rec = asyncTriggerStore.lookup('sess-fc', 'trg_fc');
    expect(rec?.result.status).toBe('completed');
    expect(rec?.result.content).toBe('B answer');
    expect(rec?.ownerLarkAppId).toBe('cli_OTHER_BOT');
    // Our orphan was still quarantined + closed (didn't `continue` on foreign completed).
    expect(quarantined.has('sess-fc')).toBe(true);
    expect(mockCloseSession).toHaveBeenCalledWith('sess-fc');
  });

  it('FINDING #2: a reserved snapshot that ADVANCED to attempting under the CAS is reclassified (terminalized), not declared converged', async () => {
    // The race: listAllForOwner snapshots the lease as reserved-rev1; then it
    // advances to attempting-rev2 (a concurrent barrier crossing) BEFORE
    // compareAndRemoveByPath re-reads. The CAS returns changed(current=attempting);
    // reconcile must terminalize it, NOT silently declare the sweep converged and
    // leave a running poller. We inject the "advanced under us" by spying
    // listAllForOwner to hand back the stale reserved snapshot while disk holds
    // the advanced attempting record.
    const { record: reservedSnap } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-adv', triggerId: 'trg_adv', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-adv', now: 1 }) as any;
    const { file } = idempotencyStore.listAllForOwner(OWNER)[0];
    // Advance the ON-DISK record to attempting-rev2 (the concurrent crossing).
    idempotencyStore.transition(OWNER, 'k-adv', reservedSnap, { state: 'attempting', now: 5 });
    sessionRows.set('sess-adv', { sessionId: 'sess-adv', status: 'open' });
    // Reconcile enumerates the STALE reserved snapshot (pre-advance).
    const listSpy = vi.spyOn(idempotencyStore, 'listAllForOwner').mockReturnValue([{ file, record: reservedSnap }]);

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);
    listSpy.mockRestore();

    // Reclassified as a crossed fence → durable dispatch_unknown + quarantine + close.
    const rec = asyncTriggerStore.lookup('sess-adv', 'trg_adv');
    expect(rec?.result.status).toBe('failed');
    expect(rec?.result.reason).toBe('dispatch_unknown');
    expect(quarantined.has('sess-adv')).toBe(true);
    expect(mockCloseSession).toHaveBeenCalledWith('sess-adv');
    // The attempting fence on disk was NEVER deleted by the stale reserved snapshot.
    expect(idempotencyStore.lookup(OWNER, 'k-adv')?.state).toBe('attempting');
  });

  it('FINDING #2: different-identity winner = old-boot ATTEMPTING → classified ON THE SPOT (durable failed + quarantine both), not left for a non-existent re-scan', async () => {
    // codex round-7 #2: the winner lives under the SAME key file (takeover
    // overwrites in place) and `leases` is a one-time snapshot, so the winner is
    // NEVER re-scanned. Reconcile must classify it on the spot. Winner here is an
    // old-boot attempting fence with no live owner → durable dispatch_unknown +
    // quarantine + close, so restore can't reattach a session with an unterminated
    // lease. Our stale orphan (sess-cc) converges independently.
    const { record: reservedSnap } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-cc', triggerId: 'trg_cc', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-cc', now: 1 }) as any;
    const { file } = idempotencyStore.listAllForOwner(OWNER)[0];
    const { record: winner } = idempotencyStore.takeover({ ownerLarkAppId: OWNER, key: 'k-cc', expect: reservedSnap, sessionId: 'sess-cc2', triggerId: 'trg_cc2', requestHash: 'h', ownerBootId: 'boot-OLD2', now: 6 }) as any;
    idempotencyStore.transition(OWNER, 'k-cc', winner, { state: 'attempting', now: 7 }); // winner crossed the barrier
    sessionRows.set('sess-cc', { sessionId: 'sess-cc', status: 'open' });
    sessionRows.set('sess-cc2', { sessionId: 'sess-cc2', status: 'open' });
    const listSpy = vi.spyOn(idempotencyStore, 'listAllForOwner').mockReturnValue([{ file, record: reservedSnap }]);

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);
    listSpy.mockRestore();

    // BOTH converged: our orphan (never dispatched) + the winner (durable failed).
    expect(quarantined.has('sess-cc')).toBe(true);
    expect(mockCloseSession).toHaveBeenCalledWith('sess-cc');
    expect(quarantined.has('sess-cc2')).toBe(true);
    expect(mockCloseSession).toHaveBeenCalledWith('sess-cc2');
    const w = asyncTriggerStore.lookup('sess-cc2', 'trg_cc2');
    expect(w?.result.status).toBe('failed');
    expect(w?.result.reason).toBe('dispatch_unknown');
  });

  it('FINDING #2: different-identity winner = old-boot RESERVED with a LIVE session → fail-closed (cannot prove convergence)', async () => {
    // An old-boot reserved winner that has a live session row could be a genuinely
    // running turn; reconcile cannot prove it converged → throw (abort startup)
    // rather than silently succeed and let it keep executing.
    const { record: reservedSnap } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-cc', triggerId: 'trg_cc', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-cc', now: 1 }) as any;
    const { file } = idempotencyStore.listAllForOwner(OWNER)[0];
    idempotencyStore.takeover({ ownerLarkAppId: OWNER, key: 'k-cc', expect: reservedSnap, sessionId: 'sess-cc2', triggerId: 'trg_cc2', requestHash: 'h', ownerBootId: 'boot-OLD2', now: 6 });
    sessionRows.set('sess-cc', { sessionId: 'sess-cc', status: 'open' });
    sessionRows.set('sess-cc2', { sessionId: 'sess-cc2', status: 'open' }); // live winner session
    const listSpy = vi.spyOn(idempotencyStore, 'listAllForOwner').mockReturnValue([{ file, record: reservedSnap }]);

    await expect(reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession)).rejects.toThrow(/cannot prove convergence/);
    listSpy.mockRestore();
  });

  it('FINDING #2: different-identity winner = old-boot RESERVED, NO live session → fenced remove + quarantine both', async () => {
    const { record: reservedSnap } = idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-cc', triggerId: 'trg_cc', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-cc', now: 1 }) as any;
    const { file } = idempotencyStore.listAllForOwner(OWNER)[0];
    idempotencyStore.takeover({ ownerLarkAppId: OWNER, key: 'k-cc', expect: reservedSnap, sessionId: 'sess-cc2', triggerId: 'trg_cc2', requestHash: 'h', ownerBootId: 'boot-OLD2', now: 6 });
    sessionRows.set('sess-cc', { sessionId: 'sess-cc', status: 'open' }); // only our orphan has a session row; winner has none
    const listSpy = vi.spyOn(idempotencyStore, 'listAllForOwner').mockReturnValue([{ file, record: reservedSnap }]);

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);
    listSpy.mockRestore();

    // Winner (never-dispatched reserved, no live session) → lease fenced-removed + quarantined.
    expect(idempotencyStore.lookup(OWNER, 'k-cc')).toBeUndefined();
    expect(quarantined.has('sess-cc')).toBe(true);
    expect(quarantined.has('sess-cc2')).toBe(true);
  });

  it('FINDING #2: a corrupt OWN lease makes the whole reconcile throw (fail-closed, aborts startup)', async () => {
    idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-good', triggerId: 'trg_good', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-good', now: 1 });
    // Corrupt a file inside OUR owner subdir.
    const ownerSub = createHash('sha256').update(OWNER).digest('hex');
    writeFileSync(join(tempDir, 'idempotency', ownerSub, 'deadbeef.json'), '{ corrupt', 'utf-8');
    await expect(reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession)).rejects.toThrow();
  });

  it('FINDING #4: a FOREIGN corrupt lease does NOT block our reconcile (no cross-bot startup DoS)', async () => {
    idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-ours', triggerId: 'trg_ours', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-ours', now: 1 });
    sessionRows.set('sess-ours', { sessionId: 'sess-ours', status: 'open' });
    // Another bot's corrupt lease under ITS subdir.
    const foreignSub = createHash('sha256').update('cli_FOREIGN').digest('hex');
    mkdirSync(join(tempDir, 'idempotency', foreignSub), { recursive: true });
    writeFileSync(join(tempDir, 'idempotency', foreignSub, 'garbage.json'), '{ not json', 'utf-8');

    const quarantined = await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    // Our reserved orphan converged; the foreign corruption was never opened.
    expect(idempotencyStore.lookup(OWNER, 'k-ours')).toBeUndefined();
    expect(quarantined.has('sess-ours')).toBe(true);
  });


  it('routes cleanup through the BACKGROUND close wrapper, with a context label', async () => {
    // Wiring evidence: reverting any of these call sites to bare closeSession()
    // would lose the residual/refusal logging that is the only signal on a path
    // with no user surface.
    idempotencyStore.claim({ ownerLarkAppId: OWNER, sessionId: 'sess-bg', triggerId: 'trg_bg', requestHash: 'h', ownerBootId: 'boot-OLD', key: 'k-bg', now: 1 });
    sessionRows.set('sess-bg', { sessionId: 'sess-bg', status: 'open' });

    await reconcileIdempotencyLeasesOnBoot(OWNER, 'boot-CURRENT', getSession);

    // Anchor on THIS session's call rather than a global index: other cases in
    // the file share the spy.
    const call = (mockBackgroundClose.mock.calls as unknown as [string, string][])
      .find(([sessionId]) => sessionId === 'sess-bg');
    expect(call, 'cleanup did not go through the background wrapper').toBeDefined();
    expect(call![1]).toContain('trigger-session');
  });
});
