import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const network = vi.hoisted(() => ({ history: vi.fn(), thread: vi.fn(), threadContext: vi.fn(), byThreadId: vi.fn(), download: vi.fn(), detail: vi.fn(), update: vi.fn() }));
vi.mock('../src/im/lark/client.js', () => ({
  listChatMessagesUntil: network.history,
  listThreadMessages: network.thread,
  listThreadMessagesWithContext: network.threadContext,
  listMessagesByThreadId: network.byThreadId,
  downloadMessageResource: network.download,
  getMessageDetail: network.detail,
  updateMessage: network.update,
}));
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { _resetGroupContextStoreForTest, getGroupContextMessage, groupContextDbPath, upsertGroupContextMessage } from '../src/services/group-context-store.js';
import { prepareGroupContextForTurn, observePublishedGroupMessage, captureNativeGroupContextInput } from '../src/services/group-context-runtime.js';
import { bindGroupContextDelivery, confirmGroupContextDelivery, getDeliveredGroupContextSeqs, writePreparedGroupContext } from '../src/services/group-context-delivery-store.js';
import { markGroupContextCardPurpose } from '../src/im/lark/group-context-card.js';
import { ingestGroupContextEvent, setGroupContextSettingsResolver } from '../src/services/group-context-ingest.js';
import { patchPublishedGroupCard } from '../src/services/group-context-publication.js';

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'group-context-runtime-'));
  previous = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = dir;
  _resetGroupContextStoreForTest();
  network.history.mockReset(); network.thread.mockReset(); network.download.mockReset(); network.detail.mockReset();
  network.thread.mockResolvedValue([]);
  network.threadContext.mockReset().mockImplementation(async () => ({ messages: await network.thread(), verifiedThread: true, threadId: 'omt_current' }));
  network.byThreadId.mockReset().mockResolvedValue([]);
  network.update.mockReset().mockResolvedValue({});
  setGroupContextSettingsResolver(() => ({ enabled: true }));
  await setGroupContextSettings('oc_room', { enabled: true });
});
afterEach(() => {
  vi.useRealTimers();
  _resetGroupContextStoreForTest();
  setGroupContextSettingsResolver(undefined);
  if (previous === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe('group context platform integration', () => {
  it('distinguishes authoritative main-chat history from incomplete publication receipts', async () => {
    const now = Date.now();
    const history = { message_id: 'om_quote', root_id: 'om_quoted', chat_id: 'oc_room', create_time: String(now - 5), msg_type: 'text', body: { content: '{"text":"main quote"}' } };
    network.history.mockResolvedValue([history]);
    await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_now', createTime: now, query: 'continue' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_quote')).toMatchObject({ conversationScope: 'main' });
    observePublishedGroupMessage('cli_b', { ...history, message_id: 'om_unproven' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_unproven')?.conversationScope).toBeUndefined();
  });

  it('uses native thread-container proof when API rows omit all topic identifiers', async () => {
    const now = Date.now();
    network.history.mockResolvedValue([]);
    network.byThreadId.mockResolvedValue([{ message_id: 'om_topic_reply', create_time: String(now - 5), msg_type: 'text', body: { content: '{"text":"topic content"}' } }]);
    await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', rootId: 'om_topic_root', threadId: 'omt_native', turnId: 'om_now', createTime: now, query: 'continue' });
    expect(network.byThreadId).toHaveBeenCalledWith('cli_b', 'omt_native', 100);
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_topic_reply')).toMatchObject({ conversationScope: 'thread', rootId: 'om_topic_root', threadId: 'omt_native' });
  });

  it('does not certify root-only fallback history as a topic', async () => {
    const now = Date.now();
    network.history.mockResolvedValue([]);
    network.threadContext.mockResolvedValue({ verifiedThread: false, messages: [{ message_id: 'om_ambiguous', root_id: 'om_root', create_time: String(now - 5), msg_type: 'text', body: { content: '{"text":"ambiguous reply"}' } }] });
    const prepared = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', rootId: 'om_root', turnId: 'om_now', createTime: now, query: 'continue' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_ambiguous')).toMatchObject({ rootId: 'om_root' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_ambiguous')?.conversationScope).toBeUndefined();
    expect(prepared?.incomplete).toBe(true);
  });

  it('inherits topic provenance for an acknowledged card patch without native identifiers', () => {
    const base = { message_id: 'om_patch', chat_id: 'oc_room', msg_type: 'text', body: { content: '{"text":"first"}' } };
    observePublishedGroupMessage('cli_b', { ...base, root_id: 'om_root', thread_id: 'omt_native' });
    observePublishedGroupMessage('cli_b', { ...base, body: { content: '{"text":"edited"}' } });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_patch')).toMatchObject({ text: 'edited', conversationScope: 'thread', rootId: 'om_root', threadId: 'omt_native' });
  });

  it('keeps the published card destination when its patch caller supplies a routing anchor', async () => {
    const content = JSON.stringify({ elements: [{ tag: 'markdown', content: 'card answer' }] });
    upsertGroupContextMessage('cli_b', { messageId: 'om_card', chatId: 'oc_room', rootId: 'om_root', threadId: 'omt_native', conversationScope: 'thread', senderId: 'cli_b', senderType: 'bot', msgType: 'interactive', text: 'old card', createTime: Date.now() - 5 });
    await patchPublishedGroupCard('cli_b', 'oc_room', 'om_card', content, 'oc_room');
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_card')).toMatchObject({ rootId: 'om_root', threadId: 'omt_native', conversationScope: 'thread' });
  });

  it('recovers a legacy card root from older revisions instead of a patch caller routing anchor', async () => {
    const base = { messageId: 'om_legacy_card', chatId: 'oc_room', rootId: 'om_root', threadId: 'omt_native', conversationScope: 'thread' as const, senderId: 'cli_b', senderType: 'bot' as const, msgType: 'interactive', text: 'original', createTime: Date.now() - 5 };
    upsertGroupContextMessage('cli_b', base);
    upsertGroupContextMessage('cli_b', { ...base, text: 'legacy revision' });
    const { openDatabaseSyncOrThrow } = await import('../src/services/sqlite-compat.js');
    const db = openDatabaseSyncOrThrow(groupContextDbPath('cli_b'));
    try {
      db.prepare('UPDATE messages SET root_id = NULL, thread_id = NULL, conversation_scope = NULL WHERE message_id = ? AND revision = 1').run(base.messageId);
    } finally { db.close(); }
    const content = JSON.stringify({ elements: [{ tag: 'markdown', content: 'new card answer' }] });
    await patchPublishedGroupCard('cli_b', 'oc_room', base.messageId, content, 'oc_room');
    expect(getGroupContextMessage('cli_b', 'oc_room', base.messageId)).toMatchObject({ rootId: 'om_root', threadId: 'omt_native', conversationScope: 'thread' });
  });

  it('retains parent-only publication evidence and withholds unknown replies from main context', async () => {
    const now = Date.now();
    observePublishedGroupMessage('cli_b', { message_id: 'om_sparse_reply', chat_id: 'oc_room', parent_id: 'om_unknown_target', create_time: String(now - 5), msg_type: 'text', body: { content: '{"text":"UNKNOWN_SPARSE_REPLY"}' } });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_sparse_reply')).toMatchObject({ parentId: 'om_unknown_target', conversationScope: undefined, rootId: undefined });
    network.history.mockResolvedValue([]);
    const prepared = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_now', createTime: now, query: 'continue', scope: 'main' });
    expect(prepared?.body).not.toContain('UNKNOWN_SPARSE_REPLY');
  });

  it('keeps verified main quotes with parent-only metadata in main context', async () => {
    const now = Date.now();
    observePublishedGroupMessage('cli_b', { message_id: 'om_main_quote', chat_id: 'oc_room', parent_id: 'om_main_target', create_time: String(now - 5), msg_type: 'text', body: { content: '{"text":"VERIFIED_MAIN_QUOTE"}' } }, undefined, { conversationScope: 'main' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_main_quote')).toMatchObject({ parentId: 'om_main_target', conversationScope: 'main' });
    network.history.mockResolvedValue([]);
    const prepared = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_now', createTime: now, query: 'continue', scope: 'main' });
    expect(prepared?.body).toContain('VERIFIED_MAIN_QUOTE');
  });

  it('prepares fresh bounded history for the same turn retried in a different native epoch', async () => {
    const now = Date.now();
    const row = upsertGroupContextMessage('cli_b', { messageId: 'om_peer', chatId: 'oc_room', conversationScope: 'main', senderId: 'cli_a', senderType: 'bot', msgType: 'text', text: 'PEER_HISTORY', createTime: now - 10, resourceRefs: [], sourceAppId: 'cli_b' });
    const prime = { appId: 'cli_b', chatId: 'oc_room', turnId: 'om_prime', sessionId: 'session', epoch: 'native_a' };
    writePreparedGroupContext({ ...prime, createdAt: now, body: 'PEER_HISTORY', includedSeqs: [row.seq], throughSeq: row.seq, incomplete: false });
    bindGroupContextDelivery(prime); confirmGroupContextDelivery(prime);
    network.history.mockResolvedValue([]);
    const request = { ...prime, turnId: 'om_same_request', createTime: now + 10, query: 'continue' };
    const original = await prepareGroupContextForTurn(request);
    expect(original?.body).toBe('');
    const replacement = await prepareGroupContextForTurn({ ...request, epoch: 'native_b' });
    expect(replacement?.body).toContain('PEER_HISTORY');
    expect(replacement?.includedSeqs).toEqual([row.seq]);
    const originalRetry = await prepareGroupContextForTurn(request);
    expect(originalRetry?.body).toBe('');
  });
  it('does not attribute a later external edit back to the same text to an older native ACK', () => {
    const now = Date.now();
    const binding = { appId: 'cli_b', chatId: 'oc_room', turnId: 'om_native', sessionId: 'sess', epoch: 'native_one' };
    writePreparedGroupContext({ ...binding, createdAt: now, body: '', includedSeqs: [], throughSeq: 0, incomplete: false });
    bindGroupContextDelivery(binding);
    const message = (text: string, offset: number) => ({ message_id: 'om_reedited', chat_id: 'oc_room', create_time: String(now - 400), update_time: String(now - offset), msg_type: 'text', body: { content: JSON.stringify({ text }) } });
    observePublishedGroupMessage('cli_b', message('A', 300));
    observePublishedGroupMessage('cli_b', message('B', 200));
    observePublishedGroupMessage('cli_b', message('A', 100));
    const externalRevision = getGroupContextMessage('cli_b', 'oc_room', 'om_reedited')!.seq;
    observePublishedGroupMessage('cli_b', message('A', 300), binding);
    confirmGroupContextDelivery(binding);
    expect(getDeliveredGroupContextSeqs('cli_b', 'oc_room', 'sess', 'native_one')).not.toContain(externalRevision);
  });
  it('freezes native input identity and suppresses its own published answer after completion', async () => {
    const now = Date.now();
    const data = { sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } }, message: {
      message_id: 'om_native', chat_id: 'oc_room', chat_type: 'group', message_type: 'text', create_time: String(now - 10), content: JSON.stringify({ text: 'original native input' }),
    } };
    ingestGroupContextEvent('cli_b', data);
    const nativeInputSeqs = captureNativeGroupContextInput('cli_b', data);
    expect(nativeInputSeqs).toHaveLength(1);
    network.history.mockResolvedValue([]);
    const binding = { appId: 'cli_b', chatId: 'oc_room', turnId: 'om_native', sessionId: 'sess', epoch: 'native_one' };
    await prepareGroupContextForTurn({ ...binding, createTime: now, query: 'original native input', nativeInputSeqs });
    bindGroupContextDelivery(binding);
    observePublishedGroupMessage('cli_b', { message_id: 'om_native_answer', chat_id: 'oc_room', create_time: String(now), msg_type: 'text', body: { content: JSON.stringify({ text: 'own native answer' }) } }, binding);
    expect(getDeliveredGroupContextSeqs('cli_b', 'oc_room', 'sess', 'native_one')).toEqual([]);
    expect(confirmGroupContextDelivery(binding)).toBe(true);
    const next = await prepareGroupContextForTurn({ ...binding, turnId: 'om_next', createTime: now + 10, query: 'continue' });
    expect(next?.body).toBe('');
    ingestGroupContextEvent('cli_b', { ...data, message: { ...data.message, update_time: String(now + 11), content: JSON.stringify({ text: 'edited native input' }) } });
    expect(captureNativeGroupContextInput('cli_b', data)).toEqual([]);
    const afterEdit = await prepareGroupContextForTurn({ ...binding, turnId: 'om_after_edit', createTime: now + 20, query: 'continue' });
    expect(afterEdit?.body).toContain('edited native input');
    expect(afterEdit?.body).not.toContain('own native answer');
  });
  it('filters published runtime cards and projects final body with only authored resources', () => {
    const base = { schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '💭 **处理中 · 12.0s**' },
      { tag: 'markdown', content: 'PUBLIC_RESULT' },
      { tag: 'div', element_id: 'botmux_turn_process', elements: [
        { tag: 'markdown', content: 'PROCESS_LOG' }, { tag: 'img', img_key: 'process_img' },
      ] },
      { tag: 'img', img_key: 'authored_img' },
    ] } };
    const publish = (purpose: 'runtime' | 'turn-message') => observePublishedGroupMessage('cli_b', {
      message_id: 'om_unified', chat_id: 'oc_room', msg_type: 'interactive',
      body: { content: JSON.stringify(markGroupContextCardPurpose(base, purpose)) },
    });
    publish('runtime');
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_unified')).toBeUndefined();
    publish('turn-message');
    const row = getGroupContextMessage('cli_b', 'oc_room', 'om_unified');
    expect(row).toMatchObject({ cardContentVersion: 1 });
    expect(row?.text).toContain('PUBLIC_RESULT');
    expect(row?.text).not.toMatch(/PROCESS_LOG|处理中/);
    expect(row?.resourceRefs.map(ref => ref.key)).toEqual(['authored_img']);
  });

  it('rehydrates flattened unified cards from structured details without merging process text', async () => {
    const now = Date.now();
    const flattened = JSON.stringify(markGroupContextCardPurpose({ elements: [[{ tag: 'text', text: 'FLATTENED_PROCESS' }]] }, 'turn-message'));
    const structured = JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成 · 12.0s**' },
      { tag: 'markdown', content: 'STRUCTURED_ANSWER' },
      { tag: 'markdown', element_id: 'botmux_turn_process', content: 'STRUCTURED_PROCESS' },
    ] } }, 'turn-message'));
    network.history.mockResolvedValue([{ message_id: 'om_merged', chat_id: 'oc_room', create_time: String(now - 100),
      update_time: String(now - 100), msg_type: 'interactive', sender: { id: 'cli_peer', sender_type: 'app' }, body: { content: flattened } }]);
    network.detail.mockImplementation(async (_app, _id, options) => ({ items: [{ update_time: String(now - 1),
      body: { content: options.userCardContent ? structured : flattened } }] }));
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '总结' });
    expect(value?.body).toContain('STRUCTURED_ANSWER');
    expect(value?.body).not.toMatch(/FLATTENED_PROCESS|STRUCTURED_PROCESS|已完成/);
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_merged')).toMatchObject({ cardContentVersion: 1, updateTime: now - 1 });
  });

  it('excludes a card completed after the triggering message even if the list had an old timestamp', async () => {
    const now = Date.now();
    const flattened = JSON.stringify(markGroupContextCardPurpose({ elements: [[{ tag: 'text', text: 'OLD_PROCESS' }]] }, 'turn-message'));
    const final = JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成 · 12.0s**' },
      { tag: 'markdown', content: 'FUTURE_ANSWER' },
    ] } }, 'turn-message'));
    network.history.mockResolvedValue([{ message_id: 'om_future', chat_id: 'oc_room', create_time: String(now - 100),
      update_time: String(now - 100), msg_type: 'interactive', sender: { id: 'cli_peer', sender_type: 'app' }, body: { content: flattened } }]);
    network.detail.mockResolvedValue({ items: [{ update_time: String(now + 100), body: { content: final } }] });
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '总结' });
    expect(value?.body ?? '').not.toMatch(/FUTURE_ANSWER|OLD_PROCESS/);
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_future')?.updateTime).toBe(now + 100);
  });

  it('withholds an unversioned turn answer first seen after the trigger, then shares it on the next turn', async () => {
    const now = Date.now();
    const content = JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成 · 12.0s**' },
      { tag: 'markdown', content: 'UNVERSIONED_FINAL' },
    ] } }, 'turn-message'));
    network.history.mockResolvedValue([{ message_id: 'om_no_version', chat_id: 'oc_room', create_time: String(now - 100),
      msg_type: 'interactive', sender: { id: 'cli_peer', sender_type: 'app' }, body: { content } }]);
    const first = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_first', createTime: now - 1, query: '总结' });
    expect(first?.body ?? '').not.toContain('UNVERSIONED_FINAL');
    const version = getGroupContextMessage('cli_b', 'oc_room', 'om_no_version')?.cardObservedAt;
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_no_version')?.updateTime).toBeUndefined();
    expect(version).toBeGreaterThan(now - 1);
    const next = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_second', createTime: Date.now() + 10, query: '总结' });
    expect(next?.body).toContain('UNVERSIONED_FINAL');
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_no_version')?.cardObservedAt).toBe(version);
  });

  it('invalidates the local cache when same-text authoritative projection certifies an old row', async () => {
    const now = Date.now();
    const text = '💭 **处理中 · 12.0s**\nThis is an intentional quoted status example';
    upsertGroupContextMessage('cli_b', { messageId: 'om_cached', chatId: 'oc_room', senderId: 'cli_b', senderType: 'bot',
      msgType: 'interactive', text, createTime: now - 100, updateTime: now - 100, resourceRefs: [], sourceAppId: 'cli_b' });
    network.history.mockResolvedValue([]);
    const first = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_first', createTime: now, query: '总结' });
    expect(first?.body).not.toContain('intentional quoted');
    const seq = getGroupContextMessage('cli_b', 'oc_room', 'om_cached')?.seq;
    ingestGroupContextEvent('cli_b', { sender: { sender_id: { app_id: 'cli_b' }, sender_type: 'app' }, message: {
      message_id: 'om_cached', chat_id: 'oc_room', chat_type: 'group', create_time: String(now - 100), update_time: String(now - 50), message_type: 'interactive',
      content: JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: text }] } }, 'message')) } });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_cached')?.seq).toBe(seq);
    const second = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_second', createTime: now + 100, query: '总结' });
    expect(second?.body).toContain('intentional quoted');
  });

  it('does not compare the local observation bound with a later authoritative platform revision', () => {
    const now = Date.now();
    const card = (text: string) => JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [
      { tag: 'markdown', element_id: 'botmux_turn_status', content: '✅ **已完成 · 12.0s**' }, { tag: 'markdown', content: text },
    ] } }, 'turn-message'));
    observePublishedGroupMessage('cli_b', { message_id: 'om_clock', chat_id: 'oc_room', create_time: String(now - 100),
      msg_type: 'interactive', body: { content: card('OLD_BODY') } });
    observePublishedGroupMessage('cli_b', { message_id: 'om_clock', chat_id: 'oc_room', create_time: String(now - 100),
      update_time: String(now - 10), msg_type: 'interactive', body: { content: card('NEW_BODY') } });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_clock')).toMatchObject({ text: 'NEW_BODY', updateTime: now - 10 });
  });

  it('persists presentation-only tombstones and never replays the recalled answer', async () => {
    const now = Date.now();
    upsertGroupContextMessage('cli_b', {
      messageId: 'om_answer', chatId: 'oc_room', senderId: 'cli_peer', senderType: 'bot',
      msgType: 'text', text: 'RECALLED_ANSWER', createTime: now - 100,
      resourceRefs: [], sourceAppId: 'cli_b',
    });
    network.history.mockResolvedValue([
      { message_id: 'om_answer', chat_id: 'oc_room', create_time: String(now - 100), msg_type: 'text', sender: { id: 'cli_peer', sender_type: 'app' }, deleted: true, body: { content: '{"text":""}' } },
      { message_id: 'om_unseen', chat_id: 'oc_room', create_time: String(now - 50), msg_type: 'text', deleted: true, body: { content: '{"text":""}' } },
      { message_id: 'om_deleted_card', chat_id: 'oc_room', create_time: String(now - 40), msg_type: 'interactive', sender: { id: 'cli_peer', sender_type: 'app' }, deleted: true, body: { content: '{}' } },
      { message_id: 'om_deleted_fallback', chat_id: 'oc_room', create_time: String(now - 30), msg_type: 'interactive', sender: { id: 'cli_peer', sender_type: 'app' }, deleted: true, body: { content: JSON.stringify({ elements: [{ tag: 'markdown', content: '请升级至最新版本客户端，以查看内容' }] }) } },
    ]);
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '总结' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_answer')?.deleted).toBe(true);
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_unseen')?.deleted).toBe(true);
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_deleted_card')?.deleted).toBe(true);
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_deleted_fallback')?.deleted).toBe(true);
    expect(network.detail).not.toHaveBeenCalled();
    expect(value?.body).not.toContain('RECALLED_ANSWER');
    expect(value?.body).toContain('<revoked>');
    expect(value?.body).not.toContain('message_id="om_unseen"');
    observePublishedGroupMessage('cli_b', {
      message_id: 'om_unseen', chat_id: 'oc_room', create_time: String(now - 50),
      msg_type: 'text', body: { content: '{"text":"LATE_ORIGINAL"}' },
    });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_unseen')?.deleted).toBe(true);
  });

  it('keeps a streamed tombstone when later history pages time out', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    network.history.mockImplementation(async (_app, _chat, options) => {
      options.stopAfter({ message_id: 'om_recalled_page', chat_id: 'oc_room', create_time: String(now - 1), msg_type: 'text', deleted: true, body: { content: '{"text":""}' } }, 1);
      return new Promise(() => {});
    });
    const preparing = prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '总结' });
    await vi.advanceTimersByTimeAsync(3100);
    await preparing;
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_recalled_page')?.deleted).toBe(true);
  });

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
    expect(network.threadContext).toHaveBeenCalledWith('cli_b', 'oc_room', 'om_root', expect.any(Number));
  });

  it('does not attribute an unknown history sender to the observing bot', async () => {
    network.history.mockResolvedValue([{ message_id: 'om_unknown', create_time: String(Date.now() - 2), msg_type: 'text', body: { content: '{"text":"unattributed"}' } }]);
    await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: Date.now(), query: '总结' });
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_unknown')).toMatchObject({ senderId: '', senderType: 'unknown' });
  });

  it('cuts off the first real zero-based unversioned edit arriving after the request', async () => {
    network.history.mockResolvedValue([]);
    const now = Date.now() - 1000;
    const source = { messageId: 'om_choice', chatId: 'oc_room', conversationScope: 'main' as const, senderId: 'ou_user', senderType: 'user' as const, msgType: 'text', text: 'keep lake', createTime: now, resourceRefs: [], sourceAppId: 'cli_b' };
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
      conversationScope: 'main', msgType: 'text', text: `decision ${i}`, createTime: now - 200 + i, resourceRefs: [], sourceAppId: 'cli_b',
    });
    const value = await prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: 'decision 104' });
    expect(value?.body).toContain('decision 104');
    expect(value?.incomplete).toBe(true);
  });

  it('keeps fetched user text when optional card enrichment never finishes', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    network.history.mockResolvedValue([
      { message_id: 'om_plain', chat_id: 'oc_room', create_time: String(now - 2), msg_type: 'text', sender: { id: 'ou_user', sender_type: 'user' }, body: { content: '{"text":"latest user decision"}' } },
      { message_id: 'om_card', chat_id: 'oc_room', create_time: String(now - 1), msg_type: 'interactive', sender: { id: 'cli_peer', sender_type: 'app' }, body: { content: JSON.stringify({ elements: [{ tag: 'markdown', content: '请升级至最新版本客户端，以查看内容' }] }) } },
    ]);
    network.detail.mockImplementation(() => new Promise(() => {}));
    const preparing = prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '总结' });
    await vi.advanceTimersByTimeAsync(3100);
    const value = await preparing;
    expect(value?.body).toContain('latest user decision');
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_plain')?.text).toBe('latest user decision');
    expect(value?.incomplete).toBe(true);
  });

  it('keeps the first completed page when a later history page stalls', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    network.history.mockImplementation(async (_app, _chat, options) => {
      options.stopAfter({ message_id: 'om_page_one', chat_id: 'oc_room', create_time: String(now - 2), msg_type: 'text', sender: { id: 'ou_user', sender_type: 'user' }, body: { content: '{"text":"first page decision"}' } }, 1);
      return new Promise(() => {});
    });
    const preparing = prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: '总结' });
    await vi.advanceTimersByTimeAsync(3100);
    expect((await preparing)?.body).toContain('first page decision');
  });

  it('retains the newest decision when streamed descending history exceeds the row cap', async () => {
    await setGroupContextSettings('oc_room', { enabled: true, maxMessages: 100 });
    vi.useFakeTimers();
    const now = Date.now();
    network.history.mockImplementation(async (_app, _chat, options) => {
      for (let i = 104; i >= 0; i--) options.stopAfter({
        message_id: `om_stream_${i}`, chat_id: 'oc_room', create_time: String(now - 200 + i),
        msg_type: 'text', sender: { id: 'ou_user', sender_type: 'user' },
        body: { content: JSON.stringify({ text: `choice ${i}` }) },
      }, 105 - i);
      return new Promise(() => {});
    });
    const preparing = prepareGroupContextForTurn({ appId: 'cli_b', chatId: 'oc_room', turnId: 'om_next', createTime: now, query: 'choice 104' });
    await vi.advanceTimersByTimeAsync(3100);
    expect((await preparing)?.body).toContain('choice 104');
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_stream_104')).toBeDefined();
    expect(getGroupContextMessage('cli_b', 'oc_room', 'om_stream_0')).toBeUndefined();
  });
});
