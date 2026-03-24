import * as client from './client.js';
import { downloadImage } from './client.js';
import { parseMessage, isTextMessage } from './message-parser.js';
import type { ILinkRawMessage } from './message-parser.js';
import { isCommand, handleCommand } from './command-handler.js';
import type { WeixinCommandContext } from './command-handler.js';
import type { ImEventHandler } from '../types.js';
import { logger } from '../../utils/logger.js';
import { join } from 'node:path';

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
        if (client.isAuthError(data)) {
          logger.error(
            `[weixin] getupdates error: ${data.errmsg} (code ${data.errcode}). Run "botmux weixin-auth" to re-authenticate.`,
          );
          this.running = false;
          break;
        }
        backoff = 1000;
        if (data.get_updates_buf) this.cursor = data.get_updates_buf;

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

    // Only text and image messages are supported
    if (!isTextMessage(raw) && raw.message_type !== 2) {
      await this.commandCtx.sendReply(userId, '暂不支持该类型消息，请发送文字或图片。');
      return;
    }

    const imMsg = parseMessage(raw);

    // Download images to local temp files
    if (imMsg.attachments) {
      for (const att of imMsg.attachments) {
        if (att.type === 'image' && att.path.includes('\n')) {
          const [cdnUrl, aesKey] = att.path.split('\n');
          const tmpDir = join('/tmp', 'botmux-weixin-images');
          const savePath = join(tmpDir, `${Date.now()}-${att.name}`);
          try {
            await downloadImage(cdnUrl, aesKey, savePath);
            att.path = savePath;  // Replace CDN URL with local path
          } catch (err) {
            logger.warn(`[weixin] Failed to download image: ${err}`);
            att.path = '';  // Mark as failed
          }
        }
      }
    }

    if (!imMsg.content.trim() && !imMsg.attachments?.length) return;

    if (isCommand(imMsg.content)) {
      await handleCommand(imMsg, this.commandCtx);
    } else if (existing?.sessionKey) {
      await this.handler.onThreadReply(imMsg, existing.sessionKey);
    } else {
      await this.handler.onNewTopic(imMsg, 'weixin', 'p2p');
    }
  }
}
