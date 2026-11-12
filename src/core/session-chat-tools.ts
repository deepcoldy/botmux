import { authorizeSandboxSendRoute, type SandboxSendRouteDeps } from './sandbox-send-route.js';
import type { ChatUserMember } from '../im/lark/client.js';

export const SESSION_CHAT_TOOLS_ROUTE = '/api/session-chat-tools';

export interface SessionChatContext {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  turnId?: string;
  callerOpenId?: string;
  /** Proven by daemon-owned exact-turn caller records, never the request. */
  humanCaller: boolean;
  enabled: boolean;
  isCurrent(): boolean;
}

export interface SessionChatDeps {
  route: SandboxSendRouteDeps;
  resolveMembers(identifiers: string[]): Promise<Map<string, string>>;
  listMembers(chatId: string): Promise<ChatUserMember[]>;
  create(input: { name: string; userIds: string[]; chatMode: 'group' | 'topic' }): Promise<{
    chatId: string; invalidUserIds: string[];
  }>;
}

const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,160}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The request chooses content only. App, caller and live turn come from the
 * daemon. Creation has a single provider write; the Riff gateway owns its
 * durable operation receipt, including unknown outcomes after a lost response. */
export async function handleSessionChatTool(raw: unknown, ctx: SessionChatContext | undefined, deps: SessionChatDeps): Promise<{
  status: number; body: Record<string, unknown>;
}> {
  const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });
  if (!ctx) return fail(404, 'session_not_found');
  if (!ctx.enabled) return fail(403, 'chat_tools_unavailable');
  const body = raw as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || !ctx.turnId || body.turnId !== ctx.turnId || !ctx.isCurrent()) {
    return fail(409, 'turn_changed');
  }
  // Never let a copied owner/env identity authorize a bot-opened or callerless turn.
  const caller = ctx.callerOpenId;
  if (!ctx.humanCaller || !caller || !OPEN_ID.test(caller)) return fail(403, 'human_caller_required');
  if (!deps.route.canTalk(ctx.chatId, caller)) return fail(403, 'principal_not_authorized');
  if (body.action === 'members') {
    if (body.chatId !== undefined && typeof body.chatId !== 'string') return fail(400, 'bad_chat_id');
    const decision = await authorizeSandboxSendRoute({
      sessionChatId: ctx.chatId, chatId: body.chatId as string | undefined, turnCallerOpenId: caller,
    }, deps.route);
    if (!decision.ok) return fail(403, decision.error);
    if (!ctx.isCurrent()) return fail(409, 'turn_changed');
    const canRead = () => deps.route.canTalk(ctx.chatId, caller) && deps.route.canTalk(decision.chatId, caller);
    if (!canRead()) return fail(403, 'principal_not_authorized');
    const members = await deps.listMembers(decision.chatId);
    if (!ctx.isCurrent()) return fail(409, 'turn_changed');
    if (!canRead()) return fail(403, 'principal_not_authorized');
    return { status: 200, body: { ok: true, larkAppId: ctx.larkAppId, chatId: decision.chatId, members } };
  }
  if (body.action !== 'create') return fail(400, 'chat_subcommand_unsupported');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100
    || !Array.isArray(body.members) || body.members.length > 49
    || !body.members.every(id => typeof id === 'string' && (OPEN_ID.test(id) || EMAIL.test(id)))
    || (body.chatMode !== 'group' && body.chatMode !== 'topic')) return fail(400, 'invalid_chat_create');
  const identifiers = [...new Set(body.members as string[])];
  const resolved = await deps.resolveMembers(identifiers);
  if (identifiers.some(id => !OPEN_ID.test(resolved.get(id) ?? ''))) return fail(400, 'chat_member_unresolved');
  if (!ctx.isCurrent()) return fail(409, 'turn_changed');
  if (!deps.route.canTalk(ctx.chatId, caller)) return fail(403, 'principal_not_authorized');
  const result = await deps.create({
    name: body.name.trim(), chatMode: body.chatMode,
    userIds: [...new Set([caller, ...identifiers.map(id => resolved.get(id)!)])],
  });
  // Do not discard a committed chat if the turn rotates during the API call.
  // No follow-up invite/notification is performed, and retries reuse its receipt.
  if (!/^oc_[A-Za-z0-9_-]{1,128}$/.test(result.chatId ?? '')) throw new Error('chat_creation_outcome_unknown; do not repeat automatically');
  return { status: 200, body: { ok: true, larkAppId: ctx.larkAppId, ...result, complete: result.invalidUserIds.length === 0 } };
}
