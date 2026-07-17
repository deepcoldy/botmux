import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  V3DistillationStoreError,
  acceptProposal,
  beginCommit,
  loadProposal,
  listActiveV3DistillationProposals,
  markCommitted,
  prepareProposal,
  publishProposal,
  rejectProposal,
  v3DistillationProposalDir,
  v3DistillationStoreRoot,
  type PrepareV3DistillationProposalInput,
} from '../src/workflows/v3/distillation-store.js';
import {
  V3_DISTILLATION_COMPILER_VERSION,
  type V3DistillationCompiledBodyV1,
} from '../src/workflows/v3/distillation-schema.js';
import { computeSavedWorkflowGateDigest } from '../src/workflows/v3/library-schema.js';

const SHA_A = `sha256:${'a'.repeat(64)}`;
const SHA_B = `sha256:${'b'.repeat(64)}`;
const SHA_C = `sha256:${'c'.repeat(64)}`;
const SHA_D = `sha256:${'d'.repeat(64)}`;
const SHA_E = `sha256:${'e'.repeat(64)}`;
const SHA_F = `sha256:${'f'.repeat(64)}`;
const WORKFLOW_ID = `wf_${'1'.repeat(32)}`;
const REVISION_ID = `rev_${'2'.repeat(64)}`;
const REVISION_HASH = `sha256:${'3'.repeat(64)}`;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-v3-distill-store-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function prepareInput(requestKey = 'om_request_1'): PrepareV3DistillationProposalInput {
  return {
    requestKey,
    compilerVersion: V3_DISTILLATION_COMPILER_VERSION,
    displayName: 'Weekly research',
    replyTarget: { kind: 'thread', rootMessageId: requestKey },
    sourceIdentity: {
      runId: 'research-260716-120000-abcd1234',
      runEnvelopeSha256: SHA_A,
      dagSha256: SHA_B,
      specSha256: SHA_C,
      botSnapshotsSha256: SHA_D,
      baselineRevisionSha256: SHA_E,
      ownerOpenId: 'ou_owner',
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
    },
    now: new Date('2026-07-16T01:00:00.000Z'),
  };
}

function compiledBody(): V3DistillationCompiledBodyV1 {
  const dagTemplate = {
    nodes: [{
      id: 'research',
      type: 'goal' as const,
      goal: 'Research ${params.topic}',
      bot: 'cli_research',
      depends: [],
      inputs: [],
      humanGate: null,
    }],
  };
  return {
    schemaVersion: 1,
    compilerVersion: V3_DISTILLATION_COMPILER_VERSION,
    baselineRevisionSha256: SHA_E,
    revisionDraft: {
      sourceRunId: 'research-260716-120000-abcd1234',
      inputs: { topic: { type: 'string', required: true } },
      contextRefs: [],
      specTemplate: {
        schemaVersion: 1,
        title: 'Research report',
        requirement: 'Research ${params.topic}',
        nodes: [{
          sketchId: 'research',
          goal: 'Research ${params.topic}',
          input_needs: [],
          expected_outputs: ['report'],
          acceptance: 'complete',
          risk_gate: false,
          unknowns: [],
        }],
      },
      specStatus: 'current',
      dagTemplate,
      safety: {
        gateDigest: computeSavedWorkflowGateDigest(dagTemplate),
        sideEffects: [],
      },
    },
    replacements: [
      {
        path: '/dagTemplate/nodes/0/goal',
        startUtf8: 9,
        endUtf8: 16,
        literalSha256: SHA_F,
        replacement: '${params.topic}',
        paramName: 'topic',
        fieldCategory: 'goal',
      },
      {
        path: '/specTemplate/requirement',
        startUtf8: 9,
        endUtf8: 16,
        literalSha256: SHA_F,
        replacement: '${params.topic}',
        paramName: 'topic',
        fieldCategory: 'spec',
      },
    ],
    safeSummary: {
      parameters: [{
        name: 'topic',
        type: 'string',
        required: true,
        hasDefault: false,
        replacementCount: 2,
        fields: [{ nodeOrdinal: 1, field: 'goal' }],
      }],
      roundTripVerified: true,
      structuralFieldsUnchanged: true,
    },
  };
}

function prepareAndPublish(requestKey = 'om_request_1') {
  const prepared = prepareProposal(dataDir, prepareInput(requestKey));
  const proposed = publishProposal(dataDir, prepared.prepared.proposalId, {
    compiled: compiledBody(),
    now: new Date('2026-07-16T01:01:00.000Z'),
  });
  return proposed;
}

function actor(proposalHash: string) {
  return {
    proposalHash,
    operatorOpenId: 'ou_owner',
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    now: new Date('2026-07-16T01:02:00.000Z'),
  };
}

function expectStoreCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected store operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(V3DistillationStoreError);
    expect((error as V3DistillationStoreError).code).toBe(code);
  }
}

describe('v3 distillation proposal store', () => {
  it('persists immutable bodies separately from lock-protected lifecycle state', () => {
    const proposed = prepareAndPublish();
    const proposalId = proposed.prepared.proposalId;
    const proposalDir = v3DistillationProposalDir(dataDir, proposalId);
    const proposalBytes = readFileSync(join(proposalDir, 'proposal.json'), 'utf-8');
    const preparedBytes = readFileSync(join(proposalDir, 'prepared.json'), 'utf-8');
    expect(proposed.prepared.replyTarget).toEqual({
      kind: 'thread',
      rootMessageId: 'om_request_1',
    });

    const accepted = acceptProposal(dataDir, proposalId, actor(proposed.proposal!.proposalHash));
    expect(accepted.state.state).toBe('accepted');
    const committing = beginCommit(dataDir, proposalId, {
      proposalHash: proposed.proposal!.proposalHash,
      workflowId: WORKFLOW_ID,
      createdAt: '2026-07-16T01:03:00.000Z',
      now: new Date('2026-07-16T01:03:00.000Z'),
    });
    expect(committing.state.state).toBe('committing');
    const committed = markCommitted(dataDir, proposalId, {
      proposalHash: proposed.proposal!.proposalHash,
      workflowId: WORKFLOW_ID,
      revisionId: REVISION_ID,
      revisionContentHash: REVISION_HASH,
      now: new Date('2026-07-16T01:04:00.000Z'),
    });
    expect(committed.state).toMatchObject({
      state: 'committed',
      commit: { workflowId: WORKFLOW_ID, createdAt: '2026-07-16T01:03:00.000Z' },
      result: { workflowId: WORKFLOW_ID, revisionId: REVISION_ID },
    });
    expect(readFileSync(join(proposalDir, 'proposal.json'), 'utf-8')).toBe(proposalBytes);
    expect(readFileSync(join(proposalDir, 'prepared.json'), 'utf-8')).toBe(preparedBytes);
  });

  it('inventories only active prepared/proposed allocations for cold recovery', () => {
    const proposed = prepareAndPublish('om_active');
    const active = listActiveV3DistillationProposals(dataDir);
    expect(active.map((item) => item.prepared.proposalId)).toEqual([proposed.prepared.proposalId]);
    rejectProposal(dataDir, proposed.prepared.proposalId, actor(proposed.proposal!.proposalHash));
    const replacement = prepareProposal(dataDir, prepareInput('om_replacement'));
    expect(listActiveV3DistillationProposals(dataDir).map((item) => item.prepared.proposalId))
      .toEqual([replacement.prepared.proposalId]);
  });

  it('makes every same transition idempotent and rejects conflicting replays', () => {
    const proposed = prepareAndPublish();
    const id = proposed.prepared.proposalId;
    const hash = proposed.proposal!.proposalHash;
    expect(publishProposal(dataDir, id, { compiled: compiledBody() }).state.state).toBe('proposed');

    const accepted = acceptProposal(dataDir, id, actor(hash));
    expect(acceptProposal(dataDir, id, actor(hash)).state).toEqual(accepted.state);
    const commitInput = {
      proposalHash: hash,
      workflowId: WORKFLOW_ID,
      createdAt: '2026-07-16T01:03:00.000Z',
      now: new Date('2026-07-16T01:03:00.000Z'),
    };
    const committing = beginCommit(dataDir, id, commitInput);
    expect(beginCommit(dataDir, id, commitInput).state).toEqual(committing.state);
    const resultInput = {
      proposalHash: hash,
      workflowId: WORKFLOW_ID,
      revisionId: REVISION_ID,
      revisionContentHash: REVISION_HASH,
      now: new Date('2026-07-16T01:04:00.000Z'),
    };
    const committed = markCommitted(dataDir, id, resultInput);
    expect(markCommitted(dataDir, id, resultInput).state).toEqual(committed.state);

    expectStoreCode(() => beginCommit(dataDir, id, {
      ...commitInput,
      workflowId: `wf_${'9'.repeat(32)}`,
    }), 'CONTENT_CONFLICT');
    expectStoreCode(() => rejectProposal(dataDir, id, actor(hash)), 'STATE_CONFLICT');
  });

  it('recovers a crash after immutable proposal publication but before the state transition', () => {
    const proposed = prepareAndPublish();
    const id = proposed.prepared.proposalId;
    const path = join(v3DistillationProposalDir(dataDir, id), 'state.json');
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      proposalId: id,
      liveKey: proposed.prepared.liveKey,
      state: 'prepared',
      preparedAt: proposed.state.preparedAt,
      updatedAt: proposed.state.preparedAt,
    })}\n`, { mode: 0o600 });

    const crashWindow = loadProposal(dataDir, id);
    expect(crashWindow.state.state).toBe('prepared');
    expect(crashWindow.proposal?.proposalHash).toBe(proposed.proposal?.proposalHash);
    const recovered = publishProposal(dataDir, id, {
      compiled: compiledBody(),
      now: new Date('2026-07-16T01:05:00.000Z'),
    });
    expect(recovered.state).toMatchObject({
      state: 'proposed',
      proposalHash: proposed.proposal?.proposalHash,
    });
  });

  it.runIf(process.platform !== 'win32')('recovers the writer-owned hard-link publication crash window', () => {
    const proposed = prepareAndPublish();
    const dir = v3DistillationProposalDir(dataDir, proposed.prepared.proposalId);
    const target = join(dir, 'proposal.json');
    const temp = join(dir, `.proposal.json.${process.pid}.0123456789abcdef.tmp`);
    linkSync(target, temp);
    expect(lstatSync(target).nlink).toBe(2);

    const loaded = loadProposal(dataDir, proposed.prepared.proposalId);
    expect(loaded.proposal?.proposalHash).toBe(proposed.proposal?.proposalHash);
    expect(lstatSync(target).nlink).toBe(1);
    expect(() => lstatSync(temp)).toThrow();
  });

  it('reuses an exact request and supersedes only a proposed older request', () => {
    const first = prepareAndPublish('om_request_1');
    const exact = prepareProposal(dataDir, {
      ...prepareInput('om_request_1'),
      // Wall-clock time is mutable state, not part of the content-addressed
      // per-event allocation.
      now: new Date('2026-07-16T09:00:00.000Z'),
    });
    expect(exact.prepared.proposalId).toBe(first.prepared.proposalId);
    expect(exact.state.state).toBe('proposed');

    expectStoreCode(() => prepareProposal(dataDir, {
      ...prepareInput('om_request_1'),
      displayName: 'Conflicting replay',
    }), 'CONTENT_CONFLICT');

    const second = prepareProposal(dataDir, {
      ...prepareInput('om_request_2'),
      displayName: 'Monthly research',
      now: new Date('2026-07-16T02:00:00.000Z'),
    });
    expect(second.prepared.proposalId).not.toBe(first.prepared.proposalId);
    expect(second.state.state).toBe('prepared');
    expect(loadProposal(dataDir, first.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: second.prepared.proposalId,
    });
    expectStoreCode(() => acceptProposal(
      dataDir,
      first.prepared.proposalId,
      actor(first.proposal!.proposalHash),
    ), 'STATE_CONFLICT');
  });

  it('rejects a delayed old request without disturbing the current proposal', () => {
    const firstInput = prepareInput('om_request_old');
    const first = prepareAndPublish('om_request_old');
    const second = prepareProposal(dataDir, {
      ...prepareInput('om_request_new'),
      displayName: 'Replacement research',
      now: new Date('2026-07-16T02:00:00.000Z'),
    });
    const secondProposed = publishProposal(dataDir, second.prepared.proposalId, {
      compiled: compiledBody(),
      now: new Date('2026-07-16T02:01:00.000Z'),
    });

    expectStoreCode(() => prepareProposal(dataDir, {
      ...firstInput,
      now: new Date('2026-07-16T03:00:00.000Z'),
    }), 'STALE_PROPOSAL');

    expect(loadProposal(dataDir, first.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: second.prepared.proposalId,
    });
    expect(loadProposal(dataDir, second.prepared.proposalId).state).toEqual(secondProposed.state);
  });

  it('recovers a durable replacing intent after a crash during supersession', () => {
    const first = prepareAndPublish('om_request_old');
    const firstProposedState = first.state;
    const replacementInput = {
      ...prepareInput('om_request_new'),
      displayName: 'Replacement research',
      now: new Date('2026-07-16T02:00:00.000Z'),
    };
    const second = prepareProposal(dataDir, replacementInput);

    // Recreate the only two-file crash window: the global index says a
    // replacement is in progress, while the old proposal has not yet recorded
    // its terminal superseded state. The new immutable allocation already
    // exists and must be adopted, not regenerated.
    writeFileSync(
      join(v3DistillationStoreRoot(dataDir), 'identity-index.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          [first.prepared.liveKey]: {
            state: 'replacing',
            proposalId: second.prepared.proposalId,
            prepared: second.prepared,
            preparedAt: second.state.preparedAt,
            previousProposalId: first.prepared.proposalId,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(v3DistillationProposalDir(dataDir, first.prepared.proposalId), 'state.json'),
      `${JSON.stringify(firstProposedState)}\n`,
      { mode: 0o600 },
    );

    const recovered = prepareProposal(dataDir, {
      ...replacementInput,
      now: new Date('2026-07-16T08:00:00.000Z'),
    });
    expect(recovered.prepared.proposalId).toBe(second.prepared.proposalId);
    expect(recovered.state.state).toBe('prepared');
    expect(loadProposal(dataDir, first.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: second.prepared.proposalId,
    });
  });

  it('finishes a durable replacement before accepting a different later request', () => {
    const first = prepareAndPublish('om_request_old');
    const replacementInput = {
      ...prepareInput('om_request_replacement'),
      displayName: 'Replacement research',
      now: new Date('2026-07-16T02:00:00.000Z'),
    };
    const second = prepareProposal(dataDir, replacementInput);

    writeFileSync(
      join(v3DistillationStoreRoot(dataDir), 'identity-index.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          [first.prepared.liveKey]: {
            state: 'replacing',
            proposalId: second.prepared.proposalId,
            prepared: second.prepared,
            preparedAt: second.state.preparedAt,
            previousProposalId: first.prepared.proposalId,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(v3DistillationProposalDir(dataDir, first.prepared.proposalId), 'state.json'),
      `${JSON.stringify(first.state)}\n`,
      { mode: 0o600 },
    );

    const third = prepareProposal(dataDir, {
      ...prepareInput('om_request_later'),
      displayName: 'Later research',
      now: new Date('2026-07-16T03:00:00.000Z'),
    });
    expect(third.prepared.proposalId).not.toBe(second.prepared.proposalId);
    expect(third.prepared.displayName).toBe('Later research');
    expect(loadProposal(dataDir, first.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: second.prepared.proposalId,
    });
  });

  it('recovers a replacing allocation before handling a later request', () => {
    const first = prepareAndPublish('om_request_old');
    const replacementInput = {
      ...prepareInput('om_request_replacement'),
      displayName: 'Replacement research',
      now: new Date('2026-07-16T02:00:00.000Z'),
    };
    const second = prepareProposal(dataDir, replacementInput);
    rmSync(v3DistillationProposalDir(dataDir, second.prepared.proposalId), {
      recursive: true,
      force: true,
    });
    writeFileSync(
      join(v3DistillationStoreRoot(dataDir), 'identity-index.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          [first.prepared.liveKey]: {
            state: 'replacing',
            proposalId: second.prepared.proposalId,
            prepared: second.prepared,
            preparedAt: second.state.preparedAt,
            previousProposalId: first.prepared.proposalId,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );

    const recovered = prepareProposal(dataDir, {
      ...prepareInput('om_request_after_crash'),
      displayName: 'Recovered research',
      now: new Date('2026-07-16T03:00:00.000Z'),
    });
    expect(recovered.prepared.proposalId).not.toBe(second.prepared.proposalId);
    expect(recovered.state.state).toBe('prepared');
    expect(loadProposal(dataDir, first.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: second.prepared.proposalId,
    });
  });

  it('cold-recovers a replacing intent without another inbound request', () => {
    const first = prepareAndPublish('om_request_old');
    const second = prepareProposal(dataDir, {
      ...prepareInput('om_request_replacement'),
      displayName: 'Replacement research',
      now: new Date('2026-07-16T02:00:00.000Z'),
    });
    rmSync(v3DistillationProposalDir(dataDir, second.prepared.proposalId), {
      recursive: true,
      force: true,
    });
    writeFileSync(
      join(v3DistillationStoreRoot(dataDir), 'identity-index.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        entries: {
          [first.prepared.liveKey]: {
            state: 'replacing',
            proposalId: second.prepared.proposalId,
            prepared: second.prepared,
            preparedAt: second.state.preparedAt,
            previousProposalId: first.prepared.proposalId,
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(v3DistillationProposalDir(dataDir, first.prepared.proposalId), 'state.json'),
      `${JSON.stringify(first.state)}\n`,
      { mode: 0o600 },
    );

    const active = listActiveV3DistillationProposals(dataDir);
    expect(active).toHaveLength(1);
    expect(active[0]?.prepared).toEqual(second.prepared);
    expect(active[0]?.state.state).toBe('prepared');
    expect(loadProposal(dataDir, first.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: second.prepared.proposalId,
    });
  });

  it('replays the same event, replaces a new request target, and protects accepted work', () => {
    const prepared = prepareProposal(dataDir, prepareInput());
    const redelivery = prepareProposal(dataDir, prepareInput());
    expect(redelivery.prepared.proposalId).toBe(prepared.prepared.proposalId);
    const replacement = prepareProposal(dataDir, prepareInput('om_request_2'));
    expect(replacement.prepared.proposalId).not.toBe(prepared.prepared.proposalId);
    expect(replacement.prepared.replyTarget).toEqual({
      kind: 'thread',
      rootMessageId: 'om_request_2',
    });
    expect(replacement.state.state).toBe('prepared');

    const proposed = publishProposal(dataDir, replacement.prepared.proposalId, { compiled: compiledBody() });
    acceptProposal(dataDir, replacement.prepared.proposalId, actor(proposed.proposal!.proposalHash));
    expectStoreCode(() => prepareProposal(dataDir, prepareInput('om_request_3')), 'IDENTITY_BUSY');

    beginCommit(dataDir, replacement.prepared.proposalId, {
      proposalHash: proposed.proposal!.proposalHash,
      workflowId: WORKFLOW_ID,
      createdAt: '2026-07-16T03:00:00.000Z',
    });
    expectStoreCode(() => prepareProposal(dataDir, prepareInput('om_request_4')), 'IDENTITY_BUSY');
  });

  it('supersedes a same-name proposal from a distinct thread', () => {
    const proposed = prepareAndPublish('om_request_original');
    const retried = prepareProposal(dataDir, {
      ...prepareInput('om_request_retry'),
      now: new Date('2026-07-16T04:00:00.000Z'),
    });
    expect(retried.prepared.proposalId).not.toBe(proposed.prepared.proposalId);
    expect(retried.prepared.replyTarget).toEqual({
      kind: 'thread',
      rootMessageId: 'om_request_retry',
    });
    expect(retried.state.state).toBe('prepared');
    expect(loadProposal(dataDir, proposed.prepared.proposalId).state).toMatchObject({
      state: 'superseded',
      supersededByProposalId: retried.prepared.proposalId,
    });
  });

  it('lets a new explicit name replace an unreviewed prepared allocation', () => {
    const firstInput = prepareInput();
    const first = prepareProposal(dataDir, firstInput);
    const second = prepareProposal(dataDir, {
      ...prepareInput('om_request_renamed'),
      displayName: 'Renamed weekly research',
    });
    expect(second.prepared.proposalId).not.toBe(first.prepared.proposalId);
    expect(second.prepared.displayName).toBe('Renamed weekly research');
    expect(second.state.state).toBe('prepared');
    expect(loadProposal(dataDir, first.prepared.proposalId).state.state).toBe('prepared');
    expectStoreCode(() => prepareProposal(dataDir, firstInput), 'STALE_PROPOSAL');
  });

  it('keeps reject terminal and permits a later request for the same live identity', () => {
    const proposed = prepareAndPublish();
    const hash = proposed.proposal!.proposalHash;
    const rejected = rejectProposal(dataDir, proposed.prepared.proposalId, actor(hash));
    expect(rejected.state.state).toBe('rejected');
    expect(rejectProposal(dataDir, proposed.prepared.proposalId, actor(hash)).state).toEqual(rejected.state);
    expectStoreCode(
      () => acceptProposal(dataDir, proposed.prepared.proposalId, actor(hash)),
      'STATE_CONFLICT',
    );

    const replacement = prepareProposal(dataDir, prepareInput('om_request_later'));
    expect(replacement.state.state).toBe('prepared');
    expect(replacement.prepared.proposalId).not.toBe(proposed.prepared.proposalId);
  });

  it('creates a private 0700 tree with 0600 regular proposal files', () => {
    const proposed = prepareAndPublish();
    const root = v3DistillationStoreRoot(dataDir);
    const dir = v3DistillationProposalDir(dataDir, proposed.prepared.proposalId);
    if (process.platform !== 'win32') {
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(root, 'proposals')).mode & 0o777).toBe(0o700);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      for (const name of ['prepared.json', 'proposal.json', 'state.json']) {
        const stat = lstatSync(join(dir, name));
        expect(stat.isFile()).toBe(true);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.mode & 0o777).toBe(0o600);
      }
      expect(lstatSync(join(root, 'identity-index.json')).mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(process.platform !== 'win32')('rejects symlinks, non-private files, and tampered content without reflecting it', () => {
    const proposed = prepareAndPublish();
    const id = proposed.prepared.proposalId;
    const dir = v3DistillationProposalDir(dataDir, id);
    const statePath = join(dir, 'state.json');
    chmodSync(statePath, 0o644);
    expectStoreCode(() => loadProposal(dataDir, id), 'STORE_CORRUPT');
    chmodSync(statePath, 0o600);

    const proposalPath = join(dir, 'proposal.json');
    const target = join(dataDir, 'private-target.json');
    writeFileSync(target, '{"private":"do-not-reflect"}\n', { mode: 0o600 });
    unlinkSync(proposalPath);
    symlinkSync(target, proposalPath);
    try {
      loadProposal(dataDir, id);
      throw new Error('expected symlink rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(V3DistillationStoreError);
      expect((error as Error).message).not.toContain('do-not-reflect');
      expect((error as V3DistillationStoreError).code).toBe('STORE_CORRUPT');
    }
  });

  it('verifies the full immutable proposal hash instead of trusting stored hash fields', () => {
    const proposed = prepareAndPublish();
    const id = proposed.prepared.proposalId;
    const path = join(v3DistillationProposalDir(dataDir, id), 'proposal.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    raw.displayName = 'tampered-private-name';
    writeFileSync(path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
    expectStoreCode(() => loadProposal(dataDir, id), 'STORE_CORRUPT');
  });
});
