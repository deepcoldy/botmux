import { describe, expect, it } from 'vitest';

import {
  SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
  buildSavedWorkflowRevision,
  computeSavedWorkflowGateDigest,
  computeSavedWorkflowRevisionContentHash,
  loadSavedWorkflowRevision,
  mintSavedWorkflowId,
  validateDagTemplate,
  validateSavedWorkflowMetadata,
  validateSavedWorkflowRevisionPayload,
  validateSpecTemplate,
  type SavedWorkflowRevisionPayloadV1,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';

const WORKFLOW_ID = 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER = { openId: 'ou_owner', larkAppId: 'cli_owner' };

function dagTemplate(goal = '研究并输出报告'): V3DagTemplate {
  return {
    nodes: [{
      id: 'research',
      type: 'goal',
      goal,
      bot: 'cli_research',
      depends: [],
      inputs: [],
      humanGate: null,
    }],
  };
}

function payload(overrides: Partial<SavedWorkflowRevisionPayloadV1> = {}): SavedWorkflowRevisionPayloadV1 {
  const dag = dagTemplate();
  return {
    workflowId: WORKFLOW_ID,
    humanVersion: 1,
    createdAt: '2026-07-10T08:00:00.000Z',
    createdBy: OWNER,
    sourceRunId: 'research-260710-160000-000-abcdef12',
    inputs: {
      topic: { type: 'string', required: true },
      days: { type: 'number', default: 7 },
    },
    contextRefs: ['chatId', 'initiatorOpenId'],
    specTemplate: {
      schemaVersion: 1,
      title: '竞品周报',
      requirement: '研究指定主题并输出周报',
      nodes: [{
        sketchId: 'research',
        goal: '研究竞品',
        input_needs: [],
        expected_outputs: ['报告'],
        acceptance: '引用完整',
        risk_gate: false,
        unknowns: [],
      }],
    },
    specStatus: 'current',
    dagTemplate: dag,
    safety: { gateDigest: computeSavedWorkflowGateDigest(dag), sideEffects: [] },
    ...overrides,
  };
}

describe('v3 Saved Workflow library schema', () => {
  it('keeps a Unicode display name while workflowId remains path-safe', () => {
    expect(mintSavedWorkflowId('12345678-1234-1234-1234-1234567890ab'))
      .toBe('wf_123456781234123412341234567890ab');

    const revision = buildSavedWorkflowRevision(payload());
    const metadata = validateSavedWorkflowMetadata({
      schemaVersion: SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
      workflowId: WORKFLOW_ID,
      displayName: '  竞品周报  ',
      aliases: ['每周竞品'],
      owner: OWNER,
      scope: { kind: 'chat', chatId: 'oc_chat' },
      status: 'active',
      latestRevision: revision.revisionId,
      publishedRevision: revision.revisionId,
      createdAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:00:00.000Z',
    });

    expect(metadata.displayName).toBe('竞品周报');
    expect(metadata.workflowId).toMatch(/^wf_[0-9a-f]{32}$/);
    expect(metadata.scope).toEqual({ kind: 'chat', chatId: 'oc_chat' });
  });

  it('validates typed defaults and forbids defaults on sensitive inputs', () => {
    expect(() => validateSavedWorkflowRevisionPayload(payload({
      inputs: { days: { type: 'number', default: 'seven' } },
    }))).toThrow(/default must match declared type number/);

    expect(() => validateSavedWorkflowRevisionPayload(payload({
      inputs: { token: { type: 'string', sensitive: true, default: 'secret' } },
    }))).toThrow(/sensitive and cannot have a default/);

    expect(() => validateSavedWorkflowRevisionPayload(payload({
      inputs: { config: { type: 'object', default: { mode: 'safe' } } },
    }))).not.toThrow();
  });

  it('requires templates to omit runId and every executable goal to have a direct bot selector', () => {
    expect(() => validateDagTemplate({ runId: 'old-run', ...dagTemplate() })).toThrow(/must not contain runId/);
    expect(() => validateSpecTemplate({ runId: 'old-run', ...payload().specTemplate })).toThrow(/must not contain runId/);

    const withoutBot = dagTemplate();
    delete withoutBot.nodes[0]!.bot;
    expect(() => validateDagTemplate(withoutBot)).toThrow(/direct bot selector/);
  });

  it('produces a stable content hash across object-key order and changes on semantic content', () => {
    const first = buildSavedWorkflowRevision(payload({
      inputs: {
        topic: { type: 'string', required: true },
        days: { type: 'number', default: 7 },
      },
    }));
    const reordered = buildSavedWorkflowRevision(payload({
      inputs: {
        days: { default: 7, type: 'number' },
        topic: { required: true, type: 'string' },
      },
    }));
    const changed = buildSavedWorkflowRevision(payload({ dagTemplate: dagTemplate('输出不同报告') }));

    expect(first.revisionId).toBe(reordered.revisionId);
    expect(first.contentHash).toBe(reordered.contentHash);
    expect(changed.revisionId).not.toBe(first.revisionId);
    expect(first.revisionId).toMatch(/^rev_[0-9a-f]{64}$/);
  });

  it('detects tampering before returning a revision', () => {
    const stored = buildSavedWorkflowRevision(payload());
    const tampered = {
      ...stored,
      payload: { ...(stored.payload as SavedWorkflowRevisionPayloadV1), sourceRunId: 'replaced-run' },
    };
    expect(() => loadSavedWorkflowRevision(tampered, {
      workflowId: WORKFLOW_ID,
      revisionId: stored.revisionId,
    })).toThrow(/contentHash does not match payload/);
  });

  it('fails loud on a future revision schema instead of guessing', () => {
    const stored = buildSavedWorkflowRevision(payload());
    const schemaVersion = 2;
    const contentHash = computeSavedWorkflowRevisionContentHash(schemaVersion, stored.payload);
    const future = {
      ...stored,
      schemaVersion,
      contentHash,
      revisionId: `rev_${contentHash.slice('sha256:'.length)}`,
    };
    expect(() => loadSavedWorkflowRevision(future)).toThrow(/newer than supported/);
  });
});
