/**
 * Contract tests for the ask broker — covers §3 lifecycle, canTalk-based click
 * authorization, §7 timeout, §8 invalidation. Card dispatch is mocked via a fake
 * AskCardDispatcher
 * so these tests stay IM-agnostic and run in pure node.
 *
 * Run:  pnpm vitest run test/ask-broker.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _allAskIds,
  _getPending,
  _pendingCount,
  _resetForTest,
  findPendingAskByAnchor,
  invalidateAll,
  registerAsk,
  setCardDispatcher,
  setCanTalkChecker,
  submitAsk,
  submitCustomReply,
  toggleAsk,
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
    questions: [{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }],
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

// 默认 canTalk 放行集：模拟「这些 open_id 能在该 chat 跟 bot 说话」。
// 答复鉴权 = canTalk，故凡在此集合内者可作答，其余（ou_stranger / ou_other）拒绝。
const DEFAULT_TALKERS = new Set(['ou_owner', 'ou_a', 'ou_b', 'ou_u', 'ou_talker']);

beforeEach(() => {
  vi.useFakeTimers();
  _resetForTest();
  setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
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
    expect(dispatched.questions).toEqual([{ prompt: '继续发版吗？', options: OPTIONS, multiSelect: false }]);

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
      answers: [['yes']],
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

  it('returns "unauthorized" when clicker cannot canTalk in this chat', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    // ou_stranger 不在默认 canTalk 放行集 → unauthorized
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
    registerAsk(makeInput());
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

describe('canTalk authorization (遵循 canTalk 权限)', () => {
  it('canTalk 命中 → 可作答（不依赖任何 approver 名单）', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    // 仅 ou_talker 能在该 chat 对话，其余拒绝（覆盖默认放行集）
    setCanTalkChecker((_app, chatId, openId) => chatId === 'oc_chat' && openId === 'ou_talker');
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    expect(tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_talker' })).toBe('accepted');
  });

  it('canTalk 未命中 → unauthorized，ask 仍 pending', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    setCanTalkChecker(() => false);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    expect(tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_stranger' })).toBe('unauthorized');
    expect(_pendingCount()).toBe(1);
  });

  it('checker 未注入（degraded）→ 谁都不能答', async () => {
    const d = mockDispatcher();
    _resetForTest();        // 清空 beforeEach 注入的默认 checker
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    expect(tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_owner' })).toBe('unauthorized');
  });

  it('canTalk 放行覆盖 toggle / submitCustomReply 路径', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    setCanTalkChecker((_app, _chat, openId) => openId === 'ou_talker');
    registerAsk(makeInput({
      questions: [{ prompt: '多选？', options: OPTIONS, multiSelect: true }],
    }));
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    // 非 canTalk 用户被拒（先于 settle 验证）
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'no', by: 'ou_stranger' })).toBe('unauthorized');
    // canTalk 用户可 toggle + 自定义文字作答
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'yes', by: 'ou_talker' })).toBe('toggled');
    expect(submitCustomReply({ askId, by: 'ou_talker', text: '我直接打字答' })).toBe('accepted');
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

describe('toggleAsk + submitAsk', () => {
  it('多选：toggle 累积，submit 才 settle', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    const p = registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'pick', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], multiSelect: true }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    // toggle 两个选项 — 不 settle
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'a', by: 'ou_u' })).toBe('toggled');
    expect(_pendingCount()).toBe(1);
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'b', by: 'ou_u' })).toBe('toggled');
    expect(_pendingCount()).toBe(1);
    // submit 用累积选中项 settle
    expect(submitAsk({ askId, nonce, by: 'ou_u' })).toBe('accepted');
    const r = await p;
    expect(r.kind).toBe('answered');
    if (r.kind === 'answered') expect([...r.answers[0]!].sort()).toEqual(['a', 'b']);
  });

  it('toggle 取消选中（再次 toggle 同一 key 去除）', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    const p = registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'pick', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], multiSelect: true }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    // 选 a 后取消 a，最终只有 b
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'a', by: 'ou_u' })).toBe('toggled');
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'a', by: 'ou_u' })).toBe('toggled');
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'b', by: 'ou_u' })).toBe('toggled');
    expect(submitAsk({ askId, nonce, by: 'ou_u' })).toBe('accepted');
    const r = await p;
    if (r.kind === 'answered') expect([...r.answers[0]!]).toEqual(['b']);
  });

  it('单选：toggle 后再 toggle 同一 key，set 内只保留该 key', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    const p = registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'go', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }], multiSelect: false }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    // 单选 toggle：选 y → 选 n（不累积，只保留最后选的）
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'y', by: 'ou_u' })).toBe('toggled');
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'n', by: 'ou_u' })).toBe('toggled');
    expect(submitAsk({ askId, nonce, by: 'ou_u' })).toBe('accepted');
    const r = await p;
    if (r.kind === 'answered') expect(r.answers).toEqual([['n']]);
  });

  it('单问单选：submit 携带显式 selections', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    const p = registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'go', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }], multiSelect: false }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    expect(submitAsk({ askId, nonce, by: 'ou_u', selections: [['y']] })).toBe('accepted');
    const r = await p;
    if (r.kind === 'answered') expect(r.answers).toEqual([['y']]);
  });

  it('未授权 toggle/submit 不改变状态', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'pick', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], multiSelect: true }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    // 未授权用户 toggle → unauthorized，状态不变
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'a', by: 'ou_other' })).toBe('unauthorized');
    expect(_pendingCount()).toBe(1);
    // 未授权用户 submit → unauthorized，状态不变
    expect(submitAsk({ askId, nonce, by: 'ou_other' })).toBe('unauthorized');
    expect(_pendingCount()).toBe(1);
  });

  it('toggleAsk 返回 stale（未知 askId）', () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    expect(toggleAsk({ askId: 'no-such', nonce: 'x', questionIndex: 0, key: 'a', by: 'ou_u' })).toBe('stale');
  });

  it('submitAsk 返回 stale（未知 askId）', () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    expect(submitAsk({ askId: 'no-such', nonce: 'x', by: 'ou_u' })).toBe('stale');
  });

  it('toggleAsk 返回 stale（options 中不存在的 key）', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'pick', options: [{ key: 'a', label: 'A' }], multiSelect: true }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    expect(toggleAsk({ askId, nonce, questionIndex: 0, key: 'z', by: 'ou_u' })).toBe('stale');
  });

  it('submitAsk 单选问题未选任何项时返回 stale', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    registerAsk({
      larkAppId: 'a', chatId: 'c', rootMessageId: null, sessionId: 's',
      questions: [{ prompt: 'go', options: [{ key: 'y', label: '是' }, { key: 'n', label: '否' }], multiSelect: false }],
      timeoutMs: 60_000,
    });
    const askId = _allAskIds()[0]!;
    const nonce = _getPending(askId)!.nonce;
    // 未 toggle 任何项直接 submit，单选问题没选 → stale
    expect(submitAsk({ askId, nonce, by: 'ou_u' })).toBe('stale');
    expect(_pendingCount()).toBe(1);
  });

  it('_allAskIds 返回所有未 settle 及已 settle(retention 内)的 askId', async () => {
    _resetForTest();
    setCanTalkChecker((_app, _chat, openId) => DEFAULT_TALKERS.has(openId));
    setCardDispatcher({ send: async () => ({ messageId: 'm1' }) });
    registerAsk(makeInput({ sessionId: 'sx' }));
    registerAsk(makeInput({ sessionId: 'sy' }));
    const ids = _allAskIds();
    expect(ids).toHaveLength(2);
  });
});

describe('自定义回复 findPendingAskByAnchor + submitCustomReply', () => {
  it('findPendingAskByAnchor: 按 (larkAppId, chatId, rootMessageId=anchor) 命中未 settle 的 ask', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const found = findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'om_root' });
    expect(found?.askId).toBe(d.sendCalls[0]!.askId);
  });

  it('findPendingAskByAnchor: chat-scope（rootMessageId=null）按 chatId 作为 anchor 命中', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput({ rootMessageId: null }));
    await Promise.resolve();
    await Promise.resolve();
    const found = findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'oc_chat' });
    expect(found?.askId).toBe(d.sendCalls[0]!.askId);
  });

  it('findPendingAskByAnchor: anchor 不匹配 → undefined', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'om_other' }),
    ).toBeUndefined();
  });

  it('findPendingAskByAnchor: larkAppId 不同 → undefined（不跨 bot 命中）', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    expect(
      findPendingAskByAnchor({ larkAppId: 'other_app', chatId: 'oc_chat', anchor: 'om_root' }),
    ).toBeUndefined();
  });

  it('findPendingAskByAnchor: settled 的 ask 不再被命中', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_owner' });
    await p;
    expect(
      findPendingAskByAnchor({ larkAppId: 'cli_app', chatId: 'oc_chat', anchor: 'om_root' }),
    ).toBeUndefined();
  });

  it('submitCustomReply: 授权用户文字回复 → answered，comment=文字，answers 全空', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId } = d.sendCalls[0]!;
    expect(submitCustomReply({ askId, by: 'ou_owner', text: '我想先灰度 10% 再全量' })).toBe('accepted');
    const r = await p;
    expect(r.kind).toBe('answered');
    if (r.kind === 'answered') {
      expect(r.comment).toBe('我想先灰度 10% 再全量');
      expect(r.answers).toEqual([[]]);
      expect(r.by).toBe('ou_owner');
    }
    expect(_pendingCount()).toBe(0);
    expect(d.settleCalls).toHaveLength(1);
  });

  it('submitCustomReply: 前后空白被 trim 后写入 comment', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId } = d.sendCalls[0]!;
    submitCustomReply({ askId, by: 'ou_owner', text: '  灰度  ' });
    const r = await p;
    if (r.kind === 'answered') expect(r.comment).toBe('灰度');
  });

  it('submitCustomReply: 非授权用户 → unauthorized，状态不变', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId } = d.sendCalls[0]!;
    expect(submitCustomReply({ askId, by: 'ou_stranger', text: '随便答' })).toBe('unauthorized');
    expect(_pendingCount()).toBe(1);
  });

  it('submitCustomReply: 空白文字 → stale，状态不变', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId } = d.sendCalls[0]!;
    expect(submitCustomReply({ askId, by: 'ou_owner', text: '   ' })).toBe('stale');
    expect(_pendingCount()).toBe(1);
  });

  it('submitCustomReply: 未知 askId → stale', () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    expect(submitCustomReply({ askId: 'no-such', by: 'ou_owner', text: 'x' })).toBe('stale');
  });

  it('submitCustomReply: 已 settle → already_settled', async () => {
    const d = mockDispatcher();
    setCardDispatcher(d);
    const p = registerAsk(makeInput());
    await Promise.resolve();
    await Promise.resolve();
    const { askId, nonce } = d.sendCalls[0]!;
    tryResolveAsk({ askId, nonce, selected: 'yes', by: 'ou_owner' });
    await p;
    expect(submitCustomReply({ askId, by: 'ou_owner', text: 'late' })).toBe('already_settled');
  });
});
