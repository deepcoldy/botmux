/**
 * LarkImAdapter — wraps existing lark/ modules to implement the ImAdapter interface.
 * This bridges the legacy appId-based function calls with the adapter pattern.
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { registerLarkClient, stderrLogger, getBot } from '../../bot-registry.js';
import {
  sendMessage as larkSendMessage,
  replyMessage as larkReplyMessage,
  updateMessage as larkUpdateMessage,
  deleteMessage as larkDeleteMessage,
  sendUserMessage as larkSendUserMessage,
  downloadMessageResource,
  resolveAllowedUsers as larkResolveAllowedUsers,
  listThreadMessages,
  addReaction as larkAddReaction,
  removeReaction as larkRemoveReaction,
} from './client.js';
import {
  buildSessionCard,
  buildStreamingCard,
  buildRepoSelectCard,
} from './card-builder.js';
import {
  startLarkEventDispatcher,
  probeBotOpenId,
  writeBotInfoFile,
} from './event-dispatcher.js';
import { parseApiMessage } from './message-parser.js';
import { logger } from '../../utils/logger.js';
import type {
  ImAdapter,
  ImCapabilities,
  ImCardBuilder,
  ImCard,
  ImMessage,
  ImUser,
  ImEventHandler,
} from '../types.js';

export class LarkImAdapter implements ImAdapter {
  readonly id: string;
  readonly capabilities: ImCapabilities = {
    cards: true,
    updateMessage: true,
    threads: true,
    richText: true,
    reactions: true,
    typing: false,
    attachments: true,
  };

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly client: Lark.Client;
  private wsClient?: Lark.WSClient;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.id = `lark:${appId}`;

    this.client = new Lark.Client({
      appId,
      appSecret,
      logger: stderrLogger,
    });
    registerLarkClient(appId, this.client);
  }

  // ─── Card builder ────────────────────────────────────────────────────────

  readonly cards: ImCardBuilder = {
    buildSessionCard: (opts) => {
      const json = buildSessionCard(
        opts.sessionId,
        opts.rootMessageId,
        opts.terminalUrl,
        opts.title,
      );
      return { payload: json };
    },

    buildStreamingCard: (opts) => {
      const json = buildStreamingCard(
        opts.sessionId,
        opts.rootMessageId,
        opts.terminalUrl,
        opts.title,
        opts.content,
        opts.status,
      );
      return { payload: json };
    },

    buildRepoSelectCard: (opts) => {
      // ImCardBuilder uses { name, path, description } but Lark needs ProjectInfo { name, path, type, branch }.
      // Cast as any — the Lark card builder only uses name, path, and branch from the objects.
      const json = buildRepoSelectCard(
        opts.projects as any,
        opts.currentCwd,
        opts.rootMessageId,
      );
      return { payload: json };
    },
  };

  // ─── Message methods ─────────────────────────────────────────────────────

  async sendMessage(threadId: string, content: string, format: 'text' | 'rich'): Promise<string> {
    const msgType = format === 'rich' ? 'interactive' : 'text';
    return larkSendMessage(this.appId, threadId, content, msgType);
  }

  async replyMessage(messageId: string, content: string, format: 'text' | 'rich'): Promise<string> {
    const msgType = format === 'rich' ? 'interactive' : 'text';
    return larkReplyMessage(this.appId, messageId, content, msgType);
  }

  async updateMessage(messageId: string, content: string): Promise<void> {
    return larkUpdateMessage(this.appId, messageId, content);
  }

  async deleteMessage(messageId: string): Promise<void> {
    return larkDeleteMessage(this.appId, messageId);
  }

  async sendCard(threadId: string, card: ImCard): Promise<string> {
    // For Lark, card.payload is a JSON string (the card JSON).
    // Send as reply with msgType 'interactive'.
    const cardJson = card.payload as string;
    return larkReplyMessage(this.appId, threadId, cardJson, 'interactive');
  }

  async updateCard(messageId: string, card: ImCard): Promise<void> {
    const cardJson = card.payload as string;
    return larkUpdateMessage(this.appId, messageId, cardJson);
  }

  // ─── User resolution ─────────────────────────────────────────────────────

  async resolveUsers(identifiers: string[]): Promise<ImUser[]> {
    const openIds = await larkResolveAllowedUsers(this.appId, identifiers);
    return openIds.map(id => ({ id, identifier: id }));
  }

  async sendDirectMessage(userId: string, content: string): Promise<void> {
    await larkSendUserMessage(this.appId, userId, content);
  }

  // ─── Attachments & threads ───────────────────────────────────────────────

  async downloadAttachment(messageId: string, resourceKey: string): Promise<string> {
    // Downloads to a temp path — callers should provide a proper save location via the client.ts function
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const savePath = join(tmpdir(), `botmux-${messageId}-${resourceKey}`);
    await downloadMessageResource(this.appId, messageId, resourceKey, 'file', savePath);
    return savePath;
  }

  async getThreadMessages(threadId: string, limit: number): Promise<ImMessage[]> {
    // threadId is rootMessageId; we need chatId too, but the listThreadMessages
    // function requires it. For now, we look it up from the message itself.
    // In practice, callers should use the client.ts function directly for Lark.
    // This is a best-effort implementation.
    const msgs = await listThreadMessages(this.appId, '', threadId, limit);
    return msgs.map((msg: any) => {
      const parsed = parseApiMessage(msg);
      return {
        id: parsed.messageId,
        threadId: parsed.rootId,
        senderId: parsed.senderId,
        senderType: (parsed.senderType === 'app' ? 'bot' : 'user') as 'user' | 'bot',
        content: parsed.content,
        msgType: parsed.msgType,
        createTime: parsed.createTime,
      };
    });
  }

  // ─── Reactions ───────────────────────────────────────────────────────────

  async addReaction(messageId: string, emojiType: string): Promise<string> {
    return larkAddReaction(this.appId, messageId, emojiType);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    return larkRemoveReaction(this.appId, messageId, reactionId);
  }

  // ─── Bot identity ────────────────────────────────────────────────────────

  getBotUserId(): string | undefined {
    return getBot(this.appId).botUserId;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async start(handler: ImEventHandler): Promise<void> {
    this.wsClient = startLarkEventDispatcher(this.appId, this.appSecret, {
      handleCardAction: async (data, _appId) => {
        const action = data?.action;
        const value = action?.value;
        if (value) {
          await handler.onCardAction({
            actionType: value.action ?? 'unknown',
            threadId: value.root_id ?? '',
            operatorId: data?.operator?.open_id,
            value,
          });
        }
      },
      handleNewTopic: async (data, chatId, _messageId, chatType, _appId) => {
        const msg = this.eventDataToImMessage(data);
        await handler.onNewTopic(msg, chatId, chatType);
      },
      handleThreadReply: async (data, rootId, _appId) => {
        const msg = this.eventDataToImMessage(data);
        await handler.onThreadReply(msg, rootId);
      },
    });
    logger.info(`LarkImAdapter started for ${this.appId}`);
  }

  async stop(): Promise<void> {
    // WSClient doesn't have a clean stop — it will be GC'd
    this.wsClient = undefined;
    logger.info(`LarkImAdapter stopped for ${this.appId}`);
  }

  // ─── Lark-specific helpers (transition period) ───────────────────────────

  getLarkClient(): Lark.Client {
    return this.client;
  }

  getAppId(): string {
    return this.appId;
  }

  getAppSecret(): string {
    return this.appSecret;
  }

  async probeIdentity(): Promise<void> {
    return probeBotOpenId(this.appId);
  }

  writeInfoFile(dataDir: string): void {
    writeBotInfoFile(dataDir);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private eventDataToImMessage(data: any): ImMessage {
    const message = data.message;
    const sender = data.sender;
    return {
      id: message?.message_id ?? '',
      threadId: message?.root_id ?? '',
      senderId: sender?.sender_id?.open_id ?? '',
      senderType: sender?.sender_type === 'app' ? 'bot' : 'user',
      content: message?.content ?? '',
      msgType: message?.message_type ?? 'text',
      createTime: message?.create_time ?? '',
    };
  }
}
