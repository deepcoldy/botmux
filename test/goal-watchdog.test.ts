import { describe, expect, it } from 'vitest';
import {
  GOAL_WATCHDOG_PROMPT_PREFIX,
  pendingGoalTasks,
  runGoalWatchdogOnce,
} from '../src/core/goal-watchdog.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { LedgerHandle } from '../src/verified-delivery/ledger.js';
import type { TaskView } from '../src/verified-delivery/types.js';

function task(taskId: string, chatId: string | undefined, status: TaskView['status']): TaskView {
  return { taskId, chatId, status, reports: [] };
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
});
