/** Codex 完成事件的固定来源。 */
export type CodexTaskSource = 'codex-desktop';

/** 产生任务的 Codex 客户端表面。旧事件可能没有该字段。 */
export type CodexClientSurface = 'codex-app' | 'codex-cli';

/** Codex 会话形态；Side Chat 是不落盘的临时会话。 */
export type CodexConversationKind = 'side';

/** Codex 任务的终态。 */
export type CodexTaskStatus = 'completed' | 'failed' | 'cancelled';

/**
 * 独立 Codex App/CLI 通过 Stop Hook 发给 BotMux 的完成事件。
 *
 * 该类型只描述跨插件边界的数据；调用方仍须通过 parseCodexNotifierEvent 做运行时校验。
 */
export interface CodexTaskCompletedEvent {
  schemaVersion: 1;
  eventId: string;
  type: 'task.completed';
  source: CodexTaskSource;
  clientSurface?: CodexClientSurface;
  conversationKind?: CodexConversationKind;
  threadId: string;
  nativeTurnId: string;
  status: CodexTaskStatus;
  title?: string;
  cwd: string;
  completedAt: string;
  finalPreview?: string;
}

export type CodexNotifierDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface CodexNotifierDelivery {
  status: CodexNotifierDeliveryStatus;
  attempts: number;
  updatedAt: string;
  messageId?: string;
  lastError?: string;
}

export interface CodexNotifierEventRecord {
  event: CodexTaskCompletedEvent;
  receivedAt: string;
  delivery: CodexNotifierDelivery;
}
