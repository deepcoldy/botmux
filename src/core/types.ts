import type { ChildProcess } from 'node:child_process';
import type { Session, DaemonToWorker, LarkAttachment, LarkMention, DisplayMode, StreamStatus } from '../types.js';
import type { CliUsageLimitState } from '../utils/cli-usage-limit.js';

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
  /** Routing scope:
   *   'thread' → routing key = session.rootMessageId, replies use reply_in_thread=true
   *   'chat'   → routing key = chatId, replies are plain chat messages
   *  Must be set explicitly at session creation (no implicit default — every
   *  caller decides based on event context). Restored sessions without a
   *  persisted scope fall back to 'thread' in the restore path. */
  scope: 'thread' | 'chat';
  spawnedAt: number;
  cliVersion: string;
  lastMessageAt: number;
  hasHistory: boolean;   // true after CLI has run at least once for this session
  workingDir?: string;
  initConfig?: Extract<DaemonToWorker, { type: 'init' }>;   // stored for restart
  pendingRepo?: boolean;         // waiting for repo selection before spawning CLI
  repoCardMessageId?: string;    // message_id of the repo selection card — for withdrawal
  worktreeCreating?: boolean;    // a worktree-open is in flight — dedups repeated card clicks / `/repo wt`
  pendingPrompt?: string;        // original user message to send after repo is selected
  /** One-shot CLI slash command to send literally after the worker reports
   *  prompt_ready. Used when a new topic starts with an adapter-default
   *  passthrough command such as `/goal`: the CLI must see raw `/...`, not a
   *  botmux-wrapped `<user_message>`. In-memory only to avoid replaying after
   *  daemon restart. */
  pendingRawInput?: string;
  /** Wrapped prompt for messages buffered while a pendingRawInput session
   *  waited for repo selection (pendingFollowUps / attachments). Built at the
   *  fork site (where prompt-building context lives) and delivered right
   *  after the raw input on prompt_ready, so the buffered messages queue as
   *  the next turn instead of being dropped. In-memory only, like
   *  pendingRawInput. */
  pendingFollowUpInput?: { userPrompt: string; cliInput: string };
  pendingAttachments?: LarkAttachment[];
  pendingMentions?: LarkMention[];    // @mentions from initial message, used when building prompt after repo selection
  /** Sender (open_id + type + resolved name) of the initial message — stashed
   *  so the deferred spawn after repo-selection still injects a <sender> tag
   *  matching the original caller, not the user who clicked the card. */
  pendingSender?: import('../im/lark/identity-cache.js').ResolvedSender;
  pendingFollowUps?: string[];         // buffered follow-up messages (enriched) sent while waiting for repo selection
  ownerOpenId?: string;          // topic creator's open_id — receives write-enabled terminal link via DM
  streamCardId?: string;         // message_id of the streaming card in group (PATCHed with live output)
  streamCardNonce?: string;       // unique nonce for the current streaming card — embedded in button values to distinguish old vs current card
  streamCardPending?: boolean;    // true when a new turn started, next screen_update creates a new card
  /** Set on sessions restored after a daemon restart: suppresses the automatic
   *  card post/patch from the recovery re-fork so a restart stays silent in the
   *  group (the owner gets a private DM summary instead). Cleared on the first
   *  real CLI input (rememberLastCliInput) — the next turn posts a card normally.
   *  In-memory only. See core/restart-report.ts. */
  suppressRecoveryCard?: boolean;
  /** Session-scoped override: when true, the streaming card is posted/patched
   *  even if the bot has `disableStreamingCard` set. Flipped on by the `/card`
   *  command so a user can manually summon a live card in an otherwise-quiet
   *  session. In-memory only (resets on daemon restart). */
  streamingCardForced?: boolean;
  /** Two-phase turn reactions (auto-on for card-off sessions, i.e. streaming
   *  card disabled). The bot reacts 冲! on each user message the moment it's accepted for the session
   *  (bound to the message, NOT a worker status edge — so type-ahead / busy-
   *  batched messages each get their own reaction). Every pending ✋ here is
   *  flipped to ✅ when the turn returns to idle. In-memory only (a daemon
   *  restart mid-turn just leaves a stale ✋ — purely cosmetic). */
  pendingAckReactions?: Array<{ messageId: string; reactionId?: string }>;
  /** Card body display mode. Default 'hidden'. When user clicks 显示输出, defaults to 'screenshot'. */
  displayMode?: DisplayMode;
  /** Latest uploaded screenshot image_key for the streaming card. */
  currentImageKey?: string;
  lastScreenContent?: string;    // last screen_update content — used to freeze card at idle
  lastScreenStatus?: StreamStatus;  // last screen_update status
  usageLimit?: CliUsageLimitState;
  usageLimitRetryTimer?: NodeJS.Timeout;
  lastUserPrompt?: string;
  lastCliInput?: string;
  replyThreadAliases?: { [rootMessageId: string]: { createdAt: string; lastUsedAt: string } };
  currentReplyTarget?: { rootMessageId: string; turnId: string; updatedAt: string };
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
  /** Agent-raised "needs human" signal (`botmux send --attention`). Non-blocking:
   *  the agent flags it hit a blocker only a human can clear (authorization,
   *  an irreversible decision, missing access) and goes on to end its turn.
   *  Feeds the dashboard needs-you column with the human-readable `reason`.
   *  Cleared when the user next replies to the session or when the session
   *  closes. Distinct from tuiPromptCardId (which is a
   *  rendered TUI menu detected by screen-analyzer) — this is deliberate,
   *  agent-initiated, and carries no rendered options. */
  agentAttention?: { kind: string; reason: string; at: number };
  /** 文档评论入口（/subscribe-lark-doc）：本会话「来自文档评论的轮」的回复落点
   *  映射。key = turnId（= 触发评论的 reply_id/comment_id，随消息传给 worker 再
   *  随 final_output 传回）；value = 该回哪个文档的哪条评论。deliverFinalOutput
   *  命中后把正文发表为文档评论而非飞书卡片，并删除该项。仅内存（轮是瞬时的）。 */
  docCommentTurns?: Map<string, { fileToken: string; fileType: string; commentId: string; replyToOpenId?: string; replyToName?: string }>;
  /** Last assistant uuid emitted via the adopt bridge final_output pipeline.
   *  Used by the daemon to dedupe successive `final_output` IPCs (e.g. when
   *  the worker re-drains the transcript after a noisy idle). */
  lastBridgeEmittedUuid?: string;
  /** Flag flipped to true once a `session.exited` dashboard event has been
   *  published for this session. Both the dashboard-driven close path
   *  (closeSession) and the worker-process exit handler may try to publish;
   *  this guard prevents double-counting on the dashboard side. */
  exitEventEmitted?: boolean;
  /** Present when this session was created via /adopt (shared observation mode).
   *  Either tmuxTarget (tmux) OR zellijSession+zellijPaneId (zellij) is set. */
  adoptedFrom?: {
    /** Source backend of the external session. Absent means legacy tmux metadata. */
    source?: 'tmux' | 'herdr' | 'zellij';
    tmuxTarget?: string;       // e.g. "0:2.0" — user's original tmux pane
    zellijSession?: string;    // zellij session name (zellij backend)
    zellijPaneId?: string;     // e.g. "terminal_1" — observe/drive target
    herdrSessionName?: string;
    herdrTarget?: string;
    herdrPaneId?: string;
    herdrAgentName?: string;
    herdrTerminalId?: string;
    originalCliPid?: number;   // CLI process PID in the user's pane, when the source exposes one
    sessionId?: string;       // CLI session ID (for takeover/resume)
    cliId?: import('../adapters/cli/types.js').CliId;  // recognized CLI type
    cwd: string;              // CLI working directory
    paneCols?: number;        // pane width at adopt time
    paneRows?: number;        // pane height at adopt time
  };
}

/** Composite key for activeSessions — allows multiple bots to have independent
 *  sessions anchored on the same id. The first arg is the **routing anchor**:
 *  - thread-scope → rootMessageId
 *  - chat-scope   → chatId
 *  Lark message ids start with `om_` and chat ids with `oc_`, so collisions
 *  between the two address spaces are not possible. */
export function sessionKey(anchorId: string, larkAppId: string): string {
  return `${anchorId}::${larkAppId}`;
}

/** Resolve the routing anchor for an active session — chatId for chat-scope
 *  sessions, rootMessageId for thread-scope. Used to compute `sessionKey()` at
 *  storage and lookup time. */
export function sessionAnchorId(ds: DaemonSession): string {
  return ds.scope === 'chat' ? ds.chatId : ds.session.rootMessageId;
}
