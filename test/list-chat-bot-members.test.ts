import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dataDir: '' }));

vi.mock('../src/config.js', () => ({
  config: {
    session: {
      get dataDir() { return state.dataDir; },
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
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  LoggerLevel: { error: 4 },
  Client: class MockClient {
    appId: string;
    im: any;

    constructor(opts: { appId: string }) {
      this.appId = opts.appId;
      this.im = {
        v1: {
          chatMembers: {
            isInChat: vi.fn(async () => ({ code: 0, data: { is_in_chat: true } })),
          },
        },
      };
    }
  },
}));

describe('listChatBotMembers', () => {
  afterEach(() => {
    if (state.dataDir) {
      rmSync(state.dataDir, { recursive: true, force: true });
      state.dataDir = '';
    }
  });

  it('returns larkAppId so callers can identify self when cliId is duplicated', async () => {
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
      { larkAppId: 'cli_self', name: 'codex', displayName: 'Botmux Oncall(Codex)', openId: 'ou_self_seen_by_self' },
      { larkAppId: 'cli_peer', name: 'codex', displayName: 'Botmux Oncall(CoCo)', openId: 'ou_peer_seen_by_self' },
    ]);
    expect(bots.map(b => b.larkAppId === 'cli_self')).toEqual([true, false]);
  });
});
