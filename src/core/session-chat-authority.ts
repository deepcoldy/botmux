import { commandSpec } from './command-schema.js';
import { evaluateTalk, humanCanRunDaemonCommand } from '../im/lark/event-dispatcher.js';
import type { SessionChatDeps } from './session-chat-tools.js';

/** Talk and group-creation decisions for session chat tools, from the same
 *  bot policy the daemon applies to a human's messages and `/group` command.
 *  `callerUnionId` feeds only the command's canTalk downgrade, as for `/group`. */
export function sessionChatAuthority(
  larkAppId: string,
  session: { chatId: string; chatType: 'group' | 'p2p' },
  callerUnionId?: string,
): Pick<SessionChatDeps, 'canCreateChat' | 'canTalkInNewChat'> & { canTalk(chatId: string, openId: string): boolean } {
  const group = commandSpec('/group');
  // A canTalk downgrade may name the command or its alias, as typed in chat.
  const names = group ? [group.name, ...(group.aliases ?? [])] : [];
  return {
    canTalk: (chatId, openId) => evaluateTalk(larkAppId, chatId, openId, undefined, undefined,
      chatId === session.chatId ? session.chatType : 'group').allowed,
    canCreateChat: openId => names.some(cmd =>
      humanCanRunDaemonCommand(larkAppId, session.chatId, openId, callerUnionId, cmd, session.chatType)),
    // No chat id: every chat-scoped leg (session group, oncall, allowed group,
    // chat grant, meeting inviter) is skipped; chat-independent legs remain.
    canTalkInNewChat: openId => evaluateTalk(larkAppId, undefined, openId, undefined, undefined, 'group').allowed,
  };
}
