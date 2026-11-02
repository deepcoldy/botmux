/**
 * Host-side destination check for a sandboxed `botmux send` that asked for a
 * different place than its own reply target (`--top-level` / `--chat-id` /
 * `--into`).
 *
 * The sandbox controls every byte of its relay request, so the chat id it
 * names is only a wish. The daemon decides the real destination and checks
 * it against facts the sandbox cannot touch:
 *  - `--into` is re-resolved to the root message's real chat (a forged
 *    `--chat-id` next to it must agree, never wins);
 *  - an explicit `--quote` is a reply, which Lark posts into the quoted
 *    message's own chat — so it must sit in the same chat as the target;
 *  - the session's own chat is always allowed (that is where the session
 *    already talks);
 *  - any other chat must be a group (not a DM) this bot is a member of, not
 *    an external (cross-tenant) chat, and the current turn's human caller — or the session
 *    owner when the turn has no human caller — must be a member of that chat
 *    AND pass the same talk authorization a message from them there would.
 *
 * Unknown evidence (provider errors, unreadable member lists) fails closed.
 * Pure over its `deps`, so it is testable without Lark.
 */

export type SandboxSendRouteError =
  | 'bad_chat_id'
  | 'bad_into'
  | 'into_lookup_failed'
  | 'into_chat_mismatch'
  | 'quote_lookup_failed'
  | 'quote_chat_mismatch'
  | 'no_principal'
  | 'chat_lookup_failed'
  | 'external_chat'
  | 'not_group_chat'
  | 'bot_not_in_chat'
  | 'principal_not_member'
  | 'principal_not_authorized';

export type SandboxSendRouteDecision =
  | { ok: true; chatId: string; principal?: string; reason: 'own_chat' | 'authorized' }
  | { ok: false; error: SandboxSendRouteError; chatId?: string; principal?: string };

export interface SandboxSendRouteDeps {
  /** Real chat of a message; null when the provider has no chat for it. Throws on provider failure. */
  lookupMessageChatId(messageId: string): Promise<string | null>;
  /** Chat facts from the bot's own view. Throws on provider failure. */
  getChatInfo(chatId: string): Promise<{ external: boolean; mode: 'group' | 'p2p' }>;
  /** Throws when membership cannot be determined. */
  isBotInChat(chatId: string): Promise<boolean>;
  /** Human member open ids of the chat. Throws when the list cannot be read completely. */
  listMemberOpenIds(chatId: string): Promise<string[]>;
  /** The daemon's ordinary talk decision for `openId` speaking in `chatId`. */
  canTalk(chatId: string, openId: string): boolean;
}

export interface SandboxSendRouteRequest {
  /** The session's own chat. */
  sessionChatId: string;
  chatId?: string;
  into?: string;
  /** Explicit `--quote` message id. */
  quote?: string;
  /** Human caller of the live turn (daemon-owned record). */
  turnCallerOpenId?: string;
  /** Daemon-selected session owner; used only when the turn has no human caller. */
  sessionOwnerOpenId?: string;
}

const CHAT_ID_RE = /^oc_[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,160}$/;

export async function authorizeSandboxSendRoute(
  req: SandboxSendRouteRequest,
  deps: SandboxSendRouteDeps,
): Promise<SandboxSendRouteDecision> {
  if (req.chatId !== undefined && !CHAT_ID_RE.test(req.chatId)) return { ok: false, error: 'bad_chat_id' };
  if (req.into !== undefined && !MESSAGE_ID_RE.test(req.into)) return { ok: false, error: 'bad_into' };
  if (req.quote !== undefined && !MESSAGE_ID_RE.test(req.quote)) return { ok: false, error: 'quote_lookup_failed' };

  let target = req.chatId ?? req.sessionChatId;
  if (req.into !== undefined) {
    let intoChat: string | null;
    try { intoChat = await deps.lookupMessageChatId(req.into); }
    catch { return { ok: false, error: 'into_lookup_failed' }; }
    if (!intoChat) return { ok: false, error: 'into_lookup_failed' };
    if (req.chatId !== undefined && req.chatId !== intoChat) {
      return { ok: false, error: 'into_chat_mismatch', chatId: intoChat };
    }
    target = intoChat;
  }
  if (req.quote !== undefined) {
    let quoteChat: string | null;
    try { quoteChat = await deps.lookupMessageChatId(req.quote); }
    catch { return { ok: false, error: 'quote_lookup_failed', chatId: target }; }
    if (!quoteChat) return { ok: false, error: 'quote_lookup_failed', chatId: target };
    if (quoteChat !== target) return { ok: false, error: 'quote_chat_mismatch', chatId: quoteChat };
  }
  if (target === req.sessionChatId) return { ok: true, chatId: target, reason: 'own_chat' };

  const principal = req.turnCallerOpenId ?? req.sessionOwnerOpenId;
  if (!principal || !OPEN_ID_RE.test(principal)) return { ok: false, error: 'no_principal', chatId: target };

  let info: { external: boolean; mode: 'group' | 'p2p' };
  try { info = await deps.getChatInfo(target); }
  catch { return { ok: false, error: 'chat_lookup_failed', chatId: target, principal }; }
  if (info.external) return { ok: false, error: 'external_chat', chatId: target, principal };
  // Cross-chat routing is for groups. Another person's DM is never a broadcast target.
  if (info.mode !== 'group') return { ok: false, error: 'not_group_chat', chatId: target, principal };

  let botIn: boolean;
  try { botIn = await deps.isBotInChat(target); }
  catch { return { ok: false, error: 'chat_lookup_failed', chatId: target, principal }; }
  if (!botIn) return { ok: false, error: 'bot_not_in_chat', chatId: target, principal };

  let members: string[];
  try { members = await deps.listMemberOpenIds(target); }
  catch { return { ok: false, error: 'chat_lookup_failed', chatId: target, principal }; }
  if (!members.includes(principal)) return { ok: false, error: 'principal_not_member', chatId: target, principal };

  if (!deps.canTalk(target, principal)) {
    return { ok: false, error: 'principal_not_authorized', chatId: target, principal };
  }
  return { ok: true, chatId: target, principal, reason: 'authorized' };
}

/**
 * The daemon route's request handling, minus HTTP: parse the host re-exec's
 * request, bind it to the session's LIVE turn, decide, audit. The relay was
 * authorized against one turn; a turn that rotated meanwhile must not lend
 * its successor's caller to an older request (409 turn_changed).
 */
export async function handleSandboxSendRouteRequest(body: unknown, ctx: {
  session?: {
    sessionId: string;
    chatId: string;
    liveTurnId?: string;
    /** Daemon-owned human caller of exactly that turn. */
    callerForTurn(turnId: string): string | undefined;
    ownerOpenId?: string;
  };
  deps: SandboxSendRouteDeps;
  audit(line: string): void;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const s = ctx.session;
  if (!s) return { status: 404, body: { ok: false, error: 'session_not_found' } };
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const optionalString = (v: unknown): string | undefined | null =>
    v === undefined ? undefined : typeof v === 'string' && v ? v : null;
  const chatId = optionalString(b.chatId);
  const into = optionalString(b.into);
  const quote = optionalString(b.quote);
  const turnId = optionalString(b.turnId);
  if (chatId === null || into === null || quote === null || turnId === null) {
    return { status: 400, body: { ok: false, error: 'bad_request' } };
  }
  if (turnId !== s.liveTurnId) return { status: 409, body: { ok: false, error: 'turn_changed' } };
  // A bot caller is not in the human member list → fails closed in the decision.
  const caller = s.liveTurnId ? s.callerForTurn(s.liveTurnId) : undefined;
  const decision = await authorizeSandboxSendRoute({
    sessionChatId: s.chatId,
    ...(chatId !== undefined ? { chatId } : {}),
    ...(into !== undefined ? { into } : {}),
    ...(quote !== undefined ? { quote } : {}),
    ...(caller ? { turnCallerOpenId: caller } : {}),
    ...(s.ownerOpenId ? { sessionOwnerOpenId: s.ownerOpenId } : {}),
  }, ctx.deps);
  ctx.audit(`session=${s.sessionId} turn=${s.liveTurnId ?? '-'} `
    + `requested=${chatId ?? '-'}/${into ?? '-'}/${quote ?? '-'} target=${decision.chatId ?? '-'} `
    + `principal=${decision.principal ?? '-'} decision=${decision.ok ? decision.reason : decision.error}`);
  return { status: decision.ok ? 200 : 403, body: decision };
}

/** Daemon IPC route the trusted host re-exec of a sandbox relay calls before
 *  any routed provider effect. Host-secret only (not in the untrusted aperture). */
export const SANDBOX_SEND_ROUTE_AUTHORIZE_ROUTE = '/api/sandbox-send/route-authorize';

/** Set by the sandbox outbox watcher on the host re-exec env; tells `cmdSend`
 *  that routing flags came from a sandbox and need the daemon's decision. */
export const SANDBOX_RELAY_ROUTE_GATE_ENV = 'BOTMUX_SANDBOX_RELAY_ROUTE_GATE';
