import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCompletionProposalStore } from '../src/core/completion-proposal.js';
import {
  buildCompletionProposalElement,
  handleCompletionProposalAction,
  renderCompletionProposalCard,
} from '../src/im/lark/completion-proposal-card.js';
import { buildCanonicalFinalReplyCard } from '../src/im/lark/md-card.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-completion-card-'));
  dirs.push(dataDir);
  const store = createCompletionProposalStore(dataDir);
  const prepared = store.prepare({
    visible: {
      title: '建议继续处理',
      body: '已确认一个可复用结论；继续后会重新检查权限。',
      acceptLabel: '继续处理',
      dismissLabel: '本次跳过',
    },
    larkAppId: 'cli_app',
    sessionId: 'session_1',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    anchor: 'om_root_12345678',
    originTurnId: 'om_turn_12345678',
    requesterOpenId: 'ou_requester_12345678',
  });
  const record = store.bindMessage(prepared.proposalId, prepared.nonce, 'om_completion_12345678');
  const policy = normalizeFeedbackPolicy({ enabled: true });
  const baseCard = JSON.parse(buildCanonicalFinalReplyCard({
    markdown: '任务结果',
    completionProposal: record,
    feedback: { policy },
    brand: 'botmux',
  }));
  return { store, record, baseCard };
}

describe('completion proposal final-card section', () => {
  it('renders result, proposal, feedback, separator and footer in one canonical order', () => {
    const { baseCard } = setup();
    const elements = baseCard.body.elements;
    const proposal = elements.findIndex((item: any) => item.element_id === 'botmux_completion_proposal');
    const feedback = elements.findIndex((item: any) => item.element_id === 'botmux_feedback');
    const separator = elements.findIndex((item: any) => item.tag === 'hr');
    const footer = elements.findIndex((item: any) => item.element_id === 'botmux_reply_footer');
    expect(proposal).toBeGreaterThan(0);
    expect(feedback).toBeGreaterThan(proposal);
    expect(separator).toBeGreaterThan(feedback);
    expect(footer).toBeGreaterThan(separator);
  });

  it('preserves every non-proposal element while updating its status', () => {
    const { record, baseCard } = setup();
    const next = {
      ...record,
      status: 'dismissed' as const,
      decision: { value: 'dismiss' as const, by: record.requesterOpenId, decidedAt: Date.now() },
    };
    const rendered = renderCompletionProposalCard(baseCard, next) as any;
    expect(JSON.stringify(rendered)).toContain('已选择');
    expect(JSON.stringify(rendered)).toContain('本次跳过');
    expect(JSON.stringify(rendered)).toContain('任务结果');
    expect(JSON.stringify(rendered)).toContain('botmux_feedback');
    expect(JSON.stringify(rendered)).toContain('botmux_reply_footer');
    expect(JSON.stringify(rendered)).not.toContain('completion_proposal_decide');
  });

  it('uses exact requester authorization and starts at most one continuation', async () => {
    const { store, record, baseCard } = setup();
    const startContinuation = vi.fn();
    const deps = {
      store,
      loadBaseCard: vi.fn(async () => baseCard),
      startContinuation,
    };
    const action = (operatorOpenId: string, decision: 'accept' | 'dismiss') => ({
      operator: { open_id: operatorOpenId },
      context: { open_message_id: record.cardMessageId },
      action: { value: {
        action: 'completion_proposal_decide',
        proposal_id: record.proposalId,
        nonce: record.nonce,
        decision,
      } },
    }) as any;

    const denied = await handleCompletionProposalAction(action('ou_other_12345678', 'accept'), 'cli_app', deps);
    expect(denied).toMatchObject({ toast: { type: 'error' } });
    expect(startContinuation).not.toHaveBeenCalled();

    const accepted = await handleCompletionProposalAction(action(record.requesterOpenId, 'accept'), 'cli_app', deps) as any;
    expect(accepted.deferredCard).toMatchObject({ type: 'raw' });
    expect(accepted.afterAck).toEqual(expect.any(Function));
    await accepted.afterAck();
    expect(startContinuation).toHaveBeenCalledTimes(1);

    const replay = await handleCompletionProposalAction(action(record.requesterOpenId, 'dismiss'), 'cli_app', deps) as any;
    expect(replay.afterAck).toBeUndefined();
    expect(startContinuation).toHaveBeenCalledTimes(1);
  });

  it('still starts an accepted continuation when the live card cannot be loaded', async () => {
    const { store, record } = setup();
    const startContinuation = vi.fn();
    const result = await handleCompletionProposalAction({
      operator: { open_id: record.requesterOpenId },
      context: { open_message_id: record.cardMessageId },
      action: { value: {
        action: 'completion_proposal_decide',
        proposal_id: record.proposalId,
        nonce: record.nonce,
        decision: 'accept',
      } },
    } as any, 'cli_app', {
      store,
      loadBaseCard: vi.fn(async () => { throw new Error('HTTP 500 lark rate limited'); }),
      startContinuation,
    }) as any;

    expect(result.toast).toMatchObject({ type: 'success' });
    expect(result.afterAck).toEqual(expect.any(Function));
    await result.afterAck();
    expect(startContinuation).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary punctuation and escapes ampersands in visible copy', () => {
    const { record } = setup();
    const element = buildCompletionProposalElement({
      ...record,
      visible: {
        ...record.visible,
        title: '已确认 3-5 个结论 (第 2 节)',
        body: 'A & B 可以继续。',
      },
    });
    const json = JSON.stringify(element);
    expect(json).toContain('已确认 3-5 个结论 (第 2 节)');
    expect(json).toContain('A &amp; B 可以继续。');
    expect(json).not.toContain('3\\\\-5');
  });

  it('keeps callback payload limited to the reserved action, proposal id, nonce and decision', () => {
    const { record } = setup();
    const json = JSON.stringify(buildCompletionProposalElement(record));
    expect(json).toContain('completion_proposal_decide');
    expect(json).not.toContain('prompt');
    expect(json).not.toContain('workingDir');
  });
});
