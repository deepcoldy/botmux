import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendEvent } from '../src/workflows/v3/journal.js';
import {
  computeSavedWorkflowGateDigest,
  validateDagTemplate,
  type SavedWorkflowOwner,
  type SavedWorkflowRevisionDraft,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';
import {
  SavedWorkflowPermissionError,
  createSavedWorkflow,
  loadCurrentSavedWorkflow,
  savedWorkflowMetadataPath,
  workflowLibraryRoot,
} from '../src/workflows/v3/library-store.js';
import {
  SavedWorkflowServiceError,
  instantiatePublishedSavedWorkflow,
  listVisibleSavedWorkflows,
  loadVisibleSavedWorkflow,
  resolveOwnedTerminalRunDir,
  resolveVisibleSavedWorkflow,
  saveTerminalRunAsWorkflow,
  saveTerminalRunAsWorkflowIdempotent,
} from '../src/workflows/v3/library-service.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import { writeGrillState } from '../src/workflows/v3/grill-state.js';

const OWNER: SavedWorkflowOwner = { openId: 'ou_owner', larkAppId: 'cli_test' };
const OTHER: SavedWorkflowOwner = { openId: 'ou_other', larkAppId: 'cli_test' };
const OTHER_APP: SavedWorkflowOwner = { openId: 'ou_owner', larkAppId: 'cli_other' };

function context(
  actor: SavedWorkflowOwner = OWNER,
  chatId = 'oc_a',
  chatType: 'group' | 'p2p' = 'group',
) {
  return {
    actor,
    chatId,
    chatType,
    rootMessageId: 'om_root',
    sessionId: 'session-1',
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function seedTerminalAdHocRun(
  baseDir: string,
  opts: {
    runId: string;
    owner?: SavedWorkflowOwner;
    chatId?: string;
    title?: string;
    status?: 'succeeded' | 'failed' | 'blocked';
    includeBinding?: boolean;
  },
): string {
  const actor = opts.owner ?? OWNER;
  const runDir = join(baseDir, opts.runId);
  mkdirSync(runDir, { recursive: true });
  const dag = {
    runId: opts.runId,
    nodes: [{ id: 'work', type: 'goal', goal: 'write report', depends: [], inputs: [] }],
  };
  const spec = {
    schemaVersion: 1,
    runId: opts.runId,
    title: opts.title ?? '周报',
    requirement: 'write a report',
    nodes: [{
      sketchId: 'work',
      goal: 'write report',
      input_needs: [],
      expected_outputs: ['report.md'],
      acceptance: 'report exists',
      risk_gate: false,
      unknowns: [],
    }],
  };
  writeJson(join(runDir, 'dag.json'), dag);
  writeJson(join(runDir, 'spec.json'), spec);
  writeJson(join(runDir, 'bots.snapshot.json'), {
    '': { larkAppId: 'cli_test', cliId: 'claude-code', workingDir: '/source' },
  });
  const envelope = makeAdHocRunEnvelope({
    runId: opts.runId,
    createdAt: '2026-07-10T08:00:00.000Z',
    authorizedAt: '2026-07-10T08:01:00.000Z',
    ...(opts.includeBinding === false ? {} : {
      chatBinding: {
        larkAppId: actor.larkAppId,
        chatId: opts.chatId ?? 'oc_a',
        rootMessageId: 'om_source',
        ownerOpenId: actor.openId,
      },
    }),
    artifacts: {
      dag: artifactRef(runDir, 'dag.json'),
      spec: artifactRef(runDir, 'spec.json'),
      botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
    },
  });
  publishRunEnvelopeOnce(runDir, envelope);
  const journal = join(runDir, 'journal.ndjson');
  appendEvent(journal, { type: 'runStarted', runId: opts.runId });
  const status = opts.status ?? 'succeeded';
  if (status === 'succeeded') appendEvent(journal, { type: 'runSucceeded' });
  else if (status === 'failed') appendEvent(journal, { type: 'runFailed', failedNodeId: 'work' });
  else appendEvent(journal, { type: 'runBlocked', blockedNodeId: 'work' });
  return runDir;
}

function parameterizedRevision(): SavedWorkflowRevisionDraft {
  const dagTemplate: V3DagTemplate = {
    nodes: [{
      id: 'work',
      type: 'goal',
      goal: 'write report for ${params.city} from ${context.chatId}',
      bot: 'cli_test',
      depends: [],
      inputs: [],
      humanGate: null,
    }],
  };
  return {
    sourceRunId: 'original-source',
    inputs: { city: { type: 'string', required: true } },
    contextRefs: ['chatId'],
    specTemplate: {
      schemaVersion: 1,
      title: '参数化周报',
      requirement: 'write a parameterized report',
      nodes: [{
        sketchId: 'work',
        goal: 'write report',
        input_needs: [],
        expected_outputs: ['report.md'],
        acceptance: 'report exists',
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
  };
}

function scheduleRevision(): SavedWorkflowRevisionDraft {
  const dagTemplate = validateDagTemplate({
    nodes: [{
      id: 'schedule',
      type: 'host',
      executor: 'botmux-schedule',
      input: {
        name: 'Follow up',
        schedule: '30m',
        prompt: 'follow up',
        workingDir: '/workspace/project',
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
        chatType: { $ref: 'context.chatType' },
        rootMessageId: { $ref: 'context.rootMessageId' },
        scope: 'chat',
      },
      depends: [],
      inputs: [],
      humanGate: { prompt: 'Create schedule?' },
    }],
  } satisfies V3DagTemplate);
  return {
    inputs: {},
    contextRefs: ['larkAppId', 'chatId', 'chatType', 'rootMessageId'],
    specTemplate: {
      schemaVersion: 1,
      title: 'Follow-up schedule',
      requirement: 'create a schedule',
      nodes: [{
        sketchId: 'schedule',
        goal: 'create a schedule',
        input_needs: [],
        expected_outputs: ['task id'],
        acceptance: 'task exists',
        risk_gate: true,
        unknowns: [],
      }],
    },
    specStatus: 'current',
    dagTemplate,
    safety: {
      gateDigest: computeSavedWorkflowGateDigest(dagTemplate),
      sideEffects: [{ nodeId: 'schedule', kind: 'botmux-schedule' }],
    },
  };
}

function bot(cliId = 'claude-code') {
  return {
    larkAppId: 'cli_test',
    larkAppSecret: 'secret',
    cliId,
    workingDir: '/live',
  } as any;
}

let root: string;
let dataDir: string;
let sourceDir: string;
let runsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'v3-library-service-'));
  dataDir = join(root, 'data');
  sourceDir = join(root, 'source-runs');
  runsDir = join(root, 'runs');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Saved Workflow application service', () => {
  it('saves exact chat/global definitions and resolves ambiguity without guessing', async () => {
    const chatSource = seedTerminalAdHocRun(sourceDir, { runId: 'source-chat', title: '周报' });
    const chatSaved = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: chatSource,
      context: context(),
      now: new Date('2026-07-10T09:00:00.000Z'),
    });
    expect(chatSaved).toMatchObject({ created: true, sourceStatus: 'succeeded' });
    expect(chatSaved.metadata).toMatchObject({
      displayName: '周报',
      scope: { kind: 'chat', chatId: 'oc_a' },
      owner: OWNER,
      status: 'active',
    });
    expect(chatSaved.revision.payload.inputs).toEqual({});

    const globalSource = seedTerminalAdHocRun(sourceDir, { runId: 'source-global', title: '周报' });
    const globalSaved = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: globalSource,
      context: context(),
      scope: 'global',
      now: new Date('2026-07-10T10:00:00.000Z'),
    });

    const visible = await listVisibleSavedWorkflows({ dataDir, context: context() });
    expect(visible.entries.map((entry) => entry.workflowId).sort()).toEqual([
      chatSaved.metadata.workflowId,
      globalSaved.metadata.workflowId,
    ].sort());

    await expect(resolveVisibleSavedWorkflow({ dataDir, context: context(), ref: '周报' }))
      .rejects.toMatchObject({ code: 'ambiguous', matches: expect.arrayContaining([
        expect.objectContaining({ workflowId: chatSaved.metadata.workflowId }),
        expect.objectContaining({ workflowId: globalSaved.metadata.workflowId }),
      ]) });
    await expect(resolveVisibleSavedWorkflow({
      dataDir,
      context: context(OTHER, 'oc_b'),
      ref: '周报',
    })).resolves.toMatchObject({ workflowId: globalSaved.metadata.workflowId });
    await expect(resolveVisibleSavedWorkflow({
      dataDir,
      context: context(),
      ref: chatSaved.metadata.workflowId,
    })).resolves.toMatchObject({ workflowId: chatSaved.metadata.workflowId });
    await expect(resolveVisibleSavedWorkflow({
      dataDir,
      context: context(OTHER, 'oc_b'),
      ref: chatSaved.metadata.workflowId,
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(listVisibleSavedWorkflows({
      dataDir,
      context: context(OTHER_APP),
    })).resolves.toMatchObject({ entries: [], invalid: [] });
    await expect(resolveVisibleSavedWorkflow({
      dataDir,
      context: context(OTHER_APP),
      ref: globalSaved.metadata.workflowId,
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveVisibleSavedWorkflow({
      dataDir,
      context: context(OTHER_APP),
      ref: chatSaved.metadata.workflowId,
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('replays a completed-run save idempotently and lets the first scope win', async () => {
    const source = seedTerminalAdHocRun(sourceDir, { runId: 'source-idempotent', title: '日报' });
    const first = await saveTerminalRunAsWorkflowIdempotent({
      dataDir,
      runDir: source,
      context: context(),
      scope: 'chat',
      now: new Date('2026-07-10T09:00:00.000Z'),
    });
    const replay = await saveTerminalRunAsWorkflowIdempotent({
      dataDir,
      runDir: source,
      context: context(),
      scope: 'global',
      displayName: '另一个名字不会复制资产',
      now: new Date('2026-07-10T09:05:00.000Z'),
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.metadata.workflowId).toBe(first.metadata.workflowId);
    expect(replay.metadata.displayName).toBe('日报');
    expect(replay.metadata.scope).toEqual({ kind: 'chat', chatId: 'oc_a' });
    expect((await listVisibleSavedWorkflows({ dataDir, context: context() })).entries).toHaveLength(1);

    const explicitCopy = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: source,
      context: context(),
      scope: 'global',
      displayName: '显式复制',
    });
    expect(explicitCopy.created).toBe(true);
    expect(explicitCopy.metadata.workflowId).not.toBe(first.metadata.workflowId);
  });

  it('does not expose malformed shared-library directory counts to a bot catalog', async () => {
    const corruptId = 'wf_99999999999999999999999999999999';
    mkdirSync(join(workflowLibraryRoot(dataDir), corruptId), { recursive: true });
    writeFileSync(savedWorkflowMetadataPath(dataDir, corruptId), '{broken-json', 'utf-8');

    await expect(listVisibleSavedWorkflows({ dataDir, context: context() }))
      .resolves.toEqual({ entries: [], invalid: [] });
  });

  it('re-checks app, archive, and chat visibility after the second show read', async () => {
    const created = await createSavedWorkflow(dataDir, {
      displayName: 'Race-safe show',
      owner: OWNER,
      scope: { kind: 'global' },
      revision: parameterizedRevision(),
      publish: true,
      workflowId: 'wf_88888888888888888888888888888888',
    });
    const input = { dataDir, context: context(), ref: created.metadata.workflowId };
    const resolveVisible = async () => created.metadata;
    const secondRead = (metadata: typeof created.metadata) => ({
      resolveVisible,
      loadCurrent: async () => ({ metadata, revision: created.revision }),
    });

    await expect(loadVisibleSavedWorkflow(input, secondRead({
      ...created.metadata,
      owner: { ...created.metadata.owner, larkAppId: 'cli_other' },
    }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(loadVisibleSavedWorkflow(input, secondRead({
      ...created.metadata,
      status: 'archived',
    }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(loadVisibleSavedWorkflow(input, secondRead({
      ...created.metadata,
      scope: { kind: 'chat', chatId: 'oc_other' },
    }))).rejects.toMatchObject({ code: 'scope_mismatch' });
  });

  it('appends only to an explicit owner workflow and keeps failed runs draft-only', async () => {
    const initial = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: seedTerminalAdHocRun(sourceDir, { runId: 'source-v1' }),
      context: context(),
    });
    const failedRun = seedTerminalAdHocRun(sourceDir, {
      runId: 'source-v2-failed',
      status: 'failed',
    });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir: failedRun,
      context: context(),
      workflowId: initial.metadata.workflowId,
    })).rejects.toThrow(/pass allowDraft/);

    const appended = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: failedRun,
      context: context(),
      workflowId: initial.metadata.workflowId,
      expectedLatestRevision: initial.metadata.latestRevision,
      allowDraft: true,
    });
    expect(appended).toMatchObject({ created: false, sourceStatus: 'failed' });
    expect(appended.metadata.latestRevision).toBe(appended.revision.revisionId);
    expect(appended.metadata.publishedRevision).toBe(initial.revision.revisionId);
    expect((await loadCurrentSavedWorkflow(dataDir, initial.metadata.workflowId)).revision.revisionId)
      .toBe(initial.revision.revisionId);

    const otherSource = seedTerminalAdHocRun(sourceDir, {
      runId: 'source-other',
      owner: OTHER,
    });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir: otherSource,
      context: context(OTHER),
      workflowId: initial.metadata.workflowId,
      allowDraft: true,
    })).rejects.toBeInstanceOf(SavedWorkflowPermissionError);

    const otherAppSource = seedTerminalAdHocRun(sourceDir, {
      runId: 'source-other-app',
      owner: OTHER_APP,
    });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir: otherAppSource,
      context: context(OTHER_APP),
      workflowId: initial.metadata.workflowId,
      allowDraft: true,
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails closed when the source run belongs to another chat/actor or has no owner binding', async () => {
    const source = seedTerminalAdHocRun(sourceDir, { runId: 'source-owned' });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir: source,
      context: context(OWNER, 'oc_other'),
    })).rejects.toMatchObject({ code: 'scope_mismatch' });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir: source,
      context: context(OTHER),
    })).rejects.toMatchObject({ code: 'source_not_owned' });

    const unbound = seedTerminalAdHocRun(sourceDir, {
      runId: 'source-unbound',
      includeBinding: false,
    });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir: unbound,
      context: context(),
    })).rejects.toMatchObject({ code: 'source_not_owned' });
  });

  it('instantiates only a visible published definition with actor/chat binding and typed params', async () => {
    const created = await createSavedWorkflow(dataDir, {
      displayName: '参数化周报',
      owner: OWNER,
      scope: { kind: 'chat', chatId: 'oc_a' },
      revision: parameterizedRevision(),
      publish: true,
      workflowId: 'wf_1234567890abcdef1234567890abcdef',
    });
    const materialized = await instantiatePublishedSavedWorkflow({
      dataDir,
      ref: created.metadata.workflowId,
      context: context(OTHER),
      rawParams: { city: { kind: 'string', value: '上海' } },
      bots: [bot()],
      baseDir: runsDir,
      runId: 'service-run-001',
      now: new Date('2026-07-10T11:00:00.000Z'),
    });

    expect(materialized.resolvedParams).toEqual({ city: '上海' });
    expect(materialized.envelope).toMatchObject({
      source: { kind: 'saved_definition', workflowId: created.metadata.workflowId },
      chatBinding: {
        larkAppId: OTHER.larkAppId,
        chatId: 'oc_a',
        rootMessageId: 'om_root',
        ownerOpenId: OTHER.openId,
      },
    });
    expect(existsSync(join(materialized.runDir, 'grill.state.json'))).toBe(false);
    expect(loadAuthorizedV3Run(materialized.runDir).envelope.source.kind).toBe('saved_definition');
    expect(JSON.parse(readFileSync(join(materialized.runDir, 'params.resolved.json'), 'utf-8')))
      .toMatchObject({ params: { city: '上海' }, context: { chatId: 'oc_a' } });

    await expect(instantiatePublishedSavedWorkflow({
      dataDir,
      ref: created.metadata.workflowId,
      context: context(),
      bots: [bot()],
      baseDir: runsDir,
      runId: 'missing-param-run',
    })).rejects.toThrow(/缺少必填参数：city/);
    expect(existsSync(join(runsDir, 'missing-param-run'))).toBe(false);
  });

  it.each(['group', 'p2p'] as const)(
    'carries authenticated %s chatType into a Saved Workflow schedule run',
    async (chatType) => {
      const created = await createSavedWorkflow(dataDir, {
        displayName: `Schedule ${chatType}`,
        owner: OWNER,
        scope: { kind: 'chat', chatId: 'oc_a' },
        revision: scheduleRevision(),
        publish: true,
      });
      const materialized = await instantiatePublishedSavedWorkflow({
        dataDir,
        ref: created.metadata.workflowId,
        context: context(OWNER, 'oc_a', chatType),
        bots: [],
        baseDir: runsDir,
        runId: `schedule-${chatType}`,
      });
      expect(materialized.resolvedContext).toMatchObject({
        chatId: 'oc_a',
        chatType,
        larkAppId: OWNER.larkAppId,
        rootMessageId: 'om_root',
      });
      expect(materialized.envelope.chatBinding?.chatType).toBe(chatType);
      expect(materialized.dag.nodes[0]).toMatchObject({
        type: 'host',
        executor: 'botmux-schedule',
        input: { chatType: { $ref: 'context.chatType' } },
      });
    },
  );

  it('rejects unsupported live bots before publishing a run directory', async () => {
    const created = await createSavedWorkflow(dataDir, {
      displayName: 'CLI guard',
      owner: OWNER,
      scope: { kind: 'global' },
      revision: parameterizedRevision(),
      workflowId: 'wf_abcdefabcdefabcdefabcdefabcdefab',
    });
    await expect(instantiatePublishedSavedWorkflow({
      dataDir,
      ref: created.metadata.workflowId,
      context: context(),
      rawParams: { city: { kind: 'string', value: '北京' } },
      bots: [bot('gemini')],
      baseDir: runsDir,
      runId: 'unsupported-cli-run',
    })).rejects.toThrow(/unsupported CLI/);
    expect(existsSync(join(runsDir, 'unsupported-cli-run'))).toBe(false);
  });

  it('preserves explicit params/context when an instantiated definition run is saved again', async () => {
    const original = await createSavedWorkflow(dataDir, {
      displayName: '可复用周报',
      owner: OWNER,
      scope: { kind: 'chat', chatId: 'oc_a' },
      revision: parameterizedRevision(),
      workflowId: 'wf_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    const run = await instantiatePublishedSavedWorkflow({
      dataDir,
      ref: original.metadata.workflowId,
      context: context(),
      rawParams: { city: { kind: 'string', value: '深圳' } },
      bots: [bot()],
      baseDir: runsDir,
      runId: 'definition-source-run',
    });
    appendEvent(join(run.runDir, 'journal.ndjson'), { type: 'runStarted', runId: run.runId });
    appendEvent(join(run.runDir, 'journal.ndjson'), { type: 'runSucceeded' });

    const resaved = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: run.runDir,
      context: context(),
      displayName: '复制周报',
    });
    expect(resaved.revision.payload.inputs).toEqual({
      city: { type: 'string', required: true },
    });
    expect(resaved.revision.payload.contextRefs).toEqual(['chatId']);
    expect(resaved.revision.payload.dagTemplate.nodes[0]!.goal)
      .toContain('${params.city}');
  });

  it('returns explicit not-published and invalid-context errors', async () => {
    const draft = await saveTerminalRunAsWorkflow({
      dataDir,
      runDir: seedTerminalAdHocRun(sourceDir, {
        runId: 'source-blocked',
        status: 'blocked',
      }),
      context: context(),
      allowDraft: true,
    });
    await expect(instantiatePublishedSavedWorkflow({
      dataDir,
      ref: draft.metadata.workflowId,
      context: context(),
      bots: [bot()],
      baseDir: runsDir,
    })).rejects.toMatchObject({ code: 'not_published' });

    await expect(resolveVisibleSavedWorkflow({
      dataDir,
      context: { actor: { openId: '', larkAppId: 'cli_test' } },
      ref: 'anything',
    })).rejects.toBeInstanceOf(SavedWorkflowServiceError);
  });

  it('strictly seals an owned terminal pre-envelope run before saving', async () => {
    const runId = 'legacy-owned-terminal';
    const runDir = seedTerminalAdHocRun(sourceDir, { runId });
    unlinkSync(join(runDir, 'run.json'));
    writeGrillState(runDir, {
      schemaVersion: 1,
      runId,
      goal: 'legacy report',
      status: 'dag_approved',
      createdAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:01:00.000Z',
      specPath: join(runDir, 'spec.md'),
      specJsonPath: join(runDir, 'spec.json'),
      dagPath: join(runDir, 'dag.json'),
      chatBinding: {
        larkAppId: OWNER.larkAppId,
        chatId: 'oc_a',
        rootMessageId: 'om_source',
        ownerOpenId: OWNER.openId,
      },
    });

    await expect(resolveOwnedTerminalRunDir({
      baseDir: sourceDir,
      source: runId,
      context: context(),
    })).resolves.toBe(runDir);
    expect(loadAuthorizedV3Run(runDir).envelope.source).toEqual({
      kind: 'legacy_v3',
      original: 'grill',
    });
    await expect(saveTerminalRunAsWorkflow({
      dataDir,
      runDir,
      context: context(),
      displayName: '迁移周报',
    })).resolves.toMatchObject({ created: true, sourceStatus: 'succeeded' });
  });

  it('last skips a newer tampered run and selects the newest fully verified owned terminal run', async () => {
    const valid = seedTerminalAdHocRun(sourceDir, { runId: 'a-valid' });
    const tampered = seedTerminalAdHocRun(sourceDir, { runId: 'z-tampered' });
    writeJson(join(tampered, 'dag.json'), {
      runId: 'z-tampered',
      nodes: [{ id: 'evil', type: 'goal', goal: 'changed', depends: [], inputs: [] }],
    });

    await expect(resolveOwnedTerminalRunDir({
      baseDir: sourceDir,
      source: 'last',
      context: context(),
    })).resolves.toBe(valid);
  });
});
