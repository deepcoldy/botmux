import type { ChildProcess } from 'node:child_process';
import type { Session, DaemonToWorker, LarkAttachment } from '../types.js';

/** Core session state — IM-agnostic.
 *  IM-specific rendering state (ImRenderState) is stored separately
 *  in the ImAdapter implementation (e.g. Map<string, ImRenderState>
 *  inside LarkImAdapter), NOT on this type. */
export interface DaemonSession {
  session: Session;
  worker: ChildProcess | null;   // fork'd worker process
  workerPort: number | null;     // HTTP port for xterm.js
  workerToken: string | null;    // write token for xterm.js
  larkAppId: string;
  chatId: string;
  chatType: 'group' | 'p2p';    // p2p chats need reply_in_thread to create topics
  spawnedAt: number;
  cliVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;   // true after CLI has run at least once for this session
  workingDir?: string;
  initConfig?: DaemonToWorker;   // stored for restart
  pendingRepo?: boolean;         // waiting for repo selection before spawning CLI
  pendingPrompt?: string;        // original user message to send after repo is selected
  pendingAttachments?: LarkAttachment[];
  ownerOpenId?: string;          // topic creator's open_id — receives write-enabled terminal link via DM
  streamCardId?: string;         // message_id of the streaming card in group (PATCHed with live output)
  streamCardPending?: boolean;    // true when a new turn started, next screen_update creates a new card
  streamExpanded?: boolean;       // whether streaming output is visible in card (default: collapsed)
  lastScreenContent?: string;    // last screen_update content — used to freeze card at idle
  lastScreenStatus?: 'starting' | 'working' | 'idle';  // last screen_update status
  currentTurnTitle?: string;      // title for the current turn's streaming card
  cardPatchInFlight?: boolean;    // true while a card PATCH is in-flight — screen_update skips to avoid concurrent PATCHes
}

/** Composite key for activeSessions — allows multiple bots to have independent sessions for the same thread. */
export function sessionKey(rootId: string, larkAppId: string): string {
  return `${rootId}::${larkAppId}`;
}
