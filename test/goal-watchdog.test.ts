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
  worker?: 'live' | 'none' | 'killed';
  suspendedColdResume?: boolean;
}): DaemonSession {
  const chatId = input.chatId ?? 'oc_goal';
  const larkAppId = input.larkAppId ?? 'cli_main';
  const workerMode = input.worker ?? 'live';
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
      suspendedColdResume: input.suspendedColdResume,
    },
    worker: workerMode === 'none' ? null : ({ killed: workerMode === 'killed' } as any),
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
    lastScreenStatus: input.status ?? (workerMode === 'live' ? 'idle' : undefined),
  };
}

describe('goal watchdog', () => {
  it('groups non-accepted tasks by goal chat', () => {
    const grouped = pendingGoalTasks([
      task('t1', 'oc_a', 'dispatched'),
      task('t2', 'oc_a', 'rejected'),
      task('t3', 'oc_a', 'reported'),
      task('t4', 'oc_b', 'accepted'),
      task('t5', undefined, 'dispatched'),
      task('', 'oc_a', 'dispatched'),
      { ...task('t6', 'oc_a', 'blocked'), help: { blocker: '缺权限', kind: 'access', workerOpenId: 'ou_w' } },
      { ...task('t7', 'oc_a', 'escalated'), escalation: { reason: '需要人拍' } },
    ]);

    expect([...grouped.keys()]).toEqual(['oc_a']);
    expect(grouped.get('oc_a')?.map((t) => t.taskId)).toEqual(['t1', 't2', 't3', 't6']);
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
    expect(injected[0].prompt).toContain('bucket=inProgress');
    expect(injected[0].prompt).toContain('reason=dispatched');
    expect(injected[0].prompt).toContain('next=等 worker 干活/report');
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

  it('adds worker health facts to L2 fallback prompts', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
    const injected: Array<{ prompt: string }> = [];

    await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([{ ...task('t-health', 'oc_goal', 'dispatched'), workerOpenIds: ['ou_worker'], workerNames: ['worker-a'] }]),
      now: 10_000,
      lastInjectedAt: new Map(),
      workerHealthFacts: (t, goalChatId) => [
        [
          '[worker-health]',
          `taskId: ${t.taskId}`,
          `goalChatId: ${goalChatId}`,
          'session: missing',
          'workerProcess: unknown',
        ].join('\n'),
      ],
      inject: (_target, prompt) => injected.push({ prompt }),
    });

    expect(injected).toHaveLength(1);
    expect(injected[0].prompt).toContain('[worker-health]');
    expect(injected[0].prompt).toContain('session: missing');
    expect(injected[0].prompt).toContain('workerProcess: unknown');
  });

  it('routes blocked help requests to L2 and parks escalated tasks', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
    const injected: Array<{ prompt: string }> = [];

    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([
        { ...task('t-blocked', 'oc_goal', 'blocked'), help: { blocker: '缺数据库权限', kind: 'access', workerOpenId: 'ou_worker' } },
        { ...task('t-escalated', 'oc_goal', 'escalated'), escalation: { reason: '需要人确认范围' } },
      ]),
      now: 10_000,
      lastInjectedAt: new Map(),
      inject: (_target, prompt) => injected.push({ prompt }),
    });

    expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'injected', pendingTaskIds: ['t-blocked'] }]);
    expect(injected).toHaveLength(1);
    expect(injected[0].prompt).toContain('t-blocked');
    expect(injected[0].prompt).toContain('helpKind=access');
    expect(injected[0].prompt).toContain('blocker=缺数据库权限');
    expect(injected[0].prompt).not.toContain('t-escalated');
  });

  it('does not inject L2 for reported legacy tasks', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));

    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t-reported-legacy', 'oc_goal', 'reported', undefined, '人工验收')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      inject: () => { throw new Error('reported legacy should be handled by report wake path, not watchdog L2 fallback'); },
    });

    expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'empty', pendingTaskIds: [] }]);
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

  it('event trigger scopes to one goal and honors the shared cooldown', async () => {
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

  it('routes structured passing tasks without reports to L2 instead of auto-accepting', async () => {
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
      const activeSessions = new Map<string, DaemonSession>();
      activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
      const notifications: any[] = [];
      const injected: Array<{ prompt: string }> = [];
      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 10_000,
        lastInjectedAt: new Map(),
        inject: (_target, prompt) => injected.push({ prompt }),
        notify: (event) => notifications.push(event),
      });

      expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'injected', pendingTaskIds: ['task-pass'] }]);
      expect(notifications).toHaveLength(0);
      expect(injected).toHaveLength(1);
      expect(injected[0].prompt).toContain('inspectionFact');
      expect(injected[0].prompt).toContain('worker 未走 botmux report 正式交付');
      expect(led.task('task-pass')?.status).toBe('dispatched');
      expect(led.task('task-pass')?.reports).toHaveLength(0);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('reconciles structured reported tasks using the existing report', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-reported-'));
    try {
      const out = join(baseDir, 'done.txt');
      writeFileSync(out, 'PASS');
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-reported',
        chatId: 'oc_goal',
        ts: 1,
        idempotencyKey: 'dispatched:task-reported',
        payload: {
          taskId: 'task-reported',
          workerOpenIds: ['ou_worker'],
          acceptanceCriteria: {
            version: 1,
            artifacts: [{ path: out, checks: [{ type: 'exists' }, { type: 'contains', text: 'PASS' }] }],
          },
        },
      });
      led.append({
        type: 'TaskReported',
        actor: 'worker',
        taskId: 'task-reported',
        chatId: 'oc_goal',
        ts: 2,
        idempotencyKey: 'reported:report-existing',
        payload: {
          taskId: 'task-reported',
          reportId: 'report-existing',
          workerOpenId: 'ou_worker',
          evidence: [{ kind: 'path', path: out }],
          summary: 'worker reported PASS',
        },
      });
      const notifications: any[] = [];
      const activeSessions = new Map<string, DaemonSession>();
      activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 20_000,
        lastInjectedAt: new Map(),
        inject: () => { throw new Error('should not inject L2 for structured report'); },
        notify: (event) => notifications.push(event),
      });

      expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'reconciled', pendingTaskIds: ['task-reported'] }]);
      expect(notifications.map((n) => [n.kind, n.result.reportId])).toEqual([['accepted', 'report-existing']]);
      expect(led.task('task-reported')?.status).toBe('accepted');
      expect(led.task('task-reported')?.reports).toHaveLength(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not reconcile a fresh report before the report grace window expires', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-report-grace-'));
    try {
      const out = join(baseDir, 'not-yet-visible.txt');
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-fresh-report',
        chatId: 'oc_goal',
        ts: 1_000,
        idempotencyKey: 'dispatched:task-fresh-report',
        payload: {
          taskId: 'task-fresh-report',
          workerOpenIds: ['ou_worker'],
          acceptanceCriteria: {
            version: 1,
            artifacts: [{ path: out, checks: [{ type: 'exists' }] }],
          },
        },
      });
      led.append({
        type: 'TaskReported',
        actor: 'worker',
        taskId: 'task-fresh-report',
        chatId: 'oc_goal',
        ts: 9_500,
        idempotencyKey: 'reported:report-fresh',
        payload: {
          taskId: 'task-fresh-report',
          reportId: 'report-fresh',
          workerOpenId: 'ou_worker',
          evidence: [{ kind: 'path', path: out }],
          summary: 'worker reported before file became visible',
        },
      });
      const activeSessions = new Map<string, DaemonSession>();
      activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));

      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 10_000,
        reportGraceMs: 15_000,
        lastInjectedAt: new Map(),
        inject: () => { throw new Error('fresh reports must not trigger L2 fallback'); },
        notify: () => { throw new Error('fresh reports must not be auto-rejected'); },
      });

      expect(results).toMatchObject([{
        goalChatId: 'oc_goal',
        status: 'grace',
        pendingTaskIds: ['task-fresh-report'],
      }]);
      expect(led.task('task-fresh-report')?.status).toBe('reported');
      expect(led.task('task-fresh-report')?.reports[0]?.verdict).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not reconcile or notify from a daemon that does not own the L2 supervisor', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-no-l2-'));
    try {
      const out = join(baseDir, 'done.txt');
      writeFileSync(out, 'PASS');
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-reported',
        chatId: 'oc_goal',
        ts: 1,
        idempotencyKey: 'dispatched:task-reported',
        payload: {
          taskId: 'task-reported',
          workerOpenIds: ['ou_worker'],
          acceptanceCriteria: {
            version: 1,
            artifacts: [{ path: out, checks: [{ type: 'exists' }, { type: 'contains', text: 'PASS' }] }],
          },
        },
      });
      led.append({
        type: 'TaskReported',
        actor: 'worker',
        taskId: 'task-reported',
        chatId: 'oc_goal',
        ts: 2,
        idempotencyKey: 'reported:report-existing',
        payload: {
          taskId: 'task-reported',
          reportId: 'report-existing',
          workerOpenId: 'ou_worker',
          evidence: [{ kind: 'path', path: out }],
          summary: 'worker reported PASS',
        },
      });

      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_worker',
        activeSessions: new Map(),
        ledger: led,
        now: 10_000,
        lastInjectedAt: new Map(),
        notify: () => { throw new Error('non-L2 daemon must not notify'); },
        inject: () => { throw new Error('non-L2 daemon must not inject'); },
      });

      expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'no-l2', pendingTaskIds: ['task-reported'] }]);
      expect(led.task('task-reported')?.status).toBe('reported');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('tries to revive a missing L2 supervisor before falling back to no-l2', async () => {
    const calls: string[] = [];
    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions: new Map(),
      ledger: ledger([task('t1', 'oc_goal', 'dispatched')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      reviveSupervisor: (goalChatId) => {
        calls.push(goalChatId);
        return { ok: true, status: 'revived', sessionId: 'l2-new' };
      },
      inject: () => { throw new Error('freshly revived L2 should take the next watchdog turn'); },
    });

    expect(calls).toEqual(['oc_goal']);
    expect(results).toEqual([{
      goalChatId: 'oc_goal',
      status: 'revived',
      pendingTaskIds: ['t1'],
      sessionId: 'l2-new',
      reason: 'revived',
    }]);
  });

  it('cold-wakes a suspended L2 supervisor session instead of creating a new one', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({
      chatId: 'oc_goal',
      larkAppId: 'cli_main',
      sessionId: 'l2-suspended',
      worker: 'none',
      suspendedColdResume: true,
    }));
    const injected: Array<{ sessionId: string; prompt: string }> = [];
    const reviveCalls: string[] = [];

    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t-reported-legacy', 'oc_goal', 'reported', undefined, '人工验收')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      reviveSupervisor: (goalChatId) => {
        reviveCalls.push(goalChatId);
        return { ok: true, status: 'revived', sessionId: 'should-not-create' };
      },
      inject: (target, prompt) => injected.push({ sessionId: target.session.sessionId, prompt }),
    });

    expect(reviveCalls).toEqual([]);
    expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'injected', pendingTaskIds: ['t-reported-legacy'], sessionId: 'l2-suspended' }]);
    expect(injected).toHaveLength(1);
    expect(injected[0].sessionId).toBe('l2-suspended');
    expect(injected[0].prompt).toContain('冷唤醒 L2 人工验收');
  });

  it('revives through the registry when an L2 record remains but its worker is dead', async () => {
    const activeSessions = new Map<string, DaemonSession>();
    activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({
      chatId: 'oc_goal',
      larkAppId: 'cli_main',
      sessionId: 'l2-zombie',
      worker: 'none',
      suspendedColdResume: false,
    }));
    const calls: string[] = [];

    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions,
      ledger: ledger([task('t1', 'oc_goal', 'dispatched')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      reviveSupervisor: (goalChatId) => {
        calls.push(goalChatId);
        return { ok: true, status: 'revived', sessionId: 'l2-new' };
      },
      inject: () => { throw new Error('dead non-suspended L2 must not be injected as active'); },
    });

    expect(calls).toEqual(['oc_goal']);
    expect(results).toEqual([{
      goalChatId: 'oc_goal',
      status: 'revived',
      pendingTaskIds: ['t1'],
      sessionId: 'l2-new',
      reason: 'stale-supervisor:revived',
    }]);
  });

  it('surfaces revive cooldown or budget failures without random daemon injection', async () => {
    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions: new Map(),
      ledger: ledger([task('t1', 'oc_goal', 'dispatched')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      reviveSupervisor: () => ({ ok: false, errorCode: 'revive_cooldown', error: 'last revive was 1000ms ago' }),
      inject: () => { throw new Error('revive failure must not inject without L2'); },
      notify: () => { throw new Error('revive failure must not notify without L2'); },
    });

    expect(results).toEqual([{
      goalChatId: 'oc_goal',
      status: 'revive-skipped',
      pendingTaskIds: ['t1'],
      reason: 'revive_cooldown: last revive was 1000ms ago',
    }]);
  });

  it('calls the revive failure hook so budget exhaustion can page a human', async () => {
    const failures: any[] = [];
    const results = await runGoalWatchdogOnce({
      larkAppId: 'cli_main',
      activeSessions: new Map(),
      ledger: ledger([task('t-budget', 'oc_goal', 'dispatched')]),
      now: 10_000,
      lastInjectedAt: new Map(),
      reviveSupervisor: () => ({ ok: false, errorCode: 'revive_budget_exhausted', error: '3 revive attempts in 10m' }),
      onReviveFailure: (event) => failures.push(event),
      inject: () => { throw new Error('revive failure must not inject without L2'); },
      notify: () => { throw new Error('revive failure must not notify without L2'); },
    });

    expect(results).toEqual([{
      goalChatId: 'oc_goal',
      status: 'revive-skipped',
      pendingTaskIds: ['t-budget'],
      reason: 'revive_budget_exhausted: 3 revive attempts in 10m',
    }]);
    expect(failures).toEqual([{
      goalChatId: 'oc_goal',
      errorCode: 'revive_budget_exhausted',
      error: '3 revive attempts in 10m',
      pendingTaskIds: ['t-budget'],
    }]);
  });

  it('hands structured failing tasks to L2 and rate-limits repeated injections', async () => {
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
      const injected: string[] = [];
      const activeSessions = new Map<string, DaemonSession>();
      activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
      const first = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 10_000,
        intervalMs: 30_000,
        lastInjectedAt,
        notify: (event) => notifications.push(event),
        inject: (_target, prompt) => injected.push(prompt),
      });
      const second = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 20_000,
        intervalMs: 30_000,
        lastInjectedAt,
        notify: (event) => notifications.push(event),
        inject: () => { throw new Error('should be rate-limited'); },
      });

      expect(first).toMatchObject([{ status: 'injected', pendingTaskIds: ['task-fail'] }]);
      expect(second).toMatchObject([{ status: 'rate-limited', pendingTaskIds: ['task-fail'] }]);
      expect(notifications).toEqual([]);
      expect(injected).toHaveLength(1);
      expect(injected[0]).toContain('task-fail');
      expect(injected[0]).toContain('未通过明细');
      expect(injected[0]).toContain('不要机械重复催促');
      expect(led.task('task-fail')?.status).toBe('dispatched');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('deterministically reassigns stale dispatched tasks before prompting L2', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-reassign-'));
    try {
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-dead',
        chatId: 'oc_goal',
        ts: 1,
        idempotencyKey: 'dispatched:task-dead',
        payload: {
          taskId: 'task-dead',
          workerOpenIds: ['ou_worker'],
          workerNames: ['dead-worker'],
          workerLarkAppIds: ['cli_dead'],
          workerCliIds: ['codex'],
        },
      });
      const activeSessions = new Map<string, DaemonSession>();
      activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
      const reassigned: string[] = [];
      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 10 * 60_000,
        reassignGraceMs: 60_000,
        lastInjectedAt: new Map(),
        reassignDeadWorker: (task, goalChatId) => {
          reassigned.push(`${goalChatId}:${task.taskId}`);
          return { status: 'reassigned', reason: 'worker_killed' };
        },
        inject: () => { throw new Error('reassigned task must not also wake L2'); },
      });

      expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'reassigned', pendingTaskIds: ['task-dead'] }]);
      expect(reassigned).toEqual(['oc_goal:task-dead']);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('does not reassign freshly dispatched tasks inside the grace window', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'goal-watchdog-reassign-grace-'));
    try {
      const led = openLedger({ baseDir });
      led.append({
        type: 'TaskDispatched',
        actor: 'orchestrator',
        taskId: 'task-fresh',
        chatId: 'oc_goal',
        ts: 10_000,
        idempotencyKey: 'dispatched:task-fresh',
        payload: {
          taskId: 'task-fresh',
          workerOpenIds: ['ou_worker'],
          workerLarkAppIds: ['cli_dead'],
        },
      });
      const activeSessions = new Map<string, DaemonSession>();
      activeSessions.set(sessionKey('oc_goal', 'cli_main'), ds({ chatId: 'oc_goal', larkAppId: 'cli_main' }));
      const injected: string[] = [];
      const results = await runGoalWatchdogOnce({
        larkAppId: 'cli_main',
        activeSessions,
        ledger: led,
        now: 20_000,
        reassignGraceMs: 60_000,
        lastInjectedAt: new Map(),
        reassignDeadWorker: () => { throw new Error('fresh dispatch must not reassign'); },
        inject: (_target, prompt) => injected.push(prompt),
      });

      expect(results).toMatchObject([{ goalChatId: 'oc_goal', status: 'injected', pendingTaskIds: ['task-fresh'] }]);
      expect(injected).toHaveLength(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
