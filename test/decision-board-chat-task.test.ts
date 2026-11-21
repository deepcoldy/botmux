/**
 * 决策看板「关联群里的子任务」：群里各会话的任务状态合成群状态、按事项算子任务提示、
 * 提醒正文，以及跨 bot 读会话（读不到就记「读不到」，不猜）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aggregateChatTaskState,
  formatTaskNotice,
  itemChatIds,
  itemTaskHint,
  stewardUpdatedAt,
  taskHintForChat,
  TASK_NOTICE_MAX_ENTRIES,
  type ChatSessionProbe,
  type ChatTaskState,
  type TaskNoticeEntry,
} from '../src/core/decision-board/chat-task.js';
import { ChatTaskReader, PEER_ROW_CACHE_MS, peerSessions, type ChatSessionRef } from '../src/core/decision-board/chat-task-reader.js';
import type { SessionTaskFacts } from '../src/core/session-task-status.js';
import type { BoardLink } from '../src/core/decision-board/model.js';

const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

function delivered(at: number, turnId = `turn-${at}`, summary = '修好了'): SessionTaskFacts {
  return { status: 'idle', lastMessageAt: at - MIN, lastTurn: { turnId, outcome: 'delivered', at, summary } };
}
function interrupted(at: number, turnId = `turn-${at}`): SessionTaskFacts {
  return { status: 'idle', lastMessageAt: at - MIN, lastTurn: { turnId, outcome: 'interrupted', at, errorCode: 'api_error' } };
}
const working = (since: number): SessionTaskFacts => ({ status: 'working', busySinceAt: since, lastMessageAt: since });
const raised = (at: number, reason = '要不要合？'): SessionTaskFacts => ({ status: 'idle', agentAttention: { source: 'agent', reason, at } });
const open = (sessionId: string, facts: SessionTaskFacts): ChatSessionProbe => ({ sessionId, facts });

describe('群状态合成', () => {
  it('没有会话 / 都关了 / 读不到', () => {
    expect(aggregateChatTaskState('oc_a', [])).toEqual({ chatId: 'oc_a', kind: 'no_session' });
    expect(aggregateChatTaskState('oc_a', [
      { sessionId: 's1', closed: true, closedAt: T },
      { sessionId: 's2', closed: true, closedAt: T + MIN },
    ])).toEqual({ chatId: 'oc_a', kind: 'closed', at: T + MIN });
    expect(aggregateChatTaskState('oc_a', [{ sessionId: 's1', unreadable: true }])).toEqual({ chatId: 'oc_a', kind: 'unreadable' });
  });

  it('会话清单当它开着、所属 daemon 报了关闭：算已关闭，不算空闲', () => {
    expect(aggregateChatTaskState('oc_a', [open('s1', { status: 'closed', closedAt: T })]))
      .toEqual({ chatId: 'oc_a', kind: 'closed', at: T });
    expect(aggregateChatTaskState('oc_a', [open('s1', { status: 'closed', closedAt: T }), open('s2', delivered(T))]).kind).toBe('delivered');
  });

  it('有会话读不到时不说「已交付」', () => {
    const state = aggregateChatTaskState('oc_a', [open('s1', delivered(T)), { sessionId: 's2', unreadable: true }]);
    expect(state.kind).toBe('unreadable');
    // 只剩没有结果的会话：空闲，不是已交付。
    expect(aggregateChatTaskState('oc_a', [open('s1', { status: 'idle' })]).kind).toBe('idle');
    // 结果之后又来了新消息：那条结果不再代表现状。
    expect(aggregateChatTaskState('oc_a', [open('s1', { ...delivered(T), lastMessageAt: T + MIN })]).kind).toBe('idle');
  });

  it('优先级：需要你 > 本轮中断 > 进行中 > 读不到 > 已交付；同类取最近', () => {
    const all = [
      open('s-del', delivered(T + 5 * MIN)),
      open('s-work', working(T + 4 * MIN)),
      open('s-int', interrupted(T + 3 * MIN)),
      open('s-need', raised(T + 2 * MIN)),
      { sessionId: 's-x', unreadable: true } as ChatSessionProbe,
    ];
    expect(aggregateChatTaskState('oc_a', all)).toMatchObject({ kind: 'needs_you', reason: 'attention', sessionId: 's-need', at: T + 2 * MIN, detail: '要不要合？' });
    expect(aggregateChatTaskState('oc_a', all.slice(0, 3))).toMatchObject({ kind: 'interrupted', sessionId: 's-int', detail: 'api_error' });
    expect(aggregateChatTaskState('oc_a', all.slice(0, 2))).toMatchObject({ kind: 'working', sessionId: 's-work', at: T + 4 * MIN });
    expect(aggregateChatTaskState('oc_a', [all[0]!, all[4]!]).kind).toBe('unreadable');
    expect(aggregateChatTaskState('oc_a', [open('a', delivered(T)), open('b', delivered(T + MIN, 'tb', '第二个'))]))
      .toMatchObject({ kind: 'delivered', sessionId: 'b', summary: '第二个', ref: 'tb' });
  });

  it('去重标识：本轮结果用 turnId，举手 / daemon 举手用时刻；没有时刻的不带', () => {
    expect(aggregateChatTaskState('oc_a', [open('s', interrupted(T, 'tid-1'))])).toMatchObject({ ref: 'tid-1' });
    expect(aggregateChatTaskState('oc_a', [open('s', raised(T))])).toMatchObject({ ref: String(T) });
    const daemonHand = aggregateChatTaskState('oc_a', [open('s', { status: 'idle', agentAttention: { source: 'daemon', reason: '最终回复没送达', at: T } })]);
    expect(daemonHand).toMatchObject({ kind: 'interrupted', ref: String(T), detail: '最终回复没送达' });
    const tui = aggregateChatTaskState('oc_a', [open('s', { status: 'idle', tuiPromptActive: true })]);
    expect(tui).toMatchObject({ kind: 'needs_you', reason: 'tui_prompt' });
    expect(tui.ref).toBeUndefined();
  });

  it('没有时刻的「需要你」照样显示，但不挡同群别的会话的提示', () => {
    const tui = open('s-tui', { status: 'idle', tuiPromptActive: true });
    const state = aggregateChatTaskState('oc_a', [tui, open('s-del', delivered(T, 'tid-d'))]);
    expect(state).toMatchObject({ kind: 'needs_you', reason: 'tui_prompt', alert: { kind: 'delivered', sessionId: 's-del', ref: 'tid-d' } });
    expect(taskHintForChat(state, T - 1)).toMatchObject({ kind: 'task_delivered', key: 'task:delivered:s-del:tid-d' });
    expect(itemTaskHint({ state: 'active', createdAt: T - HOUR, updatedAt: T - HOUR }, [state])).toMatchObject({ kind: 'task_delivered' });
    const withInterrupted = aggregateChatTaskState('oc_a', [tui, open('s-del', delivered(T + MIN)), open('s-int', interrupted(T, 'tid-i'))]);
    expect(withInterrupted.alert).toMatchObject({ kind: 'interrupted', ref: 'tid-i' });
    // 同群还有会话在跑或读不到：照旧不提示已交付。
    expect(aggregateChatTaskState('oc_a', [tui, open('s-del', delivered(T)), open('s-w', working(T))]).alert).toBeUndefined();
    expect(aggregateChatTaskState('oc_a', [tui, open('s-del', delivered(T)), { sessionId: 's-x', unreadable: true }]).alert).toBeUndefined();
    // 有时刻的「需要你」自己出提示。
    expect(aggregateChatTaskState('oc_a', [open('s-need', raised(T)), open('s-del', delivered(T + MIN))]).alert).toBeUndefined();
  });

  it('关联群：chat 关联去重、主群补上、排除管家群', () => {
    const links = [
      { kind: 'chat', ref: 'oc_b' }, { kind: 'pr', ref: 'o/r#1' }, { kind: 'chat', ref: 'oc_b' }, { kind: 'chat', ref: 'oc_steward' },
    ] as BoardLink[];
    expect(itemChatIds({ primaryChat: 'oc_a' }, links, 'oc_steward')).toEqual(['oc_a', 'oc_b']);
    expect(itemChatIds({ primaryChat: 'oc_b' }, links)).toEqual(['oc_b', 'oc_steward']);
  });
});

describe('子任务提示', () => {
  const del: ChatTaskState = { chatId: 'oc_a', kind: 'delivered', at: T, sessionId: 's1', ref: 'tid', summary: '修好了' };

  it('只有已交付 / 等人处理 / 中断，且晚于管家最后一次更新这一项', () => {
    expect(taskHintForChat(del, T - 1)).toEqual({ kind: 'task_delivered', chatId: 'oc_a', at: T, key: 'task:delivered:s1:tid', summary: '修好了' });
    expect(taskHintForChat(del, T)).toBeUndefined();
    expect(taskHintForChat({ ...del, kind: 'working' }, 0)).toBeUndefined();
    expect(taskHintForChat({ ...del, kind: 'idle' }, 0)).toBeUndefined();
    expect(taskHintForChat({ ...del, ref: undefined }, 0)).toBeUndefined();
    expect(taskHintForChat({ ...del, at: undefined }, 0)).toBeUndefined();
    expect(taskHintForChat({ ...del, kind: 'interrupted', detail: 'api_error' }, 0)).toMatchObject({ kind: 'task_interrupted', key: 'task:interrupted:s1:tid' });
  });

  it('管家更新过这一项就没有提示；已结束的项没有；多个群时等人 > 中断 > 已交付', () => {
    const states: ChatTaskState[] = [
      del,
      { chatId: 'oc_b', kind: 'interrupted', at: T - MIN, sessionId: 's2', ref: 'tb' },
      { chatId: 'oc_c', kind: 'needs_you', reason: 'attention', at: T - 2 * MIN, sessionId: 's3', ref: String(T - 2 * MIN) },
    ];
    const created = { state: 'active' as const, createdAt: T - HOUR, updatedAt: T - HOUR };
    expect(itemTaskHint(created, states)).toMatchObject({ kind: 'task_needs_you', chatId: 'oc_c' });
    expect(itemTaskHint({ ...created, stewardEventAt: T - 90_000 }, states)).toMatchObject({ kind: 'task_interrupted' });
    expect(itemTaskHint({ ...created, updatedAt: T - 90_000 }, states)).toMatchObject({ kind: 'task_interrupted' });
    expect(itemTaskHint({ ...created, stewardEventAt: T }, states)).toBeUndefined();
    expect(itemTaskHint({ ...created, updatedAt: T }, states)).toBeUndefined();
    expect(itemTaskHint({ state: 'done', createdAt: 0, updatedAt: 0 }, states)).toBeUndefined();
    expect(stewardUpdatedAt({ createdAt: 5, updatedAt: 5 })).toBe(5);
    expect(stewardUpdatedAt({ createdAt: 5, updatedAt: 7, stewardEventAt: 9 })).toBe(9);
    expect(stewardUpdatedAt({ createdAt: 5, updatedAt: 11, stewardEventAt: 9 })).toBe(11);
  });

  it('提醒正文：一项一行，带群名、结果第一行和链接；超过上限写「另有」', () => {
    const entry = (seq: number): TaskNoticeEntry => ({
      seq, title: `事项 ${seq}`, chatText: '修登录群', link: `https://dash.example/#/board/${seq}`,
      hint: taskHintForChat(del, 0)!,
    });
    const text = formatTaskNotice([entry(1)], 'zh');
    expect(text.split('\n')).toEqual([
      '【决策看板 · 子任务】1 条关联群的新结果（只是提示，状态没改）：',
      '#1 事项 1 — 子任务已交付（修登录群）：修好了 https://dash.example/#/board/1',
    ]);
    const many = formatTaskNotice(Array.from({ length: TASK_NOTICE_MAX_ENTRIES + 3 }, (_, i) => entry(i + 1)), 'zh').split('\n');
    expect(many).toHaveLength(TASK_NOTICE_MAX_ENTRIES + 2);
    expect(many.at(-1)).toBe('另有 3 条，见看板。');
  });
});

describe('读关联群的会话', () => {
  // 源码结构护栏(K2)：daemon 闭包里的 configured bot 过滤没有可调用入口，行为测试够不到；
  // 钉住源码接线，守的是「已从本机配置移除的 bot 不参与群状态探测」这条不变量。
  it('其他 bot 的会话只看本机配置着的 bot；读不到配置时不过滤', () => {
    const sessions = [
      { sessionId: 'mine', larkAppId: 'cli_me' },
      { sessionId: 'peer', larkAppId: 'cli_peer' },
      { sessionId: 'removed', larkAppId: 'cli_removed' },
      { sessionId: 'legacy' },
    ];
    expect(peerSessions(sessions, 'cli_me', new Set(['cli_me', 'cli_peer'])).map(s => s.sessionId)).toEqual(['peer']);
    expect(peerSessions(sessions, 'cli_me', undefined).map(s => s.sessionId)).toEqual(['peer', 'removed']);
    const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
    expect(daemon).toContain('configured = new Set(loadBotConfigsCached().map(bot => bot.larkAppId));');
    expect(daemon).toContain('sessions: peerSessions(snapshot.values(), cfg.larkAppId, configured)');
  });

  function reader(opts: {
    sessions: Record<string, ChatSessionRef[]>;
    own?: Record<string, SessionTaskFacts>;
    peers?: Record<string, SessionTaskFacts | Error>;
    now?: () => number;
    throwInventory?: boolean;
  }) {
    const peerCalls: string[] = [];
    const r = new ChatTaskReader({
      ownAppId: () => 'cli_me',
      chatSessions: ids => {
        if (opts.throwInventory) throw new Error('sessions.json unreadable');
        return new Map(ids.map(id => [id, opts.sessions[id] ?? []]));
      },
      ownRow: id => opts.own?.[id],
      peerRow: async (app, id) => {
        peerCalls.push(`${app}:${id}`);
        const v = opts.peers?.[`${app}:${id}`];
        if (v instanceof Error) throw v;
        return v;
      },
      ...(opts.now ? { now: opts.now } : {}),
    });
    return { r, peerCalls };
  }

  it('本 bot 的会话读内存，其他 bot 问所属 daemon；问不到记「读不到」', async () => {
    const { r } = reader({
      sessions: {
        oc_a: [{ sessionId: 'mine', larkAppId: 'cli_me', status: 'active' }],
        oc_b: [{ sessionId: 'peer', larkAppId: 'cli_other', status: 'active' }],
        oc_c: [{ sessionId: 'gone', larkAppId: 'cli_other', status: 'active' }],
        oc_d: [{ sessionId: 'err', larkAppId: 'cli_other', status: 'active' }],
        oc_e: [{ sessionId: 'lost', status: 'active' }],
        oc_f: [{ sessionId: 'old', larkAppId: 'cli_other', status: 'closed', closedAt: T }],
      },
      own: { mine: delivered(T) },
      peers: { 'cli_other:peer': working(T), 'cli_other:err': new Error('ECONNREFUSED') },
    });
    const states = await r.read(['oc_a', 'oc_b', 'oc_c', 'oc_d', 'oc_e', 'oc_f', 'oc_g', 'oc_a']);
    expect(Object.fromEntries([...states].map(([k, v]) => [k, v.kind]))).toEqual({
      oc_a: 'delivered', oc_b: 'working', oc_c: 'unreadable', oc_d: 'unreadable', oc_e: 'unreadable', oc_f: 'closed', oc_g: 'no_session',
    });
  });

  it('会话清单读不到：每个群都是「读不到」，不是「没有会话」', async () => {
    const { r } = reader({ sessions: {}, throwInventory: true });
    const states = await r.read(['oc_a', 'oc_b']);
    expect([...states.values()].map(s => s.kind)).toEqual(['unreadable', 'unreadable']);
  });

  it('其他 bot 的会话短时间内不重复问；提醒前的核对（fresh）照样重问', async () => {
    let now = T;
    const { r, peerCalls } = reader({
      sessions: { oc_b: [{ sessionId: 'peer', larkAppId: 'cli_other', status: 'active' }] },
      peers: { 'cli_other:peer': working(T) },
      now: () => now,
    });
    await r.read(['oc_b']);
    await r.read(['oc_b']);
    expect(peerCalls).toHaveLength(1);
    await r.read(['oc_b'], { fresh: true });
    expect(peerCalls).toHaveLength(2);
    now += PEER_ROW_CACHE_MS;
    await r.read(['oc_b']);
    expect(peerCalls).toHaveLength(3);
  });
});
