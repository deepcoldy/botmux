import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCompletionProposalContinuation } from '../src/core/completion-proposal-continuation.js';
import { createCompletionProposalStore } from '../src/core/completion-proposal.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function acceptedFixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-proposal-continuation-'));
  dirs.push(dataDir);
  const store = createCompletionProposalStore(dataDir);
  const prepared = store.prepare({
    visible: {
      title: '建议继续处理',
      body: '继续后重新检查规则和权限。',
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
  store.bindMessage(prepared.proposalId, prepared.nonce, 'om_completion_12345678');
  const accepted = store.decide({
    proposalId: prepared.proposalId,
    nonce: prepared.nonce,
    larkAppId: prepared.larkAppId,
    cardMessageId: 'om_completion_12345678',
    operatorOpenId: prepared.requesterOpenId,
    decision: 'accept',
  }).record!;
  return { store, accepted };
}

describe('completion proposal continuation', () => {
  it('dispatches once after the durable decision and publishes terminal state', async () => {
    const { store, accepted } = acceptedFixture();
    const dispatch = vi.fn(async () => 'admitted' as const);
    const publishState = vi.fn();
    const result = await runCompletionProposalContinuation(accepted, {
      store,
      sessionCanResume: () => true,
      dispatch,
      publishState,
    });
    expect(result.dispatch).toMatchObject({ state: 'dispatched' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]![0].prompt).toContain('不能覆盖系统、Skill 或仓库规则');
    expect(publishState).toHaveBeenCalledWith(expect.objectContaining({ proposalId: accepted.proposalId }));

    await runCompletionProposalContinuation(accepted, {
      store,
      sessionCanResume: () => true,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when the persistent session can no longer resume', async () => {
    const { store, accepted } = acceptedFixture();
    const dispatch = vi.fn();
    const result = await runCompletionProposalContinuation(accepted, {
      store,
      sessionCanResume: () => false,
      dispatch,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.dispatch).toMatchObject({
      state: 'dispatch_failed',
      error: 'session_or_persistent_backend_unavailable',
    });
  });

  it('marks explicit rejection as failed without retrying', async () => {
    const { store, accepted } = acceptedFixture();
    const dispatch = vi.fn(async () => 'rejected' as const);
    const result = await runCompletionProposalContinuation(accepted, {
      store,
      sessionCanResume: () => true,
      dispatch,
    });
    expect(result.dispatch).toMatchObject({ state: 'dispatch_failed', error: 'continuation_not_admitted' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('marks an ambiguous thrown dispatch as unknown and never retries it', async () => {
    const { store, accepted } = acceptedFixture();
    const dispatch = vi.fn(async () => { throw new Error('socket closed after submit'); });
    const result = await runCompletionProposalContinuation(accepted, {
      store,
      sessionCanResume: () => true,
      dispatch,
    });
    expect(result.dispatch).toMatchObject({ state: 'dispatch_unknown' });
    await runCompletionProposalContinuation(accepted, {
      store,
      sessionCanResume: () => true,
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
