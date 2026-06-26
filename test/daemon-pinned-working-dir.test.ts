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

  it('does NOT let another bot\'s oncall binding pin this bot (per-bot pin)', async () => {
    const { botRegistry, daemon } = await loadFreshModules();
    const peerOncallDir = tempDir('peer-oncall-repo');
    const selfDefaultDir = tempDir('self-default-repo');
    // app-peer is oncall-bound to peerOncallDir for this chat; app-self is NOT.
    // Pre-fix this leaked across bots (findOncallChatForAnyBot) and pinned
    // app-self to peerOncallDir. Per-bot, app-self must ignore it and fall
    // through to its own defaultWorkingDir.
    botRegistry.registerBot({
      larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code',
      oncallChats: [{ chatId: 'oc_chat', workingDir: peerOncallDir }],
    });
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      defaultWorkingDir: selfDefaultDir,
    });

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    expect(result.oncallEntry).toBeFalsy();
    expect(result.inheritedFrom).toBeNull();
    expect(result.pinnedWorkingDir).toBe(selfDefaultDir);
  });

  it('does NOT inherit a valid peer when botToBotSameDir=false (per-bot opt-out)', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const peerDir = tempDir('peer-repo');
    const defaultDir = tempDir('default-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      defaultWorkingDir: defaultDir,
      botToBotSameDir: false,
    });
    await seedPeerSession(sessionStore, peerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    // Gate off → ignore the valid peer, fall through to own defaultWorkingDir.
    expect(result.inheritedFrom).toBeNull();
    expect(result.pinnedWorkingDir).toBe(defaultDir);
  });

  it('inherits a valid peer when botToBotSameDir is default (on)', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const peerDir = tempDir('peer-repo');
    const defaultDir = tempDir('default-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      defaultWorkingDir: defaultDir,
      // botToBotSameDir omitted → default on
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

  it('uses defaultOncall.workingDir as the all-sessions fallback for non-group sessions (Oncall mode covers p2p)', async () => {
    const { botRegistry, daemon } = await loadFreshModules();
    const oncallDir = tempDir('self-oncall-repo');
    // Oncall mode: defaultOncall enabled, defaultWorkingDir cleared (the
    // dashboard makes them mutually exclusive). A p2p session never auto-binds
    // oncall (group-only), so the oncall dir must still pin it via layer-4.
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      defaultOncall: { enabled: true, workingDir: oncallDir, since: 1 },
    });

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_dm',
      chatId: 'oc_dm',
      chatType: 'p2p',
      larkAppId: 'app-self',
    });

    expect(result.oncallEntry).toBeFalsy();
    expect(result.inheritedFrom).toBeNull();
    expect(result.pinnedWorkingDir).toBe(oncallDir);
  });

  it('does NOT use a DISABLED defaultOncall.workingDir as the fallback', async () => {
    const { botRegistry, daemon } = await loadFreshModules();
    const oncallDir = tempDir('self-oncall-repo');
    // defaultOncall present but disabled → no all-sessions fallback; no
    // defaultWorkingDir either → nothing pins, caller shows the repo card.
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      defaultOncall: { enabled: false, workingDir: oncallDir, since: 0 },
    });

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread', anchor: 'om_dm', chatId: 'oc_dm', chatType: 'p2p', larkAppId: 'app-self',
    });

    expect(result.pinnedWorkingDir).toBeUndefined();
  });

  it('prefers explicit defaultWorkingDir over defaultOncall.workingDir when both are set', async () => {
    const { botRegistry, daemon } = await loadFreshModules();
    const oncallDir = tempDir('self-oncall-repo');
    const defaultDir = tempDir('self-default-repo');
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      defaultOncall: { enabled: true, workingDir: oncallDir, since: 1 },
      defaultWorkingDir: defaultDir,
    });

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread', anchor: 'om_dm', chatId: 'oc_dm', chatType: 'p2p', larkAppId: 'app-self',
    });

    expect(result.pinnedWorkingDir).toBe(defaultDir);
  });

  it('honors THIS bot\'s own oncall binding above inherit/default', async () => {
    const { botRegistry, daemon } = await loadFreshModules();
    const selfOncallDir = tempDir('self-oncall-repo');
    const selfDefaultDir = tempDir('self-default-repo');
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      oncallChats: [{ chatId: 'oc_chat', workingDir: selfOncallDir }],
      defaultWorkingDir: selfDefaultDir,
    });

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    expect(result.oncallEntry?.workingDir).toBe(selfOncallDir);
    expect(result.pinnedWorkingDir).toBe(selfOncallDir);
  });
});
