/**
 * 任务分配执行与顺序兜底引擎。
 *
 * 两种落地方式：
 * 1. `group`（默认）：复用目标 daemon 的 `POST /api/groups/create` + `POST /api/sessions/spawn`
 *    （与 Dashboard「创建会话」及 `/g --start` 同一条链路：建任务群 → 邀目标 bot 自己作用域的 owner →
 *    自动静默带入管家 → 绑 workingDir → 复用 bot 的 autoWorktree 自动开 worktree 起会话）。
 * 2. `topic`：委派给现有 `botmux dispatch --bot-app <chosen>`（保留 talk-only grant、接单确认与任务树卡）。
 *
 * 持久状态与兜底不变量：
 * - 派发前先往 `task-routing.sqlite` 写 `outcome='pending'`，包含完整候选与排除快照；
 * - 每个候选派发前再做一次轻量 preflight，若刚离线/满载/冷却立即跳过并记录原因；
 * - 显式未受理错误（建群前失败、或 spawn 返回明确 `{ ok: false }` 错误）按 `fallbackOrder` 顺延下一位；
 * - 建群成功立即持久化 `targetChatId`；若 `spawn` 发生**结果未知的传输超时**，遵守 at-most-once
 *   不盲目重派第二位，标为 `failed`（`spawn_delivery_unknown`）供调用方用 `botmux observe` 核对。
 */

import { randomUUID } from 'node:crypto';
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../daemon-ipc-auth.js';
import { listOnlineDaemons, type OnlineDaemonInfo } from '../../utils/daemon-discovery.js';
import { TaskRoutingStore } from '../../services/task-routing-store.js';
import {
  truncateTaskSummary,
  type BotRuntimeSnapshot,
  type TaskRoutingAttempt,
  type TaskRoutingCallerKind,
  type TaskRoutingConstraints,
  type TaskRoutingDecision,
  type TaskRoutingDispatchMode,
  type TaskRoutingOutcome,
  type TaskRoutingRecord,
} from './model.js';
import { evaluateCandidates } from './selector.js';

export type CandidateDispatchResult =
  | {
      ok: true;
      chatId?: string;
      sessionId?: string;
      rootMessageId?: string;
      threadId?: string | null;
      shareLink?: string | null;
    }
  | {
      ok: false;
      /** True only when we proved the candidate did NOT start the task and fallback is safe. */
      retryable: boolean;
      error: string;
      /** Set when a group was created before a non-retryable / ambiguous spawn outcome. */
      chatId?: string;
      /** Set when a Feishu topic root was posted before a non-retryable failure. */
      rootMessageId?: string;
    };

export interface ExecuteTaskRoutingInput {
  mode: TaskRoutingDispatchMode;
  task: string;
  title?: string;
  workingDir?: string;
  chatId?: string;
  callerKind: TaskRoutingCallerKind;
  callerAppId?: string;
  callerSessionId?: string;
  callerTurnId?: string;
  constraints: TaskRoutingConstraints;
  decision: TaskRoutingDecision;
}

export interface ExecuteTaskRoutingDeps {
  store: TaskRoutingStore;
  now?: () => number;
  createRecordId?: () => string;
  /** Optional check before each candidate to respect mid-flight global kill-switch. */
  isRoutingStillEnabled?: () => boolean;
  /** Optional fresh single-bot probe before attempting dispatch. */
  preflightCandidate?: (appId: string) => Promise<BotRuntimeSnapshot | null>;
  /** Execute actual dispatch to one candidate bot. */
  dispatchCandidate: (
    candidate: { appId: string; name: string },
    context: {
      mode: TaskRoutingDispatchMode;
      task: string;
      title: string;
      workingDir?: string;
      chatId?: string;
      onChatCreated?: (chatId: string) => void;
    },
  ) => Promise<CandidateDispatchResult>;
}

export interface ExecuteTaskRoutingOutput {
  ok: boolean;
  record: TaskRoutingRecord;
  chatId?: string;
  sessionId?: string;
  rootMessageId?: string;
  threadId?: string | null;
  shareLink?: string | null;
  error?: string;
}

export function deriveTaskGroupTitle(explicitTitle: string | undefined, task: string): string {
  const trimmed = explicitTitle?.trim();
  if (trimmed) return Array.from(trimmed).slice(0, 60).join('');
  const firstLine = task.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? task.trim();
  const compact = firstLine.replace(/\s+/g, ' ');
  return Array.from(compact).slice(0, 40).join('') || '新任务';
}

/**
 * Execute a planned routing decision with sequential fallback and durable two-phase recording.
 */
export async function executeTaskRoutingRun(
  input: ExecuteTaskRoutingInput,
  deps: ExecuteTaskRoutingDeps,
): Promise<ExecuteTaskRoutingOutput> {
  const nowFn = deps.now ?? Date.now;
  const createdAt = nowFn();
  const id = (deps.createRecordId ?? (() => `tr_${randomUUID().replace(/-/g, '').slice(0, 16)}`))();
  const title = deriveTaskGroupTitle(input.title, input.task);

  const baseRecord: TaskRoutingRecord = {
    id,
    createdAt,
    updatedAt: createdAt,
    mode: input.mode,
    taskSummary: truncateTaskSummary(input.task),
    callerKind: input.callerKind,
    ...(input.callerAppId ? { callerAppId: input.callerAppId } : {}),
    ...(input.callerSessionId ? { callerSessionId: input.callerSessionId } : {}),
    ...(input.callerTurnId ? { callerTurnId: input.callerTurnId } : {}),
    constraints: input.constraints,
    selectedAppId: input.decision.selectedAppId,
    selectedName: input.decision.selectedName,
    matcherKind: input.decision.matcherKind,
    confidence: input.decision.confidence,
    reason: input.decision.reason,
    ...(input.decision.fallbackFromMatcher ? { fallbackFromMatcher: input.decision.fallbackFromMatcher } : {}),
    candidates: input.decision.candidates,
    excluded: input.decision.excluded,
    attempts: [],
    outcome: input.decision.fallbackOrder.length > 0 ? 'pending' : 'failed',
    ...(input.decision.fallbackOrder.length === 0 ? { error: input.decision.reason } : {}),
  };

  deps.store.insertRecord(baseRecord);

  if (input.decision.fallbackOrder.length === 0) {
    return {
      ok: false,
      record: baseRecord,
      error: input.decision.reason,
    };
  }

  const nameByApp = new Map(input.decision.candidates.map(c => [c.larkAppId, c.name]));
  const attempts: TaskRoutingAttempt[] = [];
  let lastError = '所有候选 Bot 均派发失败';
  let recordState: TaskRoutingRecord = { ...baseRecord };
  const tryStoreUpdate = (patch: Parameters<TaskRoutingStore['updateRecord']>[1]): boolean => {
    try {
      return deps.store.updateRecord(id, patch);
    } catch {
      return false;
    }
  };

  for (let i = 0; i < input.decision.fallbackOrder.length; i++) {
    const appId = input.decision.fallbackOrder[i]!;
    const name = nameByApp.get(appId) ?? appId;

    // Respect mid-flight global disable before attempting the next candidate.
    if (deps.isRoutingStillEnabled && !deps.isRoutingStillEnabled()) {
      const abortedAt = nowFn();
      const abortReason = '任务分配已被全局关闭，中止后续候选派发';
      attempts.push({
        appId,
        name,
        outcome: 'skipped',
        reason: abortReason,
        at: abortedAt,
      });
      tryStoreUpdate({
        attempts,
        outcome: 'failed',
        targetChatId: null,
        error: abortReason,
        updatedAt: abortedAt,
      });
      recordState = {
        ...recordState,
        attempts,
        outcome: 'failed',
        targetChatId: undefined,
        error: abortReason,
        updatedAt: abortedAt,
      };
      return {
        ok: false,
        record: recordState,
        error: abortReason,
      };
    }

    // Fresh preflight right before side effect to catch last-second offline / quota / capacity drift.
    if (deps.preflightCandidate) {
      let fresh: BotRuntimeSnapshot | null;
      try {
        fresh = await deps.preflightCandidate(appId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({
          appId,
          name,
          outcome: 'skipped',
          reason: `派发前复检异常：${msg}`,
          at: nowFn(),
        });
        tryStoreUpdate({ attempts, updatedAt: nowFn() });
        lastError = `${name}：派发前复检异常（${msg}）`;
        continue;
      }
      if (!fresh) {
        attempts.push({
          appId,
          name,
          outcome: 'skipped',
          reason: '派发前复检未找到该 Bot 配置',
          at: nowFn(),
        });
        tryStoreUpdate({ attempts, updatedAt: nowFn() });
        lastError = `${name} 不可用（配置已变更）`;
        continue;
      }
      // Pass original caller constraints (not synthetic `only: [appId]`) so a bot
      // whose `taskRouting.enabled` was unchecked mid-flight is properly skipped
      // unless explicitly pinned via `--only`.
      const checked = evaluateCandidates([fresh], input.constraints, nowFn());
      if (checked.eligible.length === 0) {
        const ex = checked.excluded[0];
        const skipReason = ex?.exclusionReason ?? '派发前实时状态不可用';
        attempts.push({
          appId,
          name,
          outcome: 'skipped',
          reason: `派发前复检跳过：${skipReason}`,
          at: nowFn(),
        });
        tryStoreUpdate({ attempts, updatedAt: nowFn() });
        lastError = `${name}：${skipReason}`;
        continue;
      }
    }

    let createdChatIdForAttempt: string | undefined;
    let dispatched: CandidateDispatchResult;
    try {
      dispatched = await deps.dispatchCandidate(
        { appId, name },
        {
          mode: input.mode,
          task: input.task,
          title,
          ...(input.workingDir ? { workingDir: input.workingDir } : {}),
          ...(input.chatId ? { chatId: input.chatId } : {}),
          onChatCreated: (chatId: string) => {
            createdChatIdForAttempt = chatId;
            // Best-effort checkpoint before spawn: never let a transient SQLITE_BUSY
            // abort `/api/sessions/spawn` and leave an empty unspawned group.
            tryStoreUpdate({ targetChatId: chatId, updatedAt: nowFn() });
          },
        },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Unexpected exception: if a group was already created, treat as ambiguous (non-retryable) so we never double-dispatch.
      dispatched = {
        ok: false,
        retryable: !createdChatIdForAttempt,
        error: createdChatIdForAttempt
          ? `spawn_delivery_unknown：群 ${createdChatIdForAttempt} 已建，派发过程抛出异常：${errMsg}`
          : `派发异常：${errMsg}`,
        ...(createdChatIdForAttempt ? { chatId: createdChatIdForAttempt } : {}),
      };
    }

    if (dispatched.ok) {
      const finishedAt = nowFn();
      const attempt: TaskRoutingAttempt = {
        appId,
        name,
        outcome: 'dispatched',
        reason: i === 0 ? '首选命中并成功派发' : `前面 ${i} 个候选跳过/失败，兜底改派成功`,
        at: finishedAt,
        ...(dispatched.chatId ? { chatId: dispatched.chatId } : {}),
        ...(dispatched.sessionId ? { sessionId: dispatched.sessionId } : {}),
        ...(dispatched.rootMessageId ? { rootMessageId: dispatched.rootMessageId } : {}),
      };
      attempts.push(attempt);
      const outcome: TaskRoutingOutcome = i === 0 ? 'dispatched' : 'fallback_dispatched';
      tryStoreUpdate({
        selectedAppId: appId,
        selectedName: name,
        attempts,
        outcome,
        targetChatId: dispatched.chatId ?? createdChatIdForAttempt ?? null,
        targetSessionId: dispatched.sessionId ?? null,
        targetRootMessageId: dispatched.rootMessageId ?? null,
        error: null,
        updatedAt: finishedAt,
      });
      recordState = {
        ...recordState,
        selectedAppId: appId,
        selectedName: name,
        attempts,
        outcome,
        ...(dispatched.chatId ?? createdChatIdForAttempt ? { targetChatId: dispatched.chatId ?? createdChatIdForAttempt } : {}),
        ...(dispatched.sessionId ? { targetSessionId: dispatched.sessionId } : {}),
        ...(dispatched.rootMessageId ? { targetRootMessageId: dispatched.rootMessageId } : {}),
        updatedAt: finishedAt,
      };
      return {
        ok: true,
        record: recordState,
        chatId: dispatched.chatId ?? createdChatIdForAttempt,
        sessionId: dispatched.sessionId,
        rootMessageId: dispatched.rootMessageId,
        threadId: dispatched.threadId,
        shareLink: dispatched.shareLink,
      };
    }

    const failedAt = nowFn();
    const attemptChatId = dispatched.chatId ?? createdChatIdForAttempt;
    const attemptRootId = dispatched.rootMessageId;
    attempts.push({
      appId,
      name,
      outcome: 'failed',
      reason: dispatched.error,
      at: failedAt,
      ...(attemptChatId ? { chatId: attemptChatId } : {}),
      ...(attemptRootId ? { rootMessageId: attemptRootId } : {}),
    });
    lastError = `${name}：${dispatched.error}`;

    if (!dispatched.retryable) {
      // Non-retryable (e.g. ambiguous post-create spawn timeout): stop immediately, never double-dispatch.
      tryStoreUpdate({
        selectedAppId: appId,
        selectedName: name,
        attempts,
        outcome: 'failed',
        ...(attemptChatId ? { targetChatId: attemptChatId } : {}),
        ...(attemptRootId ? { targetRootMessageId: attemptRootId } : {}),
        error: dispatched.error,
        updatedAt: failedAt,
      });
      recordState = {
        ...recordState,
        selectedAppId: appId,
        selectedName: name,
        attempts,
        outcome: 'failed',
        ...(attemptChatId ? { targetChatId: attemptChatId } : {}),
        ...(attemptRootId ? { targetRootMessageId: attemptRootId } : {}),
        error: dispatched.error,
        updatedAt: failedAt,
      };
      return {
        ok: false,
        record: recordState,
        ...(attemptChatId ? { chatId: attemptChatId } : {}),
        ...(attemptRootId ? { rootMessageId: attemptRootId } : {}),
        error: dispatched.error,
      };
    }

    // Clear top-level targetChatId when moving on after a retryable failure
    // (the orphaned chatId remains preserved in attempts[i].chatId).
    tryStoreUpdate({ attempts, targetChatId: null, updatedAt: failedAt });
  }

  const settledAt = nowFn();
  tryStoreUpdate({
    attempts,
    outcome: 'failed',
    targetChatId: null,
    error: lastError,
    updatedAt: settledAt,
  });
  recordState = {
    ...recordState,
    attempts,
    outcome: 'failed',
    targetChatId: undefined,
    error: lastError,
    updatedAt: settledAt,
  };
  return {
    ok: false,
    record: recordState,
    error: lastError,
  };
}

// ─── Host Group Dispatcher (reuses target daemon /api/groups/create + /api/sessions/spawn) ──

export interface HostGroupDispatcherDeps {
  dataDir?: string;
  secret?: string;
  discoverDaemons?: (dataDir?: string) => OnlineDaemonInfo[];
  fetchIpc?: typeof fetchDaemonIpc;
  groupCreateTimeoutMs?: number;
  spawnTimeoutMs?: number;
}

async function ipcJsonWithTimeout(
  fetchIpc: typeof fetchDaemonIpc,
  port: number,
  path: string,
  init: RequestInit,
  secret: string | undefined,
  timeoutMs: number,
): Promise<
  | { ok: true; status: number; body: Record<string, unknown> | null; malformedJson: boolean }
  | { ok: false; timedOut: boolean; error: string }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchIpc(port, path, { ...init, signal: controller.signal }, secret);
    // Do NOT swallow stream/abort errors here: an abort mid-body MUST enter catch()
    // so callers classify it as an ambiguous transport timeout rather than an explicit refusal.
    const rawText = await res.text();
    if (!rawText.trim()) {
      return { ok: true, status: res.status, body: null, malformedJson: false };
    }
    try {
      const parsed = JSON.parse(rawText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, status: res.status, body: parsed as Record<string, unknown>, malformedJson: false };
      }
      return { ok: true, status: res.status, body: null, malformedJson: true };
    } catch {
      return { ok: true, status: res.status, body: null, malformedJson: true };
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      timedOut,
      error: timedOut ? `请求超时（${timeoutMs}ms）` : (err instanceof Error ? err.message : String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a real group-mode dispatcher that reuses the target bot daemon's
 * `/api/bot-default-oncall` (for its own app-scoped owner list), `/api/groups/create`,
 * and `/api/sessions/spawn` (identical to Dashboard "Create Session" & `/g --start`).
 *
 * Owner identity boundary: open_id (`ou_`) is ALWAYS read from the target bot's own
 * resolvedAllowedUsers, never copied from a caller bot.
 */
export function createHostGroupDispatcher(
  deps: HostGroupDispatcherDeps = {},
): ExecuteTaskRoutingDeps['dispatchCandidate'] {
  const fetchIpc = deps.fetchIpc ?? fetchDaemonIpc;
  const discover = deps.discoverDaemons ?? listOnlineDaemons;
  const createTimeout = deps.groupCreateTimeoutMs ?? 20_000;
  const spawnTimeout = deps.spawnTimeoutMs ?? 30_000;

  return async (candidate, context): Promise<CandidateDispatchResult> => {
    const secret = deps.secret ?? (() => { try { return loadDaemonIpcSecret(); } catch { return undefined; } })();
    const daemon = discover(deps.dataDir).find(d => d.larkAppId === candidate.appId);
    if (!daemon) {
      return { ok: false, retryable: true, error: '目标 Bot daemon 已离线' };
    }

    // Read target bot's own app-scoped owner open_ids / union_ids.
    const meta = await ipcJsonWithTimeout(
      fetchIpc,
      daemon.ipcPort,
      '/api/bot-default-oncall',
      { method: 'GET' },
      secret,
      5_000,
    );
    if (!meta.ok) {
      return { ok: false, retryable: true, error: `读取目标 Bot 状态失败：${meta.error}` };
    }
    if (meta.status < 200 || meta.status >= 300 || !meta.body) {
      return { ok: false, retryable: true, error: `目标 Bot 状态接口异常（HTTP ${meta.status}）` };
    }
    const allowed = Array.isArray(meta.body.resolvedAllowedUsers)
      ? meta.body.resolvedAllowedUsers.filter((u): u is string => typeof u === 'string')
      : [];
    const userOpenIds = allowed.filter(u => u.startsWith('ou_'));
    const primaryOpenId = userOpenIds[0];
    const ownerUnionIds = allowed.filter(u => u.startsWith('on_'));

    // Step 1: create task group on target daemon (steward auto-join & owner transfer handled inside createGroupWithBots).
    const groupRes = await ipcJsonWithTimeout(
      fetchIpc,
      daemon.ipcPort,
      '/api/groups/create',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: context.title,
          larkAppIds: [candidate.appId],
          userOpenIds,
          ownerUnionIds,
          ...(primaryOpenId
            ? { transferOwnerTo: primaryOpenId, notifyOwnerOpenId: primaryOpenId }
            : ownerUnionIds[0]
              ? { transferOwnerUnionId: ownerUnionIds[0] }
              : {}),
          ...(context.workingDir ? { bindWorkingDir: context.workingDir } : {}),
        }),
      },
      secret,
      createTimeout,
    );
    if (!groupRes.ok) {
      // Group creation timeout is ambiguous (group may already exist on Feishu);
      // however no session was spawned yet. For network refusal (non-timeout) safe to retry next bot.
      return {
        ok: false,
        retryable: !groupRes.timedOut,
        error: groupRes.timedOut
          ? `建群请求超时，状态未知（请先检查飞书是否已建群）：${groupRes.error}`
          : `建群失败：${groupRes.error}`,
      };
    }
    const chatId = typeof groupRes.body?.chatId === 'string' ? groupRes.body.chatId : undefined;
    if (groupRes.status >= 200 && groupRes.status < 300 && (groupRes.malformedJson || !groupRes.body)) {
      return {
        ok: false,
        retryable: false,
        error: `建群响应体异常（HTTP ${groupRes.status}，状态未知，请先检查飞书是否已建群）`,
      };
    }
    if (groupRes.status < 200 || groupRes.status >= 300 || groupRes.body?.ok !== true || !chatId) {
      const errText = typeof groupRes.body?.error === 'string' ? groupRes.body.error : `group_create_http_${groupRes.status}`;
      return { ok: false, retryable: true, error: `建群失败：${errText}` };
    }

    context.onChatCreated?.(chatId);
    const shareLink = typeof groupRes.body?.shareLink === 'string' ? groupRes.body.shareLink : null;

    // Step 2: spawn the chat-scope session in the new task group (reuses autoWorktree when configured).
    const spawnRes = await ipcJsonWithTimeout(
      fetchIpc,
      daemon.ipcPort,
      '/api/sessions/spawn',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId,
          content: context.task,
          column: 'in_progress',
          role: 'solo',
          title: context.title,
          postBanner: true,
        }),
      },
      secret,
      spawnTimeout,
    );
    if (!spawnRes.ok) {
      // Ambiguous transport drop/timeout after group creation: do NOT double-dispatch onto another bot!
      return {
        ok: false,
        retryable: false,
        chatId,
        error: spawnRes.timedOut
          ? `spawn_delivery_unknown：群 ${chatId} 已建，但启动会话超时，请用 botmux observe 确认是否已开工`
          : `spawn_delivery_unknown：群 ${chatId} 已建，启动会话连接中断：${spawnRes.error}`,
      };
    }
    const sessionId = typeof spawnRes.body?.sessionId === 'string' ? spawnRes.body.sessionId : undefined;
    if (spawnRes.status < 200 || spawnRes.status >= 300 || spawnRes.body?.ok !== true || !sessionId) {
      const explicitRefusal = spawnRes.body?.ok === false
        || (spawnRes.status >= 400 && !spawnRes.malformedJson);
      if (!explicitRefusal) {
        // HTTP 2xx with truncated/malformed/missing body is ambiguous: fail-closed (never double-dispatch).
        return {
          ok: false,
          retryable: false,
          chatId,
          error: `spawn_delivery_unknown：群 ${chatId} 已建，启动会话响应异常（HTTP ${spawnRes.status}），请用 botmux observe 确认是否已开工`,
        };
      }
      const errText = typeof spawnRes.body?.error === 'string' ? spawnRes.body.error : `session_spawn_http_${spawnRes.status}`;
      // Target daemon explicitly refused to start the session -> safe to fall back to next candidate.
      return {
        ok: false,
        retryable: true,
        chatId,
        error: `启动会话失败（群 ${chatId}）：${errText}`,
      };
    }

    return {
      ok: true,
      chatId,
      sessionId,
      shareLink,
    };
  };
}
