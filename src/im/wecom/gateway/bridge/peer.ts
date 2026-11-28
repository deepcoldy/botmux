/**
 * Same-host peer gateways: the server side of directory / fallback / result /
 * interrupt requests from the other WeCom connections of this host, and the
 * client calls this gateway makes to a peer (directory lookup, a quota-limit
 * hand-over and its result).
 *
 * Trust is the same-host rule of config/peer-trust.ts, judged again at every
 * step from both connections' current configuration files: before a request
 * is sent (by the source, standing in the target's place) and when it is
 * accepted, its result fetched or its turn interrupted (by the target).
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { type NativePeerRequest, peerRequestHash, requestNativePeer, wecomPeerControl } from '../native-peers.js';
import {
  readLocalWecomConnection,
  readLocalWecomConnections,
  wecomPeerAccepts,
  wecomPeerSide,
  type WecomPeerOperation,
} from '../../config/peer-trust.js';
import { wecomRoot } from '../../config/discovery.js';
import { nativeTaskAllowed, nativeReserve, type NativeCoreState } from '../native-core.js';
import type { TriggerRequest, TriggerResponse } from '../../../../services/trigger-types.js';
import type { WecomInboundMessage } from '../../protocol/types.js';
import type { Task, WecomBridgePolicy } from './types.js';
import type { WecomBridge } from '../bridge.js';

/** The hand-over's peer no longer accepts this connection, or the record predates the current trust rule. */
export class WecomPeerAuthorityChangedError extends Error {
  constructor() {
    super('wecom_peer_authority_changed');
  }
}

const PEER_OPERATIONS: readonly string[] = ['directory', 'fallback', 'result', 'interrupt'];

/** What this connection (the target) records of one hand-over a source asked for. */
type PeerReceipt = NonNullable<NativeCoreState['peerReceipts']>[string];

function selfId(bridge: WecomBridge): string {
  return bridge.options.connectionId ?? bridge.options.botId;
}

function root(bridge: WecomBridge): string {
  return bridge.options.peerRoot ?? wecomRoot();
}

/**
 * Whether `peerId` — another connection of this host — would accept `operation`
 * from this connection now. This connection asks nobody while its own
 * trustSameOwnerBots is switched off. Any failure (no such connection, an
 * unreadable configuration on either side) means no.
 */
export function peerAccepted(this: WecomBridge, peerId: string, operation: WecomPeerOperation): boolean {
  try {
    const own = this.policy();
    if (own.trustSameOwnerBots === false) {
      return false;
    }
    const target = readLocalWecomConnection(peerId, root(this));
    return wecomPeerAccepts({
      target: target && wecomPeerSide(target),
      source: own,
      sameConnection: peerId === selfId(this),
      operation,
    });
  } catch {
    return false;
  }
}

/**
 * Whether the gateway of peer `peerId` is running now. A quota-limit hand-over
 * interrupts this connection's turn before it asks the peer, so it is not begun
 * towards a peer that is stopped: the turn goes on and its limit result reaches
 * the user as usual.
 */
export function peerOnline(this: WecomBridge, peerId: string): boolean {
  try {
    wecomPeerControl(peerId, root(this));
    return true;
  } catch {
    return false;
  }
}

/** Configuration ids of the other WeCom connections configured on this host. */
export function localPeerIds(this: WecomBridge): string[] {
  try {
    return readLocalWecomConnections(root(this)).map(peer => peer.id).filter(id => id !== selfId(this));
  } catch {
    return [];
  }
}

/** Send one request to a peer connection of this host. */
export function sendPeer(this: WecomBridge, peerId: string, body: NativePeerRequest): Promise<Record<string, unknown>> {
  return (this.options.peerRequest ?? requestNativePeer)(peerId, body, root(this));
}

export function peerBody(
  this: WecomBridge,
  peerId: string,
  message: WecomInboundMessage,
  operation: NativePeerRequest['operation'],
  requestId: string,
): NativePeerRequest {
  return {
    operation,
    sourceId: selfId(this),
    sourceBotId: this.options.botId,
    sourceUser: message.userId,
    sourceChat: message.conversationId,
    chatType: message.chatType,
    requestId,
    trace: [selfId(this), peerId],
  };
}

/** Whether this connection (the target) accepts `operation` from `sourceId` under both current configurations. */
function sourceAccepted(bridge: WecomBridge, sourceId: string, sourceBotId: string, operation: WecomPeerOperation): boolean {
  const source = readLocalWecomConnection(sourceId, root(bridge));
  return !!source
    && source.botId === sourceBotId
    && wecomPeerAccepts({
      target: bridge.policy(),
      source: wecomPeerSide(source),
      sameConnection: sourceId === selfId(bridge),
      operation,
    });
}

/** Whether a peer request is well formed and addressed from its source to this connection (`me`). */
function peerRequestInScope(input: NativePeerRequest, me: string): boolean {
  return !!input
    && PEER_OPERATIONS.includes(input.operation)
    && typeof input.sourceId === 'string'
    && typeof input.sourceBotId === 'string'
    && typeof input.sourceUser === 'string'
    && !!input.sourceUser
    && input.sourceUser.length <= 256
    && typeof input.sourceChat === 'string'
    && !!input.sourceChat
    && input.sourceChat.length <= 256
    && (input.chatType === 'single' || input.chatType === 'group')
    && Array.isArray(input.trace)
    && input.trace.length === 2
    && new Set(input.trace).size === 2
    && input.trace[0] === input.sourceId
    && input.trace[1] === me
    && typeof input.requestId === 'string'
    && input.requestId.length <= 128;
}

/** A peer request past the scope and trust checks, with what they established. */
interface TrustedPeerRequest {
  input: NativePeerRequest;
  /** This connection's id. */
  me: string;
  /** The policy the request was judged under. */
  policy: WecomBridgePolicy;
  /** The request as a message from the source's user in the source's conversation. */
  message: WecomInboundMessage;
}

export async function receivePeer(this: WecomBridge, input: NativePeerRequest): Promise<Record<string, unknown>> {
  if (this.halted || this.poisoned) {
    throw new Error('wecom_gateway_unavailable');
  }
  const me = selfId(this);
  if (!peerRequestInScope(input, me)) {
    throw new Error('wecom_peer_scope_invalid');
  }
  if (!sourceAccepted(this, input.sourceId, input.sourceBotId, input.operation)) {
    throw new Error('wecom_peer_untrusted');
  }
  const p = this.policy();
  // The connections of one enterprise see the same user and conversation ids.
  const message: WecomInboundMessage = {
    messageId: input.requestId,
    userId: input.sourceUser,
    conversationId: input.sourceChat,
    chatType: input.chatType,
    text: '',
    replyContext: { requestId: input.requestId },
    attachments: [],
  };
  const receiptMode = input.operation === 'result'
    || input.operation === 'interrupt'
    || !!this.state.native!.peerReceipts?.[input.requestId];
  if (receiptMode
    ? !nativeTaskAllowed(this.state.native!, p, message, `peer:${input.requestId}`, Date.now())
    : this.capability(message) === 'denied') {
    throw new Error('wecom_peer_target_acl');
  }
  if (input.operation === 'directory') {
    const route = this.routeForMessage(message);
    const selected = this.state.native!.selectedRepos[route];
    return { ok: true, directory: selected?.directory ?? p.workingDirectory, anchor: message.conversationId };
  }
  const request: TrustedPeerRequest = { input, me, policy: p, message };
  const receipts = this.state.native!.peerReceipts ??= {};
  const prior = receipts[input.requestId];
  if (input.operation === 'result' || input.operation === 'interrupt') {
    return answerFromReceipt(this, request, prior);
  }
  return acceptFallback(this, request, receipts, prior);
}

/** `result` / `interrupt`: the turn of the source's accepted hand-over, named exactly as its receipt has it. */
async function answerFromReceipt(
  bridge: WecomBridge,
  { input, message }: TrustedPeerRequest,
  prior: PeerReceipt | undefined,
): Promise<Record<string, unknown>> {
  if (!prior
    || prior.sourceId !== input.sourceId
    || prior.sourceUser !== input.sourceUser
    || prior.status !== 'accepted'
    || !prior.sessionId
    || !prior.triggerId
    || input.sessionId !== prior.sessionId
    || input.triggerId !== prior.triggerId) {
    throw new Error('wecom_peer_receipt_mismatch');
  }
  if (input.operation === 'interrupt') {
    await bridge.options.core.interrupt(prior.sessionId, prior.triggerId);
    return { ok: true };
  }
  const response = await bridge.options.core.result(prior.sessionId, prior.triggerId);
  // The result call can take long: judge again under the configuration as it is now.
  if (!sourceAccepted(bridge, input.sourceId, input.sourceBotId, 'result')
    || !nativeTaskAllowed(bridge.state.native!, bridge.policy(), message, `peer:${input.requestId}`, Date.now())
    || bridge.state.native!.peerReceipts?.[input.requestId] !== prior) {
    throw new Error('wecom_peer_authority_changed');
  }
  return response as unknown as Record<string, unknown>;
}

/**
 * `fallback`: take over the source's turn. A replay of the same request answers
 * from its receipt; a new one reserves quota, saves a pending receipt, and only
 * then asks the core.
 */
async function acceptFallback(
  bridge: WecomBridge,
  { input, me, policy: p, message }: TrustedPeerRequest,
  receipts: Record<string, PeerReceipt>,
  prior: PeerReceipt | undefined,
): Promise<Record<string, unknown>> {
  if (!input.request || typeof input.request !== 'object') {
    throw new Error('wecom_peer_operation_invalid');
  }
  const raw = input.request as TriggerRequest;
  const hash = peerRequestHash(input.request);
  if (prior) {
    if (prior.hash !== hash || prior.sourceUser !== input.sourceUser) {
      throw new Error('wecom_peer_request_conflict');
    }
    if (prior.status === 'accepted') {
      return { ok: true, target: { kind: 'turn', sessionId: prior.sessionId }, triggerId: prior.triggerId };
    }
    throw new Error('wecom_peer_dispatch_uncertain');
  }
  if (!raw.envelope || typeof raw.envelope.rawText !== 'string' || raw.envelope.rawText.length > 100000) {
    throw new Error('wecom_peer_request_invalid');
  }
  const request: TriggerRequest = {
    source: { type: 'webhook', connectorId: `wecom-peer:${me}`, requestId: input.requestId },
    target: { kind: 'turn' },
    envelope: { format: 'text', sourceName: '本机显式授权交接', trusted: false, rawText: raw.envelope.rawText },
    payloadTrusted: true,
    instruction: '处理本机受控交接请求。结果仅返回源网关，由源网关投递；不要发送消息或使用飞书工具。',
    presentation: { thinking: 'hidden', topicMessage: null },
    options: { asyncReturnSessionId: true, idempotencyKey: input.requestId },
  };
  if (!nativeReserve(bridge.state.native!, p, message, `peer:${input.requestId}`, Date.now())) {
    throw new Error('wecom_peer_quota');
  }
  receipts[input.requestId] = {
    hash,
    sourceId: input.sourceId,
    sourceUser: input.sourceUser,
    status: 'pending',
    request,
  };
  bridge.state.native!.peerReceipts = receipts;
  bridge.save();
  try {
    const response = await bridge.options.core.trigger(request);
    if (!response.ok || !response.target?.sessionId || !response.triggerId) {
      throw new Error();
    }
    receipts[input.requestId] = {
      ...receipts[input.requestId],
      sessionId: response.target.sessionId,
      triggerId: response.triggerId,
      status: 'accepted',
    };
    bridge.save();
    return response as unknown as Record<string, unknown>;
  } catch {
    receipts[input.requestId].status = 'uncertain';
    bridge.save();
    throw new Error('wecom_peer_dispatch_uncertain');
  }
}

export async function peerCall(
  this: WecomBridge,
  task: Task,
  operation: 'result' | 'interrupt',
): Promise<TriggerResponse> {
  const peer = task.peer!;
  // A record of an earlier version (trust epochs) cannot be judged by the current rule.
  if (peer.epoch !== undefined || peer.targetEpoch !== undefined || !this.peerAccepted(peer.id, operation)) {
    throw new WecomPeerAuthorityChangedError();
  }
  const response = await this.sendPeer(peer.id, {
    ...this.peerBody(peer.id, task.message, operation, peer.requestId),
    sessionId: peer.sessionId,
    triggerId: peer.triggerId,
  }) as unknown as TriggerResponse;
  if (!this.peerAccepted(peer.id, operation)) {
    throw new WecomPeerAuthorityChangedError();
  }
  if (task.revoked || !this.taskAllowed(task)) {
    throw new Error('wecom_peer_authority_changed');
  }
  return task.stopRequested && operation === 'result' ? { ok: true, state: 'interrupted' } : response;
}
