import { getQuotedMessageDetail, renderQuotedMessage, type ExpandMergeForwardFn, type ResolveMergedCardFn, type RenderedQuotedMessage } from './quoted-render.js';
import { mapHistoryReads } from './history-read.js';
import { withMessageReadContext } from '../im/lark/message-read-context.js';
import type { MessageResource } from '../im/lark/message-parser.js';
import type { LarkAttachment } from '../types.js';

interface QuotedReadOptions {
  messageIds: string[];
  batch: boolean;
  raw: boolean;
  download: boolean;
  /** Remote session tools may only read messages in their current chat. */
  currentChatId?: string;
}

export type QuotedReadMessage = RenderedQuotedMessage & {
  attachments?: LarkAttachment[];
  needLogin?: boolean;
  cardJson?: unknown;
  rawContent?: string;
  attachmentDownloadSkipped?: boolean;
};

export async function readQuotedMessages(
  appId: string,
  options: QuotedReadOptions,
  deps: {
    getMessageDetail: Parameters<typeof getQuotedMessageDetail>[2];
    expandMergeForward: ExpandMergeForwardFn;
    resolveMergedCard: ResolveMergedCardFn;
    downloadResources: (appId: string, messageId: string, resources: MessageResource[]) => Promise<{ attachments: LarkAttachment[]; needLogin?: boolean }>;
    decorate: (message: QuotedReadMessage) => Promise<unknown>;
  },
) {
  return withMessageReadContext(async () => {
    const results = await mapHistoryReads(options.messageIds, async messageId => {
      try {
        const detail = await getQuotedMessageDetail(appId, messageId, deps.getMessageDetail);
        const rawMessage = detail?.items?.[0];
        if (!rawMessage) throw new Error(`未找到消息 ${messageId}`);
        if (options.currentChatId !== undefined && rawMessage.chat_id !== options.currentChatId) {
          throw Object.assign(new Error('botmux quoted refused: message is outside the current session chat'), { exitCode: 2 });
        }
        const message: QuotedReadMessage = await renderQuotedMessage(appId, rawMessage, deps.expandMergeForward, deps.resolveMergedCard, detail);
        if (options.raw) {
          if (message.mergedStructuredContent !== undefined) {
            try { message.cardJson = JSON.parse(message.mergedStructuredContent); }
            catch { message.cardJson = message.mergedStructuredContent; }
          } else message.rawContent = rawMessage.body?.content ?? '';
        }
        delete message.mergedStructuredContent;
        if (message.resources.length) {
          if (options.download) {
            const downloaded = await deps.downloadResources(appId, messageId, message.resources);
            message.attachments = downloaded.attachments;
            if (downloaded.needLogin) message.needLogin = true;
          } else message.attachmentDownloadSkipped = true;
        }
        return { messageId, message: await deps.decorate(message) };
      } catch (error: any) {
        if (!options.batch) throw error;
        return { messageId, error: error.message ?? 'Message read failed' };
      }
    });
    return {
      messages: results.filter(result => result.error === undefined).map(result => result.message),
      errors: results.filter(result => result.error !== undefined).map(result => ({ messageId: result.messageId, error: result.error! })),
    };
  });
}
