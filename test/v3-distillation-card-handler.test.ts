import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCardAction } from '../src/im/lark/card-handler.js';
import {
  handleV3DistillationAction,
  v3DistillationUserErrorMessage,
  type V3DistillationCardHandlerDeps,
} from '../src/im/lark/v3-distillation-card-handler.js';
import {
  V3_DISTILL_ACCEPT_ACTION,
  V3_DISTILL_REJECT_ACTION,
  type V3DistillationActionValue,
} from '../src/im/lark/v3-distillation-card.js';
import {
  generateV3WorkflowDistillationProposal,
  prepareV3WorkflowDistillation,
  type ProposedV3WorkflowDistillation,
} from '../src/workflows/v3/distillation-service.js';
import { loadProposal } from '../src/workflows/v3/distillation-store.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import { loadCurrentSavedWorkflow } from '../src/workflows/v3/library-store.js';
import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';

const CONTEXT = {
  ownerOpenId: 'ou_test_owner',
  larkAppId: 'cli_test',
  chatId: 'oc_test_chat',
};

let root: string;
let dataDir: string;
let baseDir: string;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedRun(runId = 'distill-card-source-260716-000001-abcd1234'): void {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), {
    runId,
    nodes: [{
      id: 'report',
      type: 'goal',
      goal: 'Write the weekly report for Singapore.',
      depends: [],
      inputs: [],
    }],
  });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId,
    title: 'Weekly report',
    requirement: 'Write the weekly report for Singapore.',
    nodes: [{
      sketchId: 'report',
      goal: 'Write the weekly report for Singapore.',
      input_needs: [],
      expected_outputs: ['A weekly report for Singapore.'],
      acceptance: 'The Singapore report exists.',
      risk_gate: false,
      unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    '': { larkAppId: CONTEXT.larkAppId, cliId: 'claude-code', workingDir: '/workspace' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-07-16T01:00:00.000Z',
    authorizedAt: '2026-07-16T01:01:00.000Z',
    chatBinding: {
      ...CONTEXT,
      rootMessageId: 'om_test_root',
    },
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  }));
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
  appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });
}

async function propose(requestKey: string): Promise<ProposedV3WorkflowDistillation> {
  const prepared = await prepareV3WorkflowDistillation({
    dataDir,
    baseDir,
    source: 'last',
    displayName: 'Weekly report template',
    requestKey,
    context: CONTEXT,
  });
  return generateV3WorkflowDistillationProposal({
    dataDir,
    baseDir,
    proposalId: prepared.proposalId,
    suggest: async (fields) => ({
      schemaVersion: 1,
      candidates: [{
        path: fields[0]!.path,
        literal: 'Singapore',
        occurrence: 0,
        type: 'string',
      }],
    }),
  });
}

function value(
  proposed: ProposedV3WorkflowDistillation,
  action: V3DistillationActionValue['action'],
): V3DistillationActionValue {
  return {
    action,
    proposalId: proposed.proposalId,
    nonce: proposed.nonce,
  };
}

function deps(
  resolveMessageChatId = vi.fn(async () => CONTEXT.chatId as string | null),
): V3DistillationCardHandlerDeps & { resolveMessageChatId: typeof resolveMessageChatId; onError: ReturnType<typeof vi.fn> } {
  return {
    dataDir,
    baseDir,
    resolveMessageChatId,
    onError: vi.fn(),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v3-distillation-card-handler-'));
  dataDir = join(root, 'data');
  baseDir = join(dataDir, 'v3-runs');
  mkdirSync(baseDir, { recursive: true });
  seedRun();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('v3 parameter-distillation card handler', () => {
  it('maps stable failure codes to actionable copy without reflecting raw errors', () => {
    expect(v3DistillationUserErrorMessage(
      Object.assign(new Error('provider detail must stay private'), { code: 'INVALID_MODEL_INPUT' }),
      'generate',
    )).toContain('模型凭据模式');
    expect(v3DistillationUserErrorMessage(
      Object.assign(new Error('private policy path'), { code: 'MANAGED_POLICY_UNSUPPORTED' }),
      'generate',
    )).toContain('托管策略');
    const unknown = v3DistillationUserErrorMessage(new Error('private model output'), 'generate');
    expect(unknown).toContain('未创建或修改');
    expect(unknown).not.toContain('private');
  });

  it('resolves the verified card message chat and routes reject before the generic permission gate', async () => {
    const proposed = await propose('om_distill_reject');
    const d = deps();
    const result = await handleCardAction({
      operator: { open_id: CONTEXT.ownerOpenId },
      context: { open_message_id: 'om_proposal_card' },
      action: { value: value(proposed, V3_DISTILL_REJECT_ACTION) as unknown as Record<string, string> },
    }, {
      activeSessions: new Map(),
      lastRepoScan: new Map(),
      sessionReply: async () => 'om_reply',
      v3DistillationDeps: d,
    }, CONTEXT.larkAppId) as any;

    expect(d.resolveMessageChatId).toHaveBeenCalledWith(CONTEXT.larkAppId, 'om_proposal_card');
    expect(result.header).toMatchObject({
      template: 'grey',
      title: { content: '已放弃参数化方案' },
    });
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('rejected');
  });

  it('fails closed before proposal access when verified operator, app, message, or chat is missing', async () => {
    const proposed = await propose('om_distill_missing_identity');
    const raw = value(proposed, V3_DISTILL_REJECT_ACTION);
    const d = deps();

    for (const args of [
      [undefined, CONTEXT.larkAppId, 'om_card'],
      [CONTEXT.ownerOpenId, undefined, 'om_card'],
      [CONTEXT.ownerOpenId, CONTEXT.larkAppId, undefined],
    ] as const) {
      const result = await handleV3DistillationAction(raw, args[0], args[1], args[2], d) as any;
      expect(result.toast.type).toBe('error');
    }
    expect(d.resolveMessageChatId).not.toHaveBeenCalled();

    const noChat = deps(vi.fn(async () => null));
    const result = await handleV3DistillationAction(
      raw,
      CONTEXT.ownerOpenId,
      CONTEXT.larkAppId,
      'om_card',
      noChat,
    ) as any;
    expect(result.toast.type).toBe('error');
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('proposed');
  });

  it('fails closed for the wrong operator, receiving app, or resolved chat without mutating the proposal', async () => {
    const proposed = await propose('om_distill_forged_identity');
    const raw = value(proposed, V3_DISTILL_ACCEPT_ACTION);
    const cases = [
      { operator: 'ou_other', app: CONTEXT.larkAppId, chat: CONTEXT.chatId },
      { operator: CONTEXT.ownerOpenId, app: 'cli_other', chat: CONTEXT.chatId },
      { operator: CONTEXT.ownerOpenId, app: CONTEXT.larkAppId, chat: 'oc_other' },
    ];

    for (const item of cases) {
      const d = deps(vi.fn(async () => item.chat));
      const result = await handleV3DistillationAction(
        raw,
        item.operator,
        item.app,
        'om_card',
        d,
      ) as any;
      expect(result.toast.type).toBe('warning');
      expect(d.onError).toHaveBeenCalledTimes(1);
      expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('proposed');
    }
  });

  it('accepts only after verified chat resolution and renders the committed definition card', async () => {
    const proposed = await propose('om_distill_accept');
    const d = deps();
    const result = await handleV3DistillationAction(
      value(proposed, V3_DISTILL_ACCEPT_ACTION),
      CONTEXT.ownerOpenId,
      CONTEXT.larkAppId,
      'om_proposal_card',
      d,
    ) as any;

    expect(d.resolveMessageChatId).toHaveBeenCalledWith(CONTEXT.larkAppId, 'om_proposal_card');
    expect(result.header).toMatchObject({
      template: 'green',
      title: { content: '已保存参数化 Workflow' },
    });
    const committed = loadProposal(dataDir, proposed.proposalId);
    expect(committed.state.state).toBe('committed');
    if (committed.state.state !== 'committed') throw new Error('expected committed state');
    const saved = await loadCurrentSavedWorkflow(dataDir, committed.state.result.workflowId);
    expect(saved.metadata.scope).toEqual({ kind: 'chat', chatId: CONTEXT.chatId });
    expect(saved.revision.payload.inputs).toEqual({ param_1: { type: 'string', required: true } });
  });
});
