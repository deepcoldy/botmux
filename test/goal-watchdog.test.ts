import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS,
  GOAL_WATCHDOG_PROMPT_PREFIX,
  pendingGoalTasks,
  runGoalWatchdogForGoal,
  runGoalWatchdogOnce,
  shouldTriggerGoalWatchdogOnSessionBoundary,
} from '../src/core/goal-watchdog.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import { openLedger, type LedgerHandle } from '../src/verified-delivery/ledger.js';
import type { AcceptanceCriteria, TaskView } from '../src/verified-delivery/types.js';

function task(
  taskId: string,
  chatId: string | undefined,
  status: TaskView['status'],
  acceptanceCriteria?: AcceptanceCriteria,
  acceptanceHint?: string,
): TaskView {
  return { taskId, chatId, status, acceptanceCriteria, acceptanceHint, reports: [] };
}

function ledger(tasks: TaskView[]): LedgerHandle {
  return {
    tasks: (chatId?: string) => chatId ? tasks.filter((t) => t.chatId === chatId) : tasks,
    read: () => [],
    task: (taskId: string) => tasks.find((t) => t.taskId === taskId),
    append: (() => { throw new Error('not used'); }) as LedgerHandle['append'],
    writeInlineEvidence: (() => { throw new Error('not used'); }) as LedgerHandle['writeInlineEvidence'],
    readInlineEvidence: (() => { throw new Error('not used'); }) as LedgerHandle['readInlineEvidence'],
  };
}

function ds(input: {
  sessionId?: string;
  title?: string;
  chatId?: string;
  larkAppId?: string;
  status?: DaemonSession['lastScreenStatus'];
}): DaemonSession {
  const chatId = input.chatId ?? 'oc_goal';
  const larkAppId = input.larkAppId ?? 'cli_main';
  return {
    session: {
      sessionId: input.sessionId ?? 's1',
      chatId,
      rootMessageId: chatId,
      scope: 'chat',
      title: input.title ?? '[Goal] Demo',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      larkAppId,
    },
    worker: input.status ? ({ killed: false } as any) : null,
    workerPort: null,
    workerToken: null,
    larkAppId,
    chatId,
    chatType: 'group',
    scope: 'chat',
    spawnedAt: 0,
    cliVersion: 'test',
    lastMessageAt: 0,
    hasHistory: false,
    lastScreenStatus: input.status,
  };
}

describe('goal watchdog', () => {
  it('groups only dispatched/rejected tasks by goal chat', () => {
    const grouped = pendingGoalTasks([
      task('t1', 'oc_a', 'dispatched'),
      task('t2', 'oc_a', 'rejected'),
      task('t3', 'oc_a', 'reported'),
      task('t4', 'oc_b', 'accepted'),
      task('t5', undefined, 'dispatched'),
    ]);

    expect([...grouped.keys()]).toEqual(['oc_a']);
    expect(grouped.get('oc_a')?.map((t) => t.taskId)).toEqual(['t1', 't2']);
  });

  it('injects only into an active chat-scope goal supervisor session', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
    // A worker/chat session in the same goal must not be mistaken for L2.
    activeSessions.set(sessionKey('oc_goal', 'cli_worker'), ds({
      chatId: 'oc_goal',
      larkAppId: 'cli_worker',
      title: 'worker task',
    }));
    const injected: Array<{ sessionId: string; prompt: string }> = [];

    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t1', 'oc_goal', 'dispatched')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      inject: (target, prompt) => injected.push({ sessionId: target.session.sessionId, prompt }),
    });

    expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'injected', pendingTaskIds: ['t1'], sessionId: 's1' }]);
    expect(injected).toHaveLength(1);
    expect(injected[0].prompt).toContain(GOAL_WATCHDOG_PROMPT_PREFIX);
    expect(injected[0].prompt).toContain('t1');
  });

  it('falls back to L2 prompt for legacy free-text acceptance hints', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
    const injected: Array<{ prompt: string }> = [];

    await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t-legacy', 'oc_goal', 'dispatched', undefined, '人工验收: 读取结果文件并确认 PASS')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      inject: (_target, prompt) => injected.push({ prompt }),
    });

    expect(injected).toHaveLength(1);
    expect(injected[0].prompt).toContain(GOAL_WATCHDOG_PROMPT_PREFIX);
    expect(injected[0].prompt).toContain('t-legacy');
    expect(injected[0].prompt).toContain('acceptanceHint=人工验收: 读取结果文件并确认 PASS');
  });

  it('skips a busy L2 and rate-limits repeated injections', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main', status: 'working' }));

    const busy = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t1', 'oc_goal', 'dispatched')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      inject: () => { throw new Error('should not inject'); },
    });
    expect(busy[0].status).toBe('busy');

    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
    const rateLimited = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t1', 'oc_goal', 'dispatched')]),
      now: 11_000,
      intervalMs: 5_000,
      lastInjectedAt: new Map([['oc_goal', 10_000]]),
      inject: () => { throw new Error('should not inject'); },
    });
    expect(rateLimited[0].status).toBe('rate-limited');
  });

  it('event trigger scopes to one goal and uses the short cooldown', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_a', 'cli_main'), ds({ chatId: 'oc_a', larkAppId: 'cli_main', sessionId: 'sa' }));
    activeSessions.set(sessionKey('oc_b', 'cli_main'), ds({ chatId: 'oc_b', larkAppId: 'cli_main', sessionId: 'sb' }));
    const injected: Array<{ sessionId: string; prompt: string }> = [];

    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([
        task('ta', 'oc_a', 'dispatched'),
        task('tb', 'oc_b', 'dispatched'),
      ]),
      goalChatIds: ['oc_b'],
      now: 10_000,
      intervalMs: DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS,
      lastInjectedAt: new Map([['oc_b', 10_000 - DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS - 1]]),
      inject: (target, prompt) => injected.push({ sessionId: target.session.sessionId, prompt }),
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ goalChatId: 'oc_b', status: 'injected', pendingTaskIds: ['tb'], sessionId: 'sb' });
    expect(injected).toHaveLength(1);
    expect(injected[0].sessionId).toBe('sb');

    const throttled = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('tb', 'oc_b', 'dispatched')]),
      goalChatIds: ['oc_b'],
      now: 10_000,
      intervalMs: DEFAULT_GOAL_WATCHDOG_EVENT_COOLDOWN_MS,
      lastInjectedAt: new Map([['oc_b', 9_999]]),
      inject: () => { throw new Error('should not inject'); },
    });
    expect(throttled[0].status).toBe('rate-limited');
  });

  it('runGoalWatchdogForGoal targets only the requested goal', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_a', 'cli_main'), ds({ chatId: 'oc_a', larkAppId: 'cli_main', sessionId: 'sa' }));
    activeSessions.set(sessionKey('oc_b', 'cli_main'), ds({ chatId: 'oc_b', larkAppId: 'cli_main', sessionId: 'sb' }));

    const results = await runGoalWatchdogForGoal({
      larkAppId: 'cli_main',
      activeSessions,
      goalChatId: 'oc_missing',
      now: 10_000,
      cooldownMs: 1,
    });

    expect(results).toEqual([]);
  });

  it('does not trigger event watchdog from the L2 supervisor session boundary', () => {
    expect(shouldTriggerGoalWatchdogOnSessionBoundary(ds({
      chatId: 'oc_goal',
      title: '[Goal] Live E2E',
      status: 'idle',
    }))).toBe(false);
    expect(shouldTriggerGoalWatchdogOnSessionBoundary(ds({
      chatId: 'oc_goal',
      title: 'worker task',
      status: 'idle',
    }))).toBe(true);
  });

  it('reconciles structured passing tasks without waking L2', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-reconcile-'));
    try {
      const out = join(baseDir, 'done.txt');
      writeFileSync(out, 'PASS');
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-pass',
        chatId: 'oc_goal',
        ts: 1,
        idempotencyKey: 'dispatched:task-pass',
        payload: {
          taskId: 'task-pass',
          workerOpenIds: ['ou_worker'],
          acceptanceCriteria: {
            version: 1,
            artifacts: [{ path: out, checks: [{ type: 'exists' }, { type: 'contains', text: 'PASS' }] }],
          },
        },
      });
      const notifications: any[] = [];
      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions: new Map(),
        ledger: led,
        now: 10_000,
        lastInjectedAt: new Map(),
        inject: () => { throw new Error('should not inject L2 for structured pass'); },
        notify: (event) => notifications.push(event),
      });

      expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'reconciled', pendingTaskIds: ['task-pass'] }]);
      expect(notifications.map((n) => n.kind)).toEqual(['accepted']);
      expect(led.task('task-pass')?.status).toBe('accepted');
      expect(led.task('task-pass')?.reports).toHaveLength(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('nudges structured failing tasks and rate-limits repeated nudges', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-nudge-'));
    try {
      const missing = join(baseDir, 'missing.txt');
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-fail',
        chatId: 'oc_goal',
        ts: 1,
        idempotencyKey: 'dispatched:task-fail',
        payload: {
          taskId: 'task-fail',
          workerOpenIds: ['ou_worker'],
          acceptanceCriteria: {
            version: 1,
            artifacts: [{ path: missing, checks: [{ type: 'exists' }] }],
          },
        },
      });
      const lastInjectedAt = new Map<string, number>();
      const notifications: any[] = [];
      const first = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions: new Map(),
        ledger: led,
        now: 10_000,
        intervalMs: 30_000,
        lastInjectedAt,
        notify: (event) => notifications.push(event),
      });
      const second = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions: new Map(),
        ledger: led,
        now: 20_000,
        intervalMs: 30_000,
        lastInjectedAt,
        notify: (event) => notifications.push(event),
      });

      expect(first).toMatchObject([{ status: 'reconciled', pendingTaskIds: ['task-fail'] }]);
      expect(second).toMatchObject([{ status: 'rate-limited', pendingTaskIds: ['task-fail'] }]);
      expect(notifications.map((n) => n.kind)).toEqual(['nudge']);
      expect(led.task('task-fail')?.status).toBe('dispatched');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
