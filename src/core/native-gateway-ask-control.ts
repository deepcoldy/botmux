import {
  answerNativeGatewayAsk,
  getAskSnapshot,
  listPendingAsks,
  setCardDispatcher,
  setNativeGatewayAskLivenessChecker,
} from './ask-broker.js';
import { confirmNativeGatewayAskDelivered, createNativeGatewayAskDispatcher } from './native-gateway-ask-dispatch.js';
import { projectCoreOnlyProgress } from './core-only-progress.js';
import type { AskCardDispatcher, NativeGatewayAskTurnOrigin } from './ask-types.js';
import type {
  NativeGatewayAnswerAction,
  NativeGatewayAskOrigin,
  NativeGatewayAskSnapshot,
} from './native-gateway-contract.js';
import type { DaemonSession } from './types.js';

export type { NativeGatewayAskOrigin, NativeGatewayAskSnapshot } from './native-gateway-contract.js';

/** Unsettled asks of exactly this live execution — the only asks a native
 * gateway may show or answer for it. */
export function nativeGatewayAskSnapshots(origin: NativeGatewayAskOrigin, appId: string, chatId: string): NativeGatewayAskSnapshot[] {
  return listPendingAsks()
    .filter(ask => ask.larkAppId === appId
      && ask.chatId === chatId
      && ask.nativeGatewayOrigin !== undefined
      && sameNativeGatewayAskOrigin({ sessionId: ask.sessionId, ...ask.nativeGatewayOrigin }, origin))
    .map(ask => ({ ask, origin }));
}

export function sameNativeGatewayAskOrigin(a: NativeGatewayAskOrigin, b: NativeGatewayAskOrigin): boolean {
  return a.sessionId === b.sessionId
    && a.turnId === b.turnId
    && a.workerGeneration === b.workerGeneration
    && a.dispatchAttempt === b.dispatchAttempt;
}

const NATIVE_GATEWAY_ANSWER_ACTIONS: ReadonlyArray<NativeGatewayAnswerAction> = ['toggle', 'submit', 'text'];

function isNativeGatewayAnswerAction(value: unknown): value is NativeGatewayAnswerAction {
  return NATIVE_GATEWAY_ANSWER_ACTIONS.includes(value as NativeGatewayAnswerAction);
}

/** An ask of exactly this execution that a person already answered (kept by
 * the broker for a short while after settlement). A later answer to it is a
 * repeat, not a stale card. */
function answeredInExecution(askId: string, nonce: string, current: NativeGatewayAskOrigin, appId: string, chatId: string): boolean {
  const ask = getAskSnapshot(askId);
  return !!ask
    && ask.settled
    && ask.result?.kind === 'answered'
    && ask.nonce === nonce
    && ask.larkAppId === appId
    && ask.chatId === chatId
    && ask.nativeGatewayOrigin !== undefined
    && sameNativeGatewayAskOrigin({ sessionId: ask.sessionId, ...ask.nativeGatewayOrigin }, current);
}

/**
 * One gateway callback (NativeGatewayAskCallback, still unvalidated) for
 * `current`, the execution the authenticated gateway is acting for. The
 * callback must name that exact execution and an ask it can currently see; the
 * nonce, responder and settlement checks stay with the broker (and with the
 * delivery receipt for `delivered`).
 */
export function nativeGatewayAskDecision(
  body: Record<string, unknown>,
  current: NativeGatewayAskOrigin,
  appId: string,
  chatId: string,
): string {
  const claimedOrigin = body.origin as NativeGatewayAskOrigin | undefined;
  if (!claimedOrigin || !sameNativeGatewayAskOrigin(claimedOrigin, current)) return 'stale';
  if (typeof body.askId !== 'string' || typeof body.nonce !== 'string') return 'stale';
  const visible = nativeGatewayAskSnapshots(current, appId, chatId).find(item => item.ask.askId === body.askId);
  if (!visible) {
    const repeatedAnswer = isNativeGatewayAnswerAction(body.action)
      && answeredInExecution(body.askId, body.nonce, current, appId, chatId);
    return repeatedAnswer ? 'already_settled' : 'stale';
  }
  if (body.action === 'delivered') {
    const delivered = typeof body.messageId === 'string'
      && confirmNativeGatewayAskDelivered(visible.ask.askId, body.nonce, body.messageId);
    return delivered ? 'accepted' : 'stale';
  }
  if (!isNativeGatewayAnswerAction(body.action)) return 'unauthorized';
  return answerNativeGatewayAsk({
    askId: visible.ask.askId,
    nonce: body.nonce,
    by: typeof body.by === 'string' ? body.by : '',
    action: body.action,
    questionIndex: typeof body.questionIndex === 'number' ? body.questionIndex : undefined,
    key: typeof body.key === 'string' ? body.key : undefined,
    text: typeof body.text === 'string' ? body.text : undefined,
    confirmEmpty: body.confirmEmpty === true,
  });
}

/** The live-session fields the gateway's own poll reads. */
export type NativeGatewayAskLiveSession =
  Parameters<typeof projectCoreOnlyProgress>[0] & Pick<DaemonSession, 'managedTurnOrigin'>;

/**
 * Whether a native gateway can still see the execution that asked: the same
 * test its poll applies — the turn is pending and running on the current worker
 * generation, and the live managed origin is this turn under this dispatch
 * attempt (an attempt number alone is per turn, so it only counts together
 * with its turn). Once this is false the ask can no longer be shown, answered
 * or confirmed, so the broker ends it instead of leaving the asking CLI
 * blocked until its own deadline.
 */
export function nativeGatewayAskOriginIsLive(
  origin: NativeGatewayAskTurnOrigin,
  session: NativeGatewayAskLiveSession | undefined,
): boolean {
  if (!session) return false;
  const progress = projectCoreOnlyProgress(session, origin.turnId);
  return !!progress
    && progress.workerGeneration === origin.workerGeneration
    && session.managedTurnOrigin?.turnId === origin.turnId
    && session.managedTurnOrigin.dispatchAttempt === origin.dispatchAttempt;
}

/**
 * Daemon bootstrap wiring for `botmux ask` delivery. A native gateway core
 * delivers asks through its gateway and ends each one with its execution;
 * every other daemon, including a bare core-only service, keeps the Lark card
 * dispatcher and no liveness check.
 */
export function wireAskCardDelivery(options: {
  nativeGatewayCore: boolean;
  larkDispatcher: () => AskCardDispatcher;
  findSession: (sessionId: string) => NativeGatewayAskLiveSession | undefined;
}): void {
  if (!options.nativeGatewayCore) {
    setCardDispatcher(options.larkDispatcher());
    return;
  }
  setCardDispatcher(createNativeGatewayAskDispatcher());
  setNativeGatewayAskLivenessChecker(ask => !!ask.nativeGatewayOrigin
    && nativeGatewayAskOriginIsLive(ask.nativeGatewayOrigin, options.findSession(ask.sessionId)));
}
