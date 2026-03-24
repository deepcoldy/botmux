import * as client from './client.js';
import { parseMessage, isTextMessage } from './message-parser.js';
import type { ILinkRawMessage } from './message-parser.js';
import { isCommand, handleCommand } from './command-handler.js';
import type { WeixinCommandContext } from './command-handler.js';
import type { ImEventHandler } from '../types.js';
import { logger } from '../../utils/logger.js';

export interface SessionMapping {
  sessionKey: string;
  contextToken: string;
}

export class WeixinPoller {
  private running = false;
  private cursor = '';
  private token: string;
  private handler: ImEventHandler;
  private sessions = new Map<string, SessionMapping>();
  private commandCtx: WeixinCommandContext;

  constructor(
    token: string,
    handler: ImEventHandler,
    sendReply: (userId: string, text: string) => Promise<void>,
  ) {
    this.token = token;
    this.handler = handler;
    this.commandCtx = {
      sendReply,
      handler,
      getActiveSessionKey: (userId) => this.sessions.get(userId)?.sessionKey,
      clearSession: (userId) => this.sessions.delete(userId),
    };
  }

  start(): void {
    this.running = true;
    this.poll().catch(err => logger.error(`[weixin] Poller crashed: ${err}`));
  }

  stop(): void { this.running = false; }

  getContextToken(userId: string): string | undefined {
    return this.sessions.get(userId)?.contextToken;
  }

  registerSession(userId: string, sessionKey: string): void {
    const existing = this.sessions.get(userId);
    this.sessions.set(userId, {
      sessionKey,
      contextToken: existing?.contextToken ?? '',
    });
  }

  private async poll(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const data = await client.getUpdates(this.token, this.cursor);
        if (data.ret !== 0) {
          logger.error(
            `[weixin] getupdates ret=${data.ret}. Run "botmux weixin-auth" to re-authenticate.`,
          );
          this.running = false;
          break;
        }
        backoff = 1000;
        this.cursor = data.get_updates_buf;

        for (const rawMsg of (data.msgs ?? [])) {
          await this.handleMessage(rawMsg as ILinkRawMessage);
        }
      } catch (err) {
        if (!this.running) break;
        logger.warn(`[weixin] Poll error: ${err}. Retry in ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
    logger.info('[weixin] Poller stopped');
  }

  private async handleMessage(raw: ILinkRawMessage): Promise<void> {
    const userId = raw.from_user_id;

    // Always update contextToken first
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.contextToken = raw.context_token;
    } else {
      this.sessions.set(userId, { sessionKey: '', contextToken: raw.context_token });
    }

    // Skip non-text messages
    if (!isTextMessage(raw)) {
      await this.commandCtx.sendReply(userId, '暂不支持媒体消息，请发送文字。');
      return;
    }

    const imMsg = parseMessage(raw);
    if (!imMsg.content.trim()) return;

    if (isCommand(imMsg.content)) {
      await handleCommand(imMsg, this.commandCtx);
    } else if (existing?.sessionKey) {
      await this.handler.onThreadReply(imMsg, existing.sessionKey);
    } else {
      await this.handler.onNewTopic(imMsg, 'weixin', 'p2p');
    }
  }
}
