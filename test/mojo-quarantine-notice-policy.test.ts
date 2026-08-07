/**
 * Output-boundary policy for the mojo quarantine notice.
 *
 * Review found the notice called sessionReply() directly, bypassing the
 * managedAuxUiSuppressed guards every other auxiliary message funnels through: a
 * dedicated VC receiver would post an aux message to Lark, a silent scheduled turn
 * could be "lit up", and a no-transport bot would dial Feishu with nowhere to
 * render.
 *
 * Run:  pnpm vitest run test/mojo-quarantine-notice-policy.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: (id: string) => {
    if (id === 'app_missing') throw new Error('deregistered');
    return { config: { larkAppId: id, apiOnly: id === 'app_api_only' } };
  },
  getAllBots: () => [],
  getOwnerOpenId: () => undefined,
  findOncallChat: () => undefined,
  effectiveDefaultWorkingDir: () => '/tmp',
}));
vi.mock('../src/core/silent-schedule-turns.js', () => ({
  isSilentScheduledTurn: (_ds: unknown, turnId?: string) => turnId === 'silent-turn',
}));

import { mojoAuxNoticeAllowed } from '../src/core/worker-pool.js';

function ds(opts: { larkAppId?: string; chatId?: string; vcReceiver?: boolean }): never {
  return {
    larkAppId: opts.larkAppId ?? 'app_ok',
    chatId: opts.chatId ?? 'oc_real_chat',
    session: {
      sessionId: 'sid-x',
      ...(opts.vcReceiver ? { vcMeetingReceiver: { some: 'receiver' } } : {}),
    },
  } as never;
}

describe('mojoAuxNoticeAllowed', () => {
  it('allows an ordinary IM session', () => {
    expect(mojoAuxNoticeAllowed(ds({}), 'turn-1')).toBe(true);
  });

  it('suppresses a dedicated VC receiver', () => {
    // Auxiliary UI is never an authorized channel there.
    expect(mojoAuxNoticeAllowed(ds({ vcReceiver: true }), 'turn-1')).toBe(false);
  });

  it('suppresses a silent scheduled turn', () => {
    expect(mojoAuxNoticeAllowed(ds({}), 'silent-turn')).toBe(false);
  });

  it('suppresses a no-transport (apiOnly) bot', () => {
    expect(mojoAuxNoticeAllowed(ds({ larkAppId: 'app_api_only' }), 'turn-1')).toBe(false);
  });

  it('suppresses an HTTP virtual chat', () => {
    expect(mojoAuxNoticeAllowed(ds({ chatId: 'http_async_abc' }), 'turn-1')).toBe(false);
    expect(mojoAuxNoticeAllowed(ds({ chatId: 'http_wait_abc' }), 'turn-1')).toBe(false);
  });

  it('fails closed when the bot is deregistered', () => {
    expect(mojoAuxNoticeAllowed(ds({ larkAppId: 'app_missing' }), 'turn-1')).toBe(false);
  });
});
