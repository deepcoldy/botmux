export interface ImCapabilities {
  cards: boolean;
  updateMessage: boolean;
  threads: boolean;
  richText: boolean;
  reactions: boolean;
  typing: boolean;
  attachments: boolean;
}

export interface ImMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderType: 'user' | 'bot';
  content: string;
  msgType: string;
  attachments?: ImAttachment[];
  createTime: string;
}

export interface ImAttachment {
  type: 'image' | 'file';
  path: string;
  name: string;
}

export interface ImUser {
  id: string;
  identifier: string;
}

export interface ImMention {
  key: string;
  name: string;
  userId?: string;
}

export interface ImCard {
  payload: unknown;
}

export interface ImCardAction {
  actionType: string;
  threadId: string;
  operatorId?: string;
  value?: Record<string, unknown>;
}

export interface ImEventHandler {
  onNewTopic(msg: ImMessage, chatId: string, chatType: 'group' | 'p2p'): Promise<void>;
  onThreadReply(msg: ImMessage, threadId: string): Promise<void>;
  onCardAction(action: ImCardAction): Promise<void>;
}

export interface ImCardBuilder {
  buildSessionCard(opts: {
    sessionId: string;
    rootMessageId: string;
    terminalUrl: string;
    title: string;
  }): ImCard;

  buildStreamingCard(opts: {
    sessionId: string;
    rootMessageId: string;
    terminalUrl: string;
    title: string;
    content: string;
    status: 'starting' | 'working' | 'idle';
  }): ImCard;

  buildRepoSelectCard(opts: {
    projects: Array<{ name: string; path: string; description: string }>;
    currentCwd: string;
    rootMessageId: string;
  }): ImCard;
}

export interface ImAdapter {
  readonly id: string;
  readonly capabilities: ImCapabilities;

  start(handler: ImEventHandler): Promise<void>;
  stop(): Promise<void>;

  cards: ImCardBuilder;

  sendMessage(threadId: string, content: string, format: 'text' | 'rich'): Promise<string>;
  replyMessage(messageId: string, content: string, format: 'text' | 'rich'): Promise<string>;
  updateMessage(messageId: string, content: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  sendCard(threadId: string, card: ImCard): Promise<string>;
  updateCard(messageId: string, card: ImCard): Promise<void>;

  resolveUsers(identifiers: string[]): Promise<ImUser[]>;
  sendDirectMessage(userId: string, content: string): Promise<void>;

  downloadAttachment(messageId: string, resourceKey: string): Promise<string>;
  getThreadMessages(threadId: string, limit: number): Promise<ImMessage[]>;

  /** Add a reaction emoji to a message. Returns the reaction ID. */
  addReaction(messageId: string, emojiType: string): Promise<string>;
  /** Remove a reaction by its reaction ID (not emoji type). */
  removeReaction(messageId: string, reactionId: string): Promise<void>;

  getBotUserId(): string | undefined;
}
