/**
 * resolveSender's message.get fallback (B 方案).
 *
 * The live-event path only carries a sender open_id, so `<sender>` tag names
 * come from best-effort resolution. Order: cache/hint → contact API (users
 * only, needs scope) → message.get(with_sender_name=true) as last resort. The
 * message fallback covers what contact can't: bots, missing/out-of-range
 * contact scope, AND a contact lookup that hangs/times out. It only fires when
 * a `messageId` hint is supplied AND the earlier steps produced no name, so the
 * happy path (cache hit) never pays an extra API round-trip.
 *
 * Each step keeps its own `RESOLVE_BUDGET_MS` timeout on purpose: a *single*
 * shared deadline would let a hung contact lookup consume the whole budget and
 * starve the message.get fallback — which is exactly the "contact 首查超时"
 * case the PR exists to cover. The ~1.6s worst case (both APIs slow) is an
 * accepted, non-blocking tradeoff; losing fallback coverage is not.
 *
 * Each test runs against a unique on-disk cache dir (mkdtemp) so a real flush
 * can't leak an `identities-*.json` file into the next run and silently short-
 * circuit the "fallback actually fires" / "cache hit skips fetch" assertions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getMessageDetail = vi.fn();
const larkGet = vi.fn();
// Mutable so beforeEach can repoint the identity cache at a fresh temp dir.
const mockConfig = vi.hoisted(() => ({ session: { dataDir: '' } }));

vi.mock('../src/im/lark/client.js', () => ({
  getMessageDetail: (...a: unknown[]) => getMessageDetail(...a),
  larkGet: (...a: unknown[]) => larkGet(...a),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({}),
}));

vi.mock('../src/config.js', () => ({
  config: mockConfig,
}));

import { resolveSender, flushIdentityCacheSync } from '../src/im/lark/identity-cache.js';

const APP = 'cli_identity_test';

describe('resolveSender message.get fallback', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-identity-test-'));
    mockConfig.session.dataDir = dataDir;
    getMessageDetail.mockReset();
    larkGet.mockReset();
    // contact API miss by default so the fallback path is exercised for users.
    larkGet.mockResolvedValue({ code: 0, data: { user: {} } });
  });

  afterEach(() => {
    // Restore real timers (only the contact-timeout test swaps them in) and
    // clear the module-level flush debounce so it can't fire into the next
    // test's dir.
    vi.useRealTimers();
    flushIdentityCacheSync();
    rmSync(dataDir, { recursive: true, force: true });
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

  it('still falls back to message.get after a hung contact lookup times out (PR core case)', async () => {
    vi.useFakeTimers();
    // contact.v3.user.get never settles → its per-step withTimeout must trip at
    // RESOLVE_BUDGET_MS. The message.get fallback MUST still run afterwards; a
    // shared/total deadline that let contact eat the whole budget would starve
    // it, silently dropping the exact "contact 首查超时" case the PR targets.
    larkGet.mockImplementation(() => new Promise(() => {}));
    getMessageDetail.mockResolvedValue({
      items: [{ sender: { sender_name: '杨志发' } }],
    });

    const p = resolveSender(APP, 'ou_slow_contact', 'user', { messageId: 'om_slow' });
    // Trip the contact-step timeout (RESOLVE_BUDGET_MS = 800ms).
    await vi.advanceTimersByTimeAsync(800);
    const s = await p;

    expect(larkGet).toHaveBeenCalled();
    expect(getMessageDetail).toHaveBeenCalledOnce();
    expect(s).toMatchObject({ type: 'user', name: '杨志发' });
  });
});
