import type { IncomingMessage } from 'node:http';
import { attestCurrentExecutionLoopbackPeer, resolveLoopbackPeerProcesses } from './current-actor-attestation.js';
import { authorizeSameBotDelivery, deliverSameBotMessage, type DeliverySessionView } from './same-bot-delivery.js';
import { mailboxStatus, MAILBOX_ID_RE } from '../services/mailbox-store.js';
import { pickTurnReplyTarget } from './reply-target.js';
import type { DaemonSession } from './types.js';
import type { TriggerRequest, TriggerResponse } from '../services/trigger-types.js';
import type { TriggerSessionInternalOptions } from './trigger-session.js';

export const MAILBOX_STATUS_ROUTE = '/api/mailbox/status';
export function mailboxSessionView(ds: DaemonSession): DeliverySessionView {
  const origin = ds.managedTurnOrigin;
  const turnId = origin?.turnId;
  const reply = turnId ? pickTurnReplyTarget(ds.session, turnId) : undefined;
  // callerOpenId can include an inbound bot sender on older publications.
  // Human attribution requires the exact daemon-recorded participant type.
  const callerIsHuman = reply?.participants?.some(p => p.openId === origin?.callerOpenId && p.isBot === false)
    || (!reply && !!turnId && (ds.scheduledTurnCallers?.has(turnId)
      || ds.session.failedTurnRecovery?.turnId === turnId
        && ds.session.failedTurnRecovery.caller.senderType === 'user'));
  return {
    sessionId: ds.session.sessionId, larkAppId: ds.larkAppId, chatId: ds.chatId,
    rootMessageId: ds.session.rootMessageId, scope: ds.scope ?? ds.session.scope,
    status: ds.session.status, receiver: !!ds.session.vcMeetingReceiver,
    liveOrigin: ds.managedTurnOrigin,
    // The worker's private publication is the exact turn's human caller. Do
    // not use lastCallerOpenId, which may already describe a queued next turn.
    triggeringUserOpenId: callerIsHuman ? origin?.callerOpenId : undefined,
  };
}

export async function handleMailboxIpc(input: {
  operation: 'send' | 'status';
  raw: unknown;
  socket: Pick<IncomingMessage['socket'], 'remoteAddress' | 'remotePort' | 'localPort'>;
  selfLarkAppId: string;
  enabled(): boolean;
  findSession(id: string): DaemonSession | undefined;
  listSessions(): DaemonSession[];
  trigger(request: TriggerRequest, internal: TriggerSessionInternalOptions): Promise<TriggerResponse>;
}): Promise<{ status: number; body: object }> {
  const fail = (status: number, error: string) => ({ status, body: { ok: false, state: 'failed', error } });
  if (!input.enabled()) return fail(403, 'mailbox_disabled');
  const raw = input.raw && typeof input.raw === 'object' && !Array.isArray(input.raw)
    ? input.raw as Record<string, unknown> : undefined;
  const sourceId = typeof raw?.sessionId === 'string' ? raw.sessionId : '';
  if (!sourceId || sourceId.length > 200) return fail(400, 'bad_source_session');
  const peer = resolveLoopbackPeerProcesses(input.socket);
  const attestInput = peer.ok ? { sessionId: sourceId, peer: peer.peer, findSession: input.findSession } : undefined;
  const proof = attestInput ? attestCurrentExecutionLoopbackPeer(attestInput) : null;
  if (!proof || proof.ds.larkAppId !== input.selfLarkAppId) return fail(403, 'host_process_source_unproven');
  // A host HMAC, a body capability, an env marker and owner identity each fail
  // to prove THIS socket belongs to THIS turn. All mailbox operations use the
  // existing live peer/worker attestation, including host-signed requests.
  if (input.operation === 'status') {
    const id = raw?.deliveryId;
    if (typeof id !== 'string' || !MAILBOX_ID_RE.test(id)) return fail(400, 'bad_delivery_id');
    try {
      const result = mailboxStatus(input.selfLarkAppId, sourceId, id);
      return result ? { status: 200, body: result } : fail(404, 'delivery_not_found');
    } catch { return fail(503, 'receipt_unavailable'); }
  }
  const decision = authorizeSameBotDelivery({
    raw: input.raw, enabled: true, sourceProven: true,
    selfLarkAppId: input.selfLarkAppId, source: mailboxSessionView(proof.ds),
  });
  if (!decision.ok) return fail(decision.status, decision.error);
  const result = await deliverSameBotMessage({
    decision,
    getSource: () => {
      if (!input.enabled()) return undefined;
      const fresh = attestCurrentExecutionLoopbackPeer(attestInput!);
      return fresh && fresh.ds === proof.ds && fresh.generation === proof.generation
        && fresh.turnId === proof.turnId && fresh.capability === proof.capability
        && fresh.callerOpenId === proof.callerOpenId
        ? mailboxSessionView(fresh.ds) : undefined;
    },
    listTargets: () => input.listSessions().map(mailboxSessionView),
    trigger: input.trigger,
  });
  return { status: result.ok ? 200 : result.state === 'unknown' ? 503 : result.error === 'idempotency_conflict' ? 409 : 422, body: result };
}
