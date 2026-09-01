/**
 * Persistence round-trip for the frozen mojo control-plane identity.
 *
 * Review asked specifically for a test that goes through a REAL session-store
 * write + reload, rather than only asserting on in-memory objects: the freeze is
 * worthless if the snapshot does not survive a daemon restart, and that is
 * exactly the window where an operator's config edit could re-identify a session.
 *
 * Run:  pnpm vitest run test/mojo-identity-persistence.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  diffMojoSessionIdentity,
  pickMojoSessionIdentity,
  type MojoSessionIdentity,
} from '../src/adapters/backend/mojo-types.js';
import type { Session } from '../src/types.js';

let dir: string;

/**
 * Fresh session-store module bound to the isolated data dir. A new module
 * instance with the same dir is how a daemon restart looks to the store.
 */
async function freshStore() {
  vi.resetModules();
  const store = await import('../src/services/session-store.js');
  store.init();
  return store;
}

type Store = Awaited<ReturnType<typeof freshStore>>;

/** Create a real mojo session row and stamp the fields under test onto it. */
function seedSession(store: Store, patch: Partial<Session>): Session {
  const created = store.createSession('oc_persist', 'om_persist', 'mojo persistence');
  Object.assign(created, {
    larkAppId: 'app_persist',
    cliId: 'mojo',
    backendType: 'mojo',
    ...patch,
  });
  store.updateSession(created);
  return created;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'botmux-mojo-persist-'));
  process.env.SESSION_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('mojoIdentity survives a session-store round trip', () => {
  it('persists and reloads a populated snapshot verbatim', async () => {
    const identity = pickMojoSessionIdentity({
      cloud: true,
      localDaemon: false,
      baseUrl: 'https://tenant-a.example.com',
      ppeEnv: 'ppe-a',
      workspaceId: 'ws-a',
      agentId: 'agent-a',
      // Credentials must not be captured in the first place.
      jwt: 'super-secret',
    });

    const write = await freshStore();
    const { sessionId } = seedSession(write, { mojoIdentity: identity });

    // Simulate a daemon restart: brand-new module instance, same data dir.
    const read = await freshStore();
    const reloaded = read.listSessions().find(s => s.sessionId === sessionId);

    expect(reloaded).toBeDefined();
    expect(reloaded!.mojoIdentity).toEqual({
      cloud: true,
      localDaemon: false,
      baseUrl: 'https://tenant-a.example.com',
      ppeEnv: 'ppe-a',
      workspaceId: 'ws-a',
      agentId: 'agent-a',
    });
    // No plaintext credential reached disk.
    expect(JSON.stringify(reloaded!.mojoIdentity)).not.toContain('super-secret');
  });

  it('distinguishes a reloaded EMPTY snapshot from a never-frozen session', async () => {
    // This is the distinction the migration depends on: `{}` means "frozen with
    // nothing configured" and must NOT be re-derived from live config on the next
    // wake, while `undefined` means "predates the field".
    const write = await freshStore();
    const frozenId = seedSession(write, { mojoIdentity: {} }).sessionId;
    const legacyId = seedSession(write, {}).sessionId;

    const read = await freshStore();
    const sessions = read.listSessions();
    const frozenEmpty = sessions.find(s => s.sessionId === frozenId);
    const legacy = sessions.find(s => s.sessionId === legacyId);

    expect(frozenEmpty!.mojoIdentity).toEqual({});
    expect(legacy!.mojoIdentity).toBeUndefined();
    // The guard the daemon actually uses must tell them apart after a reload.
    expect(Boolean(frozenEmpty!.mojoIdentity)).toBe(true);
    expect(Boolean(legacy!.mojoIdentity)).toBe(false);
  });

  it('reloaded snapshot still detects drift against a changed live config', async () => {
    const write = await freshStore();
    const { sessionId } = seedSession(write, {
      mojoIdentity: pickMojoSessionIdentity({
        cloud: true, baseUrl: 'https://tenant-a.example.com', workspaceId: 'ws-a',
      }),
    });

    const read = await freshStore();
    const reloaded = read.listSessions()
      .find(s => s.sessionId === sessionId)!.mojoIdentity as MojoSessionIdentity;

    // Operator switched tenant + workspace + execution mode while the daemon was down.
    const drift = diffMojoSessionIdentity(reloaded, pickMojoSessionIdentity({
      cloud: false, baseUrl: 'https://tenant-b.example.com', workspaceId: 'ws-b',
    }));
    expect(drift).toContain('baseUrl');
    expect(drift).toContain('workspaceId');
    expect(drift.join('\n')).toContain('cloud: true → false');
    // Still no values for the URL/workspace keys.
    expect(drift.join()).not.toContain('tenant-b');
  });

  it('updateSession persists a snapshot added after creation', async () => {
    // The migration path: a legacy row is loaded, frozen, then written back.
    const write = await freshStore();
    const { sessionId } = seedSession(write, {});
    const loaded = write.listSessions().find(s => s.sessionId === sessionId)!;
    expect(loaded.mojoIdentity).toBeUndefined();

    loaded.mojoIdentity = pickMojoSessionIdentity({ cloud: true, workspaceId: 'ws-migrated' });
    write.updateSession(loaded);

    const read = await freshStore();
    expect(read.listSessions().find(s => s.sessionId === sessionId)!.mojoIdentity)
      .toEqual({ cloud: true, workspaceId: 'ws-migrated' });
  });
});
