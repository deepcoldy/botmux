import type { ChildProcess } from 'node:child_process';
import type { Session, DaemonToWorker, LarkAttachment, LarkMention, DisplayMode } from '../types.js';

/** Frozen card state — cached content for historical streaming cards that can still be toggled. */
export interface FrozenCard {
  messageId: string;      // Lark message_id for PATCHing
  content: string;        // frozen text snapshot — kept so "导出文字" still works on historical cards
  title: string;          // turn title at freeze time
  /** Legacy boolean expand/collapse — kept for migrating old persisted cards. */
  expanded?: boolean;
  /** Display mode at freeze time. If absent, derived from `expanded`. */
  displayMode?: DisplayMode;
  /** Latest uploaded image_key for the frozen card (only when displayMode === 'screenshot'). */
  imageKey?: string;
}

/** Resolve effective display mode for a frozen card.
 *  Legacy persisted values (e.g. `'text'` from pre-v2.4 cards) map to
 *  `'screenshot'` so old cards still render meaningfully. */
export function frozenDisplayMode(fc: FrozenCard): DisplayMode {
  if (fc.displayMode === 'screenshot' || fc.displayMode === 'hidden') return fc.displayMode;
  return fc.expanded ? 'screenshot' : 'hidden';
}

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
  repoCardMessageId?: string;    // message_id of the repo selection card — for withdrawal
  pendingPrompt?: string;        // original user message to send after repo is selected
  pendingAttachments?: LarkAttachment[];
  pendingMentions?: LarkMention[];    // @mentions from initial message, used when building prompt after repo selection
  pendingFollowUps?: string[];         // buffered follow-up messages (enriched) sent while waiting for repo selection
  ownerOpenId?: string;          // topic creator's open_id — receives write-enabled terminal link via DM
  streamCardId?: string;         // message_id of the streaming card in group (PATCHed with live output)
  streamCardNonce?: string;       // unique nonce for the current streaming card — embedded in button values to distinguish old vs current card
  streamCardPending?: boolean;    // true when a new turn started, next screen_update creates a new card
  /** Card body display mode. Default 'hidden'. When user clicks 显示输出, defaults to 'screenshot'. */
  displayMode?: DisplayMode;
  /** Latest uploaded screenshot image_key for the streaming card. */
  currentImageKey?: string;
  lastScreenContent?: string;    // last screen_update content — used to freeze card at idle
  lastScreenStatus?: 'starting' | 'working' | 'idle' | 'analyzing';  // last screen_update status
  currentTurnTitle?: string;      // title for the current turn's streaming card
  cardPatchInFlight?: boolean;    // true while a card PATCH is in-flight
  pendingCardJson?: string;       // queued card JSON — flushed when in-flight PATCH completes (latest wins)
  pendingCardId?: string;         // card message_id captured at schedule time — prevents stale reads when streamCardId changes between schedule and flush
  frozenCards?: Map<string, FrozenCard>;  // nonce → FrozenCard (historical cards' cached state for toggle)
  /** message_id of the TUI prompt interactive card (if active) */
  tuiPromptCardId?: string;
  /** Cached TUI prompt options — for dedup and for resolving after click */
  tuiPromptOptions?: Array<{ label?: string; text: string; selected: boolean; type?: string; keys?: string[] }>;
  tuiPromptMultiSelect?: boolean;
  tuiToggledIndices?: number[];  // tracks toggled options for multi-select card PATCH
  /** Last assistant uuid emitted via the adopt bridge final_output pipeline.
   *  Used by the daemon to dedupe successive `final_output` IPCs (e.g. when
   *  the worker re-drains the transcript after a noisy idle). */
  lastBridgeEmittedUuid?: string;
  /** Present when this session was created via /adopt (shared observation mode). */
  adoptedFrom?: {
    tmuxTarget: string;       // e.g. "0:2.0" — user's original tmux pane
    originalCliPid: number;   // CLI process PID in the user's pane
    sessionId?: string;       // CLI session ID (for takeover/resume)
    cliId?: import('../adapters/cli/types.js').CliId;  // recognized CLI type
    cwd: string;              // CLI working directory
    paneCols?: number;        // tmux pane width at adopt time
    paneRows?: number;        // tmux pane height at adopt time
  };
}

/** Composite key for activeSessions — allows multiple bots to have independent sessions for the same thread. */
export function sessionKey(rootId: string, larkAppId: string): string {
  return `${rootId}::${larkAppId}`;
}
