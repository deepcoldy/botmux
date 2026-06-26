/**
 * v3 per-file input selector（P3）— schema 校验 + buildInputs 行为。
 *
 * `inputs: [{ from, select: { name | path } }]`：从上游 manifest 拉单个命名
 * 产物而非整箱；selector 未命中 → GoalInputs.omitted（reason 'selectorMiss'），
 * 缺失对 agent 可见而非静默。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { validateDag, DagValidationError } from '../src/workflows/v3/dag.js';
import { runWorkflow } from '../src/workflows/v3/runtime.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import {
  GOAL_ENV,
  type BotSnapshot,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type ValidateManifest,
} from '../src/workflows/v3/contract.js';

function goal(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'goal', goal: `do ${id}`, depends: [], inputs: [], ...extra };
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

// ─── schema ──────────────────────────────────────────────────────────────────

describe('validateDag: inputs.select 校验', () => {
  it('select.name / select.path 单选合法并归一化', () => {
    const d = validateDag({
      runId: 'sel',
      nodes: [
        goal('up'),
        goal('down', { depends: ['up'], inputs: [{ from: 'up', select: { name: 'report' } }] }),
      ],
    });
    expect(d.nodes.find((n) => n.id === 'down')!.inputs).toEqual([{ from: 'up', select: { name: 'report' } }]);
  });

  it('name+path 同时设 / 空值 / 未知 key → 报错', () => {
    expect(
      problemsOf(() =>
        validateDag({ runId: 'sel', nodes: [goal('up'), goal('d', { depends: ['up'], inputs: [{ from: 'up', select: { name: 'a', path: 'b' } }] })] }),
      ).some((p) => p.includes('exactly ONE')),
    ).toBe(true);
    expect(
      problemsOf(() =>
        validateDag({ runId: 'sel', nodes: [goal('up'), goal('d', { depends: ['up'], inputs: [{ from: 'up', select: { name: '' } }] })] }),
      ).some((p) => p.includes('non-empty')),
    ).toBe(true);
    expect(
      problemsOf(() =>
        validateDag({ runId: 'sel', nodes: [goal('up'), goal('d', { depends: ['up'], inputs: [{ from: 'up', pick: 'x' }] })] }),
      ).some((p) => p.includes('unsupported key')),
    ).toBe(true);
  });
});

// ─── buildInputs（经由 runWorkflow 集成）────────────────────────────────────

const validateManifest: ValidateManifest = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (e) {
    return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
  }
};
const resolveBotSnapshot = (): BotSnapshot => ({ larkAppId: 'cli_t', cliId: 'claude-code', workingDir: '/tmp' });

function fileEntry(outputDir: string, name: string, content: string): Manifest['files'][number] {
  writeFileSync(join(outputDir, name), content);
  return {
    name,
    path: name,
    kind: 'markdown',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: 'text/markdown',
  };
}

function okResult(req: Parameters<RunNode>[0], files: Manifest['files']): { status: 'ok'; manifestPath: string } {
  const manifestPath = req.env[GOAL_ENV.MANIFEST_PATH]!;
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, status: 'ok', summary: `done ${req.node.id}`, files }));
  return { status: 'ok', manifestPath };
}

describe('buildInputs: selector 注入与 miss', () => {
  it('select.name 只注入命中文件；select 未命中 → omitted selectorMiss', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-sel-'));
    try {
      const dag = validateDag({
        runId: 'sel-run',
        nodes: [
          goal('up'),
          goal('down', {
            depends: ['up'],
            inputs: [{ from: 'up', select: { name: 'report.md' } }],
          }),
          goal('miss', {
            depends: ['up'],
            inputs: [{ from: 'up', select: { name: 'ghost.md' } }],
          }),
        ],
      });
      const seen: Record<string, GoalInputs> = {};
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'up') {
          return okResult(req, [
            fileEntry(req.outputDir, 'report.md', 'REPORT'),
            fileEntry(req.outputDir, 'notes.md', 'NOTES'),
          ]);
        }
        seen[req.node.id] = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
        return okResult(req, [fileEntry(req.outputDir, `${req.node.id}.md`, 'OUT')]);
      };
      const outcome = await runWorkflow(dag, { runNode, validateManifest, resolveBotSnapshot }, { baseDir: base });
      expect(outcome.reason).toBe('terminal');

      // 命中：只有 report.md，notes.md 不进
      expect(seen.down!.inputs.map((i) => i.name)).toEqual(['report.md']);
      expect(seen.down!.omitted).toBeUndefined();

      // 未命中：零注入 + omitted selectorMiss
      expect(seen.miss!.inputs).toEqual([]);
      expect(seen.miss!.omitted).toEqual([{ from: 'up', reason: 'selectorMiss' }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
