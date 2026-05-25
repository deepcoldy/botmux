/**
 * Contract tests for the ask broker — covers §3 lifecycle, §6 approver, §7
 * timeout, §8 invalidation. Card dispatch is mocked via a fake AskCardDispatcher
 * so these tests stay IM-agnostic and run in pure node.
 *
 * Run:  pnpm vitest run test/ask-broker.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _getPending,
  _pendingCount,
  _resetForTest,
  invalidateAll,
  registerAsk,
  setCardDispatcher,
  tryResolveAsk,
} from '../src/core/ask-broker.js';
import type {
  AskCardDispatcher,
  AskOption,
  AskResult,
  CreateAskInput,
  PendingAsk,
} from '../src/core/ask-types.js';

const OPTIONS: AskOption[] = [
  { key: 'yes', label: '继续' },
  { key: 'no', label: '回滚' },
];

function makeInput(over: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
    sessionId: 'sess-1',
    approvers: new Set(['ou_owner']),
    options: OPTIONS,
    prompt: '继续发版吗？',
    timeoutMs: 5_000,
    ...over,
  };
}

function mockDispatcher(
  options: {
    send?: AskCardDispatcher['send'];
    onSettle?: AskCardDispatcher['onSettle'];
  } = {},
): AskCardDispatcher & {
  sendCalls: PendingAsk[];
  settleCalls: Array<{ ask: PendingAsk; result: AskResult }>;
} {
  const sendCalls: PendingAsk[] = [];
  const settleCalls: Array<{ ask: PendingAsk; result: AskResult }> = [];
  return {
    async send(ask) {
      sendCalls.push(ask);
      if (options.send) return options.send(ask);
      return { messageId: `om_card_${ask.askId}` };
    },
    onSettle(ask, result) {
      settleCalls.push({ ask, result });
      if (options.onSettle) return options.onSettle(ask, result);
    },
    sendCalls,
    settleCalls,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
});

afterEach(() => {
  vi.useRealTimers();
  _resetForTest();
});

describe('registerAsk happy path', () => {
  it('register → tryResolveAsk("yes") resolves with kind:answered', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);

    const p = registerAsk(makeInput());

    // Card dispatch is async — flush the microtask queue so send() runs
    // and cardMessageId is stored. Use a real-timers slip via Promise.resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(_pendingCount()).toBe(1);
    expect(d.sendCalls).toHaveLength(1);
    const [dispatched] = d.sendCalls;
    expect(dispatched.options).toEqual(OPTIONS);
    expect(dispatched.approvers.has('ou_owner')).toBe(true);

    const outcome = tryResolveAsk({
      askId: dispatched.askId,
      nonce: dispatched.nonce,
      selected: 'yes',
      by: 'ou_owner',
    });
    expect(outcome).toBe('accepted');

    const result = await p;
    expect(result).toEqual({
      kind: 'answered',
      selected: 'yes',
      by: 'ou_owner',
      comment: null,
      timedOut: false,
    });
    expect(_pendingCount()).toBe(0);
    expect(d.settleCalls).toHaveLength(1);
    expect(d.settleCalls[0]!.result.kind).toBe('answered');
  });

  it('captures cardMessageId once dispatcher.send resolves', async () => {
    const d = mockDispatcher({
      send: async () => ({ messageId: 'om_specific_card' }),
    });
    setCardDispatcher(d);

    registerAsk(makeInput());
    // Flush enough microtasks so registerAsk's `dispatcher.send(...).then(...)`
    // chain has run all three hops (caller microtask → send body resolve →
    // .then callback). Four ticks is overkill but cheap.
    for (let i = 0; i < 4; i++) await Promise.resolve();

    const askId = d.sendCalls[0]!.askId;
    const snap = _getPending(askId);
    expect(snap?.cardMessageId).toBe('om_specific_card');
  });
});

describe('tryResolveAsk gating', () => {
  it('returns "stale" for unknown askId', () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    expect(
      tryResolveAsk({
        askId: 'no-such-id',
        nonce: 'xxx',
        selected: 'yes',
        by: 'ou_owner',
      }),
    ).toBe('stale');
  });

  it('returns "stale" for nonce mismatch (covers daemon-restart stale card)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId } = d.sendCalls[0]!;
    expect(
      tryResolveAsk({
        askId,
        nonce: 'wrong-nonce',
        selected: 'yes',
        by: 'ou_owner',
      }),
    ).toBe('stale');
  });

  it('returns "unauthorized" when clicker is not in approver allowlist', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput({ approvers: new Set(['ou_owner']) }));
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    expect(
      tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_stranger' }),
    ).toBe('unauthorized');
    // Ask still pending — caller may have spoofed; broker must not settle.
    expect(_pendingCount()).toBe(1);
  });

  it('returns "stale" when selected key is not in options (defensive)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    expect(
      tryResolveAsk({ askId, nonce, selected: 'maybe', by: 'ou_owner' }),
    ).toBe('stale');
  });

  it('returns "already_settled" for a second click after race winner', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(
      makeInput({ approvers: new Set(['ou_a', 'ou_b']) }),
    );
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;

    expect(
      tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_a' }),
    ).toBe('accepted');
    expect(
      tryResolveAsk({ askId, nonce, selected: 'no', by: 'ou_b' }),
    ).toBe('already_settled');
  });
});

describe('timeout', () => {
  it('settles with kind:timedOut after deadlineMs elapses', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput({ timeoutMs: 1_000 }));
    await Promise.resolve();
    await Promise.resolve();
    expect(_pendingCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    const result = await p;
    expect(result.kind).toBe('timedOut');
    expect(result.timedOut).toBe(true);
    expect(_pendingCount()).toBe(0);
    expect(d.settleCalls[0]!.result.kind).toBe('timedOut');
  });

  it('clicks shortly after timeout return "already_settled" (within retention window)', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput({ timeoutMs: 1_000 }));
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    vi.advanceTimersByTime(1_000);
    await p;

    // Settled entry is retained for SETTLED_RETENTION_MS (60s) so race-losers
    // get the precise "already_settled" outcome, not a generic "stale".
    expect(
      tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_owner' }),
    ).toBe('already_settled');
  });

  it('clicks well past retention window return "stale"', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput({ timeoutMs: 1_000 }));
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    vi.advanceTimersByTime(1_000);
    await p;

    // Push Date.now() past the 60s retention horizon — the settled entry
    // should have been GC'd by the next click attempt.
    vi.advanceTimersByTime(120_000);
    expect(
      tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_owner' }),
    ).toBe('stale');
  });
});

describe('invalidateAll', () => {
  it('settles every pending ask with kind:invalidated and clears registry', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p1 = registerAsk(makeInput({ sessionId: 'sess-a' }));
    const p2 = registerAsk(makeInput({ sessionId: 'sess-b' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(_pendingCount()).toBe(2);

    const count = invalidateAll('daemon shutdown');
    expect(count).toBe(2);
    expect(_pendingCount()).toBe(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('invalidated');
    expect(r2.kind).toBe('invalidated');
    if (r1.kind === 'invalidated') {
      expect(r1.reason).toBe('daemon shutdown');
    }
  });

  it('returns 0 when no pending asks exist', () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    expect(invalidateAll('noop')).toBe(0);
  });
});

describe('dispatcher failure', () => {
  it('immediately settles the ask as invalidated if card dispatch throws', async () => {
    const d = mockDispatcher({
      send: async () => {
        throw new Error('lark 5xx');
      },
    });
    setCardDispatcher(d);

    const result = await registerAsk(makeInput());
    expect(result.kind).toBe('invalidated');
    if (result.kind === 'invalidated') {
      expect(result.reason).toMatch(/lark 5xx/);
    }
    expect(_pendingCount()).toBe(0);
  });

  it('throws synchronously if registerAsk is called before setCardDispatcher', () => {
    // _resetForTest() unwired the dispatcher; do not wire one here.
    expect(() => registerAsk(makeInput())).toThrowError(
      /cardDispatcher not wired/,
    );
  });
});

describe('onSettle hook is best-effort', () => {
  it('does not throw out of the broker even if onSettle throws', async () => {
    const d = mockDispatcher({
      onSettle: () => {
        throw new Error('patch failed');
      },
    });
    setCardDispatcher(d);
    const p = registerAsk(makeInput({ timeoutMs: 500 }));
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    // Must still resolve cleanly despite onSettle blowing up.
    const result = await p;
    expect(result.kind).toBe('timedOut');
  });
});
