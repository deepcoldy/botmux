/**
 * schedule-follow-active.test.ts
 *
 * `botmux schedule add --follow-active`: at fire time the task resolves its
 * landing point in three steps —
 *
 *  1. the topic it last landed in is still open (an active thread session
 *     exists under that root, any bot) → fire there, nothing persisted
 *  2. it was closed → the topic in this chat where a HUMAN most recently
 *     spoke; persisted as the new landing point
 *  3. no open human-active topic → this fire runs as `new-topic`; the fire
 *     path reports the fresh root via recordFollowActiveFreshTopic so the next
 *     fire finds it under step 1
 *
 *  - isTopicOpen / pickMostRecentHumanTopic: pure predicates over the active
 *    thread-session list (chat-scope rows, rows without a root, rows from
 *    other chats are ignored; bot-only activity never qualifies for step 2)
 *  - resolveFollowActiveRoot: the three steps + a failing lookup keeps the
 *    last landing point ('unknown') instead of moving on a missing reading
 *  - applyFollowActive: no-op for non-follow tasks and for tasks parked away
 *    from topic execution; a failing persist does not block the fire
 *  - followActiveOpenedFreshTopic / recordFollowActiveFreshTopic: step 3 wiring
 *  - default deps reach the cross-bot session-store lookup and schedule-store
 *    (stubbed here)
 *  - markSessionActivity({ human: true }) stamps lastHumanMessageAt; a bot
 *    turn advances lastMessageAt only
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScheduledTask, Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';

const findActiveThreadSessionsByChat = vi.fn<(chatId: string) => Session[]>(() => []);
const updateSession = vi.fn();
vi.mock('../src/services/session-store.js', () => ({
  findActiveThreadSessionsByChat: (...a: any[]) => findActiveThreadSessionsByChat(...(a as [string])),
  updateSession: (...a: any[]) => updateSession(...a),
}));

const storeUpdateTask = vi.fn();
vi.mock('../src/services/schedule-store.js', () => ({
  updateTask: (...a: any[]) => storeUpdateTask(...a),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const publish = vi.fn();
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: (...a: any[]) => publish(...a) } }));
vi.mock('../src/core/dashboard-rows.js', () => ({ composeRowFromActive: vi.fn(() => ({})) }));
vi.mock('../src/core/session-message-preview.js', () => ({ buildSessionMessagePreview: vi.fn(() => undefined) }));

const {
  isTopicOpen,
  isTopicHumanHeld,
  pickMostRecentHumanTopic,
  resolveFollowActiveRoot,
  applyFollowActive,
  followActiveOpenedFreshTopic,
  recordFollowActiveFreshTopic,
} = await import('../src/core/schedule-follow-active.js');
const { markSessionActivity, stampHumanActivity } = await import('../src/core/session-activity.js');

const CHAT = 'oc_chat_A';
const OTHER_CHAT = 'oc_chat_B';

function session(overrides: Partial<Session> & { rootMessageId?: string }): Session {
  return {
    sessionId: `s-${overrides.rootMessageId ?? 'x'}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: CHAT,
    title: 't',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: 'sentinel',
    schedule: 'every 30m',
    prompt: 'check',
    workingDir: '/w',
    chatId: CHAT,
    rootMessageId: 'om_origin',
    scope: 'thread',
    executionPosition: 'topic',
    larkAppId: 'cli_app_1',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    followActive: true,
    ...overrides,
  } as ScheduledTask;
}

// The origin topic still has an active session (bot-only is enough: "open" is
// about the session existing, not about who spoke last).
const originOpen = () => session({ rootMessageId: 'om_origin', lastMessageAt: '2026-01-01T05:00:00.000Z' });
const liveHuman = (root = 'om_live', at = '2026-01-01T12:00:00.000Z') => session({ rootMessageId: root, lastHumanMessageAt: at });

beforeEach(() => {
  findActiveThreadSessionsByChat.mockReset();
  findActiveThreadSessionsByChat.mockImplementation(() => []);
  storeUpdateTask.mockReset();
  updateSession.mockReset();
  publish.mockReset();
});

describe('isTopicOpen', () => {
  it('is true when an active thread session exists under the root, regardless of who spoke', () => {
    expect(isTopicOpen(CHAT, 'om_origin', [originOpen()])).toBe(true);
    expect(isTopicOpen(CHAT, 'om_origin', [liveHuman('om_origin')])).toBe(true);
  });

  it('is false when no active session holds the root — closed, or never engaged', () => {
    expect(isTopicOpen(CHAT, 'om_origin', [])).toBe(false);
    expect(isTopicOpen(CHAT, 'om_origin', [liveHuman('om_other')])).toBe(false);
    expect(isTopicOpen(CHAT, undefined, [originOpen()])).toBe(false);
  });

  it('ignores chat-scope rows, other chats and roots equal to the chat id', () => {
    expect(isTopicOpen(CHAT, 'om_origin', [session({ rootMessageId: 'om_origin', scope: 'chat' })])).toBe(false);
    expect(isTopicOpen(CHAT, 'om_origin', [session({ chatId: OTHER_CHAT, rootMessageId: 'om_origin' })])).toBe(false);
    expect(isTopicOpen(CHAT, CHAT, [session({ rootMessageId: CHAT })])).toBe(false);
  });
});

describe('pickMostRecentHumanTopic', () => {
  it('picks the root with the newest human activity', () => {
    const root = pickMostRecentHumanTopic(CHAT, [
      session({ rootMessageId: 'om_old', lastHumanMessageAt: '2026-01-01T10:00:00.000Z' }),
      session({ rootMessageId: 'om_new', lastHumanMessageAt: '2026-01-01T12:00:00.000Z' }),
      session({ rootMessageId: 'om_mid', lastHumanMessageAt: '2026-01-01T11:00:00.000Z' }),
    ]);
    expect(root).toBe('om_new');
  });

  it('ignores bot-only activity: lastMessageAt alone never qualifies a topic', () => {
    // The sentinel's own topic was just written by the bot (lastMessageAt is
    // the newest of all) but no human has spoken there.
    const root = pickMostRecentHumanTopic(CHAT, [
      session({ rootMessageId: 'om_bot_only', lastMessageAt: '2026-01-01T23:00:00.000Z' }),
      session({ rootMessageId: 'om_human', lastMessageAt: '2026-01-01T09:00:00.000Z', lastHumanMessageAt: '2026-01-01T09:00:00.000Z' }),
    ]);
    expect(root).toBe('om_human');
  });

  it('ignores chat-scope rows, other chats, missing roots and roots equal to the chat id', () => {
    const root = pickMostRecentHumanTopic(CHAT, [
      session({ rootMessageId: 'om_chat_scope', scope: 'chat', lastHumanMessageAt: '2026-01-01T23:00:00.000Z' }),
      session({ chatId: OTHER_CHAT, rootMessageId: 'om_elsewhere', lastHumanMessageAt: '2026-01-01T22:00:00.000Z' }),
      session({ rootMessageId: CHAT, lastHumanMessageAt: '2026-01-01T21:00:00.000Z' }),
      session({ rootMessageId: undefined, lastHumanMessageAt: '2026-01-01T20:00:00.000Z' }),
      session({ rootMessageId: 'om_bad_ts', lastHumanMessageAt: 'not-a-date' }),
      session({ rootMessageId: 'om_ok', lastHumanMessageAt: '2026-01-01T01:00:00.000Z' }),
    ]);
    expect(root).toBe('om_ok');
  });

  it('returns undefined when no candidate has human activity', () => {
    expect(pickMostRecentHumanTopic(CHAT, [])).toBeUndefined();
    expect(pickMostRecentHumanTopic(CHAT, [session({ rootMessageId: 'om_x' })])).toBeUndefined();
  });
});

describe('isTopicHumanHeld', () => {
  it('needs an open session under the root that has seen a human message', () => {
    expect(isTopicHumanHeld(CHAT, 'om_origin', [liveHuman('om_origin')])).toBe(true);
    expect(isTopicHumanHeld(CHAT, 'om_origin', [originOpen()])).toBe(false);
    expect(isTopicHumanHeld(CHAT, 'om_origin', [liveHuman('om_other')])).toBe(false);
    expect(isTopicHumanHeld(CHAT, 'om_origin', [session({ rootMessageId: 'om_origin', lastHumanMessageAt: 'not-a-date' })])).toBe(false);
    expect(isTopicHumanHeld(CHAT, undefined, [liveHuman('om_origin')])).toBe(false);
  });
});

describe('resolveFollowActiveRoot — four steps', () => {
  it('step 1: the landing point is open AND human-held → stay, even if a human spoke elsewhere more recently', () => {
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [
      liveHuman('om_origin', '2026-01-01T08:00:00.000Z'),
      liveHuman('om_live', '2026-01-01T12:00:00.000Z'),
    ]);
    expect(r).toEqual({ rootMessageId: 'om_origin', source: 'retained' });
  });

  it('step 2: the landing point was closed → the most recently human-active open topic', () => {
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [
      liveHuman('om_older', '2026-01-01T10:00:00.000Z'),
      liveHuman('om_live', '2026-01-01T12:00:00.000Z'),
    ]);
    expect(r).toEqual({ rootMessageId: 'om_live', source: 'active' });
  });

  it('step 2 also applies to a landing point that is open but bot-only: the task does not pin itself', () => {
    // The task opened om_origin itself (step 4 on an earlier fire) and is the
    // only writer there; a person is active in om_live. Before the reorder,
    // the bot-only session counted as "open" under step 1 and the task never
    // left its own topic.
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [originOpen(), liveHuman()]);
    expect(r).toEqual({ rootMessageId: 'om_live', source: 'active' });
  });

  it('step 3: no human-active topic anywhere but the landing point is open → kept (no second topic)', () => {
    expect(resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [originOpen()]))
      .toEqual({ rootMessageId: 'om_origin', source: 'kept' });
    // Upgrade window: sessions created before lastHumanMessageAt existed carry
    // no human clock at all. The landing point still counts as open → stay.
    expect(resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [
      session({ rootMessageId: 'om_origin' }),
      session({ rootMessageId: 'om_other' }),
    ])).toEqual({ rootMessageId: 'om_origin', source: 'kept' });
  });

  it('step 4: nothing open → fresh topic (bot-only topics elsewhere do not count)', () => {
    expect(resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => []))
      .toEqual({ rootMessageId: undefined, source: 'fresh' });
    expect(resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => [
      session({ rootMessageId: 'om_other_sentinel', lastMessageAt: '2026-01-01T23:00:00.000Z' }),
    ])).toEqual({ rootMessageId: undefined, source: 'fresh' });
  });

  it('a failing lookup keeps the last landing point instead of moving on a reading it does not have', () => {
    const r = resolveFollowActiveRoot({ chatId: CHAT, rootMessageId: 'om_origin' }, () => { throw new Error('sqlite unavailable'); });
    expect(r).toEqual({ rootMessageId: 'om_origin', source: 'unknown' });
  });
});

describe('applyFollowActive', () => {
  it('returns the task untouched when followActive is not set', () => {
    const persist = vi.fn();
    const t = task({ followActive: undefined });
    expect(applyFollowActive(t, { listCandidates: () => [liveHuman()], persist })).toBe(t);
    expect(persist).not.toHaveBeenCalled();
  });

  it('leaves tasks parked at top-level / new-topic alone even if the flag is still set', () => {
    const persist = vi.fn();
    const list = () => [liveHuman()];
    for (const executionPosition of ['top-level', 'new-topic'] as const) {
      const t = task({ executionPosition, scope: 'chat', rootMessageId: undefined });
      expect(applyFollowActive(t, { listCandidates: list, persist })).toBe(t);
    }
    expect(persist).not.toHaveBeenCalled();
  });

  it('step 1: a human-held landing point is kept as-is and nothing is persisted', () => {
    const persist = vi.fn();
    const t = task();
    expect(applyFollowActive(t, { listCandidates: () => [liveHuman('om_origin', '2026-01-01T08:00:00.000Z'), liveHuman()], persist })).toBe(t);
    expect(persist).not.toHaveBeenCalled();
  });

  it('step 3: a bot-only landing point with no human topic anywhere is kept as-is, nothing persisted', () => {
    const persist = vi.fn();
    const t = task();
    expect(applyFollowActive(t, { listCandidates: () => [originOpen()], persist })).toBe(t);
    expect(persist).not.toHaveBeenCalled();
    expect(followActiveOpenedFreshTopic(t, t)).toBe(false);
  });

  it('step 2: re-targets to the human-active topic and persists the new landing point (with the task appId)', () => {
    const persist = vi.fn();
    const out = applyFollowActive(task(), {
      listCandidates: () => [liveHuman('om_live', '2026-01-01T12:00:00.000Z'), liveHuman('om_older', '2026-01-01T08:00:00.000Z')],
      persist,
    });
    expect(out.rootMessageId).toBe('om_live');
    expect(out.scope).toBe('thread');
    expect(out.executionPosition).toBe('topic');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('task-1', 'om_live', 'cli_app_1');
  });

  it('step 2: still fires into the resolved topic when persisting fails', () => {
    const out = applyFollowActive(task(), {
      listCandidates: () => [liveHuman()],
      persist: () => { throw new Error('disk full'); },
    });
    expect(out.rootMessageId).toBe('om_live');
  });

  it('step 4: switches THIS fire to new-topic without touching the stored task', () => {
    const persist = vi.fn();
    const t = task();
    const out = applyFollowActive(t, { listCandidates: () => [], persist });
    expect(out).not.toBe(t);
    expect(out.executionPosition).toBe('new-topic');
    expect(out.scope).toBe('chat');
    expect(out.followActive).toBe(true);
    expect(out.rootMessageId).toBe('om_origin');
    expect(persist).not.toHaveBeenCalled();
    expect(followActiveOpenedFreshTopic(t, out)).toBe(true);
  });

  it('a failing lookup keeps the task as-is (no move, no fresh topic, nothing persisted)', () => {
    const persist = vi.fn();
    const t = task();
    expect(applyFollowActive(t, { listCandidates: () => { throw new Error('sqlite unavailable'); }, persist })).toBe(t);
    expect(persist).not.toHaveBeenCalled();
    expect(followActiveOpenedFreshTopic(t, t)).toBe(false);
  });

  it('by default reads candidates across bots via session-store and persists via schedule-store', () => {
    findActiveThreadSessionsByChat.mockImplementation(() => [liveHuman('om_other_bot_topic')]);
    const out = applyFollowActive(task());
    expect(findActiveThreadSessionsByChat).toHaveBeenCalledWith(CHAT);
    expect(out.rootMessageId).toBe('om_other_bot_topic');
    expect(storeUpdateTask).toHaveBeenCalledWith('task-1', { rootMessageId: 'om_other_bot_topic' }, 'cli_app_1');
  });
});

describe('step 4 completion', () => {
  it('followActiveOpenedFreshTopic is false for a genuine new-topic task', () => {
    const t = task({ executionPosition: 'new-topic', scope: 'chat', followActive: undefined });
    expect(followActiveOpenedFreshTopic(t, t)).toBe(false);
  });

  it('recordFollowActiveFreshTopic persists the fresh root as the landing point and swallows persist errors', () => {
    const persist = vi.fn();
    recordFollowActiveFreshTopic(task(), 'om_fresh', persist);
    expect(persist).toHaveBeenCalledWith('task-1', 'om_fresh', 'cli_app_1');
    expect(() => recordFollowActiveFreshTopic(task(), 'om_fresh', () => { throw new Error('disk full'); })).not.toThrow();
  });

  it('by default persists via schedule-store', () => {
    recordFollowActiveFreshTopic(task(), 'om_fresh');
    expect(storeUpdateTask).toHaveBeenCalledWith('task-1', { rootMessageId: 'om_fresh' }, 'cli_app_1');
  });

  it('the fresh topic, once open, is kept under step 3 on the next fire — no second topic', () => {
    const persist = vi.fn();
    const first = applyFollowActive(task(), { listCandidates: () => [], persist });
    expect(first.executionPosition).toBe('new-topic');
    recordFollowActiveFreshTopic(task(), 'om_fresh', persist);
    const next = task({ rootMessageId: 'om_fresh' });
    const out = applyFollowActive(next, {
      listCandidates: () => [session({ rootMessageId: 'om_fresh', lastMessageAt: '2026-01-02T00:00:00.000Z' })],
      persist,
    });
    expect(out).toBe(next);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('the fresh topic does not pin the task: a human speaking elsewhere pulls it there on the next fire', () => {
    const persist = vi.fn();
    const next = task({ rootMessageId: 'om_fresh' });
    const out = applyFollowActive(next, {
      listCandidates: () => [
        session({ rootMessageId: 'om_fresh', lastMessageAt: '2026-01-02T00:00:00.000Z' }),
        liveHuman('om_live', '2026-01-01T23:00:00.000Z'),
      ],
      persist,
    });
    expect(out.rootMessageId).toBe('om_live');
    expect(persist).toHaveBeenCalledWith('task-1', 'om_live', 'cli_app_1');
  });
});

describe('human activity clock', () => {
  function ds(): DaemonSession {
    const s = session({ rootMessageId: 'om_r', lastMessageAt: '2026-01-01T00:00:00.000Z' });
    return { session: s, lastMessageAt: 0 } as unknown as DaemonSession;
  }

  it('a human turn stamps both clocks; a bot turn only the generic one', () => {
    const human = ds();
    markSessionActivity(human, Date.parse('2026-01-01T10:00:00.000Z'), { human: true });
    expect(human.session.lastMessageAt).toBe('2026-01-01T10:00:00.000Z');
    expect(human.session.lastHumanMessageAt).toBe('2026-01-01T10:00:00.000Z');
    expect(human.lastHumanMessageAt).toBe(Date.parse('2026-01-01T10:00:00.000Z'));

    const bot = ds();
    markSessionActivity(bot, Date.parse('2026-01-01T11:00:00.000Z'));
    expect(bot.session.lastMessageAt).toBe('2026-01-01T11:00:00.000Z');
    expect(bot.session.lastHumanMessageAt).toBeUndefined();
    expect(bot.lastHumanMessageAt).toBeUndefined();
    expect(updateSession).toHaveBeenCalledTimes(2);
  });

  it('a later bot turn does not move the human clock', () => {
    const d = ds();
    markSessionActivity(d, Date.parse('2026-01-01T10:00:00.000Z'), { human: true });
    markSessionActivity(d, Date.parse('2026-01-01T12:00:00.000Z'), { human: false });
    expect(d.session.lastMessageAt).toBe('2026-01-01T12:00:00.000Z');
    expect(d.session.lastHumanMessageAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('stampHumanActivity seeds the human clock on a freshly created session', () => {
    const s = session({ rootMessageId: 'om_r' });
    stampHumanActivity(s, Date.parse('2026-01-01T09:30:00.000Z'));
    expect(s.lastHumanMessageAt).toBe('2026-01-01T09:30:00.000Z');
  });
});
