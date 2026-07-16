/**
 * v3 capability override（P2）— schema 校验 + 合并语义 + goal 渲染。
 * Workflow 权限姿态固定为 bypass；节点只允许改模型/追加指令。
 */
import { describe, it, expect } from 'vitest';

import { validateDag, DagValidationError } from '../src/workflows/v3/dag.js';
import { mergeNodeCapability, renderGoalFile } from '../src/workflows/v3/runtime.js';
import { botToSnapshot } from '../src/workflows/v3/bot-resolve.js';
import type { BotSnapshot } from '../src/workflows/v3/contract.js';

function goal(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra };
}

function dag(nodes: Record<string, unknown>[]): Record<string, unknown> {
  return { runId: 'override-test', nodes };
}

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof DagValidationError) return err.problems;
    throw err;
  }
  return [];
}

// ─── validateDag ─────────────────────────────────────────────────────────────

describe('validateDag: override 校验', () => {
  it('合法 override 归一化保留（model trim + node instructions）', () => {
    const d = validateDag(
      dag([
        goal('a', {
          override: { model: ' claude-haiku-4-5 ', systemPromptAppend: '只读分析，不要修改文件' },
        }),
      ]),
    );
    expect(d.nodes[0]!.override).toEqual({
      model: 'claude-haiku-4-5',
      systemPromptAppend: '只读分析，不要修改文件',
    });
  });

  it('permissionMode 已下线，任何值都显式拒绝', () => {
    const problems = problemsOf(() =>
      validateDag(dag([goal('a', { override: { permissionMode: 'restricted' } })])),
    );
    expect(
      problems.some(
        (p) =>
          p.includes('unsupported key') &&
          p.includes('permissionMode was removed') &&
          p.includes('always require CLI bypass') &&
          p.includes('delete this key'),
      ),
    ).toBe(true);
  });

  it('toolsSubset（P2b 延期）→ 显式报错而非静默忽略', () => {
    const problems = problemsOf(() =>
      validateDag(dag([goal('a', { override: { toolsSubset: ['Bash'] } })])),
    );
    expect(problems.some((p) => p.includes('toolsSubset is deferred'))).toBe(true);
  });

  it('空 override / 超长字段 / 非法形状 → 报错', () => {
    expect(
      problemsOf(() => validateDag(dag([goal('a', { override: {} })]))).some((p) =>
        p.includes('at least one'),
      ),
    ).toBe(true);
    expect(
      problemsOf(() =>
        validateDag(dag([goal('a', { override: { model: 'x'.repeat(65) } })])),
      ).some((p) => p.includes('64')),
    ).toBe(true);
    expect(
      problemsOf(() =>
        validateDag(dag([goal('a', { override: { systemPromptAppend: 'y'.repeat(8001) } })])),
      ).some((p) => p.includes('8000')),
    ).toBe(true);
    expect(
      problemsOf(() => validateDag(dag([goal('a', { override: 'fast' })]))).some((p) =>
        p.includes('must be an object'),
      ),
    ).toBe(true);
  });

  it('loop 复合节点拒绝 override；body 节点允许', () => {
    const loopNode = (override: unknown, bodyOverride: unknown): Record<string, unknown> => ({
      id: 'l',
      type: 'loop',
      depends: [],
      inputs: [],
      maxIterations: 2,
      ...(override !== undefined ? { override } : {}),
      body: {
        nodes: [
          goal('test', {
            resultSchema: { type: 'object', properties: { passed: { type: 'boolean' } }, required: ['passed'] },
            ...(bodyOverride !== undefined ? { override: bodyOverride } : {}),
          }),
        ],
      },
      exit: { node: 'test', when: { path: 'result.passed', equals: true } },
    });

    const rejected = problemsOf(() => validateDag(dag([loopNode({ model: 'm' }, undefined)])));
    expect(rejected.some((p) => p.includes('set override on body nodes instead'))).toBe(true);

    const ok = validateDag(dag([loopNode(undefined, { model: 'cheap-model' })]));
    expect(ok.nodes[0]!.body!.nodes[0]!.override).toEqual({ model: 'cheap-model' });
  });
});

// ─── mergeNodeCapability ─────────────────────────────────────────────────────

describe('mergeNodeCapability: 只允许模型改道', () => {
  const permissive: BotSnapshot = { larkAppId: 'app', cliId: 'claude-code', workingDir: '/w', model: 'base-model' };

  it('无 override → 快照原样', () => {
    expect(mergeNodeCapability(permissive, undefined)).toEqual(permissive);
  });

  it('model 改道：节点 override 覆盖 bot 默认', () => {
    expect(mergeNodeCapability(permissive, { model: 'node-model' }).model).toBe('node-model');
  });

  it('受限 bot 在快照生成前 fail-fast，不能进入 workflow', () => {
    expect(() => botToSnapshot({
      larkAppId: 'restricted-app',
      cliId: 'claude-code',
      disableCliBypass: true,
    } as any)).toThrow(/requires CLI bypass permissions.*disableCliBypass=true/);
  });
});

// ─── renderGoalFile ──────────────────────────────────────────────────────────

describe('renderGoalFile: 节点级指令段', () => {
  it('有 systemPromptAppend → 渲染 Node-specific instructions 段；无 → 不渲染', () => {
    const withAppend = renderGoalFile('do x', undefined, undefined, '只读分析');
    expect(withAppend).toContain('## Node-specific instructions');
    expect(withAppend).toContain('只读分析');

    const without = renderGoalFile('do x');
    expect(without).not.toContain('## Node-specific instructions');
  });
});
