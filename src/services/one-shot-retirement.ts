import type { OneShotRetirement, Session } from '../types.js';

/** Exact authority for one ordinary per-message session lifetime. */
export interface OneShotRetirementTuple {
  sessionId: string;
  workerGeneration: number;
  turnId: string;
  dispatchAttempt?: number;
}

export interface OneShotTerminalEvidence {
  kind: 'terminal';
  status: 'completed' | 'failed' | 'cancelled' | 'ambiguous';
  outputDisposition?: 'nothing_to_send';
  completedAtMs?: number;
}

export interface OneShotDeliveryEvidence {
  kind: 'delivery';
  source: 'automatic_final' | 'explicit_final' | 'terminal_notice' | 'nothing_to_send';
  messageId?: string;
}

export interface OneShotDeliveryUncertainEvidence {
  kind: 'delivery_uncertain';
  reason: string;
}

export type OneShotRetirementEvidence =
  | OneShotTerminalEvidence
  | OneShotDeliveryEvidence
  | OneShotDeliveryUncertainEvidence;

export type OneShotRetirementObservation =
  | { outcome: 'not_one_shot' }
  | { outcome: 'stale'; reason: string }
  | { outcome: 'conflict'; reason: string }
  | { outcome: 'duplicate'; retirement: OneShotRetirement }
  | { outcome: 'persisted'; retirement: OneShotRetirement };

export interface OneShotRetirementPersistence {
  persist: (session: Session) => void;
  now?: () => Date;
}

export interface OneShotRetirementCloseCallbackResult {
  ok: boolean;
}

export interface OneShotRetirementCloseDeps extends OneShotRetirementPersistence {
  close: (
    sessionId: string,
    context: string,
  ) => OneShotRetirementCloseCallbackResult | Promise<OneShotRetirementCloseCallbackResult>;
}

export type OneShotRetirementCloseResult =
  | { outcome: 'not_one_shot' | 'not_ready' | 'stale' | 'conflict'; reason?: string }
  | { outcome: 'close_requested'; result: OneShotRetirementCloseCallbackResult }
  | { outcome: 'close_refused'; result: OneShotRetirementCloseCallbackResult };

export interface OneShotRetirementBootReconciliation {
  closedSessionIds: Set<string>;
  quarantinedSessionIds: Set<string>;
  quarantineReasons: Map<string, string>;
}

export interface OneShotRetirementBootDeps extends OneShotRetirementCloseDeps {
  ownerLarkAppId: string;
  /** Fresh durable read used to verify that an ok close actually committed. */
  read: (sessionId: string) => Session | undefined;
}

const closeInFlight = new Map<string, Promise<OneShotRetirementCloseResult>>();

function validPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sameOptionalAttempt(left: number | undefined, right: number | undefined): boolean {
  return left === right;
}

function tupleKey(tuple: OneShotRetirementTuple): string {
  return [tuple.sessionId, tuple.workerGeneration, tuple.turnId, tuple.dispatchAttempt ?? ''].join('\0');
}

function tupleProblem(tuple: OneShotRetirementTuple): string | undefined {
  if (!tuple.sessionId) return 'invalid_session_id';
  if (!tuple.turnId) return 'invalid_turn_id';
  if (!validPositiveInteger(tuple.workerGeneration)) return 'invalid_worker_generation';
  if (tuple.dispatchAttempt !== undefined && !validPositiveInteger(tuple.dispatchAttempt)) {
    return 'invalid_dispatch_attempt';
  }
  return undefined;
}

function terminalDeliveryConflict(retirement: OneShotRetirement): string | undefined {
  const terminal = retirement.terminal;
  const delivery = retirement.delivery;
  if (!terminal || delivery.state !== 'settled') return undefined;
  if (terminal.outputDisposition === 'nothing_to_send'
    && delivery.source !== 'nothing_to_send'
    && delivery.source !== 'terminal_notice') {
    return 'nothing_to_send_delivery_conflict';
  }
  if (delivery.source === 'nothing_to_send'
    && (terminal.status !== 'completed' || terminal.outputDisposition !== 'nothing_to_send')) {
    return 'nothing_to_send_terminal_conflict';
  }
  if (delivery.source === 'automatic_final' && terminal.status !== 'completed') {
    return 'automatic_final_terminal_conflict';
  }
  if (delivery.source === 'terminal_notice'
    && terminal.status === 'completed'
    && terminal.outputDisposition !== 'nothing_to_send') {
    return 'terminal_notice_terminal_conflict';
  }
  return undefined;
}

function retirementIdentityProblem(
  retirement: OneShotRetirement,
  tuple: OneShotRetirementTuple,
): string | undefined {
  if (retirement.version !== 1) return 'unsupported_retirement_version';
  if (retirement.turnId !== tuple.turnId) return 'retirement_turn_conflict';
  if (retirement.workerGeneration !== tuple.workerGeneration) {
    return 'retirement_generation_conflict';
  }
  if (!sameOptionalAttempt(retirement.dispatchAttempt, tuple.dispatchAttempt)) {
    return 'retirement_attempt_conflict';
  }
  if (!['armed', 'waiting', 'ready', 'closing'].includes(retirement.phase)) {
    return 'invalid_retirement_phase';
  }
  if (!retirement.delivery || !['pending', 'settled', 'uncertain'].includes(retirement.delivery.state)) {
    return 'invalid_retirement_delivery';
  }
  const conflict = terminalDeliveryConflict(retirement);
  if (conflict) return conflict;
  const joined = retirement.terminal !== undefined && retirement.delivery.state === 'settled';
  if ((retirement.phase === 'ready' || retirement.phase === 'closing') && !joined) {
    return 'retirement_ready_without_joined_evidence';
  }
  if (retirement.phase === 'armed'
    && (retirement.terminal !== undefined || retirement.delivery.state !== 'pending')) {
    return 'retirement_armed_with_evidence';
  }
  return undefined;
}

function sessionIdentityProblem(
  session: Session,
  tuple: OneShotRetirementTuple,
  allowUnboundGeneration: boolean,
): { kind: 'not_one_shot' | 'stale' | 'conflict'; reason: string } | undefined {
  const oneShot = session.oneShot;
  if (!oneShot || oneShot.version !== 1 || oneShot.mode !== 'ordinary_per_message') {
    return { kind: 'not_one_shot', reason: 'not_one_shot' };
  }
  const malformedTuple = tupleProblem(tuple);
  if (malformedTuple) return { kind: 'conflict', reason: malformedTuple };
  if (session.sessionId !== tuple.sessionId) {
    return { kind: 'stale', reason: 'session_id_mismatch' };
  }
  if (session.status !== 'active') {
    return { kind: 'stale', reason: 'session_not_active' };
  }
  if (oneShot.turn.turnId !== tuple.turnId) {
    return { kind: 'stale', reason: 'turn_id_mismatch' };
  }
  if (!sameOptionalAttempt(oneShot.turn.dispatchAttempt, tuple.dispatchAttempt)) {
    return { kind: 'stale', reason: 'dispatch_attempt_mismatch' };
  }
  if (session.workerGeneration !== tuple.workerGeneration) {
    return { kind: 'stale', reason: 'session_generation_mismatch' };
  }
  if (oneShot.turn.workerGeneration === undefined) {
    if (!allowUnboundGeneration) {
      return { kind: 'conflict', reason: 'one_shot_generation_unbound' };
    }
  } else if (oneShot.turn.workerGeneration !== tuple.workerGeneration) {
    return { kind: 'stale', reason: 'one_shot_generation_mismatch' };
  }
  if (oneShot.retirement) {
    const retirementProblem = retirementIdentityProblem(oneShot.retirement, tuple);
    if (retirementProblem) return { kind: 'conflict', reason: retirementProblem };
  }
  return undefined;
}

function isoNow(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

function persistOneShot(
  session: Session,
  nextOneShot: NonNullable<Session['oneShot']>,
  persist: (session: Session) => void,
): void {
  const previous = session.oneShot;
  session.oneShot = nextOneShot;
  try {
    persist(session);
  } catch (error) {
    session.oneShot = previous;
    throw error;
  }
}

function nextPhase(retirement: OneShotRetirement): OneShotRetirement['phase'] {
  if (retirement.phase === 'closing') return 'closing';
  if (retirement.terminal && retirement.delivery.state === 'settled') return 'ready';
  if (retirement.terminal || retirement.delivery.state !== 'pending') return 'waiting';
  return 'armed';
}

function sameTerminal(
  current: NonNullable<OneShotRetirement['terminal']>,
  evidence: OneShotTerminalEvidence,
): boolean {
  return current.status === evidence.status
    && (evidence.outputDisposition === undefined
      || current.outputDisposition === evidence.outputDisposition)
    && (evidence.completedAtMs === undefined || current.completedAtMs === evidence.completedAtMs);
}

function sameDelivery(
  current: Extract<OneShotRetirement['delivery'], { state: 'settled' }>,
  evidence: OneShotDeliveryEvidence,
): boolean {
  return current.source === evidence.source
    && (evidence.messageId === undefined || current.messageId === evidence.messageId);
}

function validateDeliveryEvidence(evidence: OneShotDeliveryEvidence): string | undefined {
  if (evidence.source === 'nothing_to_send') {
    return evidence.messageId === undefined ? undefined : 'nothing_to_send_has_message_id';
  }
  if (!evidence.messageId?.trim()) return 'delivery_message_id_missing';
  return undefined;
}

/** Arm the exact worker lifetime before accepting terminal or delivery proof. */
export function armOneShotRetirement(
  session: Session,
  tuple: OneShotRetirementTuple,
  deps: OneShotRetirementPersistence,
): OneShotRetirementObservation {
  const problem = sessionIdentityProblem(session, tuple, true);
  if (problem) {
    return problem.kind === 'not_one_shot'
      ? { outcome: 'not_one_shot' }
      : { outcome: problem.kind, reason: problem.reason };
  }
  const oneShot = session.oneShot!;
  if (oneShot.retirement) {
    return { outcome: 'duplicate', retirement: oneShot.retirement };
  }
  const retirement: OneShotRetirement = {
    version: 1,
    turnId: tuple.turnId,
    ...(tuple.dispatchAttempt !== undefined ? { dispatchAttempt: tuple.dispatchAttempt } : {}),
    workerGeneration: tuple.workerGeneration,
    phase: 'armed',
    delivery: { state: 'pending' },
    updatedAt: isoNow(deps.now),
  };
  persistOneShot(session, {
    ...oneShot,
    turn: { ...oneShot.turn, workerGeneration: tuple.workerGeneration },
    retirement,
  }, deps.persist);
  return { outcome: 'persisted', retirement };
}

/** Persist one side of the terminal/delivery join without closing the session. */
export function recordOneShotRetirementEvidence(
  session: Session,
  tuple: OneShotRetirementTuple,
  evidence: OneShotRetirementEvidence,
  deps: OneShotRetirementPersistence,
): OneShotRetirementObservation {
  const problem = sessionIdentityProblem(session, tuple, false);
  if (problem) {
    return problem.kind === 'not_one_shot'
      ? { outcome: 'not_one_shot' }
      : { outcome: problem.kind, reason: problem.reason };
  }
  const oneShot = session.oneShot!;
  const current = oneShot.retirement;
  if (!current) return { outcome: 'conflict', reason: 'retirement_not_armed' };

  let next: OneShotRetirement = structuredClone(current);
  let changed = false;

  if (evidence.kind === 'terminal') {
    if (evidence.outputDisposition === 'nothing_to_send' && evidence.status !== 'completed') {
      return { outcome: 'conflict', reason: 'nothing_to_send_without_completed_terminal' };
    }
    if (current.terminal) {
      if (!sameTerminal(current.terminal, evidence)) {
        return { outcome: 'conflict', reason: 'terminal_evidence_conflict' };
      }
      const enriched = {
        ...current.terminal,
        ...(evidence.outputDisposition !== undefined
          ? { outputDisposition: evidence.outputDisposition }
          : {}),
        ...(evidence.completedAtMs !== undefined ? { completedAtMs: evidence.completedAtMs } : {}),
      };
      if (JSON.stringify(enriched) !== JSON.stringify(current.terminal)) {
        next.terminal = enriched;
        changed = true;
      }
    } else {
      next.terminal = {
        status: evidence.status,
        ...(evidence.outputDisposition !== undefined
          ? { outputDisposition: evidence.outputDisposition }
          : {}),
        ...(evidence.completedAtMs !== undefined ? { completedAtMs: evidence.completedAtMs } : {}),
      };
      changed = true;
    }

  } else if (evidence.kind === 'delivery') {
    const evidenceProblem = validateDeliveryEvidence(evidence);
    if (evidenceProblem) return { outcome: 'conflict', reason: evidenceProblem };
    if (current.delivery.state === 'uncertain') {
      return { outcome: 'conflict', reason: 'delivery_already_uncertain' };
    }
    if (current.delivery.state === 'settled') {
      return sameDelivery(current.delivery, evidence)
        ? { outcome: 'duplicate', retirement: current }
        : { outcome: 'conflict', reason: 'delivery_evidence_conflict' };
    }
    next.delivery = {
      state: 'settled',
      source: evidence.source,
      messageId: evidence.messageId!,
    };
    changed = true;
  } else {
    const reason = evidence.reason.trim();
    if (!reason) return { outcome: 'conflict', reason: 'delivery_uncertainty_reason_missing' };
    if (current.delivery.state === 'settled') {
      return { outcome: 'conflict', reason: 'uncertainty_after_settlement' };
    }
    if (current.delivery.state === 'uncertain') {
      return current.delivery.reason === reason
        ? { outcome: 'duplicate', retirement: current }
        : { outcome: 'conflict', reason: 'delivery_uncertainty_conflict' };
    }
    next.delivery = { state: 'uncertain', reason };
    changed = true;
  }

  const conflict = terminalDeliveryConflict(next);
  if (conflict) return { outcome: 'conflict', reason: conflict };
  const phase = nextPhase(next);
  if (phase !== next.phase) {
    next.phase = phase;
    changed = true;
  }
  if (!changed) return { outcome: 'duplicate', retirement: current };
  next.updatedAt = isoNow(deps.now);
  persistOneShot(session, { ...oneShot, retirement: next }, deps.persist);
  return { outcome: 'persisted', retirement: next };
}

/**
 * Claim and close a joined retirement. Ready is always a separately persisted
 * state: only a subsequent write advances it to closing, and only after that
 * write succeeds is the authoritative close callback invoked.
 */
export async function closeOneShotRetirementIfReady(
  session: Session,
  tuple: OneShotRetirementTuple,
  deps: OneShotRetirementCloseDeps,
): Promise<OneShotRetirementCloseResult> {
  const problem = sessionIdentityProblem(session, tuple, false);
  if (problem) {
    return problem.kind === 'not_one_shot'
      ? { outcome: 'not_one_shot' }
      : { outcome: problem.kind, reason: problem.reason };
  }
  const retirement = session.oneShot!.retirement;
  if (!retirement) return { outcome: 'conflict', reason: 'retirement_not_armed' };
  if (retirement.phase !== 'ready' && retirement.phase !== 'closing') {
    return { outcome: 'not_ready' };
  }

  const key = tupleKey(tuple);
  const existing = closeInFlight.get(key);
  if (existing) return existing;

  if (retirement.phase === 'ready') {
    const closing: OneShotRetirement = {
      ...retirement,
      phase: 'closing',
      updatedAt: isoNow(deps.now),
    };
    persistOneShot(session, { ...session.oneShot!, retirement: closing }, deps.persist);
  }

  const task = Promise.resolve()
    .then(() => deps.close(
      tuple.sessionId,
      'one-shot retirement ' + tuple.turnId + ' generation ' + tuple.workerGeneration,
    ))
    .then(result => result.ok
      ? { outcome: 'close_requested' as const, result }
      : { outcome: 'close_refused' as const, result });
  closeInFlight.set(key, task);
  const clear = (): void => {
    if (closeInFlight.get(key) === task) closeInFlight.delete(key);
  };
  void task.then(clear, clear);
  return task;
}

/**
 * Re-drive crash-interrupted ready/closing rows before active-session restore.
 * Any exact-owner row whose tuple cannot be validated, whose authoritative
 * close is refused, or whose close throws is durably quarantined. Ownerless or
 * foreign-owner rows are returned in the quarantine set without mutation, so
 * each daemon can fail closed without racing to rewrite another daemon's row.
 * The caller must exclude the complete returned set from this boot's restore.
 */
export async function reconcileOneShotRetirementsOnBoot(
  sessions: readonly Session[],
  deps: OneShotRetirementBootDeps,
): Promise<OneShotRetirementBootReconciliation> {
  const closedSessionIds = new Set<string>();
  const quarantinedSessionIds = new Set<string>();
  const quarantineReasons = new Map<string, string>();

  const quarantineFresh = (snapshot: Session, reason: string): void => {
    const session = deps.read(snapshot.sessionId);
    if (!session) {
      throw new Error(`one-shot row disappeared during boot reconciliation: ${snapshot.sessionId}`);
    }
    // A concurrent/idempotent durable close makes quarantine unnecessary.
    if (session.status === 'closed') {
      closedSessionIds.add(snapshot.sessionId);
      return;
    }
    if (session.status !== 'active') {
      throw new Error(
        `one-shot row has unsupported status during boot reconciliation: `
        + `${snapshot.sessionId}:${String(session.status)}`,
      );
    }
    const previous = session.restoreQuarantinedAt;
    session.restoreQuarantinedAt ??= isoNow(deps.now);
    try {
      deps.persist(session);
    } catch (error) {
      session.restoreQuarantinedAt = previous;
      throw error;
    }
    quarantinedSessionIds.add(snapshot.sessionId);
    quarantineReasons.set(snapshot.sessionId, reason);
  };

  for (const session of sessions) {
    if (session.status !== 'active' || session.oneShot === undefined) continue;

    // Never let a daemon guess ownership of a legacy/misfiled one-shot row. It
    // may reserve its visible lane, but only an exact app owner may mutate the
    // row or re-drive a provider-affecting close. Treat the row as quarantined
    // for this boot without writing it: an ownerless legacy store may be visible
    // to several daemons, and a quarantine write here would itself create a
    // cross-daemon mutation race.
    if (session.larkAppId !== deps.ownerLarkAppId) {
      quarantinedSessionIds.add(session.sessionId);
      quarantineReasons.set(session.sessionId, session.larkAppId === undefined
        ? 'one_shot_owner_missing'
        : 'one_shot_owner_mismatch');
      continue;
    }

    const rawOneShot: unknown = session.oneShot;
    if (!rawOneShot || typeof rawOneShot !== 'object' || Array.isArray(rawOneShot)) {
      quarantineFresh(session, 'invalid_one_shot_identity');
      continue;
    }
    const oneShot = rawOneShot as Partial<NonNullable<Session['oneShot']>>;
    const turn = oneShot.turn;
    if (oneShot.version !== 1
      || oneShot.mode !== 'ordinary_per_message'
      || typeof oneShot.routingAnchor !== 'string'
      || oneShot.routingAnchor.length === 0
      || typeof oneShot.visibleLaneKey !== 'string'
      || oneShot.visibleLaneKey.length === 0
      || !turn
      || typeof turn !== 'object'
      || typeof turn.turnId !== 'string'
      || turn.turnId.length === 0
      || (turn.dispatchAttempt !== undefined && !validPositiveInteger(turn.dispatchAttempt))
      || (turn.workerGeneration !== undefined && !validPositiveInteger(turn.workerGeneration))) {
      quarantineFresh(session, 'invalid_one_shot_identity');
      continue;
    }

    const retirement = oneShot.retirement;
    if (!retirement) {
      quarantineFresh(session, 'retirement_not_armed');
      continue;
    }
    if (typeof retirement !== 'object' || Array.isArray(retirement)) {
      quarantineFresh(session, 'invalid_retirement');
      continue;
    }
    if (!['armed', 'waiting', 'ready', 'closing'].includes(retirement.phase)) {
      quarantineFresh(session, 'invalid_retirement_phase');
      continue;
    }
    if (retirement.phase !== 'ready' && retirement.phase !== 'closing') {
      const uncertainty = retirement.delivery?.state === 'uncertain'
        ? `:${retirement.delivery.reason}`
        : '';
      quarantineFresh(session, `retirement_${retirement.phase}${uncertainty}`);
      continue;
    }

    // Preserve the persisted identity verbatim. An absent/invalid generation
    // becomes a coordinator conflict and is quarantined rather than guessed.
    const tuple: OneShotRetirementTuple = {
      sessionId: session.sessionId,
      workerGeneration: retirement.workerGeneration ?? 0,
      turnId: retirement.turnId,
      ...(retirement.dispatchAttempt !== undefined
        ? { dispatchAttempt: retirement.dispatchAttempt }
        : {}),
    };
    try {
      const result = await closeOneShotRetirementIfReady(session, tuple, deps);
      if (result.outcome === 'close_requested') {
        const durable = deps.read(session.sessionId);
        if (!durable) {
          throw new Error(`one-shot row disappeared after close: ${session.sessionId}`);
        }
        if (durable.status !== 'closed') {
          quarantineFresh(session, 'close_not_durable');
          continue;
        }
        closedSessionIds.add(session.sessionId);
        continue;
      }
      const outcome: string = result.outcome;
      const detail: string | undefined = 'reason' in result ? result.reason : undefined;
      const reason: string = detail ? `${outcome}:${detail}` : outcome;
      quarantineFresh(session, reason);
    } catch (error) {
      quarantineFresh(
        session,
        `close_error:${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { closedSessionIds, quarantinedSessionIds, quarantineReasons };
}

/** Test isolation for the process-local duplicate-close join. */
export function __testOnly_resetOneShotRetirementCloseState(): void {
  closeInFlight.clear();
}
