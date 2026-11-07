/**
 * Caller/target authorization for agent-facing daemon mutations:
 * `botmux workflow start|cancel|retry|grant`.
 *
 * These commands run as child processes of a long-lived CLI.  The inherited
 * BOTMUX_OWNER_OPEN_ID / BOTMUX_LARK_APP_ID values describe the session at
 * spawn time, not necessarily the human who opened the current turn.  The
 * only chat authority is therefore resolveCurrentTurnProvenance(): a fresh
 * process-tree marker joined to the latest durable session record.
 */
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveCurrentTurnProvenance,
  type CurrentTurnProvenance,
} from '../../core/current-turn-provenance.js';
import {
  GRILL_STATUS_FILE,
  defaultBaseDir,
  readGrillState,
  type RunChatBinding,
} from './grill-state.js';
import { isValidRunId } from './ops-projection.js';
import { readRunEnvelope, type V3RunEnvelope } from './run-envelope.js';
import { readJournal } from './journal.js';
import { materialize } from './state.js';
import { isUnattendedSyntheticTurnId, type WorkflowEventTurnVerifier } from '../../core/workflow-event-turn.js';
import { parseScheduledTurnId } from '../../core/scheduled-turn-provenance.js';
import { readV3MainWakeIssued } from './main-wake-ledger.js';
import type { V3ActionCaller } from './action-provenance.js';

export type V3DaemonCommandBindingSource = 'run-envelope' | 'legacy-grill' | 'legacy-unbound';

export interface V3DaemonCommandAuthority {
  runDir: string;
  /** Exact daemon owner selected from the authenticated target/current turn. */
  larkAppId: string;
  mode: 'chat' | 'standalone';
  bindingSource: V3DaemonCommandBindingSource;
  /** Chat mode only: who decided this request (design §13.6) — recorded by
   *  `retry` / `ask-human`, and whether `--reason` is required. */
  caller?: V3ActionCaller;
}

export interface AuthorizeV3DaemonCommandOptions {
  runId: string;
  dataDir: string;
  baseDir?: string;
  envSessionId?: string;
  startPid?: number;
  /** Explicit `--bot`; inherited BOTMUX_LARK_APP_ID is intentionally ignored. */
  requestedLarkAppId?: string;
  /** Cancel-only escape hatch: an unbound manual run is mutated on local disk
   * and therefore does not need a daemon selector. Other daemon commands keep
   * requiring --bot for standalone routing. */
  allowStandaloneLocal?: boolean;
  /** Test seam. Production always uses the fresh marker/session resolver. */
  resolveProvenance?: (options: {
    dataDir: string;
    envSessionId?: string;
    startPid?: number;
    verifyWorkflowEventTurn?: WorkflowEventTurnVerifier;
  }) => CurrentTurnProvenance | null;
}

export class V3DaemonCommandAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'V3DaemonCommandAuthorityError';
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertLegacyBindingShape(binding: RunChatBinding, runId: string): void {
  if (!nonEmpty(binding.larkAppId) || !nonEmpty(binding.chatId)) {
    throw new V3DaemonCommandAuthorityError(
      `legacy run ${runId} 的 grill.chatBinding 缺少有效 larkAppId/chatId`,
    );
  }
  for (const [key, value] of [
    ['ownerOpenId', binding.ownerOpenId],
    ['rootMessageId', binding.rootMessageId],
    ['sessionId', binding.sessionId],
  ] as const) {
    if (value !== undefined && !nonEmpty(value)) {
      throw new V3DaemonCommandAuthorityError(
        `legacy run ${runId} 的 grill.chatBinding.${key} 无效`,
      );
    }
  }
}

function readTargetBinding(
  runDir: string,
  runId: string,
): { binding?: RunChatBinding; source: V3DaemonCommandBindingSource; initiatorOpenId?: string } {
  let stat;
  try {
    stat = lstatSync(runDir);
  } catch {
    throw new V3DaemonCommandAuthorityError(`找不到 v3 run ${runId}`);
  }
  if (!stat.isDirectory()) {
    throw new V3DaemonCommandAuthorityError(`v3 run 路径不是目录：${runDir}`);
  }

  const envelope = readRunEnvelope(runDir, runId);
  if (envelope.kind === 'ok') {
    const initiatorOpenId = resolveV3RunInitiator(envelope.envelope);
    return {
      ...(envelope.envelope.chatBinding ? { binding: envelope.envelope.chatBinding } : {}),
      source: 'run-envelope',
      ...(initiatorOpenId ? { initiatorOpenId } : {}),
    };
  }
  if (envelope.kind === 'invalid') {
    // Compatibility is intentionally missing-only. A corrupt run.json must
    // never be bypassed by a still-readable grill.state.json.
    throw new V3DaemonCommandAuthorityError(
      `v3 run ${runId} 的 run.json 无效，拒绝降级到 grill.state：${envelope.problems.join('; ')}`,
    );
  }

  const grillPath = join(runDir, GRILL_STATUS_FILE);
  if (existsSync(grillPath)) {
    const grill = readGrillState(runDir);
    if (!grill) {
      throw new V3DaemonCommandAuthorityError(
        `legacy run ${runId} 的 ${GRILL_STATUS_FILE} 无法解析`,
      );
    }
    if (grill.runId !== runId) {
      throw new V3DaemonCommandAuthorityError(
        `legacy run 目录 ${runId} 与 grill.state.runId ${grill.runId} 不一致`,
      );
    }
    if (grill.chatBinding) assertLegacyBindingShape(grill.chatBinding, runId);
    return {
      ...(grill.chatBinding ? { binding: grill.chatBinding } : {}),
      source: 'legacy-grill',
    };
  }

  // Old standalone/manual runs predate both run.json and grill.state.json.
  // Requiring dag.json distinguishes one of those runs from an empty/unknown
  // directory while preserving the one-release compatibility path.
  if (!existsSync(join(runDir, 'dag.json'))) {
    throw new V3DaemonCommandAuthorityError(
      `v3 run ${runId} 既没有 run.json/grill.state.json，也没有 legacy dag.json`,
    );
  }
  return { source: 'legacy-unbound' };
}

/** The exact identity tuple a chat mutation must prove against the binding. */
export interface V3RunMutationCurrentTuple {
  callerOpenId: string;
  chatId: string;
  larkAppId: string;
}

function mismatchFields(current: V3RunMutationCurrentTuple, target: RunChatBinding): string[] {
  const fields: string[] = [];
  if (current.callerOpenId !== target.ownerOpenId) fields.push('callerOpenId');
  if (current.chatId !== target.chatId) fields.push('chatId');
  if (current.larkAppId !== target.larkAppId) fields.push('larkAppId');
  return fields;
}

/**
 * Chat-tuple authorization core shared by the CLI host path (marker-derived
 * provenance) and the daemon session relay (capability-derived live session).
 * The tuple must have been AUTHENTICATED by the caller: process-tree marker +
 * durable session join on the host, or rotating per-turn capability + the
 * daemon's own live session record on the relay path — never env/argv claims.
 */
export function authorizeV3RunMutationForCurrentTuple(options: {
  runId: string;
  baseDir?: string;
  current: V3RunMutationCurrentTuple;
}): V3DaemonCommandAuthority {
  if (!isValidRunId(options.runId)) {
    throw new V3DaemonCommandAuthorityError(`v3 runId 非法：${options.runId}`);
  }
  const runDir = join(options.baseDir ?? defaultBaseDir(), options.runId);
  const target = readTargetBinding(runDir, options.runId);
  if (!target.binding) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 是未绑定的 standalone/legacy run，不能从 botmux chat turn 修改`,
    );
  }
  if (!nonEmpty(target.binding.ownerOpenId)) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 的 chatBinding 缺少已认证 owner，不能从 botmux chat turn 修改`,
    );
  }
  const mismatches = mismatchFields(options.current, target.binding);
  if (mismatches.length > 0) {
    throw new V3DaemonCommandAuthorityError(
      `当前 turn 与 run ${options.runId} 的 chatBinding 不匹配：${mismatches.join(', ')}`,
    );
  }
  return {
    runDir,
    larkAppId: target.binding.larkAppId,
    mode: 'chat',
    bindingSource: target.source,
  };
}

/**
 * Authorize a CLI daemon mutation and return the only app id it may contact.
 *
 * Chat callers may mutate only a run bound to the exact current
 * (caller, chat, app) tuple. Genuine standalone callers may mutate only an
 * unbound run and must name the daemon explicitly with --bot. This preserves
 * the dev path without letting a detached/stale agent fall back to it.
 */
export function authorizeV3DaemonCommand(
  options: AuthorizeV3DaemonCommandOptions,
): V3DaemonCommandAuthority {
  if (!isValidRunId(options.runId)) {
    throw new V3DaemonCommandAuthorityError(`v3 runId 非法：${options.runId}`);
  }

  const resolveProvenance = options.resolveProvenance ?? resolveCurrentTurnProvenance;
  const current = resolveProvenance({
    dataDir: options.dataDir,
    ...(options.envSessionId ? { envSessionId: options.envSessionId } : {}),
    ...(options.startPid !== undefined ? { startPid: options.startPid } : {}),
    // A turn this run's own events woke acts for the run's frozen initiator,
    // so the owner-tuple check below applies to it unchanged (design §13.1).
    verifyWorkflowEventTurn: workflowEventTurnVerifierFor(options.runId, options.baseDir),
  });
  const runDir = join(options.baseDir ?? defaultBaseDir(), options.runId);
  const requested = options.requestedLarkAppId;
  if (requested !== undefined && !nonEmpty(requested)) {
    throw new V3DaemonCommandAuthorityError('--bot 需要非空 larkAppId');
  }

  if (current) {
    const authority = authorizeV3RunMutationForCurrentTuple({
      runId: options.runId,
      ...(options.baseDir ? { baseDir: options.baseDir } : {}),
      current,
    });
    if (requested !== undefined && requested !== authority.larkAppId) {
      throw new V3DaemonCommandAuthorityError(
        `--bot ${requested} 不能覆盖 run/当前 turn 绑定的 bot ${authority.larkAppId}`,
      );
    }
    return {
      ...authority,
      caller: v3ActionCallerFor({
        runId: options.runId,
        ...(options.baseDir ? { baseDir: options.baseDir } : {}),
        current: {
          callerOpenId: current.callerOpenId,
          turnId: current.turnId,
          ...(current.workflowRunEvent ? { workflowRunEvent: current.workflowRunEvent } : {}),
          ...(current.overtakenWorkflowRunEvent ? { overtakenWorkflowRunEvent: current.overtakenWorkflowRunEvent } : {}),
          ...(parseScheduledTurnId(current.turnId) ? { scheduledTurn: true } : {}),
        },
      }),
    };
  }

  const target = readTargetBinding(runDir, options.runId);

  if (target.binding) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 绑定了 chat caller，standalone 命令不能修改`,
    );
  }
  if (!requested && !options.allowStandaloneLocal) {
    throw new V3DaemonCommandAuthorityError(
      `standalone 操作未绑定 run ${options.runId} 时必须显式提供 --bot <larkAppId>`,
    );
  }
  return {
    runDir,
    larkAppId: requested ?? '',
    mode: 'standalone',
    bindingSource: target.source,
  };
}

// ─── Runtime flow edits (design §13.1, M1) ─────────────────────────────────

/** Who decided a runtime flow edit: `human` — the caller, in a turn their own
 *  message opened; `runEvent` — the main bot on its own, acting for the run's
 *  initiator (a turn this run's events woke, or another turn no message of
 *  the initiator opened; see {@link authorizeV3RunEditForCurrentTuple}). */
export type V3RunEditTurnOrigin = 'human' | 'runEvent';

export interface V3RunEditCurrentTuple extends V3RunMutationCurrentTuple {
  sessionId?: string;
  rootMessageId?: string;
  /** Set only by a trusted resolver (see CurrentTurnProvenance). */
  workflowRunEvent?: { runId: string };
  /** Set only by a trusted resolver: the turn is this run's wake turn, which
   *  a newer message of `callerOpenId` overtook (see CurrentTurnProvenance). */
  overtakenWorkflowRunEvent?: { runId: string };
  /** Set only by a trusted resolver: a scheduled turn
   *  (`schedule:<taskId>:<uuid>`) of a task `callerOpenId` created. */
  scheduledTurn?: boolean;
}

export interface V3RunEditAuthority extends V3DaemonCommandAuthority {
  /** Authenticated human of the current turn. */
  callerOpenId: string;
  /** `runEvent` whenever the main bot decided on its own for the initiator;
   *  `human` only for a turn the caller's own message opened. */
  origin: V3RunEditTurnOrigin;
  /** The request runs inside this run's wake turn (verified, or overtaken
   *  by a newer message): `--reason` is required (design §13.6). */
  wakeTurn?: boolean;
}

/**
 * Authorize `botmux workflow status|edit` for the current turn: the turn must
 * run in the run's main session — the same app and chat, and the bound topic
 * root (or session, for chat-scope runs). Unlike start/cancel/retry/grant the
 * caller need NOT be the owner: anyone talking to the main bot there may ask
 * for an edit, but whether it applies directly or waits for the initiator's
 * confirmation is decided later from {@link V3RunEditAuthority.origin} and
 * {@link V3RunEditAuthority.callerOpenId} (M1).
 */
export function authorizeV3RunEditForCurrentTuple(options: {
  runId: string;
  baseDir?: string;
  current: V3RunEditCurrentTuple;
}): V3RunEditAuthority {
  if (!isValidRunId(options.runId)) {
    throw new V3DaemonCommandAuthorityError(`v3 runId 非法：${options.runId}`);
  }
  const runDir = join(options.baseDir ?? defaultBaseDir(), options.runId);
  const target = readTargetBinding(runDir, options.runId);
  const binding = target.binding;
  if (!binding) {
    throw new V3DaemonCommandAuthorityError(
      `run ${options.runId} 是未绑定的 standalone/legacy run，不支持运行中修改`,
    );
  }
  const { current } = options;
  const wake = current.workflowRunEvent ?? current.overtakenWorkflowRunEvent;
  if (wake && wake.runId !== options.runId) {
    // A wake-up belongs to exactly one run; it never lends its turn to another.
    throw new V3DaemonCommandAuthorityError(
      `该回合由 run ${wake.runId} 的事件唤醒，不能修改 run ${options.runId}`,
    );
  }
  const mismatches: string[] = [];
  if (current.chatId !== binding.chatId) mismatches.push('chatId');
  if (current.larkAppId !== binding.larkAppId) mismatches.push('larkAppId');
  if (binding.rootMessageId) {
    if (current.rootMessageId !== binding.rootMessageId) mismatches.push('rootMessageId');
  } else if (binding.sessionId) {
    if (current.sessionId !== binding.sessionId) mismatches.push('sessionId');
  } else if (!nonEmpty(binding.ownerOpenId) || current.callerOpenId !== binding.ownerOpenId) {
    // Nothing identifies a main session: only the owner's own turn qualifies.
    mismatches.push('callerOpenId');
  }
  if (mismatches.length > 0) {
    throw new V3DaemonCommandAuthorityError(
      `当前 turn 不在 run ${options.runId} 的主会话里：${mismatches.join(', ')}`,
    );
  }
  const wakeTurn = wake?.runId === options.runId;
  return {
    runDir,
    larkAppId: binding.larkAppId,
    mode: 'chat',
    bindingSource: target.source,
    callerOpenId: current.callerOpenId,
    origin: v3RunEditOrigin(options.runId, current, target.initiatorOpenId ?? binding.ownerOpenId),
    ...(wakeTurn ? { wakeTurn: true } : {}),
  };
}

/**
 * Who decided a `retry` / `ask-human` of `runId` from an authenticated turn
 * (same grading as a runtime edit, {@link v3RunEditOrigin}): the main bot for
 * this run's wake turn — and for that wake turn overtaken by the initiator,
 * or the initiator's scheduled turn — otherwise the caller. `wakeTurn` marks
 * a request that must give `--reason`.
 */
export function v3ActionCallerFor(input: {
  runId: string;
  baseDir?: string;
  current: Pick<V3RunEditCurrentTuple, 'callerOpenId' | 'workflowRunEvent' | 'overtakenWorkflowRunEvent' | 'scheduledTurn'> & {
    turnId?: string;
  };
}): V3ActionCaller {
  const runDir = join(input.baseDir ?? defaultBaseDir(), input.runId);
  const target = readTargetBinding(runDir, input.runId);
  const { current } = input;
  const wakeTurn = current.workflowRunEvent?.runId === input.runId || current.overtakenWorkflowRunEvent?.runId === input.runId;
  return {
    origin: v3RunEditOrigin(input.runId, current, target.initiatorOpenId ?? target.binding?.ownerOpenId),
    openId: current.callerOpenId,
    ...(wakeTurn ? { wakeTurn: true } : {}),
    ...(current.turnId ? { turnId: current.turnId } : {}),
  };
}

/**
 * Who decided the edit (M2 乙). Only a turn opened by the caller's own
 * message is the caller's own decision. A turn this run's events woke is the
 * main bot's — and so is that wake turn after a newer message overtook it,
 * and a scheduled turn: the identity they carry is authenticated, but nobody
 * at the keyboard made this request. For the initiator's identity such a
 * turn therefore counts as the main bot acting for the run (`runEvent`: the
 * full §13.5 list, no automatic rerun budget, recorded as `main_bot`); for
 * anyone else's it stays that person's turn (M1: always a proposal).
 */
function v3RunEditOrigin(
  runId: string,
  current: Pick<V3RunEditCurrentTuple, 'callerOpenId' | 'workflowRunEvent' | 'overtakenWorkflowRunEvent' | 'scheduledTurn'>,
  initiatorOpenId: string | undefined,
): V3RunEditTurnOrigin {
  if (current.workflowRunEvent?.runId === runId) return 'runEvent';
  const unattended = current.scheduledTurn === true || current.overtakenWorkflowRunEvent?.runId === runId;
  return unattended && nonEmpty(initiatorOpenId) && current.callerOpenId === initiatorOpenId ? 'runEvent' : 'human';
}

/** CLI host path: authenticate the current turn from the process-tree
 *  marker, then apply {@link authorizeV3RunEditForCurrentTuple}. Runtime
 *  edits are chat-only — a standalone invocation is refused. */
export function authorizeV3RunEditCommand(
  options: Omit<AuthorizeV3DaemonCommandOptions, 'requestedLarkAppId' | 'allowStandaloneLocal'>,
): V3RunEditAuthority {
  if (!isValidRunId(options.runId)) {
    throw new V3DaemonCommandAuthorityError(`v3 runId 非法：${options.runId}`);
  }
  const resolveProvenance = options.resolveProvenance ?? resolveCurrentTurnProvenance;
  const current = resolveProvenance({
    dataDir: options.dataDir,
    ...(options.envSessionId ? { envSessionId: options.envSessionId } : {}),
    ...(options.startPid !== undefined ? { startPid: options.startPid } : {}),
    verifyWorkflowEventTurn: workflowEventTurnVerifierFor(options.runId, options.baseDir),
  });
  if (!current) {
    throw new V3DaemonCommandAuthorityError(
      'workflow status/edit 只能在 run 主会话的当前 botmux turn 里使用',
    );
  }
  return authorizeV3RunEditForCurrentTuple({
    runId: options.runId,
    ...(options.baseDir ? { baseDir: options.baseDir } : {}),
    current: {
      callerOpenId: current.callerOpenId,
      chatId: current.chatId,
      larkAppId: current.larkAppId,
      sessionId: current.sessionId,
      ...(current.rootMessageId ? { rootMessageId: current.rootMessageId } : {}),
      ...(current.workflowRunEvent ? { workflowRunEvent: current.workflowRunEvent } : {}),
      ...(current.overtakenWorkflowRunEvent ? { overtakenWorkflowRunEvent: current.overtakenWorkflowRunEvent } : {}),
      ...(parseScheduledTurnId(current.turnId) ? { scheduledTurn: true } : {}),
    },
  });
}

/** The run's initiator: the Gate-2 approver of an ad-hoc run, otherwise the
 *  authenticated owner the run was bound to (saved-workflow runs). */
export function resolveV3RunInitiator(envelope: V3RunEnvelope): string | undefined {
  if (envelope.authorization.kind === 'gate2' && envelope.authorization.authorizedByOpenId) {
    return envelope.authorization.authorizedByOpenId;
  }
  return envelope.chatBinding?.ownerOpenId;
}

/**
 * Verify a `workflow-event:<runId>:<seq>` turn for a status/edit of `runId`:
 * the turn must belong to this very run, run in its main session (app, chat,
 * topic root), and name an event that exists in a run that is still active.
 * The turn then acts for the run's initiator; the edit path records it as the
 * main bot (origin `runEvent`).
 */
export function workflowEventTurnVerifierFor(
  runId: string,
  baseDir?: string,
  now: () => number = Date.now,
): WorkflowEventTurnVerifier {
  return ({ runId: turnRunId, eventSeq, turnId, session }) => {
    if (turnRunId !== runId) return { ok: false, reason: `回合属于 run ${turnRunId}` };
    const runDir = join(baseDir ?? defaultBaseDir(), runId);
    // Only a turn the run-owning daemon recorded as issued to THIS session.
    const issued = readV3MainWakeIssued(runDir, eventSeq);
    if (
      !issued || issued.runId !== runId || issued.turnId !== turnId ||
      issued.sessionId !== session.sessionId || issued.larkAppId !== session.larkAppId ||
      issued.chatId !== session.chatId || (issued.rootMessageId ?? undefined) !== session.rootMessageId ||
      issued.issuedAt > now()
    ) {
      return { ok: false, reason: '该回合不是拥有该 run 的 daemon 签发的' };
    }
    // Generation join (same rule as human turns): if a message has advanced
    // the session's turn pointers since the wake turn was issued, the
    // session's identity now belongs to that newer turn — `stale` tells the
    // caller to authenticate the request as that turn instead. A record
    // without `turnPointersAtIssue` counts as overtaken as soon as the
    // session has a pointer. A pointer moved by an unattended synthetic turn
    // (a report relay, another wake turn, a scheduled fire) is no
    // interjection and does not count; every other pointer does, so a card
    // click or an unknown id still makes the wake turn stale (and, having no
    // human turn to fall back to, refused) — see V3MainWakeRecord.
    const advanced = (pointer: string | undefined, atIssue: string | undefined): boolean =>
      pointer !== undefined && pointer !== turnId && pointer !== atIssue && !isUnattendedSyntheticTurnId(pointer);
    if (
      advanced(session.quoteTargetId, issued.turnPointersAtIssue?.quoteTargetId) ||
      advanced(session.currentReplyTargetTurnId, issued.turnPointersAtIssue?.currentReplyTargetTurnId)
    ) {
      return { ok: false, reason: '主会话已有更新的人类消息，事件回合不再代表当前回合', stale: true };
    }
    const envelope = readRunEnvelope(runDir, runId);
    if (envelope.kind !== 'ok' || !envelope.envelope.chatBinding) {
      return { ok: false, reason: 'run 没有可验证的 run.json 绑定' };
    }
    const binding = envelope.envelope.chatBinding;
    if (session.larkAppId !== binding.larkAppId || session.chatId !== binding.chatId) {
      return { ok: false, reason: '会话不属于该 run 的应用/群' };
    }
    if (binding.rootMessageId ? session.rootMessageId !== binding.rootMessageId : binding.sessionId !== session.sessionId) {
      return { ok: false, reason: '会话不是该 run 的主会话' };
    }
    const events = readJournal(join(runDir, 'journal.ndjson'));
    if (eventSeq > events.length) return { ok: false, reason: '唤醒事件不存在' };
    const status = materialize(events).runStatus;
    if (status !== 'running' && status !== 'blocked') return { ok: false, reason: `run 已是 ${status}` };
    const initiator = resolveV3RunInitiator(envelope.envelope);
    if (!initiator) return { ok: false, reason: 'run 没有已认证的发起人' };
    return { ok: true, callerOpenId: initiator };
  };
}
