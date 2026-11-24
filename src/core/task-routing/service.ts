/**
 * 任务分配高层编排服务（Host CLI 与 Daemon IPC 共用同一套实现）。
 *
 * 职责：
 * - 统一执行 `taskRouting.enabled` 全局默认关闭闸门（合码标准 3.1）；
 * - 统一解析 `--prefer` / `--only` / `--exclude` / `--bot` 引用（重名/未知 fail-closed）；
 * - 装配实时探测（probe）、规则 + 本地 bot one-shot 裁判（selector + bot-matcher）、
 *   执行与顺序兜底（executor）、以及懒创建 SQLite 账本（TaskRoutingStore）。
 */

import type { BotConfig } from '../../bot-registry.js';
import { loadBotConfigs } from '../../bot-registry.js';
import { isTaskRoutingEnabled, readGlobalTaskRoutingConfig } from '../../global-config.js';
import { resolveBotmuxDataDir } from '../data-dir.js';
import { TaskRoutingStore } from '../../services/task-routing-store.js';
import { runBotOneShotMatcher, type BotOneShotRunner } from './bot-matcher.js';
import {
  createHostGroupDispatcher,
  executeTaskRoutingRun,
  type CandidateDispatchResult,
  type ExecuteTaskRoutingDeps,
  type ExecuteTaskRoutingOutput,
} from './executor.js';
import {
  type BotRuntimeSnapshot,
  type CandidateEvaluation,
  type TaskRoutingAttempt,
  type TaskRoutingCallerKind,
  type TaskRoutingConstraints,
  type TaskRoutingDecision,
  type TaskRoutingDispatchMode,
  type TaskRoutingGlobalConfig,
  type TaskRoutingOutcome,
  type TaskRoutingRecord,
} from './model.js';
import {
  collectBotRuntimeSnapshots,
  resolveTaskRoutingBotRef,
  type TaskRoutingProbeDeps,
} from './probe.js';
import { evaluateCandidates, selectBotForTask, type SemanticMatcherFn } from './selector.js';

export interface TaskRoutingServiceDeps {
  dataDir?: string;
  now?: () => number;
  readGlobalTaskRouting?: () => TaskRoutingGlobalConfig | undefined;
  loadConfigs?: () => BotConfig[];
  probeDeps?: TaskRoutingProbeDeps;
  store?: TaskRoutingStore;
  oneShotRunner?: BotOneShotRunner;
  allowOneShot?: (cfg: BotConfig) => boolean;
  invokeMatcher?: SemanticMatcherFn;
  dispatchGroupCandidate?: ExecuteTaskRoutingDeps['dispatchCandidate'];
  dispatchTopicCandidate?: ExecuteTaskRoutingDeps['dispatchCandidate'];
}

export interface RawTaskRoutingConstraintRefs {
  prefer?: string;
  only?: readonly string[];
  exclude?: readonly string[];
  workingDir?: string;
}

export class TaskRoutingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TaskRoutingError';
    this.code = code;
    this.status = status;
  }
}

function getGlobalConfig(deps: TaskRoutingServiceDeps): TaskRoutingGlobalConfig | undefined {
  return (deps.readGlobalTaskRouting ?? readGlobalTaskRoutingConfig)();
}

function isEnabled(deps: TaskRoutingServiceDeps): boolean {
  return deps.readGlobalTaskRouting
    ? deps.readGlobalTaskRouting()?.enabled === true
    : isTaskRoutingEnabled();
}

export function assertTaskRoutingEnabled(deps: TaskRoutingServiceDeps): TaskRoutingGlobalConfig {
  const cfg = getGlobalConfig(deps);
  if (cfg?.enabled !== true) {
    throw new TaskRoutingError(
      'task_routing_disabled',
      '任务分配功能默认关闭。请在 Dashboard 设置中开启「Bot 任务分配」，或在 ~/.botmux/config.json 中设置 {"taskRouting":{"enabled":true}} 后再使用。',
      403,
    );
  }
  return cfg;
}

function resolveConstraints(
  refs: RawTaskRoutingConstraintRefs | undefined,
  snapshots: readonly BotRuntimeSnapshot[],
): TaskRoutingConstraints {
  const out: TaskRoutingConstraints = {};
  if (!refs) return out;

  if (refs.prefer) {
    const res = resolveTaskRoutingBotRef(refs.prefer, snapshots);
    if (!res.ok) throw new TaskRoutingError('invalid_bot_ref', `--prefer：${res.error}`, 400);
    out.prefer = res.larkAppId;
  }
  if (refs.only?.length) {
    const resolved: string[] = [];
    for (const raw of refs.only) {
      const res = resolveTaskRoutingBotRef(raw, snapshots);
      if (!res.ok) throw new TaskRoutingError('invalid_bot_ref', `--only：${res.error}`, 400);
      if (!resolved.includes(res.larkAppId)) resolved.push(res.larkAppId);
    }
    out.only = resolved;
  }
  if (refs.exclude?.length) {
    const resolved: string[] = [];
    for (const raw of refs.exclude) {
      const res = resolveTaskRoutingBotRef(raw, snapshots);
      if (!res.ok) throw new TaskRoutingError('invalid_bot_ref', `--exclude：${res.error}`, 400);
      if (!resolved.includes(res.larkAppId)) resolved.push(res.larkAppId);
    }
    out.exclude = resolved;
  }
  if (out.prefer && out.exclude?.includes(out.prefer)) {
    throw new TaskRoutingError('conflicting_constraints', '--prefer 与 --exclude 不能指向同一个 Bot', 400);
  }
  if (out.prefer && out.only?.length && !out.only.includes(out.prefer)) {
    throw new TaskRoutingError('conflicting_constraints', '--prefer 指定的 Bot 必须位于 --only 列表中', 400);
  }
  if (refs.workingDir?.trim()) {
    out.workingDir = refs.workingDir.trim();
  }
  return out;
}

function buildMatcherFn(
  globalCfg: TaskRoutingGlobalConfig,
  allConfigs: readonly BotConfig[],
  deps: TaskRoutingServiceDeps,
): SemanticMatcherFn | undefined {
  if (deps.invokeMatcher) return deps.invokeMatcher;
  if (globalCfg.matcher?.mode !== 'bot' || !globalCfg.matcher.botAppId) return undefined;
  const matcherBot = allConfigs.find(c => c.larkAppId === globalCfg.matcher!.botAppId);
  if (!matcherBot) {
    return async () => ({
      ok: false,
      errorCode: 'matcher_bot_not_found',
      detail: `全局配置的语义裁判 Bot ${globalCfg.matcher!.botAppId} 不在本机 bots.json 中`,
    });
  }
  return request => runBotOneShotMatcher(request, {
    botConfig: matcherBot,
    timeoutMs: globalCfg.matcher?.timeoutMs,
    allowOneShot: deps.allowOneShot,
    runner: deps.oneShotRunner,
  });
}

export async function getTaskRoutingStatus(deps: TaskRoutingServiceDeps = {}): Promise<{
  enabled: boolean;
  matcherMode: string;
  matcherBotAppId?: string;
  policy?: string;
  eligible: CandidateEvaluation[];
  excluded: CandidateEvaluation[];
}> {
  const globalCfg = assertTaskRoutingEnabled(deps);
  const nowMs = (deps.now ?? Date.now)();
  const snapshots = await collectBotRuntimeSnapshots({
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.loadConfigs ? { loadConfigs: deps.loadConfigs } : {}),
    ...deps.probeDeps,
  });
  const { eligible, excluded } = evaluateCandidates(snapshots, {}, nowMs);
  return {
    enabled: true,
    matcherMode: globalCfg.matcher?.mode ?? 'rule',
    ...(globalCfg.matcher?.botAppId ? { matcherBotAppId: globalCfg.matcher.botAppId } : {}),
    ...(globalCfg.policy ? { policy: globalCfg.policy } : {}),
    eligible,
    excluded,
  };
}

export async function recommendBotForTask(
  input: {
    task: string;
    constraints?: RawTaskRoutingConstraintRefs;
    noLlm?: boolean;
    callerReason?: string;
  },
  deps: TaskRoutingServiceDeps = {},
): Promise<{ decision: TaskRoutingDecision; constraints: TaskRoutingConstraints }> {
  const globalCfg = assertTaskRoutingEnabled(deps);
  const task = input.task.trim();
  if (!task) throw new TaskRoutingError('empty_task', '任务描述不能为空', 400);

  const loadConfigs = deps.loadConfigs ?? deps.probeDeps?.loadConfigs ?? loadBotConfigs;
  const allConfigs = loadConfigs();
  const snapshots = await collectBotRuntimeSnapshots({
    ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    loadConfigs: () => allConfigs,
    ...deps.probeDeps,
  });
  const constraints = resolveConstraints(input.constraints, snapshots);
  const invokeMatcher = buildMatcherFn(globalCfg, allConfigs, deps);

  const decision = await selectBotForTask({
    task,
    snapshots,
    constraints,
    policy: globalCfg.policy,
    matcherConfig: globalCfg.matcher,
    noLlm: input.noLlm,
    callerReason: input.callerReason,
    nowMs: (deps.now ?? Date.now)(),
    invokeMatcher,
  });

  return { decision, constraints };
}

export async function runTaskRouting(
  input: {
    mode: TaskRoutingDispatchMode;
    task: string;
    title?: string;
    workingDir?: string;
    chatId?: string;
    constraints?: RawTaskRoutingConstraintRefs;
    noLlm?: boolean;
    callerReason?: string;
    callerKind: TaskRoutingCallerKind;
    callerAppId?: string;
    callerSessionId?: string;
    callerTurnId?: string;
  },
  deps: TaskRoutingServiceDeps = {},
): Promise<ExecuteTaskRoutingOutput> {
  const { decision, constraints } = await recommendBotForTask(
    {
      task: input.task,
      constraints: {
        ...input.constraints,
        ...(input.workingDir ? { workingDir: input.workingDir } : {}),
      },
      noLlm: input.noLlm,
      callerReason: input.callerReason,
    },
    deps,
  );

  const dataDir = deps.dataDir ?? resolveBotmuxDataDir();
  const store = deps.store ?? new TaskRoutingStore(dataDir);
  const loadConfigs = deps.loadConfigs ?? deps.probeDeps?.loadConfigs ?? loadBotConfigs;

  const dispatchCandidate: ExecuteTaskRoutingDeps['dispatchCandidate'] = input.mode === 'topic'
    ? (deps.dispatchTopicCandidate ?? (async (): Promise<CandidateDispatchResult> => ({
        ok: false,
        retryable: false,
        error: 'topic 模式需要提供 dispatchTopicCandidate 执行器',
      })))
    : (deps.dispatchGroupCandidate ?? createHostGroupDispatcher({ dataDir }));

  const preflightCandidate = async (appId: string): Promise<BotRuntimeSnapshot | null> => {
    const fresh = await collectBotRuntimeSnapshots(
      {
        dataDir,
        ...(deps.now ? { now: deps.now } : {}),
        loadConfigs,
        ...deps.probeDeps,
      },
      { onlyAppIds: [appId] },
    );
    return fresh[0] ?? null;
  };

  return executeTaskRoutingRun(
    {
      mode: input.mode,
      task: input.task,
      title: input.title,
      workingDir: input.workingDir,
      chatId: input.chatId,
      callerKind: input.callerKind,
      callerAppId: input.callerAppId,
      callerSessionId: input.callerSessionId,
      callerTurnId: input.callerTurnId,
      constraints,
      decision,
    },
    {
      store,
      now: deps.now,
      isRoutingStillEnabled: () => isEnabled(deps),
      preflightCandidate,
      dispatchCandidate,
    },
  );
}

export async function listTaskRoutingHistory(
  input: { limit?: number; botRef?: string } = {},
  deps: TaskRoutingServiceDeps = {},
): Promise<TaskRoutingRecord[]> {
  assertTaskRoutingEnabled(deps);
  const dataDir = deps.dataDir ?? resolveBotmuxDataDir();
  const store = deps.store ?? new TaskRoutingStore(dataDir);

  let botAppId: string | undefined;
  if (input.botRef?.trim()) {
    const trimmed = input.botRef.trim();
    if (/^cli_[A-Za-z0-9_-]{1,128}$/.test(trimmed)) {
      botAppId = trimmed;
    } else {
      const snapshots = await collectBotRuntimeSnapshots({
        dataDir,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.loadConfigs ? { loadConfigs: deps.loadConfigs } : {}),
        ...deps.probeDeps,
      });
      const resolved = resolveTaskRoutingBotRef(trimmed, snapshots);
      if (!resolved.ok) throw new TaskRoutingError('invalid_bot_ref', `--bot：${resolved.error}`, 400);
      botAppId = resolved.larkAppId;
    }
  }

  return store.listRecords({
    limit: input.limit ?? 20,
    ...(botAppId ? { botAppId } : {}),
  });
}

/**
 * Live preflight check for one candidate right before dispatching (shared by group & topic modes).
 * Checks the live global kill-switch (bypassing 2s cache) and the candidate's fresh runtime status.
 */
export async function preflightTaskRoutingCandidate(
  input: {
    appId: string;
    constraints?: TaskRoutingConstraints;
  },
  deps: TaskRoutingServiceDeps = {},
): Promise<{ allowed: true } | { allowed: false; abortAll: boolean; reason: string }> {
  if (!isEnabled(deps)) {
    return {
      allowed: false,
      abortAll: true,
      reason: '任务分配已被全局关闭，中止后续候选派发',
    };
  }
  const dataDir = deps.dataDir ?? resolveBotmuxDataDir();
  const loadConfigs = deps.loadConfigs ?? deps.probeDeps?.loadConfigs ?? loadBotConfigs;
  const nowFn = deps.now ?? Date.now;
  let fresh: BotRuntimeSnapshot | null;
  try {
    const snaps = await collectBotRuntimeSnapshots(
      {
        dataDir,
        ...(deps.now ? { now: deps.now } : {}),
        loadConfigs,
        ...deps.probeDeps,
      },
      { onlyAppIds: [input.appId] },
    );
    fresh = snaps[0] ?? null;
  } catch (err) {
    return {
      allowed: false,
      abortAll: false,
      reason: `派发前复检异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!fresh) {
    return {
      allowed: false,
      abortAll: false,
      reason: '派发前复检未找到该 Bot 配置',
    };
  }
  const checked = evaluateCandidates([fresh], input.constraints ?? {}, nowFn());
  if (checked.eligible.length === 0) {
    const ex = checked.excluded[0];
    return {
      allowed: false,
      abortAll: false,
      reason: `派发前复检跳过：${ex?.exclusionReason ?? '派发前实时状态不可用'}`,
    };
  }
  return { allowed: true };
}

/**
 * Atomically settle a pending routing record to a terminal outcome (CAS `WHERE outcome = 'pending'`).
 */
export function settleTaskRoutingRecord(
  id: string,
  patch: {
    selectedAppId?: string | null;
    selectedName?: string | null;
    attempts?: TaskRoutingAttempt[];
    outcome: Exclude<TaskRoutingOutcome, 'pending'>;
    targetChatId?: string | null;
    targetSessionId?: string | null;
    targetRootMessageId?: string | null;
    error?: string | null;
  },
  deps: { dataDir?: string; store?: TaskRoutingStore; now?: () => number } = {},
): { settled: boolean; record: TaskRoutingRecord | null } {
  const store = deps.store ?? new TaskRoutingStore(deps.dataDir ?? resolveBotmuxDataDir());
  const settled = store.settlePendingRecord(id, { ...patch, updatedAt: (deps.now ?? Date.now)() });
  return { settled, record: store.getRecord(id) };
}
