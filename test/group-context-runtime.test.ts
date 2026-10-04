import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const network = vi.hoisted(() => ({ history: vi.fn(), thread: vi.fn(), download: vi.fn() }));
vi.mock('../src/im/lark/client.js', () => ({
  listChatMessagesUntil: network.history,
  listThreadMessages: network.thread,
  downloadMessageResource: network.download,
  getMessageDetail: vi.fn(),
}));
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { _resetGroupContextStoreForTest, getGroupContextMessage, upsertGroupContextMessage } from '../src/services/group-context-store.js';
import { prepareGroupContextForTurn, observePublishedGroupMessage } from '../src/services/group-context-runtime.js';

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'group-context-runtime-'));
  previous = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dir;
  _resetGroupContextStoreForTest();
  network.history.mockReset(); network.thread.mockReset(); network.download.mockReset();
  network.thread.mockResolvedValue([]);
  await setGroupContextSettings('oc_room', { enabled: true });
});
afterEach(() => {
  _resetGroupContextStoreForTest();
  if (previous === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe('group context platform integration', () => {
  it('loads user and peer replies automatically using this app’s access', async () => {
    const now = Date.now();
    network.history.mockResolvedValue([
      { message_id: 'om_user', chat_id: 'oc_room', create_time: String(now - 10), msg_type: 'text', sender: { id: 'ou_user', sender_type: 'user', sender_name: 'User' }, body: { content: JSON.stringify({ text: '改成坐船，取消登山' }) } },
      { message_id: 'om_peer', chat_id: 'oc_room', create_time: String(now - 5), msg_type: 'text', sender: { id: 'cli_peer', sender_type: 'app', sender_name: 'Peer' }, body: { content: JSON.stringify({ text: '建议十二点出发，尚未订票' }) } },
    ]);
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '最终计划' });
    expect(value?.body).toContain('取消登山');
    expect(value?.body).toContain('尚未订票');
    expect(value?.body).toContain('Peer');
    expect(network.history.mock.calls[0][0]).toBe('cli_b');
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_peer')?.senderType).toBe('bot');
  });

  it('records successful published messages even when the platform sends no self echo', () => {
    observePublishedGroupMessage('cli_b', {
      message_id: 'om_sent', chat_id: 'oc_room', create_time: String(Date.now()),
      msg_type: 'text', body: { content: JSON.stringify({ text: 'published conclusion' }) },
    });
    const record = getGroupContextMessage('cli_b', 'oc_room', 'om_sent');
    expect(record?.text).toBe('published conclusion');
    expect(record?.senderType).toBe('bot');
  });

  it('does not collect outbound messages from a disabled group', () => {
    observePublishedGroupMessage('cli_b', { message_id: 'om_sent', chat_id: 'oc_other', msg_type: 'text', body: { content: '{"text":"not collected"}' } });
    expect(getGroupContextMessage('cli_b', 'oc_other', 'om_sent')).toBeUndefined();
  });

  it('automatically retrieves the current thread in addition to group background', async () => {
    network.history.mockResolvedValue([]);
    network.thread.mockResolvedValue([{ message_id: 'om_peer', root_id: 'om_root', create_time: String(Date.now() - 2), msg_type: 'text', sender: { id: 'cli_peer', sender_type: 'app' }, body: { content: '{"text":"thread-only answer"}' } }]);
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', rootId: 'om_root', turnId: 'om_next', createTime: Date.now(), query: '对一下' });
    expect(value?.body).toContain('thread-only answer');
    expect(network.thread).toHaveBeenCalledWith('cli_b', 'oc_room', 'om_root', expect.any(Number));
  });

  it('does not attribute an unknown history sender to the observing bot', async () => {
    network.history.mockResolvedValue([{ message_id: 'om_unknown', create_time: String(Date.now() - 2), msg_type: 'text', body: { content: '{"text":"unattributed"}' } }]);
    await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: Date.now(), query: '总结' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_unknown')).toMatchObject({ senderId: '', senderType: 'unknown' });
  });

  it('cuts off the first real zero-based unversioned edit arriving after the request', async () => {
    network.history.mockResolvedValue([]);
    const now = Date.now() - 1000;
    const source = { messageId: 'om_choice', chatId: 'oc_room', senderId: 'ou_user', senderType: 'user' as const, msgType: 'text', text: 'keep lake', createTime: now, resourceRefs: [], sourceAppId: 'cli_b' };
    expect(upsertGroupContextMessage('cli_b', source, { now: now + 20 }).revision).toBe(0);
    expect(upsertGroupContextMessage('cli_b', { ...source, text: 'future edit mountain' }, { now: now + 500 }).revision).toBe(1);
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now + 100, query: '总结' });
    expect(value?.body).toContain('keep lake');
    expect(value?.body).not.toContain('future edit mountain');
    expect(value?.incomplete).toBe(true);
  });

  it('uses a completed history scan as a warm backfill boundary, not the current message head', async () => {
    network.history.mockResolvedValue([]);
    await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_first', createTime: Date.now(), query: 'first' });
    await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_second', createTime: Date.now(), query: 'second' });
    const options = network.history.mock.calls[1][2];
    expect(options.stopAfter({ create_time: String(Date.now() - 600_000) }, 50)).toBe(true);
  });
  it('keeps the newest decision when a burst crosses the configured retention row limit', async () => {
    await setGroupContextSettings('oc_room', { enabled: true, maxMessages: 100 });
    network.history.mockResolvedValue([]);
    const now = Date.now();
    for (let i = 0; i < 105; i++) upsertGroupContextMessage('cli_b', {
      messageId: `om_${i}`, chatId: 'oc_room', senderId: 'ou_user', senderType: 'user',
      msgType: 'text', text: `decision ${i}`, createTime: now - 200 + i, resourceRefs: [], sourceAppId: 'cli_b',
    });
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: 'decision 104' });
    expect(value?.body).toContain('decision 104');
    expect(value?.incomplete).toBe(true);
  });
});
