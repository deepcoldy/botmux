import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  artifactRef,
  loadAuthorizedV3Run,
  makeAdHocRunEnvelope,
  publishRunEnvelopeOnce,
} from '../src/workflows/v3/run-envelope.js';
import {
  compileSavedWorkflowFromRun,
  materializeSavedWorkflowRun,
} from '../src/workflows/v3/library-materialize.js';
import { appendEvent } from '../src/workflows/v3/journal.js';
import {
  computeSavedWorkflowGateDigest,
  computeSavedWorkflowSideEffects,
  validateDagTemplate,
  validateSavedWorkflowRevisionPayload,
  type SavedWorkflowRevisionDraft,
  type SavedWorkflowRevisionPayloadV1,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';
import { createSavedWorkflow } from '../src/workflows/v3/library-store.js';
import { assertSavedWorkflowTemplateBindings } from '../src/workflows/v3/template-bindings.js';

const WORKFLOW_ID = 'wf_55555555555555555555555555555555';
const OWNER = { openId: 'ou_owner', larkAppId: 'cli_test' };
const BINDING = {
  larkAppId: 'cli_test',
  chatId: 'oc_chat',
  rootMessageId: 'om_root',
  ownerOpenId: 'ou_owner',
};

function hostNode(
  id: string,
  executor: 'feishu-send' | 'feishu-reply' | 'botmux-schedule',
  input: Record<string, unknown>,
) {
  return {
    id,
    type: 'host' as const,
    executor,
    input,
    depends: [],
    inputs: [],
    humanGate: { prompt: `Approve ${executor}?` },
  };
}

function sendDag(input: Record<string, unknown> = {}): V3DagTemplate {
  return {
    nodes: [hostNode('send', 'feishu-send', {
      larkAppId: { $ref: 'context.larkAppId' },
      chatId: { $ref: 'context.chatId' },
      content: 'Hello ${params.name} from ${context.initiatorOpenId}',
      ...input,
    })],
  };
}

function specTemplate(nodeIds: string[]) {
  return {
    schemaVersion: 1 as const,
    title: 'Host side effects',
    requirement: 'Execute approved host side effects',
    nodes: nodeIds.map((id) => ({
      sketchId: id,
      goal: `Execute ${id}`,
      input_needs: [],
      expected_outputs: ['provider receipt'],
      acceptance: 'Provider receipt is persisted',
      risk_gate: true,
      unknowns: [],
    })),
  };
}

function revisionPayload(
  dagTemplate: V3DagTemplate,
  sideEffects = computeSavedWorkflowSideEffects(dagTemplate),
): SavedWorkflowRevisionPayloadV1 {
  const normalizedDag = validateDagTemplate(dagTemplate);
  return {
    workflowId: WORKFLOW_ID,
    humanVersion: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: OWNER,
    inputs: {
      name: { type: 'string', required: true },
      metadata: { type: 'object', required: true },
    },
    contextRefs: ['larkAppId', 'chatId', 'rootMessageId', 'initiatorOpenId'],
    specTemplate: specTemplate(normalizedDag.nodes.map((node) => node.id)),
    specStatus: 'current',
    dagTemplate: normalizedDag,
    safety: {
      gateDigest: computeSavedWorkflowGateDigest(normalizedDag),
      sideEffects,
    },
  };
}

describe('Saved Workflow host template bindings', () => {
  it('allows declared params/context bindings inside host input and rejects undeclared ones', () => {
    const dag = sendDag();
    expect(() => assertSavedWorkflowTemplateBindings(dag, {
      name: { type: 'string', required: true },
      metadata: { type: 'object', required: true },
    }, ['larkAppId', 'chatId', 'initiatorOpenId'])).not.toThrow();

    expect(() => assertSavedWorkflowTemplateBindings(dag, {
      metadata: { type: 'object', required: true },
    }, ['larkAppId', 'chatId', 'initiatorOpenId']))
      .toThrow(/undeclared parameter name/);

    expect(() => assertSavedWorkflowTemplateBindings(dag, {
      name: { type: 'string', required: true },
      metadata: { type: 'object', required: true },
    }, ['larkAppId', 'chatId']))
      .toThrow(/undeclared context initiatorOpenId/);
  });

  it.each([
    {
      executor: 'feishu-send' as const,
      identity: {
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
      },
      field: 'chatId',
      expected: 'context.chatId',
    },
    {
      executor: 'feishu-reply' as const,
      identity: {
        larkAppId: { $ref: 'context.larkAppId' },
        rootMessageId: { $ref: 'context.rootMessageId' },
      },
      field: 'rootMessageId',
      expected: 'context.rootMessageId',
    },
    {
      executor: 'botmux-schedule' as const,
      identity: {
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
        chatType: { $ref: 'context.chatType' },
      },
      field: 'chatId',
      expected: 'context.chatId',
    },
  ])('requires $executor target identity to use exact context refs', ({ executor, identity, field, expected }) => {
    const valid = {
      nodes: [hostNode('effect', executor, { ...identity, content: 'hello' })],
    };
    expect(() => assertSavedWorkflowTemplateBindings(
      valid,
      { target: { type: 'string', required: true } },
      ['larkAppId', 'chatId', 'chatType', 'rootMessageId'],
    )).not.toThrow();

    const mutable = {
      nodes: [hostNode('effect', executor, {
        ...identity,
        [field]: { $ref: 'params.target' },
        content: 'hello',
      })],
    };
    expect(() => assertSavedWorkflowTemplateBindings(
      mutable,
      { target: { type: 'string', required: true } },
      ['larkAppId', 'chatId', 'chatType', 'rootMessageId'],
    )).toThrow(new RegExp(`input\\.${field} must be exact.*${expected}`));

    const frozen = {
      nodes: [hostNode('effect', executor, {
        ...identity,
        [field]: 'oc_frozen_target',
        content: 'hello',
      })],
    };
    expect(() => assertSavedWorkflowTemplateBindings(
      frozen,
      {},
      ['larkAppId', 'chatId', 'chatType', 'rootMessageId'],
    )).toThrow(new RegExp(`input\\.${field} must be exact.*${expected}`));
  });
});

describe('Saved Workflow host safety projection', () => {
  const dag: V3DagTemplate = {
    nodes: [
      hostNode('reply', 'feishu-reply', {
        larkAppId: { $ref: 'context.larkAppId' },
        rootMessageId: { $ref: 'context.rootMessageId' },
        content: 'reply',
      }),
      hostNode('send', 'feishu-send', {
        larkAppId: { $ref: 'context.larkAppId' },
        chatId: { $ref: 'context.chatId' },
        content: 'send',
      }),
    ],
  };

  it('accepts only the exact computed host side-effect set', () => {
    const expected = computeSavedWorkflowSideEffects(dag);
    expect(expected).toEqual([
      { nodeId: 'reply', kind: 'feishu-reply' },
      { nodeId: 'send', kind: 'feishu-send' },
    ]);
    expect(() => validateSavedWorkflowRevisionPayload(revisionPayload(dag, [...expected].reverse())))
      .not.toThrow();

    expect(() => validateSavedWorkflowRevisionPayload(revisionPayload(dag, [expected[0]!])))
      .toThrow(/safety\.sideEffects does not match host nodes/);
    expect(() => validateSavedWorkflowRevisionPayload(revisionPayload(dag, [
      expected[0]!,
      { nodeId: 'send', kind: 'botmux-schedule' },
    ]))).toThrow(/safety\.sideEffects does not match host nodes/);
    expect(() => validateSavedWorkflowRevisionPayload(revisionPayload(dag, [
      ...expected,
      { nodeId: 'ghost', kind: 'feishu-send' },
    ]))).toThrow(/safety\.sideEffects does not match host nodes/);
  });
});

describe('Saved Workflow host-only materialization', () => {
  it('exact-save infers builtin context refs from an ad-hoc host DAG', () => {
    const root = mkdtempSync(join(tmpdir(), 'v3-host-exact-save-'));
    try {
      const runId = 'host-source-run';
      const runDir = join(root, runId);
      mkdirSync(runDir, { recursive: true });
      const dag = { runId, ...sendDag({ content: 'hello' }) };
      const spec = { ...specTemplate(['send']), runId };
      for (const [name, value] of [
        ['dag.json', dag],
        ['spec.json', spec],
        ['bots.snapshot.json', {}],
      ] as const) {
        writeFileSync(join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);
      }
      publishRunEnvelopeOnce(runDir, makeAdHocRunEnvelope({
        runId,
        createdAt: '2026-07-11T00:00:00.000Z',
        authorizedAt: '2026-07-11T00:01:00.000Z',
        chatBinding: BINDING,
        artifacts: {
          dag: artifactRef(runDir, 'dag.json'),
          spec: artifactRef(runDir, 'spec.json'),
          botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
        },
      }));
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runStarted', runId });
      appendEvent(join(runDir, 'journal.ndjson'), { type: 'runSucceeded' });

      const compiled = compileSavedWorkflowFromRun(runDir);
      expect(compiled.revision.contextRefs).toEqual(expect.arrayContaining([
        'larkAppId', 'chatId',
      ]));
      expect(compiled.revision.safety.sideEffects).toEqual([
        { nodeId: 'send', kind: 'feishu-send' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes without any bot configuration or bot snapshot entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v3-host-saved-'));
    try {
      const dagTemplate = sendDag({ content: 'Hello ${params.name}' });
      const full = revisionPayload(dagTemplate);
      const revision: SavedWorkflowRevisionDraft = {
        inputs: full.inputs,
        contextRefs: full.contextRefs,
        specTemplate: full.specTemplate,
        specStatus: full.specStatus,
        dagTemplate: full.dagTemplate,
        safety: full.safety,
      };
      const saved = await createSavedWorkflow(join(root, 'data'), {
        workflowId: WORKFLOW_ID,
        displayName: 'Host-only workflow',
        owner: OWNER,
        scope: { kind: 'chat', chatId: BINDING.chatId },
        revision,
        publish: true,
        now: new Date('2026-07-11T01:00:00.000Z'),
      });

      const materialized = materializeSavedWorkflowRun({
        metadata: saved.metadata,
        revision: saved.revision,
        rawParams: {
          name: { kind: 'string', value: 'Ada' },
          metadata: { kind: 'json', value: { source: 'test' } },
        },
        context: { chatBinding: BINDING, initiatorOpenId: OWNER.openId },
        bots: [],
        baseDir: join(root, 'runs'),
        runId: 'host-saved-run',
        now: new Date('2026-07-11T02:00:00.000Z'),
      });

      expect(materialized.botSnapshots.size).toBe(0);
      expect(existsSync(join(materialized.runDir, 'bots.snapshot.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(materialized.runDir, 'bots.snapshot.json'), 'utf-8')))
        .toEqual({});
      expect(materialized.resolvedParams).toEqual({ name: 'Ada', metadata: { source: 'test' } });
      expect(materialized.resolvedContext).toMatchObject({
        larkAppId: BINDING.larkAppId,
        chatId: BINDING.chatId,
        initiatorOpenId: OWNER.openId,
      });
      expect(loadAuthorizedV3Run(materialized.runDir).botSnapshots).toEqual({});
      expect(readFileSync(join(materialized.runDir, 'dag.json'), 'utf-8'))
        .toContain('${params.name}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
