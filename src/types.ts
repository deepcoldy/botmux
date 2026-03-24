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
  imBotId?: string;
  /** WeChat iLink context token for replying — updated on every received message */
  weixinContextToken?: string;
  /** WeChat user ID (from_user_id) for sending replies */
  weixinUserId?: string;
}

/** @deprecated Use from src/im/lark/types.ts */
export interface LarkAttachment {
  type: 'image' | 'file';
  path: string;       // 本地文件绝对路径
  name: string;       // 文件名
}

/** @deprecated Use from src/im/lark/types.ts */
export interface LarkMention {
  key: string;        // e.g. "@_user_1"
  name: string;       // display name
  openId?: string;    // open_id of the mentioned user/bot
}

/** @deprecated Use from src/im/lark/types.ts */
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

export interface ScheduledTask {
  id: string;
  name: string;
  type: 'cron' | 'interval' | 'once';
  schedule: string;       // cron expression, milliseconds, or ISO datetime
  prompt: string;
  workingDir: string;
  chatId: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
}

// ─── Worker IPC Messages ─────────────────────────────────────────────────────

/** Messages sent from Daemon to Worker */
export type DaemonToWorker =
  | { type: 'init'; sessionId: string; chatId: string; rootMessageId: string; workingDir: string; cliId: string; cliPathOverride?: string; backendType: 'pty' | 'tmux'; prompt: string; resume?: boolean; ownerId?: string; webPort?: number; imBotId: string }
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

export const TOOL_NAMES = {
  SEND_TO_THREAD: 'send_to_thread',
  GET_THREAD_MESSAGES: 'get_thread_messages',

  LIST_BOTS: 'list_bots',
} as const;
