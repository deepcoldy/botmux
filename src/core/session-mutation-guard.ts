import type { Session } from '../types.js';
import { hasUnsettledCodexAppDispatch } from '../utils/codex-app-dispatch-ledger.js';

type ProtectedSessionMutationState = Pick<
  Session,
  | 'codexAppDispatchLedger'
  | 'queued'
  | 'queuedActivationPending'
  | 'queuedActivationTail'
  | 'pendingRepoSetup'
>;

type ProtectedRuntimeMutationState = {
  session: ProtectedSessionMutationState;
  initialStartPending?: boolean;
  riffCloseState?: unknown;
  riffShutdownState?: unknown;
};

export type ProtectedSessionMutationReason =
  | 'codex_app_dispatch'
  | 'queued_todo'
  | 'activation_head'
  | 'activation_tail'
  | 'repository_setup'
  | 'initial_start'
  | 'riff_close'
  | 'riff_shutdown';

export function protectedSessionMutationReasons(
  value: ProtectedRuntimeMutationState | ProtectedSessionMutationState,
): ProtectedSessionMutationReason[] {
  const ds: ProtectedRuntimeMutationState | undefined = 'session' in value
    ? value
    : undefined;
  const session: ProtectedSessionMutationState = ds
    ? ds.session
    : value as ProtectedSessionMutationState;
  const reasons: ProtectedSessionMutationReason[] = [];
  if (hasUnsettledCodexAppDispatch(session.codexAppDispatchLedger)) reasons.push('codex_app_dispatch');
  if (session.queued === true) reasons.push('queued_todo');
  if (session.queuedActivationPending === true) reasons.push('activation_head');
  if ((session.queuedActivationTail?.length ?? 0) > 0) reasons.push('activation_tail');
  if (session.pendingRepoSetup !== undefined) reasons.push('repository_setup');
  if (ds?.initialStartPending === true) reasons.push('initial_start');
  if (ds?.riffCloseState !== undefined) reasons.push('riff_close');
  if (ds?.riffShutdownState !== undefined) reasons.push('riff_shutdown');
  return reasons;
}

/**
 * True while a session owns work that an ordinary config/restart/switch
 * mutation is not authorized to abandon. Explicit close remains the escape
 * hatch. Keep this backend-neutral: the activation journal protects pty and
 * Riff submissions just as the Codex App ledger protects accepted dispatches.
 */
export function hasProtectedSessionMutationOwnership(
  value: ProtectedRuntimeMutationState | ProtectedSessionMutationState,
): boolean {
  return protectedSessionMutationReasons(value).length > 0;
}
