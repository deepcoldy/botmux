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
  /** Persisted streaming-card state — allows the existing card to be PATCHed
   *  (rather than a fresh POST) after daemon restart. */
  streamCardId?: string;
  streamCardNonce?: string;
  streamExpanded?: boolean;
  currentTurnTitle?: string;
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

/** Messages sent from Daemon to Worker */
export type DaemonToWorker =
  | { type: 'init'; sessionId: string; chatId: string; rootMessageId: string; workingDir: string; cliId: string; cliPathOverride?: string; backendType: 'pty' | 'tmux'; prompt: string; resume?: boolean; ownerOpenId?: string; webPort?: number; larkAppId: string; larkAppSecret: string; adoptMode?: boolean; adoptTmuxTarget?: string; adoptPaneCols?: number; adoptPaneRows?: number }
  | { type: 'message'; content: string }
  | { type: 'close' }
  | { type: 'restart' };

/** Messages sent from Worker to Daemon */
export type WorkerToDaemon =
  | { type: 'ready'; port: number; token: string }
  | { type: 'claude_exit'; code: number | null; signal: string | null }
  | { type: 'prompt_ready' }
  | { type: 'screen_update'; content: string; status: 'working' | 'idle' }
  | { type: 'error'; message: string };

