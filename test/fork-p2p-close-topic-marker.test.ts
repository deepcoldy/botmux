import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import * as botRegistry from '../src/bot-registry.js';
import * as sessionStore from '../src/services/session-store.js';
import * as workerPool from '../src/core/worker-pool.js';
import {
  recordP2pForceTopicRoot,
  isP2pForceTopicRoot,
  __resetP2pForceTopicRootsForTest,
} from '../src/services/p2p-force-topic-store.js';
import { activeSessionKey, type DaemonSession } from '../src/core/types.js';

const APP_ID = 'app-fork-p2p-close';
const CHAT_ID = 'oc_dm_fork_close';

let dataDir: string;
let previousDataDir: string;

beforeEach(() => {
  previousDataDir = config.session.dataDir;
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-fork-p2p-close-'));
  config.session.dataDir = dataDir;
  sessionStore.init(APP_ID);
  __resetP2pForceTopicRootsForTest();
  vi.spyOn(botRegistry, 'getBot').mockReturnValue({
    config: { cliId: 'claude-code', larkAppId: APP_ID },
    resolvedAllowedUsers: ['ou_owner'],
    resolvedBlockedUsers: [],
  } as any);
});

afterEach(() => {
  workerPool.setActiveSessionsRegistry(new Map());
  config.session.dataDir = previousDataDir;
  sessionStore.init(APP_ID);
  __resetP2pForceTopicRootsForTest();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

function registerSession(options: { rootId: string; forkedFrom?: string }): DaemonSession {
  const session = sessionStore.createSession(CHAT_ID, options.rootId, 'dm topic', 'p2p');
  session.larkAppId = APP_ID;
  session.cliId = 'claude-code';
  session.scope = 'thread';
  if (options.forkedFrom) session.forkedFrom = options.forkedFrom;
  sessionStore.updateSession(session);
  const ds = {
    session,
    worker: null,
    larkAppId: APP_ID,
    chatId: CHAT_ID,
    chatType: 'p2p',
    scope: 'thread',
    hasHistory: true,
  } as DaemonSession;
  workerPool.setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]]));
  return ds;
}

describe('closing a /fork DM child ends its topic lifecycle', () => {
  it('drops the fork topic marker on close so later replies fold flat', async () => {
    const rootId = 'om_fork_child_root';
    const ds = registerSession({ rootId, forkedFrom: 'parent-session-id' });
    recordP2pForceTopicRoot(APP_ID, rootId, CHAT_ID);
    expect(isP2pForceTopicRoot(APP_ID, rootId, CHAT_ID)).toBe(true);

    await workerPool.closeSession(ds.session.sessionId);

    expect(ds.session.status).toBe('closed');
    expect(isP2pForceTopicRoot(APP_ID, rootId, CHAT_ID)).toBe(false);
  });

  it('never drops the marker of a plain /t DM topic (forkedFrom gate)', async () => {
    const rootId = 'om_plain_topic_root';
    const ds = registerSession({ rootId });
    recordP2pForceTopicRoot(APP_ID, rootId, CHAT_ID);

    await workerPool.closeSession(ds.session.sessionId);

    expect(ds.session.status).toBe('closed');
    // A regular /t topic marker is user-intent state the close path must not
    // touch even though the session row goes away.
    expect(isP2pForceTopicRoot(APP_ID, rootId, CHAT_ID)).toBe(true);
  });
});
