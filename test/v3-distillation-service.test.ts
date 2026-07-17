import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvent } from '../src/workflows/v3/journal.js';
import { instantiatePublishedSavedWorkflow } from '../src/workflows/v3/library-service.js';
import {
  appendSavedWorkflowRevision,
  loadCurrentSavedWorkflow,
  savedWorkflowDir,
  savedWorkflowMetadataPath,
  savedWorkflowRevisionPath,
  workflowLibraryRoot,
} from '../src/workflows/v3/library-store.js';
import {
  V3DistillationServiceError,
  acceptV3WorkflowDistillation,
  generateV3WorkflowDistillationProposal,
  prepareV3WorkflowDistillation,
  rejectV3WorkflowDistillation,
} from '../src/workflows/v3/distillation-service.js';
import {
  acceptProposal,
  beginCommit,
  loadProposal,
  v3DistillationProposalDir,
} from '../src/workflows/v3/distillation-store.js';
import {
  artifactRef,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';

const CONTEXT = { ownerOpenId: 'ou_test_owner', larkAppId: 'cli_test', chatId: 'oc_test' };
const WORKFLOW_ID_DOMAIN = 'workflow-v3-distillation-definition/v1';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function seedRun(
  baseDir: string,
  runId = 'distill-source-260716-000001-abcd1234',
  goal = 'Write the weekly report for Singapore.',
): string {
  const runDir = join(baseDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, 'dag.json'), {
    runId,
    nodes: [{
      id: 'report',
      type: 'goal',
      goal,
      depends: [],
      inputs: [],
    }],
  });
  writeJson(join(runDir, 'spec.json'), {
    schemaVersion: 1,
    runId,
    title: 'Weekly report',
    requirement: goal,
    nodes: [{
      sketchId: 'report',
      goal,
      input_needs: [],
      expected_outputs: ['A weekly report for Singapore.'],
      acceptance: 'The Singapore report exists.',
      risk_gate: false,
      unknowns: [],
    }],
  });
  writeJson(join(runDir, 'bots.snapshot.json'), {
    '': { larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/workspace' },
  });
  publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
    runId,
    createdAt: '2026-07-16T01:00:00.000Z',
    authorizedAt: '2026-07-16T01:01:00.000Z',
    chatBinding: {
      ...CONTEXT,
      ownerOpenId: CONTEXT.ownerOpenId,
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
  return runDir;
}

function workflowIdForProposal(proposalId: string, proposalHash: string): string {
  return `wf_${createHash('sha256').update([WORKFLOW_ID_DOMAIN, proposalId, proposalHash].join('\0'))
    .digest('hex').slice(0, 32)}`;
}

function approvalInput(proposed: {
  proposalId: string;
  proposalHash: string;
  nonce: string;
}): {
  proposalId: string;
  proposalHash: string;
  nonce: string;
  operatorOpenId: string;
  larkAppId: string;
  chatId: string;
} {
  return {
    proposalId: proposed.proposalId,
    proposalHash: proposed.proposalHash,
    nonce: proposed.nonce,
    operatorOpenId: CONTEXT.ownerOpenId,
    larkAppId: CONTEXT.larkAppId,
    chatId: CONTEXT.chatId,
  };
}

describe('v3 parameter distillation service', () => {
  let root: string;
  let baseDir: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'v3-distillation-service-'));
    dataDir = join(root, 'data');
    baseDir = join(dataDir, 'v3-runs');
    mkdirSync(baseDir, { recursive: true });
    seedRun(baseDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps the library untouched until exact-owner approval, then commits idempotently', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Weekly report template',
      requestKey: 'om_request_1',
      context: CONTEXT,
      now: new Date('2026-07-16T02:00:00.000Z'),
    });
    expect(prepared.fields).toEqual([expect.objectContaining({
      ref: 'field-001',
      category: 'goal',
      nodeOrdinal: 1,
      text: 'Write the weekly report for Singapore.',
    })]);
    await expect(loadCurrentSavedWorkflow(dataDir, 'wf_00000000000000000000000000000000'))
      .rejects.toThrow();

    const proposed = await generateV3WorkflowDistillationProposal({
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
      now: new Date('2026-07-16T02:01:00.000Z'),
    });
    expect(proposed.compiled.safeSummary.parameters).toEqual([expect.objectContaining({
      name: 'param_1',
      required: true,
      hasDefault: false,
    })]);
    expect(existsSync(workflowLibraryRoot(dataDir))).toBe(false);

    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      proposalId: proposed.proposalId,
      proposalHash: proposed.proposalHash,
      nonce: proposed.nonce,
      operatorOpenId: CONTEXT.ownerOpenId,
      larkAppId: CONTEXT.larkAppId,
      chatId: 'oc_other',
    })).rejects.toBeInstanceOf(V3DistillationServiceError);

    const first = await acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      proposalId: proposed.proposalId,
      proposalHash: proposed.proposalHash,
      nonce: proposed.nonce,
      operatorOpenId: CONTEXT.ownerOpenId,
      larkAppId: CONTEXT.larkAppId,
      chatId: CONTEXT.chatId,
      now: new Date('2026-07-16T02:02:00.000Z'),
    });
    expect(first.created).toBe(true);
    const saved = await loadCurrentSavedWorkflow(dataDir, first.workflowId);
    expect(saved.metadata.scope).toEqual({ kind: 'chat', chatId: CONTEXT.chatId });
    expect(saved.revision.payload.inputs).toEqual({ param_1: { type: 'string', required: true } });
    expect(saved.revision.payload.dagTemplate.nodes[0]).toMatchObject({
      goal: 'Write the weekly report for ${params.param_1}.',
    });
    const materialized = await instantiatePublishedSavedWorkflow({
      dataDir,
      ref: first.workflowId,
      context: {
        actor: { openId: CONTEXT.ownerOpenId, larkAppId: CONTEXT.larkAppId },
        chatId: CONTEXT.chatId,
        chatType: 'group',
        rootMessageId: 'om_materialized_root',
      },
      rawParams: { param_1: { kind: 'string', value: 'Tokyo' } },
      bots: [{
        larkAppId: CONTEXT.larkAppId,
        larkAppSecret: 'synthetic-secret',
        cliId: 'claude-code',
        workingDir: '/synthetic/workspace',
      } as any],
      baseDir,
      runId: 'distilled-materialized-260716-000003-abcd1234',
    });
    // Saved-definition materialization deliberately preserves template markers
    // in the authorized DAG. Runtime passes only the parameters referenced by
    // each node through its private workflow-inputs artifact.
    expect(JSON.parse(readFileSync(join(materialized.runDir, 'dag.json'), 'utf8')).nodes[0].goal)
      .toBe('Write the weekly report for ${params.param_1}.');
    expect(JSON.parse(readFileSync(join(materialized.runDir, 'params.resolved.json'), 'utf8')))
      .toMatchObject({ params: { param_1: 'Tokyo' } });

    // Committed replay is library verification, not another source approval.
    rmSync(prepared.sourceRunDir, { recursive: true, force: true });

    const replay = await acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      proposalId: proposed.proposalId,
      proposalHash: proposed.proposalHash,
      nonce: proposed.nonce,
      operatorOpenId: CONTEXT.ownerOpenId,
      larkAppId: CONTEXT.larkAppId,
      chatId: CONTEXT.chatId,
    });
    expect(replay).toMatchObject({ workflowId: first.workflowId, revisionId: first.revisionId, created: false });
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('committed');
  });

  it('blocks unsafe source text and unsafe names before any model-visible fields are returned', async () => {
    seedRun(
      baseDir,
      'unsafe-distill-260716-000002-abcd1234',
      'Research Alpha with password="hunter2"',
    );
    await expect(prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'unsafe-distill-260716-000002-abcd1234',
      displayName: 'Safe display name',
      requestKey: 'om_unsafe_source',
      context: CONTEXT,
    })).rejects.toMatchObject({ code: 'SECRET_OR_IDENTITY_LITERAL' });
    await expect(prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'api.example.internal',
      requestKey: 'om_unsafe_name',
      context: CONTEXT,
    })).rejects.toMatchObject({ code: 'unsafe_display_name' });
  });

  it('keeps a committed approval replay valid after normal workflow revision evolution', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir, baseDir, source: 'last', displayName: 'Evolving template',
      requestKey: 'om_evolving', context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
      dataDir, baseDir, proposalId: prepared.proposalId,
      suggest: async (fields) => ({
        schemaVersion: 1,
        candidates: [{
          path: fields[0]!.path, literal: 'Singapore', occurrence: 0, type: 'string',
        }],
      }),
    });
    const committed = await acceptV3WorkflowDistillation({ dataDir, baseDir, ...approvalInput(proposed) });
    const current = await loadCurrentSavedWorkflow(dataDir, committed.workflowId);
    const {
      workflowId: _workflowId,
      humanVersion: _humanVersion,
      createdAt: _createdAt,
      createdBy: _createdBy,
      ...draft
    } = current.revision.payload;
    const appended = await appendSavedWorkflowRevision(dataDir, committed.workflowId, {
      actor: { openId: CONTEXT.ownerOpenId, larkAppId: CONTEXT.larkAppId },
      revision: { ...draft, sourceRunId: 'later-source-run' },
      publish: true,
    });
    expect(appended.revision.revisionId).not.toBe(committed.revisionId);

    const replay = await acceptV3WorkflowDistillation({ dataDir, baseDir, ...approvalInput(proposed) });
    expect(replay).toMatchObject({
      workflowId: committed.workflowId,
      revisionId: committed.revisionId,
      created: false,
    });
  });

  it('recovers an allocated committing state without rereading the source run', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Committing recovery template',
      requestKey: 'om_request_committing_recovery',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const accepted = acceptProposal(dataDir, proposed.proposalId, {
      proposalHash: proposed.proposalHash,
      operatorOpenId: CONTEXT.ownerOpenId,
      larkAppId: CONTEXT.larkAppId,
      chatId: CONTEXT.chatId,
      now: new Date('2026-07-16T03:00:00.000Z'),
    });
    expect(accepted.state.state).toBe('accepted');
    const workflowId = workflowIdForProposal(proposed.proposalId, proposed.proposalHash);
    beginCommit(dataDir, proposed.proposalId, {
      proposalHash: proposed.proposalHash,
      workflowId,
      createdAt: accepted.state.state === 'accepted'
        ? accepted.state.approval.acceptedAt
        : 'unreachable',
    });
    rmSync(prepared.sourceRunDir, { recursive: true, force: true });

    const recovered = await acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    });
    expect(recovered).toMatchObject({ workflowId, created: true });
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('committed');
  });

  it('recovers a library publication completed before the committing state was finalized', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Published crash recovery template',
      requestKey: 'om_request_published_crash',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const first = await acceptV3WorkflowDistillation({ dataDir, baseDir, ...approvalInput(proposed) });
    const committed = loadProposal(dataDir, proposed.proposalId);
    expect(committed.state.state).toBe('committed');
    if (committed.state.state !== 'committed') throw new Error('unreachable');
    const current = await loadCurrentSavedWorkflow(dataDir, first.workflowId);
    const {
      workflowId: _workflowId,
      humanVersion: _humanVersion,
      createdAt: _createdAt,
      createdBy: _createdBy,
      ...draft
    } = current.revision.payload;
    await appendSavedWorkflowRevision(dataDir, first.workflowId, {
      actor: { openId: CONTEXT.ownerOpenId, larkAppId: CONTEXT.larkAppId },
      revision: { ...draft, sourceRunId: 'post-publication-revision' },
      publish: true,
    });
    const { result: _result, ...committingState } = committed.state;
    writeJson(join(v3DistillationProposalDir(dataDir, proposed.proposalId), 'state.json'), {
      ...committingState,
      state: 'committing',
      updatedAt: committingState.commit.startedAt,
    });
    rmSync(prepared.sourceRunDir, { recursive: true, force: true });

    const recovered = await acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    });
    expect(recovered).toMatchObject({ workflowId: first.workflowId, created: false });
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('committed');
  });

  it('serializes concurrent accepts into one exact library publication', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Concurrent approval template',
      requestKey: 'om_request_concurrent_accept',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const results = await Promise.all([
      acceptV3WorkflowDistillation({ dataDir, baseDir, ...approvalInput(proposed) }),
      acceptV3WorkflowDistillation({ dataDir, baseDir, ...approvalInput(proposed) }),
    ]);
    expect(new Set(results.map((result) => result.workflowId)).size).toBe(1);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('committed');
  });

  it('preserves and rejects a foreign partial library directory', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Foreign partial template',
      requestKey: 'om_request_foreign_partial',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const workflowId = workflowIdForProposal(proposed.proposalId, proposed.proposalHash);
    const foreignDir = savedWorkflowDir(dataDir, workflowId);
    mkdirSync(foreignDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(foreignDir, 'foreign.txt'), 'must survive\n', { mode: 0o600 });

    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    })).rejects.toMatchObject({ code: 'commit_conflict' });
    expect(readFileSync(join(foreignDir, 'foreign.txt'), 'utf8')).toBe('must survive\n');
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('committing');
  });

  it('rejects both byte-different and semantically different committed library objects', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Exact bytes template',
      requestKey: 'om_request_exact_bytes',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const first = await acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    });
    const metadataPath = savedWorkflowMetadataPath(dataDir, first.workflowId);
    const originalBytes = readFileSync(metadataPath, 'utf8');
    const original = JSON.parse(originalBytes) as Record<string, unknown>;

    writeFileSync(metadataPath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    })).rejects.toMatchObject({ code: 'commit_conflict' });

    writeFileSync(metadataPath, originalBytes, 'utf8');
    writeFileSync(metadataPath, `${JSON.stringify({ ...original, displayName: 'Changed name' })}\n`, 'utf8');
    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    })).rejects.toMatchObject({ code: 'commit_conflict' });
  });

  it('rejects an origin revision whose private file topology was weakened', async () => {
    if (process.platform === 'win32') return;
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Private origin template',
      requestKey: 'om_request_private_origin',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const first = await acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    });
    chmodSync(savedWorkflowRevisionPath(dataDir, first.workflowId, first.revisionId), 0o644);
    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    })).rejects.toMatchObject({ code: 'commit_conflict' });
  });

  it('rejects committed proposal state that disagrees with exact library bytes', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'State mismatch template',
      requestKey: 'om_request_state_mismatch',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    await acceptV3WorkflowDistillation({ dataDir, baseDir, ...approvalInput(proposed) });
    const statePath = join(v3DistillationProposalDir(dataDir, proposed.proposalId), 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      result: { revisionContentHash?: string };
    };
    state.result.revisionContentHash = `sha256:${'0'.repeat(64)}`;
    writeJson(statePath, state);

    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      ...approvalInput(proposed),
    })).rejects.toMatchObject({ code: 'commit_conflict' });
  });

  it('rejects without creating a Saved Workflow', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Another template',
      requestKey: 'om_request_2',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    const rejected = rejectV3WorkflowDistillation({
      dataDir,
      proposalId: proposed.proposalId,
      proposalHash: proposed.proposalHash,
      nonce: proposed.nonce,
      operatorOpenId: CONTEXT.ownerOpenId,
      larkAppId: CONTEXT.larkAppId,
      chatId: CONTEXT.chatId,
    });
    expect(rejected.state.state).toBe('rejected');
    expect(() => loadProposal(dataDir, proposed.proposalId)).not.toThrow();
  });

  it('revalidates source bytes at approval and never publishes a changed run', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Pinned source template',
      requestKey: 'om_request_changed_source',
      context: CONTEXT,
    });
    const proposed = await generateV3WorkflowDistillationProposal({
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
    writeFileSync(join(prepared.sourceRunDir, 'spec.json'), '{"tampered":true}\n', 'utf8');
    await expect(acceptV3WorkflowDistillation({
      dataDir,
      baseDir,
      proposalId: proposed.proposalId,
      proposalHash: proposed.proposalHash,
      nonce: proposed.nonce,
      operatorOpenId: CONTEXT.ownerOpenId,
      larkAppId: CONTEXT.larkAppId,
      chatId: CONTEXT.chatId,
    })).rejects.toBeDefined();
    expect(loadProposal(dataDir, proposed.proposalId).state.state).toBe('proposed');
    expect(existsSync(workflowLibraryRoot(dataDir))).toBe(false);
  });

  it('recovers proposal publication without asking the model to regenerate', async () => {
    const prepared = await prepareV3WorkflowDistillation({
      dataDir,
      baseDir,
      source: 'last',
      displayName: 'Crash recovery template',
      requestKey: 'om_request_publish_crash',
      context: CONTEXT,
    });
    const first = await generateV3WorkflowDistillationProposal({
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
    const loaded = loadProposal(dataDir, first.proposalId);
    writeJson(join(v3DistillationProposalDir(dataDir, first.proposalId), 'state.json'), {
      schemaVersion: 1,
      proposalId: first.proposalId,
      liveKey: loaded.prepared.liveKey,
      state: 'prepared',
      preparedAt: loaded.state.preparedAt,
      updatedAt: loaded.state.preparedAt,
    });
    const suggest = async (): Promise<never> => { throw new Error('must not regenerate'); };
    const recovered = await generateV3WorkflowDistillationProposal({
      dataDir,
      baseDir,
      proposalId: first.proposalId,
      suggest,
    });
    expect(recovered.proposalHash).toBe(first.proposalHash);
    expect(loadProposal(dataDir, first.proposalId).state.state).toBe('proposed');
  });
});
