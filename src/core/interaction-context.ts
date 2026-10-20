import { isDocNativeSession, isHttpVirtualSession } from './types.js';

/** Read-only host observation for external interaction providers.
 * No data paths, credentials, mutable grants, or business state are exposed. */
export interface InteractionSession {
  sessionId: string; larkAppId?: string; status: string; chatId: string;
  scope?: string; rootMessageId?: string; ownerOpenId?: string;
  chatType?: string; vcMeetingReceiver?: unknown;
}
export interface InteractionContextDependencies {
  findActive(sessionId: string): InteractionSession | undefined;
  canTalk(app: string, chat: string, actor: string, kind: 'group' | 'p2p'): boolean;
}
export type InteractionContextResult = { status: number; body: Record<string, unknown> };
const id = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s);

export function observeInteractionContext(
  request: { trustedHost: boolean; daemonAppId: string; sessionId: string; body: unknown },
  deps: InteractionContextDependencies,
): InteractionContextResult {
  const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });
  if (!request.trustedHost) return fail(403, 'trusted_host_required');
  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !id(request.sessionId)
    || !id(body.larkAppId) || body.actorOpenId !== undefined && (!id(body.actorOpenId) || !/^ou_[A-Za-z0-9_-]+$/.test(body.actorOpenId))) return fail(400, 'invalid_interaction_identity');
  if (!request.daemonAppId || body.larkAppId !== request.daemonAppId) return fail(409, 'receiver_mismatch');
  const session = deps.findActive(request.sessionId);
  if (!session || session.sessionId !== request.sessionId || session.status !== 'active'
    || (session.larkAppId && session.larkAppId !== request.daemonAppId)) return fail(404, 'active_session_not_found');
  const ownerlessGroup = !session.ownerOpenId && session.scope === 'chat' && session.chatType === 'group';
  if (!id(session.chatId) || !ownerlessGroup && !/^ou_[A-Za-z0-9_-]+$/.test(session.ownerOpenId ?? '')
    || (session.scope !== 'chat' && session.scope !== 'thread') || session.vcMeetingReceiver
    || !['group', 'p2p'].includes(session.chatType ?? '')
    || session.scope === 'thread' && !/^om_[A-Za-z0-9_-]+$/.test(session.rootMessageId ?? '')) return fail(409, 'interaction_origin_unavailable');
  // This registry contains live IM/document/HTTP sessions; v3 runs use a separate registry.
  if (isDocNativeSession({ scope: session.scope, chatId: session.chatId }) || isHttpVirtualSession(session.chatId)) {
    return fail(409, 'interaction_origin_unavailable');
  }
  const actorOpenId = body.actorOpenId ?? session.ownerOpenId;
  if (typeof actorOpenId !== 'string') return fail(409, 'interaction_actor_required');
  const canTalk = deps.canTalk(request.daemonAppId, session.chatId, actorOpenId, session.chatType as 'group' | 'p2p') === true;
  return { status: 200, body: { ok: true, schemaVersion: 1, context: {
    larkAppId: request.daemonAppId, sessionId: session.sessionId, status: 'active',
    chatId: session.chatId, rootMessageId: session.scope === 'thread' ? session.rootMessageId : null,
    scope: session.scope, chatType: session.chatType, ownerOpenId: session.ownerOpenId || null,
    actorOpenId, canTalk, observedAt: new Date().toISOString(),
  } } };
}
