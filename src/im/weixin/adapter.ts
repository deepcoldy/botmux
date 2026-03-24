import type {
  ImAdapter,
  ImCapabilities,
  ImEventHandler,
  ImCardBuilder,
  ImCard,
  ImMessage,
  ImUser,
} from '../types.js';
import { weixinCardBuilder } from './card-builder.js';
import { WeixinPoller } from './poller.js';
import * as ilink from './client.js';
import * as auth from './auth.js';
import { logger } from '../../utils/logger.js';

export class WeixinImAdapter implements ImAdapter {
  readonly id = 'weixin-default';
  readonly capabilities: ImCapabilities = {
    cards: false,
    updateMessage: false,
    threads: false,
    richText: false,
    reactions: false,
    typing: true,
    attachments: false,
  };
  readonly cards: ImCardBuilder = weixinCardBuilder;

  private token = '';
  private botId = '';
  private poller: WeixinPoller | null = null;

  async start(handler: ImEventHandler): Promise<void> {
    const tokenData = auth.loadToken();
    if (!tokenData) {
      logger.warn('[weixin] No token. Run "botmux weixin-auth" first. Skipping WeChat.');
      return;
    }
    const valid = await auth.validateToken(tokenData.bot_token);
    if (!valid) {
      logger.warn('[weixin] Token invalid/expired. Run "botmux weixin-auth". Skipping WeChat.');
      return;
    }
    this.token = tokenData.bot_token;
    this.botId = tokenData.bot_id;

    const sendReply = async (userId: string, text: string) => {
      const ct = this.poller?.getContextToken(userId) ?? '';
      await ilink.sendMessage(this.token, userId, text, ct);
    };

    this.poller = new WeixinPoller(this.token, handler, sendReply);
    this.poller.start();
    logger.info('[weixin] Adapter started');
  }

  async stop(): Promise<void> {
    this.poller?.stop();
    this.poller = null;
  }

  /** Strip the wx- prefix that daemon adds to rootId to recover the real iLink userId */
  private toUserId(idOrRoot: string): string {
    return idOrRoot.startsWith('wx-') ? idOrRoot.slice(3) : idOrRoot;
  }

  async sendMessage(threadId: string, content: string, _format: 'text' | 'rich'): Promise<string> {
    const userId = this.toUserId(threadId);
    const ct = this.poller?.getContextToken(userId) ?? '';
    logger.info(`[weixin] sendMessage to=${userId.substring(0, 20)}... ct=${ct ? 'yes' : 'empty'} len=${content.length}`);
    try {
      const msgId = await ilink.sendMessage(this.token, userId, content, ct);
      logger.info(`[weixin] sendMessage OK, msgId=${msgId || '(empty)'}`);
      return msgId;
    } catch (err) {
      logger.error(`[weixin] sendMessage FAILED: ${err}`);
      throw err;
    }
  }

  async replyMessage(
    messageId: string,
    content: string,
    format: 'text' | 'rich',
  ): Promise<string> {
    return this.sendMessage(messageId, content, format);
  }

  async updateMessage(): Promise<void> { /* no-op: iLink has no update API */ }
  async deleteMessage(): Promise<void> { /* no-op: iLink has no delete API */ }

  async sendCard(threadId: string, card: ImCard): Promise<string> {
    const text = typeof card.payload === 'string' ? card.payload : JSON.stringify(card.payload);
    return this.sendMessage(threadId, text, 'text');
  }

  async updateCard(): Promise<void> { /* no-op */ }

  async resolveUsers(identifiers: string[]): Promise<ImUser[]> {
    return identifiers.map(id => ({ id, identifier: id }));
  }

  async sendDirectMessage(userId: string, content: string): Promise<void> {
    await this.sendMessage(userId, content, 'text');
  }

  async downloadAttachment(): Promise<string> {
    throw new Error('WeChat attachment download not supported in V1');
  }

  async getThreadMessages(): Promise<ImMessage[]> {
    return []; // iLink has no history API
  }

  async addReaction(): Promise<string> { return ''; }
  async removeReaction(): Promise<void> {}

  getBotUserId(): string | undefined { return this.botId || undefined; }

  /** Expose poller for daemon to register sessions */
  getPoller(): WeixinPoller | null { return this.poller; }
}
