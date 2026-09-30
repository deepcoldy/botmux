import { authorizeSessionScopedIpc } from './daemon-ipc-session-auth.js';
import type { VcMeetingLiveManagedOrigin } from '../services/vc-meeting-send-policy.js';

interface ManagerAuthorizationInput {
  sessionId: string;
  appId: string;
  chatId: string;
  action: 'set' | 'clear';
  targetOpenId?: string;
  claim: Record<string, unknown>;
  liveOrigin(): VcMeetingLiveManagedOrigin | undefined;
  readMessage(appId: string, messageId: string): Promise<unknown>;
  canOperate(appId: string, chatId: string, openId: string): boolean;
}

/** The creator/owner and latest queued caller are not current-turn authority.
 * Require a rotating proof and read the corresponding event from Feishu.
 * Host HMAC alone, bot messages, stale human turns and synthetic turns fail closed.
 */
export async function authorizeHumanManager(input: ManagerAuthorizationInput): Promise<
  { ok: true; requester: string; turnId: string; stillCurrent(): boolean } | { ok: false; error: string }
> {
  const turnId = typeof input.claim.originTurnId === 'string' ? input.claim.originTurnId : '';
  const capability = typeof input.claim.originCapability === 'string' ? input.claim.originCapability : undefined;
  const attempt = typeof input.claim.originDispatchAttempt === 'number' ? input.claim.originDispatchAttempt : undefined;
  const proof = () => {
    const current = input.liveOrigin();
    if (!current || current.turnId !== turnId || current.dispatchAttempt !== attempt) return { ok: false };
    return authorizeSessionScopedIpc({
      trustedHost: false, sessionExists: true, receiverSession: false, allowReceiver: false,
      sessionId: input.sessionId, liveOrigin: current,
      claimedCapability: capability,
      claimedTurnId: turnId,
      claimedDispatchAttempt: attempt,
    });
  };
  if (!/^om_[A-Za-z0-9]+$/.test(turnId) || !proof().ok) return { ok: false, error: 'human_turn_unproven' };
  let detail: any;
  try { detail = await input.readMessage(input.appId, turnId); }
  catch { return { ok: false, error: 'human_message_unavailable' }; }
  // A new turn can rotate the capability during the network read.
  if (!proof().ok) return { ok: false, error: 'human_turn_changed' };
  const message = detail?.items?.find((item: any) => item.message_id === turnId);
  if (!message || message.chat_id !== input.chatId) return { ok: false, error: 'human_message_scope_mismatch' };
  const sender = message.sender;
  if (sender?.sender_type !== 'user' || sender.id_type !== 'open_id' || typeof sender.id !== 'string') {
    return { ok: false, error: 'human_sender_required' };
  }
  if (!input.canOperate(input.appId, input.chatId, sender.id)) return { ok: false, error: 'owner_only' };
  // Do not turn an unrelated human message into a nomination. Unsupported or
  // ambiguous wording can use the unambiguous manager set/clear command.
  let text: string;
  try { text = JSON.parse(message.body?.content ?? '{}').text; }
  catch { return { ok: false, error: 'explicit_manager_instruction_required' }; }
  if (message.msg_type !== 'text' || typeof text !== 'string') return { ok: false, error: 'explicit_manager_instruction_required' };
  for (const mention of message.mentions ?? []) {
    const id = typeof mention.id === 'string' ? mention.id : mention.id?.open_id;
    if (!input.targetOpenId || id !== input.targetOpenId || !mention.key) return { ok: false, error: 'ambiguous_manager_target' };
    text = text.split(mention.key).join('');
  }
  text = text.trim();
  const command = text.match(/^(?:请\s*)?(?:执行\s*)?(?:botmux\s+)?\/?manager\s+(set|clear)[。.!！]?$/i)?.[1]?.toLowerCase();
  const nomination = /^(?:请)?(?:你)?(?:作为|担任|担任本群的|作为本群的|设为本群的|设为)(?:本群)?(?:负责人|管理员)(?:[，,]\s*(?:请)?执行\s*(?:botmux\s+)?manager\s+set)?[。！!]?$/i.test(text);
  if (command !== input.action && !(input.action === 'set' && nomination)) return { ok: false, error: 'explicit_manager_instruction_required' };
  return { ok: true, requester: sender.id, turnId, stillCurrent: () => proof().ok };
}
