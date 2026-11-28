import type { AskCardDispatcher, AskResult, NativeGatewayAskTurnOrigin, PendingAsk } from './ask-types.js';
import { AskDispatchError, nativeGatewayExecutionEndedResult } from './ask-types.js';

export type { NativeGatewayAskTurnOrigin } from './ask-types.js';

/** Where `botmux ask` for one session can reach a human. */
export type AskDeliveryRoute =
  | { kind: 'lark' }
  | { kind: 'native_gateway'; origin: NativeGatewayAskTurnOrigin }
  /** The caller asks from a turn that is no longer live on this native gateway
   *  core (typically: the daemon restarted under a still-waiting `botmux ask`).
   *  The request must end now with this terminal result. */
  | { kind: 'ended'; result: AskResult }
  | { kind: 'unsupported' };

/**
 * A native gateway only ever polls asks frozen to an exact live turn (turn id
 * + worker generation + dispatch attempt), and only exists behind a native
 * gateway core. Every other daemon keeps its Lark route, or fails fast as
 * `unsupported` without Lark transport (including a bare core-only service,
 * where nothing would ever confirm delivery).
 *
 * On a native gateway core, an ask belongs to the live turn or to nothing:
 *  - no live turn: the asking turn has ended (a daemon restart drops every HTTP
 *    turn), so the caller gets a terminal `invalidated` (`ended`);
 *  - a live turn, but the caller names another turn or dispatch attempt (it
 *    froze them when its invocation started): the turn it asked from has ended,
 *    and it must not be re-bound to the execution that happens to be live now.
 * A caller's claim can only refuse; it never selects or grants a route. A
 * caller without a claim is routed to the live turn.
 */
export function resolveAskDeliveryRoute(input: {
  nativeGatewayCore: boolean;
  larkTransport: boolean;
  turnOrigin?: { turnId?: string; dispatchAttempt?: number };
  workerGeneration?: number;
  claimedTurnId?: string;
  claimedDispatchAttempt?: number;
}): AskDeliveryRoute {
  if (!input.nativeGatewayCore) return input.larkTransport ? { kind: 'lark' } : { kind: 'unsupported' };
  const turnId = input.turnOrigin?.turnId;
  const dispatchAttempt = input.turnOrigin?.dispatchAttempt;
  const generation = input.workerGeneration;
  if (!turnId || typeof generation !== 'number' || generation <= 0) {
    return { kind: 'ended', result: nativeGatewayExecutionEndedResult() };
  }
  const claimsAnotherTurn = input.claimedTurnId !== undefined && input.claimedTurnId !== turnId;
  const claimsAnotherAttempt = input.claimedDispatchAttempt !== undefined
    && input.claimedDispatchAttempt !== dispatchAttempt;
  if (claimsAnotherTurn || claimsAnotherAttempt) {
    return { kind: 'ended', result: nativeGatewayExecutionEndedResult() };
  }
  return { kind: 'native_gateway', origin: { turnId, workerGeneration: generation, dispatchAttempt } };
}

/** One pending delivery confirmation for one ask. Every broker send of the
 *  same ask (the first dispatch, and a re-send after its hook reconnected)
 *  waits on this same receipt, so all of them observe one outcome. */
interface DeliveryReceipt {
  nonce: string;
  timer: ReturnType<typeof setTimeout>;
  waiters: Array<{
    resolve: (value: { messageId: string }) => void;
    reject: (error: Error) => void;
  }>;
}

const receipts = new Map<string, DeliveryReceipt>();

function releaseReceipt(askId: string): DeliveryReceipt | undefined {
  const receipt = receipts.get(askId);
  if (!receipt) return undefined;
  clearTimeout(receipt.timer);
  receipts.delete(askId);
  return receipt;
}

function rejectWaiters(receipt: DeliveryReceipt, error: Error): void {
  for (const waiter of receipt.waiters) waiter.reject(error);
}

/** Native gateway confirms real card delivery before the broker starts its
 * human deadline. The broker remains the sole owner of Ask settlement. */
export function createNativeGatewayAskDispatcher(timeoutMs = 60_000): AskCardDispatcher {
  return {
    send(ask: PendingAsk) {
      if (!ask.nativeGatewayOrigin) {
        // The gateway polls asks per execution only: an ask that was not bound
        // to one can never be shown or confirmed, so fail it now instead of
        // holding it for the whole delivery window.
        return Promise.reject(new AskDispatchError('a native gateway can only deliver an ask bound to a turn it dispatched', false));
      }
      return new Promise<{ messageId: string }>((resolve, reject) => {
        const existing = receipts.get(ask.askId);
        if (existing) {
          // A re-send of the same ask joins the delivery already in flight:
          // the gateway shows one card per ask, so there is nothing new to
          // deliver, and the earlier sender must not be failed by the later.
          existing.waiters.push({ resolve, reject });
          return;
        }
        const timer = setTimeout(() => {
          const expired = releaseReceipt(ask.askId);
          if (expired) rejectWaiters(expired, new AskDispatchError('native gateway card delivery unconfirmed', false));
        }, timeoutMs);
        timer.unref?.();
        receipts.set(ask.askId, { nonce: ask.nonce, timer, waiters: [{ resolve, reject }] });
      });
    },
    onSettle(ask) {
      const settled = releaseReceipt(ask.askId);
      if (settled) rejectWaiters(settled, new AskDispatchError('native gateway ask settled', false, { releasedBySettle: true }));
    },
  };
}

export function confirmNativeGatewayAskDelivered(askId: string, nonce: string, messageId: string): boolean {
  const receipt = receipts.get(askId);
  if (!receipt || receipt.nonce !== nonce || !messageId) return false;
  releaseReceipt(askId);
  for (const waiter of receipt.waiters) waiter.resolve({ messageId });
  return true;
}
