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
  const pool = await import('../src/core/worker-pool.js');
  return { registry, store, pool, identity };
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
    const { store, pool } = await boot({ cloud: true, workspaceId: 'ws-a' });
    const a = seed(store);
    const b = seed(store, { riffParentTaskId: 'lineage-b' });
    const c = seed(store, { backendType: 'tmux', cliId: 'claude-code' });

    const activeSessions = new Map<string, never>();
    for (const session of [a, b, c]) {
      activeSessions.set(session.sessionId, {
        session, larkAppId: APP_ID,
      } as never);
    }
    pool.migrateMojoSessionIdentities(activeSessions as never);

    expect(a.mojoIdentity).toEqual({ cloud: true, workspaceId: 'ws-a' });
    // The one with a lineage is quarantined, not silently adopted.
    expect(b.mojoQuarantinedLineage).toBe('lineage-b');
    expect(b.riffParentTaskId).toBeUndefined();
    // Non-mojo untouched.
    expect(c.mojoIdentity).toBeUndefined();
  });
});
