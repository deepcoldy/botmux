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
import { isRelayableRealSession } from '../core/worker-pool.js';
import { sessionAnchorId } from '../core/types.js';

export async function collectRelayPickerEntries(
  activeSessions: Map<string, DaemonSession>,
  myAppId: string,
  /** The relay TARGET anchor (chatId for chat-scope, rootMessageId for a 话题).
   *  We exclude only the session sitting AT this anchor (can't relay onto
   *  itself); same-chat other-topic sessions have a different anchor and stay
   *  in the candidate list — that's what enables 同群话题间搬运. */
  currentAnchor: string,
  operatorOpenId: string,
): Promise<RelayPickerEntry[]> {
  const candidates: DaemonSession[] = [];
  for (const c of activeSessions.values()) {
    if (c.larkAppId !== myAppId) continue;
    if (sessionAnchorId(c) === currentAnchor) continue;
    if (c.session.ownerOpenId !== operatorOpenId) continue;
    if (c.session.adoptedFrom) continue;
    // Daemon-command scratches (worker:null + no persisted CLI markers)
    // are placeholder records for /help / unfinished /relay etc. — they
    // have no real conversation to bring along. Don't surface them in
    // anyone's picker.
    if (!isRelayableRealSession(c)) continue;
    candidates.push(c);
  }
  // Sort most-recently-active first so the session the operator just used
  // lands at the top of the picker (page 1) instead of wherever it happens
  // to sit in the activeSessions Map iteration order (insertion order on a
  // fresh daemon, on-disk order after a restart — neither useful to the
  // user). `lastMessageAt` is the runtime DaemonSession field bumped on
  // every inbound message; sessions missing it (shouldn't happen for real
  // sessions, but be defensive) sort to the bottom.
  candidates.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  // Skip the API call entirely for p2p chats. session.chatType is recorded
  // at session creation from the Lark event payload and is authoritative —
  // it doesn't drift. The earlier design used `info?.mode ?? fallbackMode`,
  // but `getChatNameAndMode` swallows API errors and returns the SAFE
  // DEFAULT `{ name: null, mode: 'group' }` — which then mis-classified
  // every p2p session as 普通群 whenever the chat.get call failed
  // (permissions / network / etc.). 王皓 caught this. Authoritative path:
  // p2p → session.chatType; non-p2p → Lark API (for group/topic split).
  const groupChatIds = [...new Set(
    candidates.filter(c => c.chatType !== 'p2p').map(c => c.chatId),
  )];
  const resolved = await Promise.all(
    groupChatIds.map(async (cid) => [cid, await getChatNameAndMode(myAppId, cid)] as const),
  );
  const chatInfo = new Map<string, { name: string | null; mode: 'group' | 'topic' | 'p2p' }>();
  for (const [cid, info] of resolved) chatInfo.set(cid, info);
  return candidates.map(c => {
    // "Running" snapshot — same predicate transferSession uses to refuse a
    // busy worker (worker-pool.ts): a live, non-killed worker whose last
    // screen status is neither idle nor limited is mid-turn. Surfaced so the
    // picker can disable the confirm button for a running session instead of
    // letting the user click through to a worker_busy error (which would
    // have already POSTed + deleted an M1). This is a snapshot at
    // render/click time, not live — re-clicking the entry re-renders and
    // recomputes it.
    const running = !!c.worker && !c.worker.killed
      && c.lastScreenStatus !== 'idle' && c.lastScreenStatus !== 'limited';
    if (c.chatType === 'p2p') {
      return {
        sessionId: c.session.sessionId,
        // chatLabel is unused for p2p in the rendered output (location
        // field always renders the locale-aware "单聊" literal), but we
        // still set it to chatId for completeness / downstream debug.
        chatLabel: c.chatId,
        title: c.session.title || c.currentTurnTitle || '(no title)',
        workingDir: c.session.workingDir,
        cliId: c.session.cliId,
        lastMessageAt: c.lastMessageAt,
        chatMode: 'p2p' as const,
        running,
      };
    }
    const info = chatInfo.get(c.chatId);
    return {
      sessionId: c.session.sessionId,
      chatLabel: info?.name ?? c.chatId,
      title: c.session.title || c.currentTurnTitle || '(no title)',
      workingDir: c.session.workingDir,
      cliId: c.session.cliId,
      lastMessageAt: c.lastMessageAt,
      chatMode: info?.mode ?? 'group',
      running,
    };
  });
}
