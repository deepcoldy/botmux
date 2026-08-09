/**
 * BEHAVIOUR tests for the frozen mojo control plane.
 *
 * Review's criticism of the previous round was correct: the migration and cancel
 * wiring were pinned with source-string assertions, which is exactly why runtime
 * problems (a cancel firing on a quarantined lineage, a session visible to the
 * dispatcher before it was frozen) survived 104 passing tests. These call the real
 * exported functions against a real session store instead.
 *
 * Run:  pnpm vitest run test/mojo-identity-freeze.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The lazily-loaded worker-pool import is expensive on first touch; under
// full-suite load the default 30s was not enough for whichever case paid for it.
vi.setConfig({ testTimeout: 90_000 });

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    constructor(public opts: Record<string, unknown>) {}
  }
  return { Client: FakeClient };
});

vi.mock('../src/im/lark/client.js', () => ({
  resolveAllowedUsersWithMap: async (_appId: string, raw: string[]) => ({
    resolved: raw, map: new Map<string, string>(), entryStatus: new Map<string, string>(),
  }),
}));

import type { MojoConfig } from '../src/adapters/backend/mojo-types.js';
import type { Session } from '../src/types.js';

const APP_ID = 'app_freeze';
let dir: string;

/** Fresh module graph bound to an isolated data dir + bots.json. */
async function boot(mojo?: MojoConfig) {
  vi.resetModules();
  writeFileSync(join(dir, 'bots.json'), JSON.stringify([{
    larkAppId: APP_ID,
    larkAppSecret: 'secret',
    cliId: 'mojo',
    backendType: 'mojo',
    ...(mojo ? { mojo } : {}),
  }]), 'utf-8');

  const registry = await import('../src/bot-registry.js');
  registry.loadBotConfigs().forEach((c: never) => registry.registerBot(c));
  const store = await import('../src/services/session-store.js');
  store.init();
  // Leaf module on purpose: no worker/spawn graph, so this stays a cheap unit test.
  const identity = await import('../src/core/mojo-session-identity.js');
  // worker-pool is a heavy module (spawn wiring, dashboard, IM). Loaded lazily so
  // only the few cases that need sessionMojoConfig pay for it — importing it
  // eagerly pushed this file past the 30s timeout under full-suite load.
  const loadPool = () => import('../src/core/worker-pool.js');
  return { registry, store, identity, loadPool };
}

type Booted = Awaited<ReturnType<typeof boot>>;

/** A persisted mojo session row, optionally already carrying a lineage. */
function seed(store: Booted['store'], patch: Partial<Session> = {}): Session {
  const created = store.createSession('oc_freeze', 'om_freeze', 'freeze test');
  Object.assign(created, {
    larkAppId: APP_ID,
    cliId: 'mojo',
    backendType: 'mojo',
    ...patch,
  });
  store.updateSession(created);
  return created;
}

/**
 * A session row EXACTLY as createSession() produces it — no backendType, because
 * services/session-store.ts:createSession does not write that field and
 * forkWorker only stamps it AFTER worker.send(initMsg).
 *
 * seed() above is deliberately NOT reused here: it hard-writes
 * `backendType: 'mojo'`, i.e. the state a session only reaches after its first
 * fork, which silently skipped the one path every new mojo session takes.
 */
function seedAsCreated(store: Booted['store'], patch: Partial<Session> = {}): Session {
  const created = store.createSession('oc_freeze', 'om_freeze', 'freeze test');
  Object.assign(created, { larkAppId: APP_ID, cliId: 'mojo', ...patch });
  store.updateSession(created);
  return created;
}

/** Raw on-disk contents, for asserting what actually reached the file. */
function rawStoreFiles(): string {
  return readdirSync(dir)
    .filter(f => f.startsWith('sessions'))
    .map(f => readFileSync(join(dir, f), 'utf-8'))
    .join('\n');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-mojo-freeze-'));
  process.env.SESSION_DATA_DIR = dir;
  process.env.BOTS_CONFIG = join(dir, 'bots.json');
});
afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  delete process.env.BOTS_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe('freezeMojoIdentityForSession', () => {
  it('freezes a session that has NOT been stamped with backendType yet', async () => {
    // THE path every new mojo session takes, and the one this whole mechanism
    // existed to cover — previously untested, so the guard's early return made
    // the freeze a silent no-op for every first fork:
    //   createSession()                 -> no backendType field at all
    //   forkWorker: sessionMojoConfig({freeze:true})  <- runs HERE
    //   worker.send(initMsg)
    //   ds.session.backendType = ...    <- stamped only AFTER the send
    // Consequences: the "control plane edited after creation" window stays wide
    // open (resume/cancel can hit another tenant), and the next daemon restart
    // sees an unfrozen row with a lineage and quarantines a session whose control
    // plane was fully known — dropping context and leaking a remote session that
    // is never cancelled.
    const { store, identity } = await boot({
      cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a',
    });
    const session = seedAsCreated(store);
    expect(session.backendType).toBeUndefined();
    expect(session.mojoIdentity).toBeUndefined();

    identity.freezeMojoIdentityForSession(session, APP_ID);

    expect(session.mojoIdentity).toEqual({
      cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a',
    });
    expect(rawStoreFiles()).toContain('tenant-a.example.com');
  });

  it('does not quarantine its own lineage after a restart', async () => {
    // The second consequence, over the REAL two-phase timeline. An earlier draft
    // of this test asserted on a row that was both unstamped and already carried
    // a lineage — a state that never coexists in production — so it failed for
    // the wrong reason. The actual sequence is:
    //   1. first fork: freeze runs while backendType is still undefined
    //   2. forkWorker then stamps backendType = 'mojo'
    //   3. first turn completes, riffParentTaskId is persisted
    //   4. daemon restarts, restore freezes again
    // With the guard reading only backendType, step 1 no-ops, so step 4 finds an
    // unfrozen row WITH a lineage and parks a session whose control plane was
    // fully known — dropping context and leaking a remote session nothing will
    // ever cancel.
    const { store, identity } = await boot({ cloud: true, workspaceId: 'ws-a' });

    // 1. first fork
    const session = seedAsCreated(store);
    identity.freezeMojoIdentityForSession(session, APP_ID);
    // 2. + 3. forkWorker stamps the backend, then the turn persists its lineage.
    session.backendType = 'mojo';
    session.riffParentTaskId = 'remote-sess-1';
    store.updateSession(session);

    // 4. restart
    identity.freezeMojoIdentityForSession(session, APP_ID);

    expect(session.mojoQuarantinedLineage).toBeUndefined();
    expect(session.riffParentTaskId).toBe('remote-sess-1');
    expect(session.mojoIdentity).toEqual({ cloud: true, workspaceId: 'ws-a' });
  });

  it('still ignores a session belonging to another backend', async () => {
    // The guard must keep doing its real job: only mojo rows get an identity.
    // Without a positive signal a riff session would now be frozen too.
    const { store, identity } = await boot({ cloud: true, workspaceId: 'ws-a' });
    const session = seedAsCreated(store, { cliId: 'riff', backendType: 'riff' });

    identity.freezeMojoIdentityForSession(session, APP_ID);

    expect(session.mojoIdentity).toBeUndefined();
  });

  it('freezes the live control plane onto a fresh session', async () => {
    const { store, identity } = await boot({
      cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a',
    });
    const session = seed(store);
    expect(session.mojoIdentity).toBeUndefined();

    identity.freezeMojoIdentityForSession(session, APP_ID);

    expect(session.mojoIdentity).toEqual({
      cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a',
    });
    // Must be durable, not just in memory.
    expect(rawStoreFiles()).toContain('tenant-a.example.com');
  });

  it('persists an EMPTY snapshot so the row is not re-migrated forever', async () => {
    const { store, identity } = await boot();
    const session = seed(store);
    identity.freezeMojoIdentityForSession(session, APP_ID);

    expect(session.mojoIdentity).toEqual({});
    // `{}` on disk is what distinguishes "frozen with nothing set" from
    // "predates the field".
    const reread = await boot();
    const reloaded = reread.store.listSessions().find(s => s.sessionId === session.sessionId);
    expect(reloaded!.mojoIdentity).toEqual({});
  });

  it('is idempotent — an already-frozen row is left alone', async () => {
    const { store, identity } = await boot({ cloud: false, baseUrl: 'https://tenant-b.example.com' });
    const session = seed(store, {
      mojoIdentity: { cloud: true, baseUrl: 'https://tenant-a.example.com' },
    });

    identity.freezeMojoIdentityForSession(session, APP_ID);

    // The live config says tenant-b; the frozen snapshot must not follow.
    expect(session.mojoIdentity).toEqual({
      cloud: true, baseUrl: 'https://tenant-a.example.com',
    });
  });

  it('QUARANTINES a legacy row that already holds a remote lineage', async () => {
    // Nothing on disk records which control plane created that remote session, so
    // adopting today's config would pair the lineage with a possibly different
    // tenant.
    const { store, identity } = await boot({ cloud: true, baseUrl: 'https://tenant-b.example.com' });
    const session = seed(store, { riffParentTaskId: 'remote-created-on-tenant-a' });

    identity.freezeMojoIdentityForSession(session, APP_ID);

    // Preserved for manual cleanup, NOT deleted…
    expect(session.mojoQuarantinedLineage).toBe('remote-created-on-tenant-a');
    // …and removed from the ACTIVE slot so no resume path picks it up.
    expect(session.riffParentTaskId).toBeUndefined();

    // Survives a reload, which is what makes manual cleanup possible.
    const reread = await boot();
    const reloaded = reread.store.listSessions().find(s => s.sessionId === session.sessionId);
    expect(reloaded!.mojoQuarantinedLineage).toBe('remote-created-on-tenant-a');
    expect(reloaded!.riffParentTaskId).toBeUndefined();
  });

  it('leaves a legacy row without a lineage fully usable', async () => {
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store);
    identity.freezeMojoIdentityForSession(session, APP_ID);
    expect(session.mojoQuarantinedLineage).toBeUndefined();
    expect(session.mojoIdentity).toEqual({ cloud: true });
  });

  it('never writes a plaintext credential to disk', async () => {
    const { store, identity } = await boot({
      cloud: true,
      jwt: 'super-secret-token',
      env: { X_JWT_TOKEN: 'also-secret-token' },
      baseUrl: 'https://tenant-a.example.com',
    });
    const session = seed(store);
    identity.freezeMojoIdentityForSession(session, APP_ID);

    // Asserted against the RAW FILE, not just the reloaded object — review noted
    // the previous test only checked the in-memory identity.
    const raw = rawStoreFiles();
    expect(raw).toContain('tenant-a.example.com');
    expect(raw).not.toContain('super-secret-token');
    expect(raw).not.toContain('also-secret-token');
  });

  it('ignores non-mojo sessions', async () => {
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store, { backendType: 'tmux', cliId: 'claude-code' });
    identity.freezeMojoIdentityForSession(session, APP_ID);
    expect(session.mojoIdentity).toBeUndefined();
  });

  it('leaves the row untouched when the bot is deregistered', async () => {
    // No config to freeze from; a later re-registration must still be able to.
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store);
    identity.freezeMojoIdentityForSession(session, 'app_does_not_exist');
    expect(session.mojoIdentity).toBeUndefined();
  });
});

describe('migrateMojoSessionIdentities', () => {
  it('freezes every restored mojo row in one pass', async () => {
    const { store, loadPool } = await boot({ cloud: true, workspaceId: 'ws-a' });
    const a = seed(store);
    const b = seed(store, { riffParentTaskId: 'lineage-b' });
    const c = seed(store, { backendType: 'tmux', cliId: 'claude-code' });

    const activeSessions = new Map<string, never>();
    for (const session of [a, b, c]) {
      activeSessions.set(session.sessionId, {
        session, larkAppId: APP_ID,
      } as never);
    }
    (await loadPool()).migrateMojoSessionIdentities(activeSessions as never);

    expect(a.mojoIdentity).toEqual({ cloud: true, workspaceId: 'ws-a' });
    // The one with a lineage is quarantined, not silently adopted.
    expect(b.mojoQuarantinedLineage).toBe('lineage-b');
    expect(b.riffParentTaskId).toBeUndefined();
    // Non-mojo untouched.
    expect(c.mojoIdentity).toBeUndefined();
  });
});

describe('quarantine is bound to an ID, not to the session', () => {
  it('marks a NEW lineage usable even though an old one is parked', async () => {
    // Once an identity is frozen, anything created afterwards was created on that
    // known control plane. Treating the session as permanently quarantined meant
    // the new session could never be cancelled after its worker died — it kept
    // consuming cloud sandbox time and holding credentials.
    const { store, loadPool } = await boot({ cloud: true, baseUrl: 'https://tenant-b.example.com' });
    const session = seed(store, {
      mojoIdentity: { cloud: true, baseUrl: 'https://tenant-b.example.com' },
      mojoQuarantinedLineage: 'old-on-unknown-tenant',
      riffParentTaskId: 'new-on-frozen-tenant-b',
    });

    const ds = { session, larkAppId: APP_ID } as never;
    const resolved = (await loadPool()).sessionMojoConfig(ds, { mojo: { cloud: true } }, { freeze: false });

    // The decision the workerless /close path gates on.
    expect(resolved.lineage).toBe('usable');
  });

  it('marks the parked ID itself quarantined', async () => {
    const { store, loadPool } = await boot({ cloud: true });
    const session = seed(store, {
      mojoIdentity: { cloud: true },
      mojoQuarantinedLineage: 'parked-id',
      riffParentTaskId: 'parked-id',
    });
    const ds = { session, larkAppId: APP_ID } as never;
    expect((await loadPool()).sessionMojoConfig(ds, { mojo: { cloud: true } }, { freeze: false }).lineage)
      .toBe('quarantined');
  });

  it("reports 'none' when there is no lineage at all", async () => {
    const { store, loadPool } = await boot({ cloud: true });
    const session = seed(store, { mojoIdentity: { cloud: true } });
    const ds = { session, larkAppId: APP_ID } as never;
    expect((await loadPool()).sessionMojoConfig(ds, { mojo: { cloud: true } }, { freeze: false }).lineage)
      .toBe('none');
  });

  it('re-freezing does not re-park an already-quarantined row', async () => {
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store, {
      mojoIdentity: { cloud: true },
      mojoQuarantinedLineage: 'parked-id',
      riffParentTaskId: 'fresh-id',
    });
    identity.freezeMojoIdentityForSession(session, APP_ID);
    // Already frozen → untouched, so the fresh lineage survives.
    expect(session.riffParentTaskId).toBe('fresh-id');
    expect(session.mojoQuarantinedLineage).toBe('parked-id');
  });

  it('flags a user-visible notice when it parks a lineage', async () => {
    // A log line alone left the user unaware their context was parked.
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store, { riffParentTaskId: 'legacy-lineage' });
    identity.freezeMojoIdentityForSession(session, APP_ID);

    expect(session.mojoQuarantineNoticePending).toBe(true);
    // Durable, so a restart cannot swallow the notice.
    const reread = await boot();
    const reloaded = reread.store.listSessions().find(s => s.sessionId === session.sessionId);
    expect(reloaded!.mojoQuarantineNoticePending).toBe(true);
  });

  it('does not flag a notice when there was nothing to park', async () => {
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store);
    identity.freezeMojoIdentityForSession(session, APP_ID);
    expect(session.mojoQuarantineNoticePending).toBeUndefined();
  });
});

describe('quarantine notice state matrix', () => {
  it('BACKFILLS the notice flag onto a row parked by an earlier build', async () => {
    // Such a row already has an identity, so both migration entry points returned
    // early and the user would never learn their context was parked.
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store, {
      mojoIdentity: { cloud: true },
      mojoQuarantinedLineage: 'parked-by-old-build',
      // No notice flag — this is what the previous build persisted.
    });
    identity.freezeMojoIdentityForSession(session, APP_ID);
    expect(session.mojoQuarantineNoticePending).toBe(true);
  });

  it('does not re-queue a notice that was already delivered', async () => {
    // `false` (delivered) must be distinguishable from `undefined` (never queued),
    // or every future turn would re-notify.
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store, {
      mojoIdentity: { cloud: true },
      mojoQuarantinedLineage: 'parked',
      mojoQuarantineNoticePending: false,
    });
    identity.freezeMojoIdentityForSession(session, APP_ID);
    expect(session.mojoQuarantineNoticePending).toBe(false);
  });

  it('parks BOTH ids rather than silently overwriting an audit record', async () => {
    // Self-audit find: `active ?? parked` would overwrite an existing parked id
    // when both are present and differ, losing the only handle to a remote
    // session that is still running somewhere.
    const { store, identity } = await boot({ cloud: true });
    const session = seed(store, {
      riffParentTaskId: 'active-unverifiable',
      mojoQuarantinedLineage: 'previously-parked',
    });
    identity.freezeMojoIdentityForSession(session, APP_ID);
    expect(session.mojoQuarantinedLineage).toContain('previously-parked');
    expect(session.mojoQuarantinedLineage).toContain('active-unverifiable');
    expect(session.riffParentTaskId).toBeUndefined();
    expect(session.mojoQuarantineNoticePending).toBe(true);
  });
});

describe('delivered notice is not re-queued after a reload', () => {
  it('treats false as DELIVERED, distinct from undefined', async () => {
    // Clearing to `undefined` on success made the restore migration read it as
    // "old build, never notified" and queue the notice again after every restart.
    const { store, identity } = await boot({ cloud: true });
    const delivered = seed(store, {
      mojoIdentity: { cloud: true },
      mojoQuarantinedLineage: 'parked',
      mojoQuarantineNoticePending: false,
    });
    identity.freezeMojoIdentityForSession(delivered, APP_ID);
    expect(delivered.mojoQuarantineNoticePending).toBe(false);

    // Survives a real store reload — this is the restart path.
    const reread = await boot();
    const reloaded = reread.store.listSessions().find(s => s.sessionId === delivered.sessionId);
    expect(reloaded!.mojoQuarantineNoticePending).toBe(false);
    // And a second migration pass still does not re-queue it.
    reread.identity.freezeMojoIdentityForSession(reloaded!, APP_ID);
    expect(reloaded!.mojoQuarantineNoticePending).toBe(false);
  });

  it('still queues for a row that was never notified', async () => {
    const { store, identity } = await boot({ cloud: true });
    const never = seed(store, {
      mojoIdentity: { cloud: true },
      mojoQuarantinedLineage: 'parked',
    });
    identity.freezeMojoIdentityForSession(never, APP_ID);
    expect(never.mojoQuarantineNoticePending).toBe(true);
  });
});
