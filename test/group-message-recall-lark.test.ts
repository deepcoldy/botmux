import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ recall: vi.fn(), read: vi.fn(), list: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({ im: { v1: { message: { delete: mocks.recall } } } }) }));
vi.mock('../src/im/lark/client.js', () => ({ assertLarkTransport: vi.fn(), getMessageDetail: mocks.read, larkGet: mocks.list }));
vi.mock('../src/services/groups-store.js', () => ({ isInChat: async () => true }));
import { createGroupMessageRecallService } from '../src/services/group-message-recall-lark.js';
import { __testOnly_resetLarkGate } from '../src/im/lark/api-gate.js';
import { larkApiError } from '../src/im/lark/lark-errors.js';
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); __testOnly_resetLarkGate();
  mocks.read.mockResolvedValue({ items: [{ message_id: 'om_message', chat_id: 'oc_group', sender: { sender_type: 'app', id: 'cli_bot' } }] });
});
afterEach(() => { vi.useRealTimers(); __testOnly_resetLarkGate(); });
it('preserves transient Lark business codes so the real shared gate retries before reporting failure', async () => {
  mocks.recall.mockResolvedValueOnce({ code: 230020, msg: 'per-chat rate limit' }).mockResolvedValue({ code: 0 });
  const result = createGroupMessageRecallService('cli_bot').recall('oc_group', { messageIds: ['om_message'] });
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await result).results).toEqual([{ messageId: 'om_message', ok: true }]);
  expect(mocks.recall).toHaveBeenCalledTimes(2);
});
it.each([false, true])('accepts an already-withdrawn race as success, thrown=%s', async thrown => {
  if (thrown) mocks.recall.mockRejectedValue({ response: { data: { code: 230011 } } });
  else mocks.recall.mockResolvedValue({ code: 230011 });
  const result = await createGroupMessageRecallService('cli_bot').recall('oc_group', { messageIds: ['om_message'] });
  expect(result.results).toEqual([{ messageId: 'om_message', ok: true }]);
  expect(mocks.recall).toHaveBeenCalledTimes(1);
});
it.each([
  larkApiError('get message', { code: 230011, msg: 'msg withdrawn' }),
  { response: { data: { code: 230011 } } },
])('settles an already-withdrawn read without deleting or blocking later messages: %j', async error => {
  const service = createGroupMessageRecallService('cli_bot');
  mocks.read.mockRejectedValueOnce(error);
  mocks.recall.mockResolvedValue({ code: 0 });
  const result = await service.recall('oc_group', { messageIds: ['om_withdrawn', 'om_message'] });
  expect(result).toEqual({ ok: true, results: [
    { messageId: 'om_withdrawn', ok: true, alreadyRecalled: true }, { messageId: 'om_message', ok: true },
  ] });
  expect(mocks.recall).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'om_message' } });
  mocks.read.mockRejectedValueOnce(error);
  mocks.recall.mockClear();
  expect(await service.recall('oc_group', { messageIds: ['om_withdrawn'] })).toEqual({
    ok: true, results: [{ messageId: 'om_withdrawn', ok: true, alreadyRecalled: true }],
  });
  expect(mocks.recall).not.toHaveBeenCalled();
});
it('keeps other read failures as failures and continues the batch', async () => {
  mocks.read.mockRejectedValueOnce(larkApiError('get message', { code: 230001, msg: 'invalid message id' }));
  mocks.recall.mockResolvedValue({ code: 0 });
  const result = await createGroupMessageRecallService('cli_bot').recall('oc_group', { messageIds: ['om_invalid', 'om_message'] });
  expect(result.ok).toBe(false);
  expect(result.results[0]).toMatchObject({ messageId: 'om_invalid', ok: false });
  expect(result.results[0].error).toContain('230001');
  expect(result.results[1]).toEqual({ messageId: 'om_message', ok: true });
  expect(mocks.recall).toHaveBeenCalledExactlyOnceWith({ path: { message_id: 'om_message' } });
});
