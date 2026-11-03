import {
  COMPLETION_PROPOSAL_ACTION,
  type CompletionProposalDecision,
  type CompletionProposalRecord,
  type CompletionProposalStore,
} from '../../core/completion-proposal.js';
import { FINAL_CARD_PROPOSAL_ELEMENT_ID } from './final-card-sections.js';
import { escapeLarkMd } from './issue-card.js';
import type { CardActionData } from './card-handler.js';

function decisionButton(
  label: string,
  style: 'primary' | 'default',
  decision: CompletionProposalDecision,
  record: CompletionProposalRecord,
): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type: style,
    behaviors: [{
      type: 'callback',
      value: {
        action: COMPLETION_PROPOSAL_ACTION,
        proposal_id: record.proposalId,
        nonce: record.nonce,
        decision,
      },
    }],
  };
}

function settledCopy(record: CompletionProposalRecord): string | undefined {
  if (record.status === 'dismissed') return `已选择：**${escapeLarkMd(record.visible.dismissLabel)}**`;
  if (record.status === 'expired') return '该后续动作已过期；如仍需要，请直接在话题中提出。';
  if (record.status !== 'accepted') return undefined;
  const state = record.dispatch?.state;
  if (state === 'dispatched') return `已选择：**${escapeLarkMd(record.visible.acceptLabel)}**，新的处理任务已启动。`;
  if (state === 'dispatch_failed') return `已记录选择，但新任务未能启动；请直接在话题中回复“${escapeLarkMd(record.visible.acceptLabel)}”。`;
  if (state === 'dispatch_unknown') return '已记录选择，但无法确认新任务是否启动；为避免重复执行，不会自动重试。请在话题中确认后再继续。';
  return `已选择：**${escapeLarkMd(record.visible.acceptLabel)}**，正在启动新的处理任务…`;
}

export function buildCompletionProposalElement(record: CompletionProposalRecord): Record<string, unknown> {
  const settled = settledCopy(record);
  return {
    tag: 'column_set',
    element_id: FINAL_CARD_PROPOSAL_ELEMENT_ID,
    flex_mode: 'none',
    background_style: 'grey-50',
    columns: [{
      tag: 'column',
      width: 'weighted',
      weight: 1,
      padding: '10px',
      elements: [{
        tag: 'markdown',
        content: settled
          ? `<text_tag color='grey'>可选后续</text_tag> ${settled}`
          : `<text_tag color='blue'>可选后续</text_tag> **${escapeLarkMd(record.visible.title)}**\n${escapeLarkMd(record.visible.body)}`,
      }],
    }, ...(settled ? [] : [{
      tag: 'column',
      width: 'auto',
      vertical_align: 'center',
      elements: [{
        tag: 'column_set',
        flex_mode: 'none',
        columns: [
          { tag: 'column', width: 'auto', elements: [decisionButton(record.visible.acceptLabel, 'primary', 'accept', record)] },
          { tag: 'column', width: 'auto', elements: [decisionButton(record.visible.dismissLabel, 'default', 'dismiss', record)] },
        ],
      }],
    }])],
  };
}

export function renderCompletionProposalCard(
  baseCard: Record<string, any>,
  record: CompletionProposalRecord,
): Record<string, unknown> {
  const card = structuredClone(baseCard);
  const elements = Array.isArray(card.body?.elements) ? card.body.elements : [];
  const index = elements.findIndex((element: unknown) =>
    !!element && typeof element === 'object'
    && (element as Record<string, unknown>).element_id === FINAL_CARD_PROPOSAL_ELEMENT_ID);
  if (index >= 0) elements.splice(index, 1, buildCompletionProposalElement(record));
  card.body = { ...(card.body ?? {}), elements };
  return card;
}

export function isCompletionProposalAction(value: unknown): boolean {
  return value === COMPLETION_PROPOSAL_ACTION;
}

function parseAction(data: CardActionData): {
  proposalId: string;
  nonce: string;
  decision: CompletionProposalDecision;
} | undefined {
  const value = data.action?.value;
  if (value?.action !== COMPLETION_PROPOSAL_ACTION) return undefined;
  if (typeof value.proposal_id !== 'string' || typeof value.nonce !== 'string') return undefined;
  if (value.decision !== 'accept' && value.decision !== 'dismiss') return undefined;
  return { proposalId: value.proposal_id, nonce: value.nonce, decision: value.decision };
}

export interface CompletionProposalCardHandlerDeps {
  store: CompletionProposalStore;
  loadBaseCard(messageId: string, larkAppId: string): Promise<Record<string, unknown> | undefined>;
  startContinuation(record: CompletionProposalRecord): void | Promise<void>;
}

export async function handleCompletionProposalAction(
  data: CardActionData,
  larkAppId: string,
  deps: CompletionProposalCardHandlerDeps,
): Promise<Record<string, unknown>> {
  const parsed = parseAction(data);
  const operatorOpenId = data.operator?.open_id;
  const cardMessageId = data.context?.open_message_id ?? data.open_message_id;
  if (!parsed || !operatorOpenId || !cardMessageId) {
    return { toast: { type: 'warning', content: '该后续动作已失效，请直接在话题中继续。' } };
  }
  let decision;
  try {
    decision = deps.store.decide({
      ...parsed,
      larkAppId,
      cardMessageId,
      operatorOpenId,
    });
  } catch {
    return { toast: { type: 'warning', content: '后续动作正在处理中，请稍后重试。' } };
  }
  if (decision.outcome === 'unauthorized') {
    return { toast: { type: 'error', content: '仅本次任务请求者可决定该后续动作。' } };
  }
  if (decision.outcome === 'stale') {
    return { toast: { type: 'warning', content: '该后续动作已失效，请直接在话题中继续。' } };
  }
  const record = decision.record;
  if (!record) return { toast: { type: 'warning', content: '该后续动作已失效。' } };
  const afterAck = decision.outcome === 'accepted'
    ? { afterAck: () => deps.startContinuation(record) }
    : {};
  let baseCard: Record<string, unknown> | undefined;
  try { baseCard = await deps.loadBaseCard(cardMessageId, larkAppId); }
  catch { /* decision is durable; card refresh must not block continuation */ }
  if (!baseCard) {
    return {
      toast: {
        type: decision.outcome === 'accepted' ? 'success' : 'warning',
        content: decision.outcome === 'accepted'
          ? '已记录选择，正在启动新的处理任务。'
          : '已记录选择，但无法刷新原完成卡。',
      },
      ...afterAck,
    };
  }
  const card = renderCompletionProposalCard(baseCard, record);
  return {
    deferredCard: { type: 'raw', data: card },
    ...afterAck,
  };
}
