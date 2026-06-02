import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ pages: [] as any[], calls: [] as any[] }));

vi.mock('../src/config.js', () => ({
  config: { session: { dataDir: '/tmp/botmux-test' } },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn(() => ({
    request: async (req: any) => {
      state.calls.push(req);
      return state.pages.shift() ?? { code: 0, data: { items: [], has_more: false } };
    },
  })),
  loadBotConfigs: vi.fn(() => []),
}));

describe('listChatMembersWithNames', () => {
  it('returns (openId, name) pairs for chat members', async () => {
    state.pages = [{ code: 0, data: { items: [
      { member_id: 'ou_a', name: '张三' },
      { member_id: 'ou_b', name: '李四' },
    ], has_more: false } }];
    state.calls = [];
    const { listChatMembersWithNames } = await import('../src/im/lark/client.js');
    const members = await listChatMembersWithNames('cli_x', 'oc_chat');
    expect(members).toEqual([
      { openId: 'ou_a', name: '张三' },
      { openId: 'ou_b', name: '李四' },
    ]);
  });

  it('defaults to a single page even when more pages exist', async () => {
    state.pages = [
      { code: 0, data: { items: [{ member_id: 'ou_a', name: '张三' }], has_more: true, page_token: 'p2' } },
      { code: 0, data: { items: [{ member_id: 'ou_b', name: '李四' }], has_more: false } },
    ];
    state.calls = [];
    const { listChatMembersWithNames } = await import('../src/im/lark/client.js');
    const members = await listChatMembersWithNames('cli_x', 'oc_chat');
    expect(members).toEqual([{ openId: 'ou_a', name: '张三' }]); // only page 1
    expect(state.calls).toHaveLength(1); // did not fetch page 2
  });

  it('skips items missing a name (e.g. bot members), keeps named users', async () => {
    state.pages = [{ code: 0, data: { items: [
      { member_id: 'ou_named', name: '王五' },
      { member_id: 'ou_noname', name: '' },
      { member_id: '', name: '空' },
    ], has_more: false } }];
    state.calls = [];
    const { listChatMembersWithNames } = await import('../src/im/lark/client.js');
    const members = await listChatMembersWithNames('cli_x', 'oc_chat');
    expect(members).toEqual([{ openId: 'ou_named', name: '王五' }]);
  });

  it('degrades to [] on API error instead of throwing', async () => {
    state.pages = [{ code: 99991663, msg: 'permission denied' }];
    state.calls = [];
    const { listChatMembersWithNames } = await import('../src/im/lark/client.js');
    await expect(listChatMembersWithNames('cli_x', 'oc_chat')).resolves.toEqual([]);
  });
});
