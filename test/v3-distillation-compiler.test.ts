import { describe, expect, it } from 'vitest';

import {
  compileV3DistillationProposal,
  enumerateV3DistillationModelFields,
  recompileV3DistillationProposal,
} from '../src/workflows/v3/distillation-compiler.js';
import {
  V3DistillationCompileError,
  parseV3DistillationCompiledBody,
  parseV3DistillationSuggestion,
} from '../src/workflows/v3/distillation-schema.js';
import {
  computeSavedWorkflowGateDigest,
  type SavedWorkflowRevisionDraft,
} from '../src/workflows/v3/library-schema.js';
import {
  assertSavedWorkflowSpecTemplateBindings,
  collectSavedWorkflowTemplateBindings,
} from '../src/workflows/v3/template-bindings.js';

function baseline(goal = '研究上海并输出上海报告'): SavedWorkflowRevisionDraft {
  const dagTemplate = {
    nodes: [{
      id: 'research-private-id',
      type: 'goal' as const,
      goal,
      bot: 'cli_test',
      depends: [],
      inputs: [],
      humanGate: null,
      override: { systemPromptAppend: '只使用上海的公开资料' },
    }],
  };
  return {
    sourceRunId: 'source-run',
    inputs: {},
    contextRefs: [],
    specTemplate: {
      schemaVersion: 1,
      title: '上海周报',
      requirement: '研究上海并输出上海报告',
      acceptance: '上海事实有来源',
      nonGoals: ['不覆盖上海以外地区'],
      nodes: [{
        sketchId: 'research-sketch',
        goal: '研究上海',
        input_needs: ['上海公开资料'],
        expected_outputs: ['上海报告'],
        acceptance: '上海事实有来源',
        risk_gate: false,
        unknowns: ['上海数据时效'],
      }],
    },
    specStatus: 'current',
    dagTemplate,
    safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] },
  };
}

function suggestion(candidates: unknown[]): unknown {
  return { schemaVersion: 1, candidates };
}

function candidate(
  path: string,
  literal = '上海',
  occurrence = 0,
): unknown {
  return { path, literal, occurrence, type: 'string' };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected compiler to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(V3DistillationCompileError);
    expect((err as V3DistillationCompileError).code).toBe(code);
    expect((err as Error).message).not.toContain('上海');
  }
}

describe('v3 deterministic parameter distillation compiler', () => {
  it('strictly parses untrusted suggestions', () => {
    expect(parseV3DistillationSuggestion(suggestion([
      candidate('/dagTemplate/nodes/0/goal'),
    ])).candidates).toHaveLength(1);
    expectCode(() => parseV3DistillationSuggestion({
      schemaVersion: 1,
      candidates: [],
      authority: 'publish',
    }), 'MALFORMED_SUGGESTION');
    expectCode(() => parseV3DistillationSuggestion(suggestion([{
      ...candidate('/dagTemplate/nodes/0/goal') as object,
      default: '上海',
    }])), 'MALFORMED_SUGGESTION');
    expectCode(() => parseV3DistillationSuggestion(suggestion([{
      ...candidate('/dagTemplate/nodes/0/goal') as object,
      paramName: 'model_controlled_name',
    }])), 'MALFORMED_SUGGESTION');
  });

  it('enumerates only opaque, allowlisted model-visible execution text', () => {
    expect(enumerateV3DistillationModelFields(baseline())).toEqual([
      {
        ref: 'field-001',
        path: '/dagTemplate/nodes/0/goal',
        category: 'goal',
        nodeOrdinal: 1,
        text: '研究上海并输出上海报告',
      },
      {
        ref: 'field-002',
        path: '/dagTemplate/nodes/0/override/systemPromptAppend',
        category: 'instruction',
        nodeOrdinal: 1,
        text: '只使用上海的公开资料',
      },
    ]);
    expect(JSON.stringify(enumerateV3DistillationModelFields(baseline())))
      .not.toContain('research-private-id');
  });

  it('compiles UTF-8 spans, mirrors all spec narrative occurrences, and exposes no literal or raw node id', () => {
    const compiled = compileV3DistillationProposal({
      baselineRevision: baseline(),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', '上海', 0),
        candidate('/dagTemplate/nodes/0/goal', '上海', 1),
        candidate('/dagTemplate/nodes/0/override/systemPromptAppend'),
      ]),
    });

    expect(compiled.revisionDraft.inputs).toEqual({ param_1: { type: 'string', required: true } });
    expect(compiled.revisionDraft.dagTemplate.nodes[0]!.goal)
      .toBe('研究${params.param_1}并输出${params.param_1}报告');
    expect(compiled.revisionDraft.dagTemplate.nodes[0]!.override?.systemPromptAppend)
      .toBe('只使用${params.param_1}的公开资料');
    expect(compiled.revisionDraft.specTemplate).not.toEqual(baseline().specTemplate);
    expect(JSON.stringify(compiled.revisionDraft.specTemplate)).not.toContain('上海');

    const firstDag = compiled.replacements.find((replacement) =>
      replacement.path === '/dagTemplate/nodes/0/goal' && replacement.startUtf8 === 6);
    expect(firstDag).toMatchObject({
      startUtf8: 6,
      endUtf8: 12,
      replacement: '${params.param_1}',
      fieldCategory: 'goal',
    });
    expect(firstDag?.literalSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(compiled.safeSummary.parameters).toEqual([expect.objectContaining({
      name: 'param_1',
      type: 'string',
      required: true,
      hasDefault: false,
      fields: [
        { nodeOrdinal: 1, field: 'goal' },
        { nodeOrdinal: 1, field: 'instruction' },
      ],
    })]);
    const safeJson = JSON.stringify(compiled);
    expect(safeJson).not.toContain('上海');
    expect(JSON.stringify(compiled.safeSummary)).not.toContain('research-private-id');
    expect(parseV3DistillationCompiledBody(compiled)).toEqual(compiled);
  });

  it('supports the same allowlist recursively inside a structured-loop body', () => {
    const draft = baseline('prepare');
    const loopDag = {
      nodes: [{
        id: 'loop', type: 'loop' as const, bot: 'cli_test', depends: [], inputs: [],
        maxIterations: 2,
        body: { nodes: [
          { id: 'code', type: 'goal' as const, goal: '修复北京问题', depends: [], inputs: [] },
          {
            id: 'test', type: 'goal' as const, goal: '验证结果', bot: 'cli_test',
            depends: [{ from: 'code' }], inputs: [{ from: 'code' }],
            resultSchema: {
              type: 'object' as const,
              properties: { passed: { type: 'boolean' as const } },
              required: ['passed'],
            },
          },
        ] },
        exit: { node: 'test', when: { path: 'result.passed', equals: true } },
        feedback: [], output: { from: 'code' }, onExhausted: 'blocked' as const,
        sessionPolicy: 'fresh' as const,
      }],
    };
    draft.dagTemplate = loopDag;
    draft.safety = { gateDigest: computeSavedWorkflowGateDigest(loopDag), sideEffects: [] };
    draft.specTemplate.requirement = '修复北京问题';
    draft.specTemplate.title = '修复报告';
    draft.specTemplate.nodes[0]!.goal = '修复北京问题';

    const compiled = compileV3DistillationProposal({
      baselineRevision: draft,
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/body/nodes/0/goal', '北京', 0),
      ]),
    });
    expect(compiled.revisionDraft.dagTemplate.nodes[0]!.body?.nodes[0]!.goal)
      .toBe('修复${params.param_1}问题');
    expect(compiled.safeSummary.parameters[0]!.fields)
      .toEqual([{ nodeOrdinal: 2, field: 'goal' }]);
  });

  it('preserves pre-existing authenticated context markers without treating them as parameters', () => {
    const draft = baseline('研究上海；来源 ${context.chatId}');
    draft.contextRefs = ['chatId'];
    draft.specTemplate.requirement = '研究上海；来源 ${context.chatId}';
    const compiled = compileV3DistillationProposal({
      baselineRevision: draft,
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', '上海', 0),
      ]),
    });
    expect(compiled.revisionDraft.dagTemplate.nodes[0]!.goal)
      .toBe('研究${params.param_1}；来源 ${context.chatId}');
    expect(compiled.revisionDraft.contextRefs).toEqual(['chatId']);
  });

  it('rejects unsupported, missing, duplicate, overlapping, and conflicting candidates', () => {
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline(), suggestion: suggestion([]),
    }), 'ZERO_CANDIDATES');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline(),
      suggestion: suggestion([candidate('/dagTemplate/nodes/0/humanGate/prompt')]),
    }), 'UNSUPPORTED_PATH');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline(),
      suggestion: suggestion([candidate('/dagTemplate/nodes/0/goal', '不存在')]),
    }), 'SOURCE_LITERAL_NOT_FOUND');
    const same = candidate('/dagTemplate/nodes/0/goal');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline(), suggestion: suggestion([same, same]),
    }), 'DUPLICATE_CANDIDATE');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline('abcd'),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', 'abc', 0),
        candidate('/dagTemplate/nodes/0/goal', 'bcd', 0),
      ]),
    }), 'OVERLAPPING_REPLACEMENTS');
  });

  it('assigns generic host-owned names independent of model candidate order', () => {
    const candidates = [
      candidate('/dagTemplate/nodes/0/goal', '报告', 0),
      candidate('/dagTemplate/nodes/0/goal', '上海', 0),
      candidate('/dagTemplate/nodes/0/goal', '上海', 1),
    ];
    const left = compileV3DistillationProposal({
      baselineRevision: baseline(), suggestion: suggestion(candidates),
    });
    const right = compileV3DistillationProposal({
      baselineRevision: baseline(), suggestion: suggestion([...candidates].reverse()),
    });
    expect(left).toEqual(right);
    expect(Object.keys(left.revisionDraft.inputs)).toEqual(['param_1', 'param_2']);
    expect(left.safeSummary.parameters.map((parameter) => parameter.name))
      .toEqual(['param_1', 'param_2']);
  });

  it('blocks secret/identity values and residue in structural or machine-local reusable text', () => {
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline('Use api_key=abcdef123456'),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', 'abcdef123456', 0),
      ]),
    }), 'SECRET_OR_IDENTITY_LITERAL');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline('Send to ou_1234567890'),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', 'ou_1234567890', 0),
      ]),
    }), 'SECRET_OR_IDENTITY_LITERAL');

    const structural = baseline('Use research-private-id');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: structural,
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', 'research-private-id', 0),
      ]),
    }), 'SOURCE_VALUE_RESIDUE');

    const pathDraft = baseline('Read /root/private/input.txt');
    pathDraft.dagTemplate.nodes.push({
      id: 'second', type: 'goal', goal: 'Reuse /root/private/input.txt', bot: 'cli_test',
      depends: [], inputs: [], humanGate: null,
    });
    pathDraft.safety = {
      gateDigest: computeSavedWorkflowGateDigest(pathDraft.dagTemplate), sideEffects: [],
    };
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: pathDraft,
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', '/root/private/input.txt', 0),
      ]),
    }), 'SECRET_OR_IDENTITY_LITERAL');

    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline('Fetch api.example.invalid'),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', 'api.example.invalid', 0),
      ]),
    }), 'SECRET_OR_IDENTITY_LITERAL');
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline('Fetch https://example.invalid/report'),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', 'https://example.invalid/report', 0),
      ]),
    }), 'SECRET_OR_IDENTITY_LITERAL');

    // An unsafe literal elsewhere in reusable text must block the whole
    // proposal even when the model selects only an unrelated safe value.
    expectCode(() => compileV3DistillationProposal({
      baselineRevision: baseline('Research 上海 using api.example.invalid'),
      suggestion: suggestion([
        candidate('/dagTemplate/nodes/0/goal', '上海', 0),
      ]),
    }), 'SECRET_OR_IDENTITY_LITERAL');
    for (const unsafeGoal of [
      '研究上海；password="hunter2"',
      '研究上海；credential=correcthorsebattery',
      '研究上海；credential=x',
      '研究上海；passwd=hunter123',
      '研究上海；password=1234',
      '研究上海；passphrase=correct-horse-battery',
      '研究上海；auth=abc',
      '研究上海；auth=synthetic-auth-value',
      '研究上海；bearer=synthetic-bearer-value',
      '研究上海；AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      '研究上海；token=ghs_abcdefghijklmnopqrstuvwxyz',
      '研究上海；token=glpat-abcdefghijklmnopqrstuvwxyz',
      '研究上海；token=npm_abcdefghijklmnopqrstuvwxyz123456',
      '研究上海；token=hf_abcdefghijklmnopqrstuvwxyz123456',
      '研究上海；token=AIzaabcdefghijklmnopqrstuvwxyz123456789',
      '研究上海；token=xapp-1-abcdefghijklmnopqrstuvwxyz',
      String.raw`研究上海；workingDir=/home/user/project`,
      String.raw`研究上海；workingDir=C:/Users/user/private.txt`,
      String.raw`研究上海；read[/home/user/private]`,
      String.raw`研究上海；files,/root/private`,
      String.raw`研究上海；path=\\server\share`,
      '研究上海；使用 localhost',
      '研究上海；访问 prod-db.corp.',
      '研究上海；访问 api.example.com:',
      '研究上海；访问 api.example.com...',
      '研究上海；访问 10.0.0.1:',
      '研究上海；访问 10.0.0.1...',
      '研究上海；访问 api.example.com:https',
      '研究上海；从 deploy@prod-db-01:repo 拉取',
      'Read file evil.com, then connect to evil.com and research 上海',
      'Inspect src/api.sh, then connect to api.sh and research 上海',
    ]) {
      expectCode(() => compileV3DistillationProposal({
        baselineRevision: baseline(unsafeGoal),
        suggestion: suggestion([candidate('/dagTemplate/nodes/0/goal', '上海', 0)]),
      }), 'SECRET_OR_IDENTITY_LITERAL');
    }

    expect(() => compileV3DistillationProposal({
      baselineRevision: baseline('更新 package.json 并研究上海'),
      suggestion: suggestion([candidate('/dagTemplate/nodes/0/goal', '上海', 0)]),
    })).not.toThrow();
    for (const safeGoal of [
      '更新 file service.rs 并研究上海',
      '更新 src/service.rs 并研究上海',
      'Refactor worker.ts and research 上海',
      '在 2026-07-16T12:30 开始研究上海',
      '使用 node:20 研究上海',
    ]) {
      expect(() => compileV3DistillationProposal({
        baselineRevision: baseline(safeGoal),
        suggestion: suggestion([candidate('/dagTemplate/nodes/0/goal', '上海', 0)]),
      })).not.toThrow();
    }
  });

  it('recompiles stored spans and hashes from the authenticated baseline before approval', () => {
    const original = baseline();
    const compiled = compileV3DistillationProposal({
      baselineRevision: original,
      suggestion: suggestion([candidate('/dagTemplate/nodes/0/goal', '上海', 0)]),
    });
    expect(recompileV3DistillationProposal(original, compiled)).toEqual(compiled);

    const shifted = structuredClone(compiled);
    shifted.replacements.find((item) => item.fieldCategory === 'goal')!.startUtf8 += 1;
    expectCode(() => recompileV3DistillationProposal(original, shifted), 'REVERSE_FILL_MISMATCH');

    const wrongHash = structuredClone(compiled);
    wrongHash.replacements.find((item) => item.fieldCategory === 'goal')!.literalSha256 =
      `sha256:${'f'.repeat(64)}`;
    expectCode(() => recompileV3DistillationProposal(original, wrongHash), 'REVERSE_FILL_MISMATCH');
  });

  it('requires compiled bodies to keep strict P0 parameter and safe-summary shapes', () => {
    const compiled = compileV3DistillationProposal({
      baselineRevision: baseline(),
      suggestion: suggestion([candidate('/dagTemplate/nodes/0/goal')]),
    });
    const withDefault = structuredClone(compiled) as any;
    withDefault.revisionDraft.inputs.param_1.default = 'unsafe';
    expectCode(() => parseV3DistillationCompiledBody(withDefault), 'MALFORMED_COMPILED_BODY');
    const leakedSummary = structuredClone(compiled) as any;
    leakedSummary.safeSummary.parameters[0].literal = '上海';
    expectCode(() => parseV3DistillationCompiledBody(leakedSummary), 'MALFORMED_COMPILED_BODY');
  });

  it('validates spec markers and collects context refs recursively through loops', () => {
    const draft = baseline('prepare');
    draft.specTemplate.requirement = 'Use ${params.city}';
    expect(() => assertSavedWorkflowSpecTemplateBindings(
      draft.specTemplate,
      { city: { type: 'string', required: true } },
      [],
    )).not.toThrow();
    draft.specTemplate.nodes[0]!.sketchId = '${params.city}';
    expect(() => assertSavedWorkflowSpecTemplateBindings(
      draft.specTemplate,
      { city: { type: 'string', required: true } },
      [],
    )).toThrow(/structural field/);

    const dag = {
      nodes: [{
        id: 'loop', type: 'loop' as const, depends: [], inputs: [], bot: 'cli_test',
        body: { nodes: [{
          id: 'inside', type: 'goal' as const, goal: 'Use ${context.chatId}',
          depends: [], inputs: [],
        }] },
      }],
    };
    expect(collectSavedWorkflowTemplateBindings(dag).context).toEqual(['chatId']);
  });
});
