import { createHash } from 'node:crypto';
import { verifyDispatchReportBinding } from './dispatch-report-binding.js';
import { deliverPublishedReport, type ReportDeliveryResponse } from './report-publication.js';
import { buildMarkdownCard } from '../im/lark/md-card.js';

export const REPORT_SOURCE_REPLY_ROUTE = '/api/report-source-reply';
export interface ReportReplyReference { messageId: string; dispatchRoot: string }
interface SourceSession {
  sessionId: string;
  chatId?: string;
  rootMessageId?: string;
  quoteTargetId?: string;
  status: string;
  reportReplyInputId?: string;
}
interface ReplyDependencies {
  dataDir: string;
  secret: string;
  selfLarkAppId: string;
  session(id: string): SourceSession | undefined;
  publish(content: string, target: { sessionId: string; chatId: string; rootMessageId: string; uuid: string; beforeWrite(): void }): Promise<string>;
  remember(reference: ReportReplyReference, sessionId: string): Promise<void>;
}

/** 跨 daemon 的调用须先通过宿主鉴权；本层再次校验签名落点与结果来源。 */
export async function deliverReportSourceReply(raw: unknown, deps: ReplyDependencies): Promise<ReportDeliveryResponse> {
  const request = raw as Record<string, unknown> | undefined;
  if (!request || typeof request.dispatchRoot !== 'string' || typeof request.content !== 'string'
    || !request.content.trim()) return { status: 400, body: { ok: false, error: 'bad_report_reply' } };
  const binding = verifyDispatchReportBinding(deps.secret, request.dispatchRoot, request.binding);
  if (!binding?.reply || binding.targetLarkAppId !== deps.selfLarkAppId
    || binding.reply.reporterLarkAppId !== request.sourceLarkAppId) {
    return { status: 403, body: { ok: false, error: 'report_reply_unproven' } };
  }
  const content = request.content;
  const reply = binding.reply;
  const key = createHash('sha256').update(JSON.stringify([
    'source-reply', binding.dispatchRoot, binding.targetSessionId, reply.sourceTurnId, content,
  ])).digest('hex');
  const current = () => deps.session(binding.targetSessionId);
  // Live-state checks belong ONLY to the first write: beforeFirstPublication
  // runs them before the pending journal is created, and publish's beforeWrite
  // rechecks at the provider boundary. A settled receipt replay or a pending
  // outcome must never see this check — deliverPublishedReport short-circuits
  // both before validate(), and post-publish reference recovery failing must
  // surface as a non-switching error, not as "proven unsent".
  const beforeWrite = () => {
    const session = current();
    if (!session || session.chatId !== binding.targetChatId || session.rootMessageId !== reply.rootMessageId
      || session.status !== 'active' || session.quoteTargetId !== reply.sourceTurnId
      || session.reportReplyInputId !== reply.sourceTurnId) {
      const error = new Error('report_reply_source_changed');
      error.name = 'ReportReplySourceChangedError';
      throw error;
    }
  };
  try {
    const delivered = await deliverPublishedReport({
      dataDir: deps.dataDir, key, cardJson: buildMarkdownCard(content, undefined, ''),
      chatId: binding.targetChatId!, delivery: 'publish', validate: () => {},
      beforeFirstPublication: beforeWrite,
      publish: uuid => deps.publish(content, { sessionId: binding.targetSessionId,
        chatId: binding.targetChatId!, rootMessageId: reply.rootMessageId, uuid, beforeWrite }),
      relay: async () => { throw new Error('source reply must not start a model turn'); },
      syncProject: async messageId => {
        // 回执先落盘，再保存上下文引用；失败重入只恢复引用，不再发正文。
        await deps.remember({ messageId,
          dispatchRoot: binding.dispatchRoot }, binding.targetSessionId);
        return { projectSynced: false };
      },
    });
    return { status: delivered.status, body: { ...delivered.body, delivery: 'reply',
      publicationTarget: { mode: 'thread', chatId: binding.targetChatId, rootMessageId: reply.rootMessageId } } };
  } catch (error) {
    if (error instanceof Error && error.message === 'report_reply_source_changed') {
      return { status: 409, body: { ok: false, error: 'report_reply_source_changed' } };
    }
    throw error;
  }
}

export function buildReportReplyContext(references: readonly ReportReplyReference[] | undefined): string {
  if (!references?.length) return '';
  return '<delivered_project_results>\n以下委托结果已由运行层投递到本话题；不要再次发送。'
    + '后续问题需要结果正文时，用 botmux quoted 读取对应消息。\n'
    + references.map(reference => `dispatch=${reference.dispatchRoot} message=${reference.messageId}`).join('\n')
    + '\n</delivered_project_results>\n';
}

export function markReportReplyInput(session: { reportReplyInputId?: string }, inputId: string): boolean {
  if (session.reportReplyInputId === inputId) return false;
  session.reportReplyInputId = inputId;
  return true;
}

/** 直投引用随会话持久并注入后续每一轮提示；长会话需要有界，避免持久数据与提示无限增长。 */
export const MAX_REPORT_REPLY_REFERENCES = 20;
export function appendReportReplyReference(
  references: readonly ReportReplyReference[] | undefined,
  reference: ReportReplyReference,
): { references: ReportReplyReference[]; changed: boolean } {
  const current = references ?? [];
  if (current.some(item => item.messageId === reference.messageId)) {
    return { references: current.slice(), changed: false };
  }
  return { references: [...current, reference].slice(-MAX_REPORT_REPLY_REFERENCES), changed: true };
}
