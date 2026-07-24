/**
 * resolveSender's message.get fallback (B 方案).
 *
 * The live-event path only carries a sender open_id, so `<sender>` tag names
 * come from best-effort resolution. Order: cache/hint → contact API (users
 * only, needs scope) → message.get(with_sender_name=true) as last resort. The
 * message fallback covers what contact can't: bots, missing/out-of-range
 * contact scope. It only fires when a `messageId` hint is supplied AND the
 * earlier steps produced no name, so the happy path (cache hit) never pays an
 * extra API round-trip.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMessageDetail = vi.fn();
const larkGet = vi.fn();

vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: (...a: unknown[]) => getMessageDetail(...a),
  larkGet: (...a: unknown[]) => larkGet(...a),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({}),
}));

vi.mock('../src/config.js', () => ({
  config: { session: { dataDir: '/tmp/botmux-identity-test' } },
}));

import { resolveSender } from '../src/im/lark/identity-cache.js';

const APP = 'cli_identity_test';

describe('resolveSender message.get fallback', () => {
  beforeEach(() => {
    getMessageDetail.mockReset();
    larkGet.mockReset();
    // contact API miss by default so the fallback path is exercised for users.
    larkGet.mockResolvedValue({ code: 0, data: { user: {} } });
  });

  it('resolves a bot sender name via message.get when contact cannot (bots skip contact)', async () => {
    getMessageDetail.mockResolvedValue({
      items: [{ sender: { sender_name: 'Premium(Claude)' } }],
    });
    const s = await resolveSender(APP, 'ou_bot_1', 'app', { messageId: 'om_1' });
    expect(s).toMatchObject({ openId: 'ou_bot_1', type: 'bot', name: 'Premium(Claude)' });
    // Bots never hit the contact API; only the message fallback ran.
    expect(larkGet).not.toHaveBeenCalled();
    expect(getMessageDetail).toHaveBeenCalledOnce();
  });

  it('falls back to message.get for a user when contact yields no name', async () => {
    getMessageDetail.mockResolvedValue({
      items: [{ sender: { sender_name: '杨志发' } }],
    });
    const s = await resolveSender(APP, 'ou_user_1', 'user', { messageId: 'om_2' });
    expect(s).toMatchObject({ type: 'user', name: '杨志发' });
    expect(getMessageDetail).toHaveBeenCalledOnce();
  });

  it('caches the resolved name so a later resolve needs no second fetch', async () => {
    getMessageDetail.mockResolvedValue({
      items: [{ sender: { sender_name: '杨志发' } }],
    });
    await resolveSender(APP, 'ou_user_cache', 'user', { messageId: 'om_3' });
    getMessageDetail.mockClear();
    const s2 = await resolveSender(APP, 'ou_user_cache', 'user', { messageId: 'om_3b' });
    expect(s2?.name).toBe('杨志发');
    expect(getMessageDetail).not.toHaveBeenCalled();
  });

  it('does not call message.get when no messageId hint is supplied', async () => {
    const s = await resolveSender(APP, 'ou_no_hint', 'app');
    expect(s).toMatchObject({ type: 'bot', name: undefined });
    expect(getMessageDetail).not.toHaveBeenCalled();
  });

  it('does not call message.get when a name is already known via hint', async () => {
    const s = await resolveSender(APP, 'ou_hinted', 'app', { name: 'KnownBot', messageId: 'om_4' });
    expect(s?.name).toBe('KnownBot');
    expect(getMessageDetail).not.toHaveBeenCalled();
  });

  it('degrades silently to undefined name when message.get has no sender_name', async () => {
    getMessageDetail.mockResolvedValue({ items: [{ sender: {} }] });
    const s = await resolveSender(APP, 'ou_blank', 'app', { messageId: 'om_5' });
    expect(s).toMatchObject({ type: 'bot', name: undefined });
    expect(getMessageDetail).toHaveBeenCalledOnce();
  });

  it('degrades silently when message.get throws', async () => {
    getMessageDetail.mockRejectedValue(new Error('boom'));
    const s = await resolveSender(APP, 'ou_err', 'app', { messageId: 'om_6' });
    expect(s).toMatchObject({ type: 'bot', name: undefined });
  });
});
