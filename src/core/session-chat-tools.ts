import { authorizeSandboxSendRoute, type SandboxSendRouteDeps } from './sandbox-send-route.js';
import type { ChatUserMember } from '../im/lark/client.js';
import type { TrustedCaller } from '../types.js';

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
  /** The authority of the human `/group` command: canOperate, or the bot's
   *  explicit canTalk downgrade of that command. */
  canCreateChat(openId: string): boolean;
  /** Talk authority that does not depend on a particular chat, i.e. whether the
   *  caller can talk in a chat that does not exist yet. */
  canTalkInNewChat(openId: string): boolean;
  resolveMembers(identifiers: string[]): Promise<Map<string, string>>;
  listMembers(chatId: string): Promise<ChatUserMember[]>;
  create(input: { name: string; userIds: string[]; chatMode: 'group' | 'topic' }): Promise<{
    chatId: string; invalidUserIds: string[];
  }>;
  /** One line per request: decision, principal, target and invite counts. */
  audit?(line: string): void;
}

/** Daemon-owned facts about the session a host tool request names. */
export interface SessionChatSessionView {
  sessionId: string;
  larkAppId: string;
  chatId: string;
  /** Live managed turn when the request arrived. */
  turnId?: string;
  /** Exact-turn caller record of `turnId`. */
  caller?: Pick<TrustedCaller, 'senderType' | 'source' | 'requestLarkAppId' | 'requestUserOpenId'>;
  /** Live managed turn while this exact session object is still the active one. */
  liveTurnId(): string | undefined;
  availability(): { vcMeetingReceiver: boolean; silentListener: boolean; larkTransport: boolean };
}

/** Builds the request context from daemon state only. A session of another
 *  app, a scheduled/recovered/bot-opened turn, and sessions without a Lark
 *  conversation never yield an authorized human caller. */
export function buildSessionChatContext(
  view: SessionChatSessionView | undefined,
  selfLarkAppId: string | undefined,
): SessionChatContext | undefined {
  if (!view || !selfLarkAppId || view.larkAppId !== selfLarkAppId) return undefined;
  const available = () => {
    const a = view.availability();
    return !a.vcMeetingReceiver && !a.silentListener && a.larkTransport;
  };
  const { caller, turnId } = view;
  return {
    sessionId: view.sessionId,
    larkAppId: view.larkAppId,
    chatId: view.chatId,
    turnId,
    callerOpenId: caller?.requestUserOpenId,
    humanCaller: caller?.senderType === 'user' && !caller.source && caller.requestLarkAppId === view.larkAppId,
    enabled: available(),
    isCurrent: () => !!turnId && view.liveTurnId() === turnId && available(),
  };
}

const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,160}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Result = { status: number; body: Record<string, unknown> };
interface Trail { principal?: string; target?: string; invited?: number; invalid?: number }

/** The request chooses content only. App, caller and live turn come from the
 * daemon. Creation has a single provider write; the Riff gateway owns its
 * durable operation receipt, including unknown outcomes after a lost response. */
export async function handleSessionChatTool(raw: unknown, ctx: SessionChatContext | undefined, deps: SessionChatDeps): Promise<Result> {
  const trail: Trail = {};
  const action = (raw as { action?: unknown } | null)?.action;
  const record = (status: number, error?: unknown) => deps.audit?.(
    `session=${ctx?.sessionId ?? '-'} turn=${ctx?.turnId ?? '-'} `
    + `action=${action === 'create' || action === 'members' ? action : 'other'} principal=${trail.principal ?? '-'} `
    + `target=${trail.target ?? '-'} invited=${trail.invited ?? '-'} invalid=${trail.invalid ?? '-'} status=${status}`
    + (error === undefined ? '' : ` error=${String(error).slice(0, 200)}`),
  );
  try {
    const result = await decide(raw, ctx, deps, trail);
    record(result.status, result.body.error);
    return result;
  } catch (error) {
    // `target=create-attempted` marks a provider write whose outcome is unknown.
    record(502, error instanceof Error ? error.message : error);
    throw error;
  }
}

async function decide(raw: unknown, ctx: SessionChatContext | undefined, deps: SessionChatDeps, trail: Trail): Promise<Result> {
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
  trail.principal = caller;
  if (!deps.route.canTalk(ctx.chatId, caller)) return fail(403, 'principal_not_authorized');
  if (body.action === 'members') {
    if (body.chatId !== undefined && typeof body.chatId !== 'string') return fail(400, 'bad_chat_id');
    const decision = await authorizeSandboxSendRoute({
      sessionChatId: ctx.chatId, chatId: body.chatId as string | undefined, turnCallerOpenId: caller,
    }, deps.route);
    trail.target = decision.chatId;
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
  // Creating a group as the bot and inviting people from the directory is the
  // human `/group` command's act, so it needs that command's authority, not
  // just talk in the source chat. The caller must also be able to talk in the
  // new chat: a chat-scoped grant (chat grant, oncall, allowed group) does not
  // carry over, and a group created without it strands the invitees because
  // every follow-up members/send is refused.
  const createRefusal = () => !deps.route.canTalk(ctx.chatId, caller) ? 'principal_not_authorized'
    : !deps.canCreateChat(caller) ? 'chat_create_not_authorized'
      : !deps.canTalkInNewChat(caller) ? 'new_chat_talk_not_authorized'
        : undefined;
  const refused = createRefusal();
  if (refused) return fail(403, refused);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100
    || !Array.isArray(body.members) || body.members.length > 49
    || !body.members.every(id => typeof id === 'string' && (OPEN_ID.test(id) || EMAIL.test(id)))
    || (body.chatMode !== 'group' && body.chatMode !== 'topic')) return fail(400, 'invalid_chat_create');
  const identifiers = [...new Set(body.members as string[])];
  const resolved = await deps.resolveMembers(identifiers);
  if (identifiers.some(id => !OPEN_ID.test(resolved.get(id) ?? ''))) return fail(400, 'chat_member_unresolved');
  if (!ctx.isCurrent()) return fail(409, 'turn_changed');
  const revoked = createRefusal();
  if (revoked) return fail(403, revoked);
  const userIds = [...new Set([caller, ...identifiers.map(id => resolved.get(id)!)])];
  trail.target = 'create-attempted';
  trail.invited = userIds.length;
  const result = await deps.create({ name: body.name.trim(), chatMode: body.chatMode, userIds });
  // Do not discard a committed chat if the turn rotates during the API call.
  // No follow-up invite/notification is performed, and retries reuse its receipt.
  if (!/^oc_[A-Za-z0-9_-]{1,128}$/.test(result.chatId ?? '')) throw new Error('chat_creation_outcome_unknown; do not repeat automatically');
  trail.target = result.chatId;
  trail.invalid = result.invalidUserIds.length;
  return { status: 200, body: { ok: true, larkAppId: ctx.larkAppId, ...result, complete: result.invalidUserIds.length === 0 } };
}
