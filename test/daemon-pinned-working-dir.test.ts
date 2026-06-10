/**
 * Regression coverage for new-session workingDir resolution.
 *
 * Run: pnpm vitest run test/daemon-pinned-working-dir.test.ts test/inherit-peer.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

let tmpRoot = '';

function tempDir(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function loadFreshModules() {
  vi.resetModules();
  process.env.SESSION_DATA_DIR = tempDir('sessions');
  const botRegistry = await import('../src/bot-registry.js');
  const sessionStore = await import('../src/services/session-store.js');
  const daemon = await import('../src/daemon.js');
  sessionStore.init();
  return { botRegistry, sessionStore, daemon };
}

async function seedPeerSession(sessionStore: typeof import('../src/services/session-store.js'), workingDir: string) {
  const peer = sessionStore.createSession('oc_chat', 'om_root', 'peer', 'group');
  peer.larkAppId = 'app-peer';
  peer.scope = 'thread';
  peer.workingDir = workingDir;
  sessionStore.updateSession(peer);
  return peer;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'botmux-daemon-pinned-dir-'));
});

afterEach(() => {
  delete process.env.SESSION_DATA_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolvePinnedWorkingDir', () => {
  it('inherits a same-anchor peer workingDir when the directory exists', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const peerDir = tempDir('peer-repo');
    const defaultDir = tempDir('default-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      defaultWorkingDir: defaultDir,
    });
    const peer = await seedPeerSession(sessionStore, peerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    expect(result.pinnedWorkingDir).toBe(peerDir);
    expect(result.inheritedFrom).toEqual({ sessionId: peer.sessionId, larkAppId: 'app-peer', workingDir: peerDir });
  });

  it('ignores a stale inherited peer workingDir and falls back to this bot defaultWorkingDir', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const stalePeerDir = join(tmpRoot, 'deleted-peer-repo');
    const defaultDir = tempDir('default-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      defaultWorkingDir: defaultDir,
    });
    await seedPeerSession(sessionStore, stalePeerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    expect(result.pinnedWorkingDir).toBe(defaultDir);
    expect(result.inheritedFrom).toBeNull();
  });

  it('returns no pinned workingDir when inherited peer and defaultWorkingDir are both invalid', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const stalePeerDir = join(tmpRoot, 'deleted-peer-repo');
    const staleDefaultDir = join(tmpRoot, 'deleted-default-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      defaultWorkingDir: staleDefaultDir,
    });
    await seedPeerSession(sessionStore, stalePeerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    expect(result.pinnedWorkingDir).toBeUndefined();
    expect(result.inheritedFrom).toBeNull();
  });
});
