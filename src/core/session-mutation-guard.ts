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

/**
 * True while a session owns work that an ordinary config/restart/switch
 * mutation is not authorized to abandon. Explicit close remains the escape
 * hatch. Keep this backend-neutral: the activation journal protects pty and
 * Riff submissions just as the Codex App ledger protects accepted dispatches.
 */
export function hasProtectedSessionMutationOwnership(
  value: ProtectedRuntimeMutationState | ProtectedSessionMutationState,
): boolean {
  const ds: ProtectedRuntimeMutationState | undefined = 'session' in value
    ? value
    : undefined;
  const session: ProtectedSessionMutationState = ds
    ? ds.session
    : value as ProtectedSessionMutationState;
  return hasUnsettledCodexAppDispatch(session.codexAppDispatchLedger)
    || session.queued === true
    || session.queuedActivationPending === true
    || (session.queuedActivationTail?.length ?? 0) > 0
    || session.pendingRepoSetup !== undefined
    || ds?.initialStartPending === true
    || ds?.riffCloseState !== undefined
    || ds?.riffShutdownState !== undefined;
}
