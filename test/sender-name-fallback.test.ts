import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  listMembers: vi.fn(),
  send: vi.fn(),
  reply: vi.fn(),
  getDetail: vi.fn(),
  del: vi.fn(),
  record: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/im/lark/client.js', () => ({
  listChatMembersWithNames: (...a: any[]) => m.listMembers(...a),
  sendMessage: (...a: any[]) => m.send(...a),
  replyMessage: (...a: any[]) => m.reply(...a),
  getMessageDetail: (...a: any[]) => m.getDetail(...a),
  deleteMessage: (...a: any[]) => m.del(...a),
}));
vi.mock('../src/im/lark/identity-cache.js', () => ({
  recordIdentity: (...a: any[]) => m.record(...a),
}));

beforeEach(() => {
  // Fresh module each test → the module-level negative cache doesn't bleed across cases.
  vi.resetModules();
  vi.useRealTimers();
  Object.values(m).forEach((fn) => fn.mockReset());
  m.del.mockResolvedValue(true);
});

describe('resolveSenderNameFallback', () => {
  it('layer 3: resolves from chat members without probing', async () => {
    m.listMembers.mockResolvedValue([
      { openId: 'ou_other', name: '他人' },
      { openId: 'ou_target', name: '目标用户' },
    ]);
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    const name = await resolveSenderNameFallback('cli_x', 'ou_target', { chatId: 'oc_c', scope: 'chat' });
    expect(name).toBe('目标用户');
    expect(m.send).not.toHaveBeenCalled();
    expect(m.reply).not.toHaveBeenCalled();
    // seeds the whole members page into the cache (free coverage for everyone)
    expect(m.record).toHaveBeenCalledTimes(2);
  });

  it('layer 4: probes via @mention + recall when members miss (chat scope)', async () => {
    m.listMembers.mockResolvedValue([{ openId: 'ou_other', name: '他人' }]);
    m.send.mockResolvedValue('om_probe');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [{ id: 'ou_target', name: '探针名' }] }] });
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    const name = await resolveSenderNameFallback('cli_x', 'ou_target', { chatId: 'oc_c', scope: 'chat' });
    expect(name).toBe('探针名');
    // probe @s the target AND carries /introduce so a misfired bot short-circuits
    const [, , content, msgType] = m.send.mock.calls[0];
    expect(content).toContain('ou_target');
    expect(content).toContain('/introduce');
    expect(msgType).toBe('text');
    expect(m.del).toHaveBeenCalledWith('cli_x', 'om_probe');
    expect(m.record).toHaveBeenCalledWith('cli_x', expect.objectContaining({ openId: 'ou_target', name: '探针名' }));
  });

  it('layer 4: thread scope replies in-thread using the anchor', async () => {
    m.listMembers.mockResolvedValue([]);
    m.reply.mockResolvedValue('om_probe');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [{ id: 'ou_target', name: '楼主' }] }] });
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    const name = await resolveSenderNameFallback('cli_x', 'ou_target', { chatId: 'oc_c', scope: 'thread', anchor: 'om_root' });
    expect(name).toBe('楼主');
    const [, msgId, , , replyInThread] = m.reply.mock.calls[0];
    expect(msgId).toBe('om_root');
    expect(replyInThread).toBe(true);
    expect(m.send).not.toHaveBeenCalled();
    expect(m.del).toHaveBeenCalledWith('cli_x', 'om_probe');
  });

  it('recalls the probe even when no name was backfilled', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockResolvedValue('om_probe');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [] }] });
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    const name = await resolveSenderNameFallback('cli_x', 'ou_target', { chatId: 'oc_c', scope: 'chat' });
    expect(name).toBeUndefined();
    expect(m.del).toHaveBeenCalledWith('cli_x', 'om_probe');
  });

  it('returns undefined (no throw) when the probe send itself fails', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockRejectedValue(new Error('send boom'));
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    await expect(
      resolveSenderNameFallback('cli_x', 'ou_target', { chatId: 'oc_c', scope: 'chat' }),
    ).resolves.toBeUndefined();
    expect(m.del).not.toHaveBeenCalled(); // no message_id to recall
  });
});

describe('enrichSenderName (gate)', () => {
  it('never probes a bot sender', async () => {
    const { enrichSenderName } = await import('../src/im/lark/sender-name-fallback.js');
    const out = await enrichSenderName('cli_x', { openId: 'ou_bot', type: 'bot' }, { chatId: 'oc_c', scope: 'chat' });
    expect(out).toEqual({ openId: 'ou_bot', type: 'bot' });
    expect(m.listMembers).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });

  it('does not probe when the name is already resolved (layers 1-2 hit)', async () => {
    const { enrichSenderName } = await import('../src/im/lark/sender-name-fallback.js');
    const out = await enrichSenderName('cli_x', { openId: 'ou_u', type: 'user', name: '已知' }, { chatId: 'oc_c', scope: 'chat' });
    expect(out).toEqual({ openId: 'ou_u', type: 'user', name: '已知' });
    expect(m.listMembers).not.toHaveBeenCalled();
  });

  it('probes a nameless user sender and merges the resolved name', async () => {
    m.listMembers.mockResolvedValue([{ openId: 'ou_u', name: '查到的名' }]);
    const { enrichSenderName } = await import('../src/im/lark/sender-name-fallback.js');
    const out = await enrichSenderName('cli_x', { openId: 'ou_u', type: 'user' }, { chatId: 'oc_c', scope: 'chat' });
    expect(out).toEqual({ openId: 'ou_u', type: 'user', name: '查到的名' });
  });

  it('returns the sender unchanged when the fallback finds nothing', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockResolvedValue('om_p');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [] }] });
    const { enrichSenderName } = await import('../src/im/lark/sender-name-fallback.js');
    const out = await enrichSenderName('cli_x', { openId: 'ou_u', type: 'user' }, { chatId: 'oc_c', scope: 'chat' });
    expect(out).toEqual({ openId: 'ou_u', type: 'user' });
  });

  it('passes an undefined sender straight through', async () => {
    const { enrichSenderName } = await import('../src/im/lark/sender-name-fallback.js');
    expect(await enrichSenderName('cli_x', undefined, { chatId: 'oc_c', scope: 'chat' })).toBeUndefined();
    expect(m.listMembers).not.toHaveBeenCalled();
  });
});

describe('resolveSenderNameFallback — robustness (timeout + failure cooldown)', () => {
  // readBudgetMs is injectable so these run in real time without fake timers.
  it('recalls and returns undefined when the read exceeds the budget', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockResolvedValue('om_probe');
    m.getDetail.mockReturnValue(new Promise(() => {})); // read hangs forever
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    const name = await resolveSenderNameFallback('cli_x', 'ou_t', { chatId: 'oc_c', scope: 'chat', readBudgetMs: 20 });
    expect(name).toBeUndefined();
    // a hung read must NOT leave the probe visible — recall fires regardless
    expect(m.del).toHaveBeenCalledWith('cli_x', 'om_probe');
  }, 2000);

  it('does not block the result on a slow recall (fire-and-forget)', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockResolvedValue('om_probe');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [{ id: 'ou_t', name: '探到' }] }] });
    m.del.mockReturnValue(new Promise(() => {})); // recall hangs
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    const name = await resolveSenderNameFallback('cli_x', 'ou_t', { chatId: 'oc_c', scope: 'chat' });
    expect(name).toBe('探到');
  }, 2000);

  it('does not re-probe the same user after a failed probe (per-user negative cache)', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockResolvedValue('om_probe');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [] }] }); // no name backfilled
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    await resolveSenderNameFallback('cli_x', 'ou_t', { chatId: 'oc_c', scope: 'chat' });
    await resolveSenderNameFallback('cli_x', 'ou_t', { chatId: 'oc_c', scope: 'chat' });
    // 2nd inbound from the same unresolvable user must NOT send another probe…
    expect(m.send).toHaveBeenCalledTimes(1);
    // …nor re-hit the members API (the cooldown gates the whole fallback)
    expect(m.listMembers).toHaveBeenCalledTimes(1);
  });

  it('cooldown is per-user — a different user is still probed', async () => {
    m.listMembers.mockResolvedValue([]);
    m.send.mockResolvedValue('om_probe');
    m.getDetail.mockResolvedValue({ items: [{ mentions: [] }] });
    const { resolveSenderNameFallback } = await import('../src/im/lark/sender-name-fallback.js');
    await resolveSenderNameFallback('cli_x', 'ou_a', { chatId: 'oc_c', scope: 'chat' });
    await resolveSenderNameFallback('cli_x', 'ou_b', { chatId: 'oc_c', scope: 'chat' });
    expect(m.send).toHaveBeenCalledTimes(2);
  });
});
