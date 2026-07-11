/**
 * Regression coverage for new-session workingDir resolution.
 *
 * Run: pnpm vitest run test/daemon-pinned-working-dir.test.ts test/inherit-peer.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
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
  it('uses a receiver-resolved repo requirement above oncall/default/inheritance', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const requiredDir = tempDir('required-repo');
    const oncallDir = tempDir('oncall-repo');
    const defaultDir = tempDir('default-repo');
    const peerDir = tempDir('peer-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      oncallChats: [{ chatId: 'oc_chat', workingDir: oncallDir }],
      defaultWorkingDir: defaultDir,
    });
    await seedPeerSession(sessionStore, peerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
      requiredWorkingDir: requiredDir,
    });

    expect(result).toMatchObject({
      pinnedWorkingDir: requiredDir,
      pinnedFromRequirement: true,
      pinnedFromBotDefault: false,
      inheritedFrom: null,
    });
    expect(result.oncallEntry).toBeUndefined();
  });

  it('prefers THIS bot\'s own defaultWorkingDir over a valid same-anchor peer (no cross-bot dir pollution)', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const peerDir = tempDir('peer-repo');
    const defaultDir = tempDir('default-repo');
    // app-peer is already running in the same thread at peerDir; app-self has its
    // OWN defaultWorkingDir. The bot's explicit config must win — it must NOT
    // inherit the sibling's dir. This is the core of the per-bot-default-over-
    // inherit fix: two bots with distinct default dirs never leak into each other.
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      defaultWorkingDir: defaultDir,
    });
    await seedPeerSession(sessionStore, peerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread',
      anchor: 'om_root',
      chatId: 'oc_chat',
      chatType: 'group',
      larkAppId: 'app-self',
    });

    expect(result.pinnedWorkingDir).toBe(defaultDir);
    expect(result.inheritedFrom).toBeNull();
    // Its OWN defaultWorkingDir (layer 3) → auto-worktree may opt in here.
    expect(result.pinnedFromBotDefault).toBe(true);
  });

  it('inherits a same-anchor peer workingDir ONLY when this bot has no oncall binding and no default dir of its own', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const peerDir = tempDir('peer-repo');
    // app-self configures nothing of its own → the last-resort inherit kicks in
    // so a freshly @mentioned collaborator follows the topic.
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({ larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code' });
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
    // Inherited from a sibling, not this bot's own default → auto-worktree stays out.
    expect(result.pinnedFromBotDefault).toBe(false);
  });

  it('uses this bot defaultWorkingDir and never consults the peer (default outranks inherit)', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    // A stale peer is present, but with a default dir set the peer is never even
    // consulted — default outranks inherit, so peer validity is irrelevant.
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
    // No default dir of its own, so the gate is what decides: off → ignore the
    // peer entirely and fall through to the repo card (no pinned dir).
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
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

    expect(result.inheritedFrom).toBeNull();
    expect(result.pinnedWorkingDir).toBeUndefined();
  });

  it('inherits a valid peer when botToBotSameDir is default (on) and the bot has no default dir', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const peerDir = tempDir('peer-repo');
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self',
      larkAppSecret: 's',
      cliId: 'claude-code',
      // botToBotSameDir omitted → default on; no defaultWorkingDir → inherit reachable
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

  it('Oncall-mode bot with a tombstoned chat uses its OWN defaultOncall dir, not a sibling peer', async () => {
    const { botRegistry, sessionStore, daemon } = await loadFreshModules();
    const oncallDir = tempDir('self-oncall-repo');
    const peerDir = tempDir('peer-repo');
    // Reproduces the reported incident: bot is in Oncall mode but this group was
    // /oncall-unbound once (tombstone) so auto-bind no longer fires → no oncall
    // entry. A sibling bot is active in the same thread at peerDir. The bot must
    // still land in its OWN configured oncall dir, never the sibling's.
    botRegistry.registerBot({ larkAppId: 'app-peer', larkAppSecret: 's', cliId: 'claude-code' });
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      defaultOncall: { enabled: true, workingDir: oncallDir, since: 1 },
      defaultOncallAutoboundChats: ['oc_chat'],
    });
    await seedPeerSession(sessionStore, peerDir);

    const result = await daemon.__testOnly_resolvePinnedWorkingDir({
      scope: 'thread', anchor: 'om_root', chatId: 'oc_chat', chatType: 'group', larkAppId: 'app-self',
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

  it('uses defaultWorkingDir after an auto-bound oncall chat is released', async () => {
    const { botRegistry, daemon } = await loadFreshModules();
    const oncallDir = tempDir('self-oncall-repo');
    const defaultDir = tempDir('self-default-repo');
    // Simulates the state after the dashboard switched from Oncall mode to
    // defaultWorkingDir mode: the autobound chat record is gone from oncallChats
    // but the old oncall dir is still preserved in defaultOncall for round-trip.
    botRegistry.registerBot({
      larkAppId: 'app-self', larkAppSecret: 's', cliId: 'claude-code',
      defaultWorkingDir: defaultDir,
      defaultOncall: { enabled: false, workingDir: oncallDir, since: 5_000 },
      defaultOncallAutoboundChats: ['oc_chat'],
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
    expect(result.pinnedWorkingDir).toBe(defaultDir);
    expect(result.pinnedFromBotDefault).toBe(true);
  });
});

describe('dispatch repo preflight', () => {
  it('runs behind the normal sender trust gate on both inbound paths', () => {
    const src = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf-8');
    for (const [startMarker, endMarker] of [
      ['async function handleNewTopic(', 'async function preflightDispatchRepo('],
      ['async function handleThreadReply(', 'async function handleDocComment('],
    ]) {
      const start = src.indexOf(startMarker);
      const end = src.indexOf(endMarker, start + startMarker.length);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      const region = src.slice(start, end);
      const trustGate = region.lastIndexOf('enforceMessageQuotaForCliInput(');
      const preflight = region.indexOf('preflightDispatchRepo({');
      expect(trustGate).toBeGreaterThanOrEqual(0);
      expect(preflight).toBeGreaterThan(trustGate);
    }
  });

  it('returns handled and emits access help before any session can be created', async () => {
    const { sessionStore, daemon } = await loadFreshModules();
    const scanRoot = tempDir('empty-project-root');
    const dataDir = tempDir('repo-data');
    const sendAccessHelp = vi.fn(async () => {});
    const resolveRequirement = vi.fn(async () => ({
      ok: false as const,
      reason: 'not_found' as const,
      detail: '项目扫描达到上限；请先在该设备选择一次项目完成登记',
    }));
    const parsed = {
      messageId: 'om_dispatch',
      msgType: 'post',
      content: [
        '执行跨设备任务',
        '',
        '[botmux-dispatch v1]',
        'taskId: task-missing-repo',
        'repo: https://github.com/acme/missing.git',
      ].join('\n'),
      senderId: 'ou_supervisor',
      senderUnionId: 'on_supervisor',
      senderType: 'bot',
      chatId: 'oc_goal',
      chatType: 'group',
      mentions: [],
    } as any;

    const result = await daemon.__testOnly_preflightDispatchRepo({
      parsed,
      larkAppId: 'app-worker',
      chatId: 'oc_goal',
      scope: 'chat',
      anchor: 'oc_goal',
    }, {
      scanDirs: [scanRoot],
      dataDir,
      sendAccessHelp,
      resolveRequirement,
    });

    expect(result).toEqual({ handled: true });
    expect(resolveRequirement).toHaveBeenCalledWith(expect.objectContaining({
      requirement: 'https://github.com/acme/missing.git',
      scanDirs: [scanRoot],
      dataDir,
    }));
    expect(sendAccessHelp).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-missing-repo',
      repo: 'https://github.com/acme/missing.git',
      supervisorOpenId: 'ou_supervisor',
      detail: '项目扫描达到上限；请先在该设备选择一次项目完成登记',
    }));
    expect(sessionStore.listSessions()).toHaveLength(0);
  });
});
