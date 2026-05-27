/**
 * Shared helper for collecting the operator's relayable sessions used by the
 * /relay picker. Same selection criteria used both at first render
 * (command-handler) and on each card-update click (card-handler re-render),
 * so factor it out to keep both paths in sync.
 *
 * Selection rules:
 *   • same bot (this larkAppId — only this daemon's sessions are visible)
 *   • NOT in the current chat (can't relay into the chat it already lives in)
 *   • operator is the session owner (owner-only access)
 *   • not an adopt session (those wrap a user-attached tmux pane, refused
 *     by transferSession anyway)
 *
 * Resolves friendly chat names and modes via getChatNameAndMode in parallel
 * (1 API call per unique source chatId). Failure modes are tolerant:
 * unresolved chats fall back to the raw chatId for chatLabel and the
 * session's own chatType for mode.
 */
import type { DaemonSession } from '../core/types.js';
import type { RelayPickerEntry } from '../im/lark/card-builder.js';
import { getChatNameAndMode } from '../im/lark/client.js';

export async function collectRelayPickerEntries(
  activeSessions: Map<string, DaemonSession>,
  myAppId: string,
  currentChatId: string,
  operatorOpenId: string,
): Promise<RelayPickerEntry[]> {
  const candidates: DaemonSession[] = [];
  for (const c of activeSessions.values()) {
    if (c.larkAppId !== myAppId) continue;
    if (c.chatId === currentChatId) continue;
    if (c.session.ownerOpenId !== operatorOpenId) continue;
    if (c.session.adoptedFrom) continue;
    candidates.push(c);
  }
  const uniqueChatIds = [...new Set(candidates.map(c => c.chatId))];
  const resolved = await Promise.all(
    uniqueChatIds.map(async (cid) => [cid, await getChatNameAndMode(myAppId, cid)] as const),
  );
  const chatInfo = new Map<string, { name: string | null; mode: 'group' | 'topic' | 'p2p' }>();
  for (const [cid, info] of resolved) chatInfo.set(cid, info);
  return candidates.map(c => {
    const info = chatInfo.get(c.chatId);
    const fallbackMode: 'group' | 'p2p' = c.chatType === 'p2p' ? 'p2p' : 'group';
    return {
      sessionId: c.session.sessionId,
      chatLabel: info?.name ?? c.chatId,
      title: c.session.title || c.currentTurnTitle || '(no title)',
      workingDir: c.session.workingDir,
      cliId: c.session.cliId,
      lastMessageAt: c.lastMessageAt,
      chatMode: info?.mode ?? fallbackMode,
    };
  });
}
