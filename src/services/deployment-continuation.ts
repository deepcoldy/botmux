import type { PendingCliInput } from '../utils/pending-input-queue.js';
import type { Session, TrustedCaller, WorkerToDaemon } from '../types.js';

/** One native-consumed ordinary turn, not a copy of its business prompt. */
export interface DeploymentContinuation {
  turnId: string;
  nativeSessionId: string;
  caller: TrustedCaller;
  workerGeneration: number;
  consumedAt: number;
  state: 'running' | 'claimed';
}

export type DeploymentContinuationRecord = DeploymentContinuation | { state: 'cancelled'; turnId: string };

const MAX_AGE_MS = 24 * 60 * 60_000;

/** Recovery owns only local ordinary Codex TUI turns. Other execution owners
 * keep their existing replay protocols. This predicate is checked again at
 * dispatch, not just when a restore candidate is enumerated. */
export function deploymentContinuationEligible(session: Session): boolean {
  return session.status === 'active'
    && (session.cliLaunchSnapshot?.cliId ?? session.cliId) === 'codex'
    && session.backendType === 'tmux'
    && !session.adoptedFrom && !session.principalLane
    && !session.xpiSharedCwdAdmissionGroupId && !session.xpiSharedCwdAdmissionLease
    && !session.vcMeetingReceiver && !session.deferredScheduleRun
    && !session.externalTriggerTopicless && !session.workspaceRetirement
    && !session.queued && !session.queuedActivationPending
    && !session.suspendedColdResume && !(session.queuedActivationTail?.length)
    && !session.readonlyTaskContinuation
    && !['backoff', 'dispatching'].includes(session.ordinaryTurnRecovery?.status ?? '');
}

export function deploymentContinuationCandidate(
  session: Session, now = Date.now(),
): DeploymentContinuation | undefined {
  const value = session.deploymentContinuation;
  if (!deploymentContinuationEligible(session) || !value || value.state !== 'running'
    || session.durablePrimaryInputCommits?.some(commit => commit.turnId === value.turnId)
    || typeof value.turnId !== 'string' || !value.turnId.startsWith('om_') || !value.nativeSessionId
    || !value.caller
    || value.nativeSessionId !== session.cliSessionId
    || value.caller.senderType !== 'user' || value.caller.source !== undefined
    || value.caller.requestLarkAppId !== session.larkAppId
    || !value.caller.requestUserOpenId?.startsWith('ou_')
    || !Number.isFinite(value.consumedAt) || value.consumedAt > now
    || now - value.consumedAt > MAX_AGE_MS) return;
  return value;
}

/** Persist-before-effect. Failure restores the in-memory projection and must
 * prevent the caller from dispatching input or sending an interrupt. */
export function setDeploymentContinuation(
  session: Session, value: DeploymentContinuationRecord | undefined, persist: (previous: DeploymentContinuationRecord | undefined) => void,
): void {
  const previous = session.deploymentContinuation;
  session.deploymentContinuation = value;
  try { persist(previous); }
  catch (error) { session.deploymentContinuation = previous; throw error; }
}

export function cancelDeploymentContinuation(
  session: Session, persist: (previous: DeploymentContinuationRecord | undefined) => void,
  turnId?: string, allowUnrecorded = false,
): void {
  const current = session.deploymentContinuation;
  const target = turnId ?? current?.turnId;
  if (!target) return;
  if ((!current || current.state === 'cancelled')
    && (!deploymentContinuationEligible(session) || !target.startsWith('om_'))) return;
  if (current?.state === 'cancelled' && current.turnId === target) return;
  if (current && current.turnId !== target
    && (current.state !== 'cancelled' || !allowUnrecorded)) return;
  if (!current && !allowUnrecorded) return;
  // A stop can precede the first native receipt. Persist its exact turn even
  // without a checkpoint so that delayed acceptance cannot rearm the task.
  setDeploymentContinuation(session, { state: 'cancelled', turnId: target }, persist);
}

/** Claim once before a new worker can type a continuation. A crash after this
 * write has an unknown dispatch outcome: do not claim it on another boot.
 * Only native-consumption evidence can return it to running. */
export function claimDeploymentContinuation(
  session: Session, expected: DeploymentContinuation, persist: (previous: DeploymentContinuationRecord | undefined) => void,
): DeploymentContinuation | undefined {
  if (deploymentContinuationCandidate(session) !== expected) return;
  const claimed = { ...structuredClone(expected), state: 'claimed' as const };
  setDeploymentContinuation(session, claimed, persist);
  return claimed;
}

/** The worker may reconstruct attribution only for a cold resume of the exact
 * native conversation. No original request is replayed; its transcript remains
 * the source of business context. */
export function deploymentContinuationTemplate(
  value: DeploymentContinuation | undefined,
  context: { appId: string; nativeSessionId?: string; resumed: boolean; reattached: boolean },
): PendingCliInput | undefined {
  if (!value || value.state !== 'claimed' || !context.resumed || context.reattached
    || value.nativeSessionId !== context.nativeSessionId
    || value.caller.requestLarkAppId !== context.appId
    || value.caller.senderType !== 'user' || value.caller.source !== undefined
    || !value.caller.requestUserOpenId?.startsWith('ou_')
    || !value.turnId.startsWith('om_')) return;
  return { content: '', turnId: value.turnId,
    turnCallerOpenId: value.caller.requestUserOpenId,
    trustedCaller: { ...value.caller, source: 'failed_turn_recovery' } };
}

export function recordDeploymentContinuation(
  session: Session,
  receipt: Extract<WorkerToDaemon, { type: 'native_input_consumed' }>,
  context: { caller?: TrustedCaller; currentTurnId?: string; workerGeneration: number; rpc: boolean },
  persist: (previous: DeploymentContinuationRecord | undefined) => void,
): boolean {
  const caller = context.caller;
  if (receipt.ordinaryInteractive !== true || receipt.proofKind !== 'codex_history_match' || !receipt.nativeSessionId
    || !deploymentContinuationEligible(session) || context.rpc
    || session.workerGeneration !== context.workerGeneration
    || (session.cliSessionId !== undefined && receipt.nativeSessionId !== session.cliSessionId)
    || session.durablePrimaryInputCommits?.some(commit => commit.turnId === receipt.turnId)
    || context.currentTurnId !== receipt.turnId || !receipt.turnId.startsWith('om_')
    || caller?.senderType !== 'user' || caller.source !== undefined
    || caller.requestLarkAppId !== session.larkAppId
    || !caller.requestUserOpenId?.startsWith('ou_')
    || (session.deploymentContinuation?.turnId === receipt.turnId
      && session.deploymentContinuation.state === 'cancelled')) return false;
  setDeploymentContinuation(session, {
    turnId: receipt.turnId, nativeSessionId: receipt.nativeSessionId,
    caller: { ...caller }, workerGeneration: context.workerGeneration,
    consumedAt: Date.now(), state: 'running',
  }, persist);
  return true;
}

export function deploymentContinuationClaimCurrent(session: Session, claim: DeploymentContinuation): boolean {
  return claim.state === 'claimed'
    && JSON.stringify(session.deploymentContinuation) === JSON.stringify(claim)
    && !!deploymentContinuationCandidate({ ...session, deploymentContinuation: { ...claim, state: 'running' } });
}
