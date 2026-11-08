export interface TurnResult {
  version: 1;
  ref: { botId: string; sessionId: string; turnId: string; dispatchAttempt?: number };
  source: { kind: 'im' | 'http'; platform?: string; chatId?: string; messageId?: string };
  execution: { status: 'completed' | 'failed' | 'cancelled' | 'ambiguous'; errorCode?: string; completedAt?: string; durationMs?: number };
  output: { status: 'available' | 'empty' | 'unavailable'; format?: 'text' | 'markdown'; content?: string; source?: 'explicit' | 'transcript'; reason?: string };
  deliveries: TurnDeliveryReceipt[];
}

export interface TurnDeliveryReceipt {
  channel: 'im' | 'http';
  status: 'delivered' | 'partial' | 'failed' | 'unknown' | 'suppressed';
  platform?: string;
  chatId?: string;
  parentMessageId?: string;
  messages: Array<{ messageId: string; kind: 'primary' | 'attachment' }>;
  reason?: string;
}

export interface TurnResultBinding {
  ref: TurnResult['ref'];
  source: TurnResult['source'];
  workerGeneration: number;
}

export type TurnResultLookup =
  | { status: 'ready'; result: TurnResult }
  | { status: 'not_ready' }
  | { status: 'unavailable'; reason: string }
  | { status: 'not_found' };
