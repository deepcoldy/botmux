export interface Session {
  sessionId: string;
  chatId: string;
  chatType?: 'group' | 'p2p';
  rootMessageId: string;
  title: string;
  status: 'active' | 'closed';
  createdAt: string;
  closedAt?: string;
  pid?: number;
  workingDir?: string;
  webPort?: number;
  larkAppId?: string;
  ownerOpenId?: string;       // topic creator's open_id — for @mention in replies
  /** open_id of the user whose message triggered the most recent CLI turn.
   *  Equals ownerOpenId for the first turn; updates on every subsequent reply.
   *  Used by `botmux send` to address the card to the actual caller in oncall
   *  groups (where the caller is often not the session owner). */
  lastCallerOpenId?: string;
  /** Persisted streaming-card state — allows the existing card to be PATCHed
   *  (rather than a fresh POST) after daemon restart. */
  streamCardId?: string;
  streamCardNonce?: string;
  /** Legacy field kept for migrating sessions persisted before displayMode was added. */
  streamExpanded?: boolean;
  /** Card body display mode — 'hidden' | 'screenshot'. */
  displayMode?: DisplayMode;
  /** Latest uploaded screenshot image_key, persisted so card can re-render after restart. */
  currentImageKey?: string;
  currentTurnTitle?: string;
  /** CLI-native resume id when it differs from botmux's sessionId (for example Codex thread id). */
  cliSessionId?: string;
  /** Persisted adopt metadata — allows adopt sessions to survive daemon restarts. */
  adoptedFrom?: {
    tmuxTarget: string;
    originalCliPid: number;
    sessionId?: string;
    cliId?: string;
    cwd: string;
    paneCols?: number;
    paneRows?: number;
  };
}

export interface LarkAttachment {
  type: 'image' | 'file';
  path: string;       // 本地文件绝对路径
  name: string;       // 文件名
}

export interface LarkMention {
  key: string;        // e.g. "@_user_1"
  name: string;       // display name
  openId?: string;    // open_id of the mentioned user/bot
}

export interface LarkMessage {
  messageId: string;
  rootId: string;
  senderId: string;
  senderType: string;
  msgType: string;
  content: string;
  createTime: string;
  attachments?: LarkAttachment[];
  mentions?: LarkMention[];
}

/**
 * Structured schedule form, computed once at creation time from the raw
 * schedule string.  Parsed form is authoritative for runtime computation;
 * the raw string is kept only for display/reconfigure.
 */
export interface ParsedSchedule {
  kind: 'once' | 'interval' | 'cron';
  /** For 'once': ISO timestamp of run time */
  runAt?: string;
  /** For 'interval': recurrence minutes */
  minutes?: number;
  /** For 'cron': cron expression (5 fields, minute/hour/dom/month/dow) */
  expr?: string;
  /** Human-friendly display text */
  display: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  /** Raw user input (e.g. "每日17:50" or "30m" or "0 9 * * *") */
  schedule: string;
  /** Structured form — authoritative for runtime */
  parsed: ParsedSchedule;
  prompt: string;
  workingDir: string;
  chatId: string;
  /** Root message id of the topic where the task was created. When set,
   *  execution replies into this thread instead of creating a new one. */
  rootMessageId?: string;
  chatType?: 'group' | 'p2p' | 'topic_group';
  larkAppId?: string;
  /** Where the user originally created the task (for cross-thread tasks where
   *  --chat-id / --root-msg-id retarget execution to a different chat).
   *  When set and != chatId/rootMessageId, the "🕐 task started" notification
   *  is posted here instead of (or in addition to) the execution target. */
  creatorChatId?: string;
  creatorRootMessageId?: string;
  creatorLarkAppId?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: 'ok' | 'error';
  lastError?: string;
  lastDeliveryError?: string;
  /** Repeat counter — times=null means forever; times>0 auto-removes after N runs */
  repeat?: { times: number | null; completed: number };
  /** Delivery target: 'origin' (original thread, default), 'local' (log only, no delivery) */
  deliver?: 'origin' | 'local';
  // DEPRECATED — kept only for backward-compat migration
  type?: 'cron' | 'interval' | 'once';
}

// ─── Worker IPC Messages ─────────────────────────────────────────────────────

/** Display modes for the streaming card output. */
export type DisplayMode = 'hidden' | 'screenshot';

/** Quick-action keys sent from card buttons to the worker's PTY/tmux backend. */
export type TermActionKey =
  | 'esc' | 'ctrlc' | 'tab' | 'enter' | 'space'
  | 'up' | 'down' | 'left' | 'right'
  | 'half_page_up' | 'half_page_down';

/** Messages sent from Daemon to Worker */
export type DaemonToWorker =
  | { type: 'init'; sessionId: string; chatId: string; rootMessageId: string; workingDir: string; cliId: string; cliPathOverride?: string; backendType: 'pty' | 'tmux'; prompt: string; resume?: boolean; cliSessionId?: string; ownerOpenId?: string; webPort?: number; larkAppId: string; larkAppSecret: string; botName?: string; botOpenId?: string; adoptMode?: boolean; adoptTmuxTarget?: string; adoptPaneCols?: number; adoptPaneRows?: number; bridgeJsonlPath?: string }
  | { type: 'message'; content: string }
  | { type: 'raw_input'; content: string }
  | { type: 'close' }
  | { type: 'restart' }
  | { type: 'tui_keys'; keys: string[]; isFinal: boolean }
  | { type: 'tui_text_input'; keys: string[]; text: string }
  | { type: 'set_display_mode'; mode: DisplayMode }
  | { type: 'term_action'; key: TermActionKey }
  | { type: 'refresh_screen' };

/** Messages sent from Worker to Daemon */
export type WorkerToDaemon =
  | { type: 'ready'; port: number; token: string }
  | { type: 'claude_exit'; code: number | null; signal: string | null }
  | { type: 'prompt_ready' }
  | { type: 'screen_update'; content: string; status: 'working' | 'idle' | 'analyzing' }
  | { type: 'error'; message: string }
  | { type: 'tui_prompt'; description: string; options: Array<{ label?: string; text: string; selected: boolean; type?: string; keys?: string[] }>; multiSelect?: boolean }
  | { type: 'tui_prompt_resolved'; selectedText?: string }
  | { type: 'screenshot_uploaded'; imageKey: string; status: 'working' | 'idle' | 'analyzing' }
  | { type: 'user_notify'; message: string }
  | { type: 'final_output'; content: string; lastUuid: string; turnId: string };
