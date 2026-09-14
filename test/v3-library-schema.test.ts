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
  validateSavedWorkflowRevisionDraft,
  validateSpecTemplate,
  collectSavedWorkflowChatSideEffectProblems,
  type SavedWorkflowRevisionPayloadV1,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';

const WORKFLOW_ID = 'wf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER = { openId: 'ou_owner', larkAppId: 'cli_owner' };

function dagTemplate(goal = '研究并输出报告'): V3DagTemplate {
  return {
    schemaVersion: 2,
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

  it('detects chat-facing side effects but only rejects them at the authoring boundary, not on load', () => {
    const unsafeDag = dagTemplate('写入外部系统，然后 botmux send --mention ou_owner "完成"');

    // The detector still flags the effect.
    expect(collectSavedWorkflowChatSideEffectProblems(unsafeDag)).toMatchObject([{
      nodeId: 'research',
      kind: 'botmux-send',
    }]);

    const unsafePayload = payload({
      dagTemplate: unsafeDag,
      safety: { gateDigest: computeSavedWorkflowGateDigest(unsafeDag), sideEffects: [] },
    });

    // READ path stays lenient: a revision that was legal before the lint existed
    // must remain loadable/show-able/appendable (backward-compat — no brick).
    expect(() => validateSavedWorkflowRevisionPayload(unsafePayload)).not.toThrow();
    const stored = buildSavedWorkflowRevision(unsafePayload);
    expect(() => loadSavedWorkflowRevision(stored, { workflowId: WORKFLOW_ID })).not.toThrow();

    // AUTHORING boundary rejects a NEW draft with migration guidance.
    const { workflowId: _w, humanVersion: _h, createdAt: _c, createdBy: _b, ...draft } = unsafePayload;
    expect(() => validateSavedWorkflowRevisionDraft(draft))
      .toThrow(/businessTask.*hostExecutor feishu-send\/feishu-reply/s);
  });

  it.each([
    '不要执行任何 botmux send…',
    '禁止调用 botmux send。',
    '不得运行 botmux reply。',
    '严禁使用 botmux send。',
    '勿调用 botmux send。',
    'Never run botmux send.',
    'Do NOT run botmux send.',
    "Don't run botmux reply.",
    'No botmux send commands.',
    '严格只读，不要执行任何 botmux send 或 botmux reply 或其它对外发消息的命令。',
  ])('does not flag an explicit prohibition: %s', (text) => {
    const dag = dagTemplate(text);
    dag.nodes[0]!.humanGate = { prompt: text };
    dag.nodes[0]!.override = { systemPromptAppend: text };

    expect(collectSavedWorkflowChatSideEffectProblems(dag)).toEqual([]);
    const { workflowId, humanVersion, createdAt, createdBy, ...draft } = payload({
      dagTemplate: dag,
      safety: { gateDigest: computeSavedWorkflowGateDigest(validateDagTemplate(dag)), sideEffects: [] },
    });
    expect(validateSavedWorkflowRevisionDraft(draft).dagTemplate.nodes[0]).toMatchObject({
      goal: text,
      humanGate: { prompt: text },
      override: { systemPromptAppend: text },
    });
  });

  it.each(['。', '.', '；', ';', '\n', '/', '，', ','])('keeps negation within the %j clause boundary', (separator) => {
    const dag = dagTemplate(`不要执行 botmux send${separator}完成后用 botmux send 汇报。`);
    expect(collectSavedWorkflowChatSideEffectProblems(dag)).toMatchObject([{
      nodeId: 'research', kind: 'botmux-send', path: 'dagTemplate.nodes.research.goal',
    }]);
  });

  it.each([
    '完成后用 botmux send 汇报。但不要发给外部群。',
    'Run botmux send but do not notify external chats.',
    '不要执行 botmux send 但完成后用 botmux reply 汇报。',
    'Do not run botmux send but run botmux reply afterwards.',
    'No changes are needed; run botmux send.',
  ])('still flags an affirmative instruction next to a prohibition: %s', (text) => {
    expect(collectSavedWorkflowChatSideEffectProblems(dagTemplate(text))).toMatchObject([{
      nodeId: 'research', kind: 'botmux-send',
    }]);
  });

  it.each([
    ['不要调用 /open-apis/im/v1/messages。', []],
    ['调用 /open-apis/im/v1/messages 发消息。', [{ kind: 'feishu-openapi-message' }]],
    ['不要调用 lark-cli im send。', []],
    ['不要发消息，完成后用 lark-cli im send 汇报。', [{ kind: 'lark-cli-im' }]],
    ['不要调用 lark-cli im send，完成后用 lark-cli im send 汇报。', [{ kind: 'lark-cli-im' }]],
    ['Do not use bytedcli feishu send; use bytedcli feishu reply.', [{ kind: 'bytedcli-feishu' }]],
    ['Do not use lark openapi send; use lark openapi reply.', [{ kind: 'feishu-openapi-message' }]],
  ])('preserves command detection across API path separators: %s', (text, expected) => {
    expect(collectSavedWorkflowChatSideEffectProblems(dagTemplate(text))).toMatchObject(expected);
  });

  it('detects a chat-facing side effect nested inside a loop body goal', () => {
    const loopDag: V3DagTemplate = {
      nodes: [{
        id: 'repair',
        type: 'loop',
        bot: 'cli_research',
        depends: [],
        inputs: [],
        maxIterations: 3,
        body: {
          nodes: [{
            id: 'iterate',
            type: 'goal',
            goal: '修好之后 botmux reply --in-thread "done"',
            depends: [],
            inputs: [],
            resultSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
          }],
        },
        exit: { node: 'iterate', when: { path: 'result.passed', equals: true } },
      }],
    };
    expect(collectSavedWorkflowChatSideEffectProblems(loopDag)).toMatchObject([{
      nodeId: 'repair.iterate',
      kind: 'botmux-send',
      path: 'dagTemplate.nodes.repair.iterate.goal',
    }]);
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
    const schemaVersion = 3;
    const contentHash = computeSavedWorkflowRevisionContentHash(schemaVersion, stored.payload);
    const future = {
      ...stored,
      schemaVersion,
      contentHash,
      revisionId: `rev_${contentHash.slice('sha256:'.length)}`,
    };
    expect(() => loadSavedWorkflowRevision(future)).toThrow(/newer than supported/);
  });

  it('读取旧 revision 时保留 v1 DAG，但新建 draft 必须使用 schemaVersion 2', () => {
    const legacyPayload = payload({
      dagTemplate: { nodes: dagTemplate().nodes },
    });
    const contentHash = computeSavedWorkflowRevisionContentHash(1, legacyPayload);
    const legacyStored = {
      schemaVersion: 1,
      contentHash,
      revisionId: `rev_${contentHash.slice('sha256:'.length)}`,
      payload: legacyPayload,
    };

    const loaded = loadSavedWorkflowRevision(legacyStored);
    expect(loaded).toMatchObject({ storedSchemaVersion: 1, schemaVersion: 2, migrated: true });
    expect(loaded.payload.dagTemplate.schemaVersion).toBeUndefined();

    const { workflowId: _w, humanVersion: _h, createdAt: _c, createdBy: _b, ...legacyDraft } = legacyPayload;
    expect(() => validateSavedWorkflowRevisionDraft(legacyDraft))
      .toThrow(/new Saved Workflow revision requires dagTemplate.schemaVersion=2/);
  });
});
