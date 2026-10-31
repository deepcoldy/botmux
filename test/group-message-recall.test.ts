import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMessageRecallService, type GroupRecallTransport, type RecallMessageRecord } from '../src/services/group-message-recall.js';

const own = (id: string, overrides: Partial<RecallMessageRecord> = {}): RecallMessageRecord => ({
  message_id: id, chat_id: 'oc_group', msg_type: 'text', body: { content: JSON.stringify({ text: 'A message' }) },
  sender: { id: 'cli_bot', sender_type: 'app', sender_name: 'Bot' }, ...overrides,
});
let transport: GroupRecallTransport;
let service: GroupMessageRecallService;
beforeEach(() => {
  transport = { isInChat: vi.fn(async () => true), list: vi.fn(async () => ({ items: [] })), read: vi.fn(async id => own(id)), recall: vi.fn(async () => {}) };
  service = new GroupMessageRecallService('cli_bot', transport);
});

describe('group message recall', () => {
  it('marks only the selected bot’s live messages as recallable and preserves opaque pagination', async () => {
    vi.mocked(transport.list).mockResolvedValue({ items: [
      own('om_own'), own('om_other', { sender: { id: 'cli_other', sender_type: 'app' } }),
      own('om_user', { sender: { id: 'ou_user', sender_type: 'user' } }), own('om_deleted', { deleted: true }),
    ], hasMore: true, pageToken: 'next+/=' });
    const result = await service.list('oc_group', { pageToken: 'opaque+/=' });
    expect(transport.list).toHaveBeenCalledWith({ containerId: 'oc_group', containerType: 'chat', pageToken: 'opaque+/=' });
    expect(result.messages.map(message => message.canRecall)).toEqual([true, false, false, false]);
    expect(result.messages[0].preview).toBe('A message');
    expect(result).toMatchObject({ hasMore: true, pageToken: 'next+/=' });
  });
  it('lists a topic only after checking its root belongs to this group', async () => {
    vi.mocked(transport.read).mockResolvedValue(own('om_root', { thread_id: 'omt_topic' }));
    await service.list('oc_group', { threadRootId: 'om_root' });
    expect(transport.list).toHaveBeenCalledWith({ containerId: 'omt_topic', containerType: 'thread', pageToken: undefined });
    vi.mocked(transport.read).mockResolvedValue(own('om_root', { chat_id: 'oc_other', thread_id: 'omt_other' }));
    await expect(service.list('oc_group', { threadRootId: 'om_root' })).rejects.toMatchObject({ status: 403 });
    expect(transport.list).toHaveBeenCalledTimes(1);
  });
  it('refuses foreign messages even when the selected bot could administratively recall them', async () => {
    vi.mocked(transport.read).mockImplementation(async id => id === 'om_cross'
      ? own(id, { chat_id: 'oc_elsewhere' }) : id === 'om_user'
        ? own(id, { sender: { id: 'cli_bot', sender_type: 'user' } })
        : own(id, { sender: { id: 'cli_other', sender_type: 'app' } }));
    const result = await service.recall('oc_group', { messageIds: ['om_cross', 'om_user', 'om_other'] });
    expect(result.ok).toBe(false);
    expect(result.results.map(result => result.error)).toEqual(['message_chat_mismatch', 'not_bot_message', 'not_bot_message']);
    expect(transport.recall).not.toHaveBeenCalled();
  });
  it('returns per-message outcomes after partial failure and does not repeat already-recalled messages', async () => {
    const deleted = new Set<string>();
    vi.mocked(transport.read).mockImplementation(async id => own(id, { deleted: deleted.has(id) }));
    vi.mocked(transport.recall).mockImplementation(async id => { if (id === 'om_expired') throw new Error('Lark 230002: expired'); deleted.add(id); });
    const input = { messageIds: ['om_good', 'om_expired', 'om_later', 'om_good'] };
    const result = await service.recall('oc_group', input);
    expect(result.results.map(result => result.ok)).toEqual([true, false, true]);
    expect(transport.recall).toHaveBeenCalledTimes(3);
    vi.mocked(transport.recall).mockClear();
    const retry = await service.recall('oc_group', input);
    expect(transport.recall).toHaveBeenCalledExactlyOnceWith('om_expired');
    expect(retry.results[0]).toMatchObject({ ok: true, alreadyRecalled: true });
  });
  it.each([{}, null, [], { messageIds: [] }, { messageIds: ['bad'] }, { messageIds: Array(51).fill('om_x') }, { messageIds: ['om_good'], appId: 'cli_other' }])('rejects invalid batches before any external IO: %j', async input => {
    await expect(service.recall('oc_group', input)).rejects.toMatchObject({ status: 400 });
    expect(transport.isInChat).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
    expect(transport.recall).not.toHaveBeenCalled();
  });
  it('rejects an out-of-group bot before listing or reading messages', async () => {
    vi.mocked(transport.isInChat).mockResolvedValue(false);
    await expect(service.list('oc_group')).rejects.toMatchObject({ status: 403 });
    await expect(service.recall('oc_group', { messageIds: ['om_x'] })).rejects.toMatchObject({ status: 403 });
    expect(transport.list).not.toHaveBeenCalled();
    expect(transport.read).not.toHaveBeenCalled();
  });
  it('validates list boundaries without a network request', async () => {
    await expect(service.list('invalid')).rejects.toMatchObject({ status: 400 });
    await expect(service.list('oc_group', { threadRootId: 'omt_untrusted' })).rejects.toMatchObject({ status: 400 });
    await expect(service.list('oc_group', { pageToken: '\n' })).rejects.toMatchObject({ status: 400 });
    expect(transport.isInChat).not.toHaveBeenCalled();
  });
});
