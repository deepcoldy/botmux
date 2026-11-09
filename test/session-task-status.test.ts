import { describe, expect, it } from 'vitest';
import {
  RECENT_TURN_WINDOW_MS,
  currentLastTurn,
  deriveSessionTaskStatus,
  normalizeLastTurn,
  replySummaryLine,
  taskStatusChangedAt,
} from '../src/core/session-task-status.js';
import {
  RECENT_TURN_ON_BOARD_MS,
  activeManualColumn,
  deriveKanbanColumn,
  effectiveKanbanPosition,
  isOffBoardDormant,
} from '../src/dashboard/web/kanban-model.js';
import { deriveSessionBoardColumn } from '../src/dashboard/web/sessions.js';
import { matchesStatusFilter, sessionTaskCardLine } from '../src/dashboard/web/session-task-view.js';

const T0 = 1_800_000_000_000;
const delivered = (at: number, summary?: string) => ({ turnId: 't1', outcome: 'delivered', at, ...(summary ? { summary } : {}) });

describe('deriveSessionTaskStatus', () => {
  it('closed wins over every other fact', () => {
    expect(deriveSessionTaskStatus({
      status: 'closed', closedAt: T0, tuiPromptActive: true, lastTurn: delivered(T0), agentAttention: { kind: 'decision', reason: 'x', at: T0, source: 'agent' },
    })).toEqual({ kind: 'closed', at: T0 });
  });

  it('agent raised hand is "waiting for your decision" and outranks other needs-you signals', () => {
    expect(deriveSessionTaskStatus({
      status: 'working', tuiPromptActive: true, pendingRepo: true,
      agentAttention: { kind: 'decision', reason: '选方案 A 还是 B', at: T0, source: 'agent' },
    })).toEqual({ kind: 'needs_you', reason: 'attention', detail: '选方案 A 还是 B', at: T0 });
  });

  it('maps each human-blocking fact to its own reason', () => {
    expect(deriveSessionTaskStatus({ status: 'idle', tuiPromptActive: true })).toMatchObject({ kind: 'needs_you', reason: 'tui_prompt' });
    expect(deriveSessionTaskStatus({ status: 'idle', pendingRepo: true })).toMatchObject({ kind: 'needs_you', reason: 'pending_repo' });
    expect(deriveSessionTaskStatus({ status: 'limited' })).toMatchObject({ kind: 'needs_you', reason: 'limited' });
    expect(deriveSessionTaskStatus({ status: 'stalled' })).toMatchObject({ kind: 'needs_you', reason: 'stalled' });
  });

  it('daemon raised hand (no agent source) means the turn was interrupted', () => {
    expect(deriveSessionTaskStatus({
      status: 'idle', agentAttention: { kind: 'blocked', reason: 'API 报错', at: T0 },
    })).toEqual({ kind: 'needs_you', reason: 'interrupted', detail: 'API 报错', at: T0 });
  });

  it('a raised hand stops blocking once a later turn starts or produces a result', () => {
    const agent = { kind: 'decision', reason: '选方案', at: T0, source: 'agent' };
    const daemon = { kind: 'blocked', reason: 'API 报错', at: T0 };
    // bot 协作群里没有真人回复去清举手，下一轮照常开跑、交付。
    expect(deriveSessionTaskStatus({ status: 'working', busySinceAt: T0 + 5, agentAttention: daemon }))
      .toEqual({ kind: 'working', since: T0 + 5 });
    expect(deriveSessionTaskStatus({
      status: 'idle', lastMessageAt: T0 + 5, agentAttention: daemon,
      lastTurn: { ...delivered(T0 + 60, '下一轮结论'), startedAt: T0 + 5 },
    })).toEqual({ kind: 'delivered', at: T0 + 60, summary: '下一轮结论' });
    expect(deriveSessionTaskStatus({
      status: 'idle', lastMessageAt: T0 + 5, agentAttention: agent,
      lastTurn: { ...delivered(T0 + 60), startedAt: T0 + 5 },
    }).kind).toBe('delivered');
  });

  it('the turn that raised the hand does not clear it by ending', () => {
    const agent = { kind: 'decision', reason: '选方案', at: T0, source: 'agent' };
    // agent 在一轮中间举手，然后结束这一轮：仍在等人。
    expect(deriveSessionTaskStatus({
      status: 'idle', lastMessageAt: T0 - 30, agentAttention: agent,
      lastTurn: { ...delivered(T0 + 60), startedAt: T0 - 30 },
    })).toMatchObject({ kind: 'needs_you', reason: 'attention' });
    expect(deriveSessionTaskStatus({ status: 'working', busySinceAt: T0 - 30, agentAttention: agent }))
      .toMatchObject({ kind: 'needs_you', reason: 'attention' });
    // 不知道哪一轮先开始（重启前的轮、举手没有时刻）就当还在等。
    expect(deriveSessionTaskStatus({ status: 'idle', agentAttention: agent, lastTurn: delivered(T0 + 60) }).kind).toBe('needs_you');
    expect(deriveSessionTaskStatus({
      status: 'idle', agentAttention: { kind: 'blocked', reason: 'x' }, lastTurn: { ...delivered(T0 + 60), startedAt: T0 + 5 },
    }).kind).toBe('needs_you');
  });

  it('busy runtime is working, with the turn start time when known', () => {
    for (const status of ['starting', 'working', 'analyzing', 'active']) {
      expect(deriveSessionTaskStatus({ status }).kind).toBe('working');
    }
    expect(deriveSessionTaskStatus({ status: 'working', busySinceAt: T0, lastTurn: delivered(T0 - 1) }))
      .toEqual({ kind: 'working', since: T0 });
  });

  it('idle after an interrupted turn needs you, with the error code', () => {
    expect(deriveSessionTaskStatus({
      status: 'idle', lastMessageAt: T0 - 10, lastTurn: { turnId: 't1', outcome: 'interrupted', at: T0, errorCode: 'api_error' },
    })).toEqual({ kind: 'needs_you', reason: 'interrupted', detail: 'api_error', at: T0 });
  });

  it('idle after a delivered turn is delivered, with time and first line', () => {
    expect(deriveSessionTaskStatus({ status: 'idle', lastMessageAt: T0 - 10, lastTurn: delivered(T0, 'PR 已开') }))
      .toEqual({ kind: 'delivered', at: T0, summary: 'PR 已开' });
    expect(deriveSessionTaskStatus({ status: 'dormant', lastTurn: delivered(T0) })).toEqual({ kind: 'delivered', at: T0 });
  });

  it('never reports delivered when the result cannot be read', () => {
    const unreadable: unknown[] = [
      undefined,
      null,
      'delivered',
      { outcome: 'delivered', at: T0 },
      { turnId: 't1', outcome: 'delivered' },
      { turnId: 't1', outcome: 'delivered', at: Number.NaN },
      { turnId: 't1', outcome: 'maybe', at: T0 },
      { turnId: 't1', outcome: 'no_output', at: T0 },
    ];
    for (const lastTurn of unreadable) {
      expect(deriveSessionTaskStatus({ status: 'idle', lastTurn }).kind).toBe('idle');
    }
  });

  it('a newer message makes the previous result stale instead of delivered', () => {
    const facts = { status: 'idle', lastMessageAt: T0 + 1, lastTurn: delivered(T0) };
    expect(currentLastTurn(facts)).toBeUndefined();
    expect(deriveSessionTaskStatus(facts).kind).toBe('idle');
    expect(deriveSessionTaskStatus({ ...facts, lastTurn: { turnId: 't1', outcome: 'interrupted', at: T0 } }).kind).toBe('idle');
  });

  it('maintenance activity covered by heldThrough does not make the result stale', () => {
    const held = { ...delivered(T0, '结论'), heldThrough: T0 + 5 };
    expect(deriveSessionTaskStatus({ status: 'idle', lastMessageAt: T0 + 5, lastTurn: held }).kind).toBe('delivered');
    expect(deriveSessionTaskStatus({ status: 'idle', lastMessageAt: T0 + 6, lastTurn: held }).kind).toBe('idle');
    expect(normalizeLastTurn({ ...delivered(T0), heldThrough: T0 })).toEqual(delivered(T0));
  });

  it('an interrupted turn of a session dormant for over 24 hours no longer needs you', () => {
    const interrupted = { turnId: 't1', outcome: 'interrupted', at: T0, errorCode: 'api_error' };
    expect(deriveSessionTaskStatus({ status: 'dormant', lastTurn: interrupted }, T0 + RECENT_TURN_WINDOW_MS - 1).kind).toBe('needs_you');
    expect(deriveSessionTaskStatus({ status: 'dormant', lastTurn: interrupted }, T0 + RECENT_TURN_WINDOW_MS)).toEqual({ kind: 'idle' });
    expect(deriveSessionTaskStatus({ status: 'dormant', lastTurn: interrupted, openTodos: { remaining: 2 } }, T0 + RECENT_TURN_WINDOW_MS).kind)
      .toBe('unfinished');
    expect(deriveSessionTaskStatus({ status: 'idle', lastTurn: interrupted }, T0 + 2 * RECENT_TURN_WINDOW_MS).kind).toBe('needs_you');
  });

  it('incomplete todos without a readable result are unfinished; delivered wins over todos', () => {
    expect(deriveSessionTaskStatus({ status: 'idle', openTodos: { remaining: 3 } })).toEqual({ kind: 'unfinished', remaining: 3 });
    expect(deriveSessionTaskStatus({ status: 'idle', openTodos: { remaining: 0 } }).kind).toBe('idle');
    expect(deriveSessionTaskStatus({ status: 'idle', openTodos: { remaining: 2 }, lastTurn: delivered(T0) }).kind).toBe('delivered');
  });

  it('normalizeLastTurn keeps only well-formed rows and drops blank optional text', () => {
    expect(normalizeLastTurn({ turnId: 't', outcome: 'delivered', at: T0, summary: '  ' })).toEqual({ turnId: 't', outcome: 'delivered', at: T0 });
    expect(normalizeLastTurn({ turnId: '', outcome: 'delivered', at: T0 })).toBeUndefined();
    expect(normalizeLastTurn({ turnId: 't', outcome: 'delivered', at: T0, startedAt: T0 - 5 })).toEqual({ turnId: 't', outcome: 'delivered', at: T0, startedAt: T0 - 5 });
    expect(normalizeLastTurn({ turnId: 't', outcome: 'delivered', at: T0, startedAt: T0 + 5 })).toEqual({ turnId: 't', outcome: 'delivered', at: T0 });
  });

  it('taskStatusChangedAt takes the newest of message, turn start, turn end and raised hand', () => {
    expect(taskStatusChangedAt({})).toBe(0);
    expect(taskStatusChangedAt({ lastMessageAt: T0, busySinceAt: T0 + 1, lastTurn: delivered(T0 + 2) })).toBe(T0 + 2);
    expect(taskStatusChangedAt({ lastMessageAt: T0, agentAttention: { kind: 'x', reason: 'y', at: T0 + 5 } })).toBe(T0 + 5);
  });
});

describe('replySummaryLine', () => {
  it('takes the first meaningful line without Markdown decoration', () => {
    expect(replySummaryLine('\n```ts\n## **结论**：已修好\n第二行')).toBe('结论：已修好');
    expect(replySummaryLine('---\n- `a` 完成')).toBe('a 完成');
    expect(replySummaryLine('   ')).toBeUndefined();
    expect(replySummaryLine(42)).toBeUndefined();
  });

  it('caps long lines', () => {
    const line = replySummaryLine('x'.repeat(500), 10)!;
    expect(line).toHaveLength(10);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('kanban columns from task status', () => {
  it('delivered goes to done, interrupted to needs-you, unfinished to todo', () => {
    expect(deriveKanbanColumn({ status: 'idle', lastTurn: delivered(T0) })).toBe('done');
    expect(deriveKanbanColumn({ status: 'idle', lastTurn: { turnId: 't', outcome: 'interrupted', at: T0 } })).toBe('in_review');
    expect(deriveKanbanColumn({ status: 'idle', openTodos: { remaining: 1 } })).toBe('todo');
    expect(deriveKanbanColumn({ status: 'idle', lastTurn: { turnId: 't', outcome: 'no_output', at: T0 } })).toBe('todo');
  });

  it('queued sessions stay in the backlog until they start', () => {
    expect(deriveKanbanColumn({ status: 'idle', queued: true, kanbanColumn: 'in_progress', kanbanColumnAt: T0 })).toBe('backlog');
  });

  it('a manual column holds until the next task-state change', () => {
    const pinned = { status: 'idle', lastMessageAt: T0, lastTurn: delivered(T0 + 10), kanbanColumn: 'in_progress', kanbanColumnAt: T0 + 20 };
    expect(deriveKanbanColumn(pinned)).toBe('in_progress');
    // 新消息
    expect(deriveKanbanColumn({ ...pinned, lastMessageAt: T0 + 30 })).toBe('todo');
    // 新一轮开跑
    expect(deriveKanbanColumn({ ...pinned, status: 'working', busySinceAt: T0 + 30 })).toBe('in_progress');
    expect(activeManualColumn({ ...pinned, status: 'working', busySinceAt: T0 + 30 })).toBeNull();
    // 一轮结束
    expect(deriveKanbanColumn({ ...pinned, lastTurn: delivered(T0 + 30) })).toBe('done');
    // 举手
    expect(deriveKanbanColumn({ ...pinned, agentAttention: { kind: 'decision', reason: 'r', at: T0 + 30, source: 'agent' } })).toBe('in_review');
  });

  it('auto-compact activity covered by heldThrough is not a new message for a manual column', () => {
    const held = { ...delivered(T0 + 10), heldThrough: T0 + 60 };
    const parked = { status: 'idle', lastTurn: held, kanbanColumn: 'todo', kanbanColumnAt: T0 + 20 };
    expect(taskStatusChangedAt({ ...parked, lastMessageAt: T0 + 60 })).toBe(T0 + 10);
    expect(deriveKanbanColumn({ ...parked, lastMessageAt: T0 + 60 })).toBe('todo');
    expect(taskStatusChangedAt({ ...parked, lastMessageAt: T0 + 61 })).toBe(T0 + 61);
    expect(activeManualColumn({ ...parked, lastMessageAt: T0 + 61 })).toBeNull();
  });

  it('a manual column placed before the upgrade holds until a turn starts, ends or a hand is raised', () => {
    const legacy = { status: 'idle', lastMessageAt: T0, kanbanColumn: 'in_progress', kanbanPosition: 5 };
    expect(deriveKanbanColumn(legacy)).toBe('in_progress');
    expect(effectiveKanbanPosition(legacy)).toBe(5);
    expect(activeManualColumn({ ...legacy, status: 'working', busySinceAt: T0 + 10 })).toBeNull();
    expect(deriveKanbanColumn({ ...legacy, lastTurn: delivered(T0 + 10) })).toBe('done');
    expect(deriveKanbanColumn({ ...legacy, agentAttention: { kind: 'decision', reason: 'r', at: T0 + 10, source: 'agent' } })).toBe('in_review');
    const parked = { status: 'idle', lastMessageAt: T0, kanbanColumn: 'backlog' };
    expect(deriveKanbanColumn(parked)).toBe('backlog');
    expect(deriveKanbanColumn({ ...parked, lastTurn: delivered(T0 + 10) })).toBe('done');
  });

  it('a backlog pin lasts until the session starts, not until any activity', () => {
    const parked = { status: 'idle', lastMessageAt: T0 + 50, kanbanColumn: 'backlog', kanbanColumnAt: T0 };
    expect(deriveKanbanColumn(parked)).toBe('backlog');
    expect(deriveKanbanColumn({ ...parked, status: 'starting' })).toBe('in_progress');
    expect(deriveKanbanColumn({ ...parked, busySinceAt: T0 + 60 })).toBe('todo');
    expect(deriveKanbanColumn({ ...parked, lastTurn: delivered(T0 + 60) })).toBe('done');
    expect(deriveKanbanColumn({ ...parked, lastTurn: delivered(T0 - 60) })).toBe('backlog');
  });

  it('manual position only counts while the manual column is in force', () => {
    const pinned = { status: 'idle', lastMessageAt: T0, kanbanColumn: 'todo', kanbanColumnAt: T0, kanbanPosition: 5 };
    expect(effectiveKanbanPosition(pinned)).toBe(5);
    expect(effectiveKanbanPosition({ ...pinned, lastMessageAt: T0 + 1 })).toBe(effectiveKanbanPosition({ lastMessageAt: T0 + 1 }));
  });

  it('dormant sessions stay off the board unless their last turn ended within 24 hours', () => {
    const now = T0 + RECENT_TURN_ON_BOARD_MS;
    expect(isOffBoardDormant({ status: 'dormant' }, now)).toBe(true);
    expect(isOffBoardDormant({ status: 'dormant', lastTurn: delivered(T0 + 1) }, now)).toBe(false);
    expect(isOffBoardDormant({ status: 'dormant', lastTurn: delivered(T0) }, now)).toBe(true);
    expect(isOffBoardDormant({ status: 'dormant', lastTurn: { turnId: 't', outcome: 'interrupted', at: T0 + 1 } }, now)).toBe(false);
    expect(isOffBoardDormant({ status: 'idle' }, now)).toBe(false);
  });

  it('a dormant session with a manual column still in force stays on the board', () => {
    expect(isOffBoardDormant({ status: 'dormant', lastMessageAt: T0, kanbanColumn: 'todo', kanbanColumnAt: T0 }, T0 + 2 * RECENT_TURN_ON_BOARD_MS)).toBe(false);
    expect(isOffBoardDormant({ status: 'dormant', lastMessageAt: T0 + 1, kanbanColumn: 'todo', kanbanColumnAt: T0 }, T0 + 2 * RECENT_TURN_ON_BOARD_MS)).toBe(true);
  });
});

describe('table and card views share the derivation', () => {
  it('board signal follows the task kind', () => {
    expect(deriveSessionBoardColumn({ status: 'idle', lastTurn: delivered(T0) })).toBe('done');
    expect(deriveSessionBoardColumn({ status: 'idle', openTodos: { remaining: 1 } })).toBe('todo');
    expect(deriveSessionBoardColumn({ status: 'idle', agentAttention: { kind: 'blocked', reason: 'r', at: T0 } })).toBe('needs-you');
    expect(deriveSessionBoardColumn({ status: 'closed' })).toBeNull();
  });

  it('status filters match task kinds and keep old raw-status filter values working', () => {
    const row = { status: 'idle', lastTurn: delivered(T0) };
    expect(matchesStatusFilter(row, 'delivered')).toBe(true);
    expect(matchesStatusFilter(row, 'idle')).toBe(false);
    expect(matchesStatusFilter({ status: 'analyzing' }, 'working')).toBe(true);
    expect(matchesStatusFilter({ status: 'analyzing' }, 'analyzing')).toBe(true);
    expect(matchesStatusFilter({ status: 'limited' }, 'limited')).toBe(true);
    expect(matchesStatusFilter({ status: 'dormant' }, 'dormant')).toBe(true);
  });

  it('the card line carries the reply first line and the turn running time', () => {
    const deliveredLine = sessionTaskCardLine({ kind: 'delivered', at: T0, summary: 'PR #12 已开' }, T0 + 12 * 60_000);
    expect(deliveredLine).toMatchObject({ tone: 'done', detail: 'PR #12 已开' });
    expect(deliveredLine!.label).toMatch(/12/);
    const working = sessionTaskCardLine({ kind: 'working', since: T0 }, T0 + 3 * 60_000);
    expect(working).toMatchObject({ tone: 'work' });
    expect(`${working!.label} ${working!.detail ?? ''}`).toMatch(/3/);
    expect(sessionTaskCardLine({ kind: 'idle' }, T0)).toBeNull();
  });
});
