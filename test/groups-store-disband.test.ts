/** Group deletion needs an explicit API success acknowledgement. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBotClient: () => ({ im: { v1: { chat: { delete: h.remove } } } }) }));
vi.mock('../src/im/lark/client.js', () => ({}));
import { disbandChat } from '../src/services/groups-store.js';
beforeEach(() => { h.remove.mockReset(); });
describe('disbandChat', () => {
  it('deletes only the requested chat', async () => {
    h.remove.mockResolvedValue({ code: 0 });
    expect(await disbandChat('cli_test', 'oc_test')).toEqual({ ok: true });
    expect(h.remove).toHaveBeenCalledWith({ path: { chat_id: 'oc_test' } });
  });
  it.each([undefined, {}, { code: 230001, msg: 'denied' }])('does not claim success for %j', async result => {
    h.remove.mockResolvedValue(result);
    expect((await disbandChat('cli_test', 'oc_test')).ok).toBe(false);
  });
});
