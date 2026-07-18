import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    dataDir: '',
    listBotsApiEnabled: false,
    listBotsApiTimeoutMs: 3000,
    listBotsApiItems: undefined as Array<{ bot_id: string; bot_name: string }> | undefined,
    listBotsApiPages: undefined as Record<string, {
      items: Array<{ bot_id: string; bot_name: string }>;
      hasMore?: boolean;
      nextPageToken?: string;
    }> | undefined,
    listBotsApiError: undefined as Error | undefined,
    listBotsApiCode: 0,
    listBotsApiCalls: 0,
  };

  class MockClient {
    appId: string;
    im: any;

    constructor(opts: { appId: string }) {
      this.appId = opts.appId;
      this.im = { v1: {} };
    }

    // isInChat and members/bots now route through client.request().
    async request({ url, params }: { url: string; params?: Record<string, unknown> }) {
      if (url.includes('/members/bots')) {
        state.listBotsApiCalls++;
        if (state.listBotsApiError) throw state.listBotsApiError;
        const pageToken = String(params?.page_token ?? '');
        const page = state.listBotsApiPages?.[pageToken];
        return {
          code: state.listBotsApiCode,
          msg: state.listBotsApiCode === 0 ? 'success' : 'business error',
          data: {
            items: page?.items ?? state.listBotsApiItems ?? [],
            has_more: page?.hasMore ?? false,
            page_token: page?.nextPageToken,
          },
        };
      }
      if (url.includes('/members/is_in_chat')) {
        return { code: 0, data: { is_in_chat: true } };
      }
      throw new Error(`unexpected GET url in mock: ${url}`);
    }
  }

  return { state, MockClient };
});
const { state, MockClient } = hoisted;

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return state.dataDir; },
    },
    chatBotDiscovery: {
      get listBotsApiEnabled() { return state.listBotsApiEnabled; },
      get listBotsApiTimeoutMs() { return state.listBotsApiTimeoutMs; },
    },
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  loadBotConfigs: vi.fn(() => [
    { larkAppId: 'cli_self', larkAppSecret: 's1', cliId: 'codex' },
    { larkAppId: 'cli_peer', larkAppSecret: 's2', cliId: 'codex' },
  ]),
  getBotClient: vi.fn((appId: string) => new MockClient({ appId })),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { error: 4 },
  Client: MockClient,
}));

describe('listChatBotMembers', () => {
  afterEach(() => {
    vi.useRealTimers();
    if (state.dataDir) {
      rmSync(state.dataDir, { recursive: true, force: true });
      state.dataDir = '';
    }
    state.listBotsApiEnabled = false;
    state.listBotsApiTimeoutMs = 3000;
    state.listBotsApiItems = undefined;
    state.listBotsApiPages = undefined;
    state.listBotsApiError = undefined;
    state.listBotsApiCode = 0;
    state.listBotsApiCalls = 0;
  });

  it('does not call /members/bots when the experimental flag is disabled', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(state.listBotsApiCalls).toBe(0);
    expect(bots.some(b => b.larkAppId === 'cli_self')).toBe(true);
  });

  it('probes authoritative membership even when roster discovery fallback is disabled', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-probe-chat-bots-'));
    state.listBotsApiEnabled = false;
    state.listBotsApiItems = [
      { bot_id: 'ou_worker', bot_name: 'relay-loopy' },
    ];

    const { probeChatBotMembership } = await import('../src/im/lark/client.js');
    await expect(probeChatBotMembership('cli_self', 'oc_goal')).resolves.toEqual({
      known: true,
      members: [{ openId: 'ou_worker', name: 'relay-loopy' }],
    });
    expect(state.listBotsApiCalls).toBe(1);
  });

  it('reads every /members/bots page before deciding that a worker is absent', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-probe-chat-bots-'));
    state.listBotsApiPages = {
      '': {
        items: [{ bot_id: 'ou_first', bot_name: 'first-loopy' }],
        hasMore: true,
        nextPageToken: 'page-2',
      },
      'page-2': {
        items: [{ bot_id: 'ou_worker', bot_name: 'relay-loopy' }],
      },
    };

    const { probeChatBotMembership } = await import('../src/im/lark/client.js');
    await expect(probeChatBotMembership('cli_self', 'oc_goal')).resolves.toEqual({
      known: true,
      members: [
        { openId: 'ou_first', name: 'first-loopy' },
        { openId: 'ou_worker', name: 'relay-loopy' },
      ],
    });
    expect(state.listBotsApiCalls).toBe(2);
  });

  it('treats broken /members/bots pagination as unknown instead of a false absence', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-probe-chat-bots-'));
    state.listBotsApiPages = {
      '': {
        items: [{ bot_id: 'ou_first', bot_name: 'first-loopy' }],
        hasMore: true,
      },
    };

    const { probeChatBotMembership } = await import('../src/im/lark/client.js');
    await expect(probeChatBotMembership('cli_self', 'oc_goal')).resolves.toEqual({
      known: false,
      members: [],
      reason: 'invalid_pagination',
    });
  });

  it('makes membership API failures explicit instead of returning a false empty roster', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-probe-chat-bots-'));
    state.listBotsApiError = new Error('gateway timeout');

    const { probeChatBotMembership } = await import('../src/im/lark/client.js');
    await expect(probeChatBotMembership('cli_self', 'oc_goal')).resolves.toEqual({
      known: false,
      members: [],
      reason: 'gateway timeout',
    });
  });

  it('uses /members/bots as current-chat truth when enabled and does not resurrect stale observed rows', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    state.listBotsApiEnabled = true;
    state.listBotsApiItems = [
      { bot_id: 'ou_self_from_api', bot_name: 'BotSelf' },
      { bot_id: 'ou_peer_from_api', bot_name: 'BotPeer' },
    ];
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self_self_view', botName: 'BotSelf', cliId: 'codex' },
      { larkAppId: 'cli_peer', botOpenId: 'ou_peer_self_view', botName: 'BotPeer', cliId: 'codex' },
    ]));
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      ou_stale_peer: { name: 'StalePeer', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(state.listBotsApiCalls).toBe(1);
    expect(bots.map(b => b.openId)).toEqual(['ou_self_from_api', 'ou_peer_from_api']);
    expect(bots.find(b => b.openId === 'ou_stale_peer')).toBeUndefined();
    expect(bots.find(b => b.openId === 'ou_peer_from_api')).toMatchObject({
      larkAppId: 'cli_peer',
      source: 'configured',
      mentionable: true,
      mentionSource: 'observed',
    });
  });

  it('binds self by open_id when /members/bots display name drifts from bots-info, so self is not surfaced as a peer', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    state.listBotsApiEnabled = true;
    // /members/bots returns self under a drifted display name, but its
    // observer-scoped bot_id is self's self-view open_id (observer == self).
    state.listBotsApiItems = [
      { bot_id: 'ou_self', bot_name: 'BotSelf Renamed' },
    ];
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(state.listBotsApiCalls).toBe(1);
    // Bound to self via open_id despite the name mismatch → caller can exclude
    // self by larkAppId instead of leaking it into <available_bots>.
    expect(bots.find(b => b.openId === 'ou_self')).toMatchObject({
      larkAppId: 'cli_self',
      source: 'configured',
      mentionSource: 'self',
    });
  });

  it('treats /members/bots items: [] as authoritative and does not fall back to observed rows', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    state.listBotsApiEnabled = true;
    state.listBotsApiItems = [];
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      ou_external: { name: 'External', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(state.listBotsApiCalls).toBe(1);
    expect(bots).toEqual([]);
  });

  it('caches /members/bots failures for 3 minutes before retrying and falls back to legacy discovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-30T00:00:00Z'));
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    state.listBotsApiEnabled = true;
    state.listBotsApiError = new Error('gateway unavailable');
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    await listChatBotMembers('cli_self', 'oc_chat');
    await listChatBotMembers('cli_self', 'oc_chat');

    expect(state.listBotsApiCalls).toBe(1);
    vi.setSystemTime(new Date('2026-06-30T00:03:01Z'));
    await listChatBotMembers('cli_self', 'oc_chat');
    expect(state.listBotsApiCalls).toBe(2);
  });

  it('does not cache non-zero /members/bots business errors as capability failures', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    state.listBotsApiEnabled = true;
    state.listBotsApiCode = 99992356;
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    await listChatBotMembers('cli_self', 'oc_bad');
    await listChatBotMembers('cli_self', 'oc_bad');

    expect(state.listBotsApiCalls).toBe(2);
  });

  it('returns larkAppId + source="configured" so callers can identify self and provenance', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self_seen_by_self', botName: 'Botmux Oncall(Codex)', cliId: 'codex' },
      { larkAppId: 'cli_peer', botOpenId: 'ou_peer_seen_by_self', botName: 'Botmux Oncall(CoCo)', cliId: 'codex' },
    ]));
    writeFileSync(join(state.dataDir, 'bot-openids-cli_self.json'), JSON.stringify({
      'Botmux Oncall(Codex)': 'ou_self_seen_by_self',
      'Botmux Oncall(CoCo)': 'ou_peer_seen_by_self',
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(bots).toEqual([
      { larkAppId: 'cli_self', name: 'codex', displayName: 'Botmux Oncall(Codex)', openId: 'ou_self_seen_by_self', source: 'configured', capability: undefined, hasTeamRole: false, mentionable: true, mentionSource: 'cross-ref' },
      { larkAppId: 'cli_peer', name: 'codex', displayName: 'Botmux Oncall(CoCo)', openId: 'ou_peer_seen_by_self', source: 'configured', capability: undefined, hasTeamRole: false, mentionable: true, mentionSource: 'cross-ref' },
    ]);
    expect(bots.map(b => b.larkAppId === 'cli_self')).toEqual([true, false]);
  });

  it('marks a peer NOT in cross-ref as known-but-not-reliably-mentionable', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    // cli_peer is in bots-info (so we know its self-view open_id) but NOT in the
    // cli_self cross-ref → cli_self cannot reliably @-mention it.
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self_seen_by_self', botName: 'BotSelf', cliId: 'codex' },
      { larkAppId: 'cli_peer', botOpenId: 'ou_peer_self_view', botName: 'BotPeer', cliId: 'codex' },
    ]));
    writeFileSync(join(state.dataDir, 'bot-openids-cli_self.json'), JSON.stringify({
      'BotSelf': 'ou_self_seen_by_self',
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    const self = bots.find(b => b.larkAppId === 'cli_self')!;
    const peer = bots.find(b => b.larkAppId === 'cli_peer')!;
    expect(self.mentionable).toBe(true);           // self is always fine
    expect(self.mentionSource).toBe('cross-ref');
    expect(peer.mentionable).toBe(false);          // self-view open_id is wrong for cli_self to use
    expect(peer.mentionSource).toBe('self');
  });

  it('upgrades a configured peer (no cross-ref) in place using an observed same-name handle', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
      { larkAppId: 'cli_peer', botOpenId: 'ou_peer_self_view', botName: 'BotPeer', cliId: 'codex' },
    ]));
    // cli_self cross-ref knows only itself → peer would be 'self' (unreliable)
    writeFileSync(join(state.dataDir, 'bot-openids-cli_self.json'), JSON.stringify({ 'BotSelf': 'ou_self' }));
    // But /introduce recorded BotPeer's open_id from cli_self's perspective
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_peer_seen_by_self': { name: 'BotPeer', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    const peers = bots.filter(b => b.displayName === 'BotPeer');
    expect(peers).toHaveLength(1);                       // upgraded in place, NOT duplicated
    expect(peers[0].larkAppId).toBe('cli_peer');         // kept managed identity
    expect(peers[0].openId).toBe('ou_peer_seen_by_self'); // adopted the reliable handle
    expect(peers[0].mentionable).toBe(true);
    expect(peers[0].mentionSource).toBe('observed');
    // no external duplicate row for the same handle
    expect(bots.filter(b => b.openId === 'ou_peer_seen_by_self' && b.larkAppId === '')).toHaveLength(0);
  });

  it('includes observed bots from observed-bots-<larkAppId>-<chatId>.json with source="introduce"', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));
    // External bot discovered via /introduce — NOT in bots-info.json
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_external_loopy': { name: 'codex-loopy', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    // Configured bots from loadBotConfigs mock (2: cli_self + cli_peer) + 1 observed external
    expect(bots).toHaveLength(3);
    const externalEntry = bots.find(b => b.openId === 'ou_external_loopy');
    expect(externalEntry).toBeDefined();
    expect(externalEntry).toMatchObject({
      openId: 'ou_external_loopy',
      displayName: 'codex-loopy',
      source: 'introduce',
      larkAppId: '',
    });
  });

  it('observed entries do not leak across chats (uses observed-bots-<larkAppId>-<chatId>.json)', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));
    const now = Date.now();
    // Observed bot recorded for a DIFFERENT chat
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_OTHER_chat.json'), JSON.stringify({
      'ou_external': { name: 'codex-loopy', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(bots.find(b => b.openId === 'ou_external')).toBeUndefined();
  });

  it('configured wins over observed when openId collides (no duplicates)', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_shared', botName: 'ConfiguredName', cliId: 'codex' },
    ]));
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_shared': { name: 'ObservedName', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(bots.filter(b => b.openId === 'ou_shared')).toHaveLength(1);
    const winner = bots.find(b => b.openId === 'ou_shared')!;
    expect(winner.displayName).toBe('ConfiguredName');
    expect(winner.source).toBe('configured');
  });

  it('filters out stale observed entries (older than 30 days)', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_self', botOpenId: 'ou_self', botName: 'BotSelf', cliId: 'codex' },
    ]));
    // 31 days ago — should be filtered out
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_stale': { name: 'ForgottenBot', source: 'introduce', firstSeenAt: stale, lastSeenAt: stale },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    expect(bots.find(b => b.openId === 'ou_stale')).toBeUndefined();
  });

  it('observed entries carry larkAppId="" (external — not owned by any local daemon)', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), '[]');
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_external': { name: 'External', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    const ext = bots.find(b => b.openId === 'ou_external');
    expect(ext).toBeDefined();
    expect(ext!.larkAppId).toBe('');
  });

  it('observed reads only the caller-app file (per-app open_id isolation)', async () => {
    // Same chat, BUT two observer apps recorded conflicting open_ids for the
    // same bot. Listing for cli_self must yield A's view; listing for cli_peer
    // must yield B's view — never cross-pollute.
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), '[]');
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_B_as_seen_by_self': { name: 'BotB', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));
    writeFileSync(join(state.dataDir, 'observed-bots-cli_peer-oc_chat.json'), JSON.stringify({
      'ou_B_as_seen_by_peer': { name: 'BotB', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const fromSelf = await listChatBotMembers('cli_self', 'oc_chat');
    const fromPeer = await listChatBotMembers('cli_peer', 'oc_chat');

    expect(fromSelf.find(b => b.openId === 'ou_B_as_seen_by_self')).toBeDefined();
    expect(fromSelf.find(b => b.openId === 'ou_B_as_seen_by_peer')).toBeUndefined();
    expect(fromPeer.find(b => b.openId === 'ou_B_as_seen_by_peer')).toBeDefined();
    expect(fromPeer.find(b => b.openId === 'ou_B_as_seen_by_self')).toBeUndefined();
  });

  it('deduplicates same-name observed entries and keeps only the latest mentionable openId', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), '[]');
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_stale': { name: 'NasCodex', source: 'introduce', firstSeenAt: now - 10_000, lastSeenAt: now - 10_000 },
      'ou_current': { name: 'NasCodex', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    const nasEntries = bots.filter(b => b.displayName === 'NasCodex');
    expect(nasEntries).toHaveLength(1);
    expect(nasEntries[0]).toMatchObject({
      openId: 'ou_current',
      mentionable: true,
      mentionSource: 'observed',
    });
    expect(bots.find(b => b.openId === 'ou_stale')).toBeUndefined();
  });

  it('prefers a same-name bot-openids cross-ref over a stale observed external handle', async () => {
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), '[]');
    writeFileSync(join(state.dataDir, 'bot-openids-cli_self.json'), JSON.stringify({
      NasCodex: 'ou_current_cross_ref',
    }));
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_stale_observed': { name: 'NasCodex', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    const nasEntries = bots.filter(b => b.displayName === 'NasCodex');
    expect(nasEntries).toHaveLength(1);
    expect(nasEntries[0]).toMatchObject({
      larkAppId: '',
      openId: 'ou_current_cross_ref',
      source: 'introduce',
      mentionable: true,
      mentionSource: 'cross-ref',
    });
    expect(bots.find(b => b.openId === 'ou_stale_observed')).toBeUndefined();
  });

  it('cross-ref name matching trims whitespace but stays case-sensitive', async () => {
    // The unified name-key normalizer is trim-only. A cross-ref key with stray
    // surrounding whitespace still matches an observed name (trim), but a
    // case-only difference does NOT — "Claude" and "claude" stay distinct bots.
    state.dataDir = mkdtempSync(join(tmpdir(), 'botmux-list-chat-bots-'));
    writeFileSync(join(state.dataDir, 'bots-info.json'), '[]');
    writeFileSync(join(state.dataDir, 'bot-openids-cli_self.json'), JSON.stringify({
      '  NasCodex  ': 'ou_cross_ref_padded', // whitespace-padded → must still match
      'Claude': 'ou_cross_ref_claude',       // capital C → must NOT match observed "claude"
    }));
    const now = Date.now();
    writeFileSync(join(state.dataDir, 'observed-bots-cli_self-oc_chat.json'), JSON.stringify({
      'ou_obs_nas': { name: 'NasCodex', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
      'ou_obs_claude': { name: 'claude', source: 'introduce', firstSeenAt: now, lastSeenAt: now },
    }));

    const { listChatBotMembers } = await import('../src/im/lark/client.js');
    const bots = await listChatBotMembers('cli_self', 'oc_chat');

    // Trim: padded cross-ref key matched the observed "NasCodex" → cross-ref openId wins.
    const nas = bots.find(b => b.displayName === 'NasCodex')!;
    expect(nas).toMatchObject({ openId: 'ou_cross_ref_padded', mentionSource: 'cross-ref' });

    // Case-sensitive: observed "claude" must NOT pick up the "Claude" cross-ref id;
    // it stays an observed external row with its own observed open_id.
    const claude = bots.find(b => b.displayName === 'claude')!;
    expect(claude).toMatchObject({ openId: 'ou_obs_claude', mentionSource: 'observed' });
  });
});
