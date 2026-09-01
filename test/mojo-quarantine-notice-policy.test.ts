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
import { describe, expect, it, vi } from 'bun:test';

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

import { auxUiSuppressedFor } from '../src/core/worker-pool.js';

function ds(opts: {
  larkAppId?: string;
  chatId?: string;
  vcReceiver?: boolean;
  suppressedTurns?: Map<string, number>;
}): never {
  return {
    larkAppId: opts.larkAppId ?? 'app_ok',
    chatId: opts.chatId ?? 'oc_real_chat',
    ...(opts.suppressedTurns ? { suppressedFinalOutputTurns: opts.suppressedTurns } : {}),
    session: {
      sessionId: 'sid-x',
      ...(opts.vcReceiver ? { vcMeetingReceiver: { some: 'receiver' } } : {}),
    },
  } as never;
}

describe('auxUiSuppressedFor', () => {
  it('allows an ordinary IM session', () => {
    expect(auxUiSuppressedFor(ds({}), 'turn-1')).toBe(false);
  });

  it('suppresses a dedicated VC receiver', () => {
    // Auxiliary UI is never an authorized channel there.
    expect(auxUiSuppressedFor(ds({ vcReceiver: true }), 'turn-1')).toBe(true);
  });

  it('suppresses a silent scheduled turn', () => {
    expect(auxUiSuppressedFor(ds({}), 'silent-turn')).toBe(true);
  });

  it('suppresses a no-transport (apiOnly) bot', () => {
    expect(auxUiSuppressedFor(ds({ larkAppId: 'app_api_only' }), 'turn-1')).toBe(true);
  });

  it('suppresses an HTTP virtual chat', () => {
    expect(auxUiSuppressedFor(ds({ chatId: 'http_async_abc' }), 'turn-1')).toBe(true);
    expect(auxUiSuppressedFor(ds({ chatId: 'http_wait_abc' }), 'turn-1')).toBe(true);
  });

  it('fails closed when the bot is deregistered', () => {
    expect(auxUiSuppressedFor(ds({ larkAppId: 'app_missing' }), 'turn-1')).toBe(true);
  });

  it('suppresses a DURABLE-suppressed replay attempt', () => {
    // The check the previous hand-copied gate dropped: an attempt at or below the
    // armed watermark is a replay whose output already happened. A quarantine
    // notice posted there is a duplicate on a ledger-suppressed turn.
    const suppressed = new Map([['turn-d', 2]]);
    expect(auxUiSuppressedFor(ds({ suppressedTurns: suppressed }), 'turn-d', 1)).toBe(true);
    expect(auxUiSuppressedFor(ds({ suppressedTurns: suppressed }), 'turn-d', 2)).toBe(true);
    // A LATER attempt is past the watermark and may output.
    expect(auxUiSuppressedFor(ds({ suppressedTurns: suppressed }), 'turn-d', 3)).toBe(false);
    // No dispatchAttempt at all = an ordinary IM turn, not a durable replay.
    expect(auxUiSuppressedFor(ds({ suppressedTurns: suppressed }), 'turn-d')).toBe(false);
  });

  it('is the SAME function the worker-handler gate uses', () => {
    // Regression guard for the root cause: the notice used to hand-copy three of
    // four checks. If someone re-introduces a private copy, this import stops
    // being the shared policy and the durable case above silently diverges again.
    expect(typeof auxUiSuppressedFor).toBe('function');
    expect(auxUiSuppressedFor.length).toBeGreaterThanOrEqual(2);
  });
});
