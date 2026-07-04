import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractSpecJsonBlock,
  parseSpecFromMarkdown,
  validateSpec,
  finalizeSpec,
  SpecValidationError,
} from '../src/workflows/v3/spec.js';
import { SPEC_SCHEMA_VERSION } from '../src/workflows/v3/contract.js';

/** A minimal valid Spec object. */
function validSpecObj(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    runId: 'deepsea-001',
    title: '竞品调研报告',
    requirement: '调研三家竞品的定价与功能，产出对比报告',
    acceptance: '每家含定价档位 + 功能矩阵',
    nonGoals: ['不做市场份额预测'],
    nodes: [
      {
        sketchId: 'research',
        goal: '调研 X/Y/Z 的定价与功能，写成 facts.md',
        input_needs: [],
        expected_outputs: ['facts.md'],
        acceptance: '每家含定价档+功能矩阵',
        risk_gate: false,
        unknowns: [],
      },
      {
        sketchId: 'report',
        goal: '基于调研产物写竞品分析报告 report.md',
        input_needs: ['research 阶段产出的竞品事实'],
        expected_outputs: ['report.md'],
        acceptance: '含结论与建议，引用事实',
        risk_gate: true,
        unknowns: ['报告读者是谁，暂按内部团队'],
      },
    ],
    ...overrides,
  };
}

/** Wrap a Spec object as the fenced json block inside a spec.md narrative. */
function specMd(obj: unknown): string {
  return [
    '# Spec: 竞品调研报告   (runId: deepsea-001)',
    '',
    '## 需求',
    '调研三家竞品…',
    '',
    '## 节点草图（architect 据此合成 dag.json）',
    '```json',
    JSON.stringify(obj, null, 2),
    '```',
    '',
  ].join('\n');
}

describe('v3 spec — extract + validate', () => {
  it('happy path：从 spec.md 抽 json 块并校验成 Spec', () => {
    const spec = parseSpecFromMarkdown(specMd(validSpecObj()));
    expect(spec.runId).toBe('deepsea-001');
    expect(spec.title).toBe('竞品调研报告');
    expect(spec.nodes).toHaveLength(2);
    expect(spec.nodes[0].sketchId).toBe('research');
    expect(spec.nodes[1].risk_gate).toBe(true);
    // input_needs 是自由文本，保留原样
    expect(spec.nodes[1].input_needs).toEqual(['research 阶段产出的竞品事实']);
  });

  it('spec.md 没有 ```json 块 → 抛 SpecValidationError', () => {
    expect(() => parseSpecFromMarkdown('# Spec\n\n纯叙事，没有代码块'))
      .toThrow(SpecValidationError);
  });

  it('```json 块 JSON 坏掉 → 抛 SpecValidationError', () => {
    const broken = '## 草图\n```json\n{ not valid json,, }\n```\n';
    expect(() => parseSpecFromMarkdown(broken)).toThrow(SpecValidationError);
  });

  it('extractSpecJsonBlock 抽出的就是 json 对象', () => {
    const obj = extractSpecJsonBlock(specMd(validSpecObj())) as Record<string, unknown>;
    expect(obj.runId).toBe('deepsea-001');
    expect(Array.isArray(obj.nodes)).toBe(true);
  });

  it('spec.md 有多个 ```json 块 → 抛 SpecValidationError（不静默选第一个）', () => {
    const two = '## 旧稿\n```json\n{"schemaVersion":1}\n```\n\n## 新稿\n```json\n{"schemaVersion":1}\n```\n';
    expect(() => extractSpecJsonBlock(two)).toThrow(SpecValidationError);
    expect(() => extractSpecJsonBlock(two)).toThrow(/2 个/);
  });
});

describe('v3 spec — validateSpec 守卫', () => {
  it('schemaVersion 错 → 报错', () => {
    expect(() => validateSpec(validSpecObj({ schemaVersion: 99 }))).toThrow(/schemaVersion/);
  });

  it('nodes 空数组 → 报错', () => {
    expect(() => validateSpec(validSpecObj({ nodes: [] }))).toThrow(/nodes 必须是非空数组/);
  });

  it('节点缺 goal → 报错', () => {
    const obj = validSpecObj();
    (obj.nodes[0] as Record<string, unknown>).goal = '';
    expect(() => validateSpec(obj)).toThrow(/goal 必须是非空字符串/);
  });

  it('节点缺 expected_outputs → 报错', () => {
    const obj = validSpecObj();
    (obj.nodes[0] as Record<string, unknown>).expected_outputs = [];
    expect(() => validateSpec(obj)).toThrow(/expected_outputs 至少要有 1 个/);
  });

  it('risk_gate 非 boolean → 报错', () => {
    const obj = validSpecObj();
    (obj.nodes[0] as Record<string, unknown>).risk_gate = 'yes';
    expect(() => validateSpec(obj)).toThrow(/risk_gate 必须是 boolean/);
  });

  it('重复 sketchId → 报错', () => {
    const obj = validSpecObj();
    (obj.nodes[1] as Record<string, unknown>).sketchId = 'research';
    expect(() => validateSpec(obj)).toThrow(/重复 sketchId/);
  });

  it('runId 非 path-safe → 报错', () => {
    expect(() => validateSpec(validSpecObj({ runId: 'bad id!' }))).toThrow(/runId 必须是 path-safe/);
  });

  it('多个问题一次性收集（不是首错即停）', () => {
    try {
      validateSpec(validSpecObj({ title: '', requirement: '' }));
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SpecValidationError);
      expect((err as SpecValidationError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('v3 spec — finalizeSpec 落盘 + runId 注入', () => {
  it('写出 canonical spec.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-spec-'));
    try {
      const mdPath = join(dir, 'spec.md');
      const jsonPath = join(dir, 'spec.json');
      writeFileSync(mdPath, specMd(validSpecObj()), 'utf-8');
      const spec = finalizeSpec(mdPath, jsonPath);
      expect(spec.runId).toBe('deepsea-001');
      const written = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      expect(written.schemaVersion).toBe(SPEC_SCHEMA_VERSION);
      expect(written.nodes).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('host 传 runId 时覆盖 grill 写的（host 权威）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-spec-'));
    try {
      const mdPath = join(dir, 'spec.md');
      const jsonPath = join(dir, 'spec.json');
      // grill 在块里写了 stale-id，host 用真实 runId 覆盖
      writeFileSync(mdPath, specMd(validSpecObj({ runId: 'stale-id' })), 'utf-8');
      const spec = finalizeSpec(mdPath, jsonPath, 'authoritative-007');
      expect(spec.runId).toBe('authoritative-007');
      expect(JSON.parse(readFileSync(jsonPath, 'utf-8')).runId).toBe('authoritative-007');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parse 失败时不写 spec.json（抛错阻断 handoff）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v3-spec-'));
    try {
      const mdPath = join(dir, 'spec.md');
      const jsonPath = join(dir, 'spec.json');
      writeFileSync(mdPath, '# Spec\n没有 json 块', 'utf-8');
      expect(() => finalizeSpec(mdPath, jsonPath)).toThrow(SpecValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
