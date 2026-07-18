import { buildDispatchMessages } from '../core/dispatch.js';
import type { DispatchReadinessResult } from '../core/a2a-readiness.js';
import { appendVerifiedDeliveryInstructions } from '../core/verified-delivery.js';
import {
  deriveTaskReleaseId,
  TASK_RELEASE_AUTO_RETRY_WINDOW_MS,
  type LedgerHandle,
} from './ledger.js';
import type {
  Evidence,
  TaskDispatchFailureClass,
  TaskDispatchIntentPayload,
  TaskDispatchedPayload,
  TaskPendingReleaseView,
  TaskReleaseDependency,
  TaskReportView,
  TaskView,
} from './types.js';

export type GoalReleaseCheckMode = 'trigger' | 'recovery';

export interface ReleaseSendInput {
  larkAppId: string;
  chatId: string;
  text: string;
  uuid: string;
  recovery: boolean;
}

export interface ReleaseEngineDeps {
  ledger: LedgerHandle;
  now: () => number;
  releasedBy: string;
  checkReadiness: (task: TaskView, pending: TaskPendingReleaseView) => Promise<DispatchReadinessResult>;
  send: (input: ReleaseSendInput) => Promise<string>;
}

export type TaskReleaseOutcome =
  | 'not-ready'
  | 'claimed'
  | 'open-intent'
  | 'already-dispatched'
  | 'dispatched'
  | 'failed-definite'
  | 'failed-ambiguous'
  | 'waiting-human'
  | 'stale';

export interface TaskReleaseResult {
  taskId: string;
  outcome: TaskReleaseOutcome;
  releaseId?: string;
  code?: string;
  detail?: string;
}

export interface FrozenReleaseClaim {
  expectedPlanEventId: string;
  expectedAcceptedEventIds: string[];
  intent: TaskDispatchIntentPayload;
}

function reportForAcceptedTask(task: TaskView): TaskReportView | undefined {
  if (!task.latestReportId) return undefined;
  return task.reports.find((report) => report.reportId === task.latestReportId);
}

function describeEvidence(evidence: Evidence): string {
  if (evidence.kind === 'url') return `URL ${evidence.url}`;
  if (evidence.kind === 'inline') return '内联证据已由监管者验收（内容未自动转发）';
  return `监管者机器上的路径 ${evidence.path}（不可跨设备访问）`;
}

export function buildUpstreamReleaseContext(dependencies: TaskView[]): string {
  const lines = [
    '— 上游产出 —',
    '本任务依赖以下已验收任务：',
  ];
  for (const dependency of dependencies) {
    const report = reportForAcceptedTask(dependency);
    const title = dependency.title?.trim() || dependency.taskId;
    if (!report) {
      lines.push(`- ${dependency.taskId} ${title}：已验收；无可用提交摘要`);
      continue;
    }
    lines.push(`- ${dependency.taskId} ${title}（report ${report.reportId}）：${report.summary}`);
    if (report.evidence.length === 0) {
      lines.push('  证据：未记录');
    } else {
      for (const evidence of report.evidence) lines.push(`  证据：${describeEvidence(evidence)}`);
    }
  }
  lines.push('需要完整产物时向监管者索取；不要假设上述路径在本机可达。');
  return lines.join('\n');
}

function optionalAligned(values: Array<string | undefined>): string[] | undefined {
  const normalized = values.map((value) => value?.trim() || '');
  return normalized.some(Boolean) ? normalized : undefined;
}

export function buildTaskReleaseClaim(input: {
  ledger: LedgerHandle;
  taskId: string;
  attempt: number;
  releasedBy: string;
}): FrozenReleaseClaim | undefined {
  const task = input.ledger.task(input.taskId);
  if (!task?.plan || task.status !== 'planned' || !task.chatId) return undefined;

  const dependencies: TaskView[] = [];
  const satisfiedBy: TaskReleaseDependency[] = [];
  for (const dependencyId of task.plan.dependsOnTaskIds) {
    const dependency = input.ledger.task(dependencyId);
    if (dependency?.status !== 'accepted' || !dependency.acceptedEventId) return undefined;
    dependencies.push(dependency);
    satisfiedBy.push({ taskId: dependencyId, acceptedEventId: dependency.acceptedEventId });
  }

  const spec = task.plan.dispatchSpec;
  const releaseId = deriveTaskReleaseId(
    task.plan.planEventId,
    satisfiedBy.map((dependency) => dependency.acceptedEventId),
    input.attempt,
  );
  const upstreamContext = buildUpstreamReleaseContext(dependencies);
  const briefWithUpstream = spec.briefBase.trimEnd()
    ? `${spec.briefBase.trimEnd()}\n\n${upstreamContext}`
    : upstreamContext;
  const brief = appendVerifiedDeliveryInstructions({
    brief: briefWithUpstream,
    taskId: task.taskId,
    acceptanceHint: spec.acceptanceHint,
  });
  const messages = buildDispatchMessages({
    title: spec.title,
    brief,
    bots: spec.workers.map((worker) => ({
      openId: worker.openId,
      name: worker.name,
      role: worker.role,
    })),
    repoRequirement: spec.requiredRepo ? { taskId: task.taskId, repo: spec.requiredRepo } : undefined,
  });
  const workerNames = spec.workers.map((worker) => worker.name?.trim() || worker.openId);
  const dispatchedPayload: TaskDispatchedPayload = {
    taskId: task.taskId,
    title: spec.title,
    workerOpenIds: spec.workers.map((worker) => worker.openId),
    workerNames,
    workerLarkAppIds: optionalAligned(spec.workers.map((worker) => worker.larkAppId)),
    workerCliIds: optionalAligned(spec.workers.map((worker) => worker.cliId)),
    workerBotUnionIds: optionalAligned(spec.workers.map((worker) => worker.unionId)),
    requiredRepo: spec.requiredRepo,
    brief,
    acceptanceHint: spec.acceptanceHint,
    acceptanceCriteria: spec.acceptanceCriteria,
    releaseId,
  };
  return {
    expectedPlanEventId: task.plan.planEventId,
    expectedAcceptedEventIds: satisfiedBy.map((dependency) => dependency.acceptedEventId),
    intent: {
      taskId: task.taskId,
      releaseId,
      attempt: input.attempt,
      planEventId: task.plan.planEventId,
      planGeneration: task.plan.planGeneration,
      satisfiedBy,
      senderLarkAppId: spec.senderLarkAppId,
      goalChatId: task.chatId,
      frozenKickoffText: messages.kickoffText,
      frozenWorkerSpecs: spec.workers,
      frozenDispatchedPayload: dispatchedPayload,
      releasedBy: input.releasedBy,
    },
  };
}

export function classifyReleaseSendFailure(error: unknown): {
  failureClass: TaskDispatchFailureClass;
  code: string;
  detail: string;
} {
  const err = error as {
    message?: string;
    code?: string | number;
    response?: { status?: number; data?: { code?: string | number; msg?: string } };
  };
  const detail = err?.message?.trim() || String(error);
  const status = Number(err?.response?.status);
  const responseCode = err?.response?.data?.code;
  const messageCode = detail.match(/\(code:\s*([^\s)]+)\)/i)?.[1];
  const code = responseCode ?? messageCode ?? err?.code;
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return { failureClass: 'definite', code: `http:${status}`, detail };
  }
  if (Number.isFinite(status) && status >= 500) {
    return { failureClass: 'ambiguous', code: `http:${status}`, detail };
  }
  if (code !== undefined && code !== '' && !String(code).match(/^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)$/i)) {
    return { failureClass: 'definite', code: `lark:${String(code)}`, detail };
  }
  const normalizedCode = String(code ?? '').toLowerCase();
  const timeout = normalizedCode.includes('timeout') || /timeout|timed out|abort/i.test(detail);
  return {
    failureClass: 'ambiguous',
    code: timeout ? 'net:timeout' : 'net:unknown',
    detail,
  };
}

function appendReleaseFailure(input: {
  deps: ReleaseEngineDeps;
  pending: TaskPendingReleaseView;
  failureClass: TaskDispatchFailureClass;
  code: string;
  detail: string;
}): boolean {
  const { deps, pending } = input;
  try {
    deps.ledger.append({
      type: 'TaskDispatchFailed',
      actor: 'orchestrator',
      taskId: pending.frozenDispatchedPayload.taskId,
      chatId: pending.goalChatId,
      ts: deps.now(),
      idempotencyKey: `dispatch-failed:${pending.releaseId}:${input.failureClass}`,
      payload: {
        taskId: pending.frozenDispatchedPayload.taskId,
        releaseId: pending.releaseId,
        planEventId: pending.planEventId,
        planGeneration: pending.planGeneration,
        attempt: pending.attempt,
        failureClass: input.failureClass,
        code: input.code,
        detail: input.detail,
        failedBy: deps.releasedBy,
      },
    });
    return true;
  } catch (error) {
    const current = deps.ledger.task(pending.frozenDispatchedPayload.taskId);
    if (current?.latestReleaseId === pending.releaseId && current.status !== 'planned') return false;
    throw error;
  }
}

function appendReleasedDispatch(input: {
  ledger: LedgerHandle;
  pending: TaskPendingReleaseView;
  ts: number;
  messageId?: string;
  confirmedBy?: string;
}): 'appended' | 'stale' {
  const { ledger, pending } = input;
  const taskId = pending.frozenDispatchedPayload.taskId;
  try {
    ledger.append({
      type: 'TaskDispatched',
      actor: 'orchestrator',
      taskId,
      chatId: pending.goalChatId,
      ts: input.ts,
      idempotencyKey: `dispatched:release:${pending.releaseId}`,
      payload: {
        ...pending.frozenDispatchedPayload,
        ...(input.messageId ? { dispatchMessageId: input.messageId } : {}),
        ...(input.confirmedBy ? { confirmedBy: input.confirmedBy } : {}),
      },
    });
    return 'appended';
  } catch (error) {
    const current = ledger.task(taskId);
    const sameOpenRelease = current?.status === 'planned'
      && current.pendingRelease?.releaseId === pending.releaseId;
    if (!sameOpenRelease) return 'stale';
    throw error;
  }
}

async function executePendingRelease(input: {
  task: TaskView;
  pending: TaskPendingReleaseView;
  recovery: boolean;
  deps: ReleaseEngineDeps;
}): Promise<TaskReleaseResult> {
  const { task, pending, deps } = input;
  let readiness: DispatchReadinessResult;
  try {
    readiness = await deps.checkReadiness(task, pending);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const persisted = appendReleaseFailure({
      deps,
      pending,
      failureClass: 'ambiguous',
      code: 'readiness:probe_failed',
      detail,
    });
    return persisted
      ? { taskId: task.taskId, outcome: 'failed-ambiguous', releaseId: pending.releaseId, code: 'readiness:probe_failed', detail }
      : { taskId: task.taskId, outcome: 'already-dispatched', releaseId: pending.releaseId };
  }
  const readinessErrors = readiness.issues.filter((issue) => issue.severity === 'error');
  if (readinessErrors.length > 0) {
    const code = `readiness:${readinessErrors[0]!.code}`;
    const detail = readinessErrors.map((issue) => issue.detail).join('；');
    const persisted = appendReleaseFailure({ deps, pending, failureClass: 'definite', code, detail });
    return persisted
      ? { taskId: task.taskId, outcome: 'failed-definite', releaseId: pending.releaseId, code, detail }
      : { taskId: task.taskId, outcome: 'already-dispatched', releaseId: pending.releaseId };
  }

  let messageId: string;
  try {
    messageId = await deps.send({
      larkAppId: pending.senderLarkAppId,
      chatId: pending.goalChatId,
      text: pending.frozenKickoffText,
      uuid: pending.releaseId,
      recovery: input.recovery,
    });
  } catch (error) {
    const failure = classifyReleaseSendFailure(error);
    const persisted = appendReleaseFailure({ deps, pending, ...failure });
    if (!persisted) return { taskId: task.taskId, outcome: 'already-dispatched', releaseId: pending.releaseId };
    return {
      taskId: task.taskId,
      outcome: failure.failureClass === 'definite' ? 'failed-definite' : 'failed-ambiguous',
      releaseId: pending.releaseId,
      code: failure.code,
      detail: failure.detail,
    };
  }

  const appendResult = appendReleasedDispatch({
    ledger: deps.ledger,
    pending,
    ts: deps.now(),
    messageId,
  });
  if (appendResult === 'stale') {
    return { taskId: task.taskId, outcome: 'stale', releaseId: pending.releaseId };
  }
  return { taskId: task.taskId, outcome: 'dispatched', releaseId: pending.releaseId };
}

function shouldRecoverPending(pending: TaskPendingReleaseView, now: number): boolean {
  if (pending.failure?.failureClass === 'definite') return false;
  return now - pending.intentAt < TASK_RELEASE_AUTO_RETRY_WINDOW_MS;
}

export async function runGoalReleaseCheck(input: {
  goalChatId: string;
  ownerLarkAppId: string;
  mode: GoalReleaseCheckMode;
  deps: ReleaseEngineDeps;
}): Promise<TaskReleaseResult[]> {
  const { deps } = input;
  const results: TaskReleaseResult[] = [];
  const tasks = deps.ledger.tasks(input.goalChatId)
    .filter((task) => task.status === 'planned' && task.plan?.dispatchSpec.senderLarkAppId === input.ownerLarkAppId);

  for (const initial of tasks) {
    if (initial.pendingRelease) {
      if (input.mode === 'trigger') {
        results.push({ taskId: initial.taskId, outcome: 'open-intent', releaseId: initial.pendingRelease.releaseId });
      } else if (!shouldRecoverPending(initial.pendingRelease, deps.now())) {
        results.push({ taskId: initial.taskId, outcome: 'waiting-human', releaseId: initial.pendingRelease.releaseId });
      } else {
        results.push(await executePendingRelease({ task: initial, pending: initial.pendingRelease, recovery: true, deps }));
      }
      continue;
    }

    let completed = false;
    for (let rebuild = 0; rebuild < 2 && !completed; rebuild++) {
      const frozen = buildTaskReleaseClaim({
        ledger: deps.ledger,
        taskId: initial.taskId,
        attempt: 0,
        releasedBy: deps.releasedBy,
      });
      if (!frozen) {
        results.push({ taskId: initial.taskId, outcome: 'not-ready' });
        completed = true;
        break;
      }
      const claim = deps.ledger.claimReadyPlan({
        taskId: initial.taskId,
        expectedPlanEventId: frozen.expectedPlanEventId,
        expectedAcceptedEventIds: frozen.expectedAcceptedEventIds,
        ts: deps.now(),
        intent: frozen.intent,
      });
      if (claim.result === 'stale') {
        if (rebuild === 1) results.push({ taskId: initial.taskId, outcome: 'stale' });
        continue;
      }
      if (claim.result !== 'created') {
        results.push({
          taskId: initial.taskId,
          outcome: claim.result,
          releaseId: claim.result === 'open-intent'
            ? (claim.intent.payload as TaskDispatchIntentPayload).releaseId
            : undefined,
        });
        completed = true;
        break;
      }
      const current = deps.ledger.task(initial.taskId);
      if (!current?.pendingRelease) {
        results.push({ taskId: initial.taskId, outcome: 'stale' });
      } else {
        results.push(await executePendingRelease({ task: current, pending: current.pendingRelease, recovery: false, deps }));
      }
      completed = true;
    }
  }
  return results;
}

export async function retryTaskRelease(input: {
  taskId: string;
  approvedBy: string;
  deps: ReleaseEngineDeps;
}): Promise<TaskReleaseResult> {
  const task = input.deps.ledger.task(input.taskId);
  const pending = task?.pendingRelease;
  if (!task || task.status !== 'planned' || !pending) return { taskId: input.taskId, outcome: 'not-ready' };
  const frozen = buildTaskReleaseClaim({
    ledger: input.deps.ledger,
    taskId: input.taskId,
    attempt: pending.attempt + 1,
    releasedBy: input.approvedBy,
  });
  if (!frozen) return { taskId: input.taskId, outcome: 'not-ready' };
  const claim = input.deps.ledger.claimRetryRelease({
    taskId: input.taskId,
    expectedReleaseId: pending.releaseId,
    approvedBy: input.approvedBy,
    ts: input.deps.now(),
    intent: frozen.intent,
  });
  if (claim.result !== 'created') {
    return {
      taskId: input.taskId,
      outcome: claim.result === 'not-retryable' ? 'waiting-human' : claim.result,
      releaseId: pending.releaseId,
    };
  }
  const current = input.deps.ledger.task(input.taskId);
  if (!current?.pendingRelease) return { taskId: input.taskId, outcome: 'stale' };
  return executePendingRelease({ task: current, pending: current.pendingRelease, recovery: false, deps: input.deps });
}

export function confirmTaskRelease(input: {
  ledger: LedgerHandle;
  taskId: string;
  confirmedBy: string;
  now: number;
}): TaskReleaseResult {
  const task = input.ledger.task(input.taskId);
  const pending = task?.pendingRelease;
  if (!task || task.status !== 'planned' || !pending) return { taskId: input.taskId, outcome: 'not-ready' };
  if (
    !input.confirmedBy.trim() ||
    pending.failure?.failureClass === 'definite' ||
    input.now - pending.intentAt < TASK_RELEASE_AUTO_RETRY_WINDOW_MS
  ) {
    return { taskId: input.taskId, outcome: 'waiting-human', releaseId: pending.releaseId };
  }
  const appendResult = appendReleasedDispatch({
    ledger: input.ledger,
    pending,
    ts: input.now,
    confirmedBy: input.confirmedBy.trim(),
  });
  if (appendResult === 'stale') {
    return { taskId: input.taskId, outcome: 'stale', releaseId: pending.releaseId };
  }
  return { taskId: input.taskId, outcome: 'dispatched', releaseId: pending.releaseId };
}
