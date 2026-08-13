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
import { readJournal } from '../src/workflows/v3/journal.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import {
  GOAL_ENV,
  type BotSnapshot,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type ValidateManifest,
} from '../src/workflows/v3/contract.js';
import type { AttemptLeaseProvider } from '../src/workflows/v3/runtime-host-contract.js';

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

describe('validateDag: v2 output key 契约', () => {
  it('v1 不接受新版 outputs 声明', () => {
    expect(problemsOf(() => validateDag({
      runId: 'legacy-outputs',
      nodes: [goal('up', {
        outputs: { report: { path: 'report.json', kind: 'json' } },
      })],
    })).join('\n')).toContain('outputs requires schemaVersion 2');
  });

  it('通过稳定 output key 解析上游公开产物', () => {
    const d = validateDag({
      schemaVersion: 2,
      runId: 'output-contract',
      nodes: [
        goal('up', {
          outputs: {
            report: { path: 'report.md', kind: 'markdown' },
          },
        }),
        goal('down', {
          depends: ['up'],
          inputs: [{ from: 'up', output: 'report' }],
        }),
      ],
    });

    expect(d.schemaVersion).toBe(2);
    expect(d.nodes.find((n) => n.id === 'up')!.outputs).toEqual({
      report: { path: 'report.md', kind: 'markdown' },
    });
    expect(d.nodes.find((n) => n.id === 'down')!.inputs).toEqual([
      { from: 'up', output: 'report' },
    ]);
  });

  it('拒绝引用上游未声明的 output key', () => {
    const problems = problemsOf(() => validateDag({
      schemaVersion: 2,
      runId: 'unknown-output',
      nodes: [
        goal('up', { outputs: { report: { path: 'report.md', kind: 'markdown' } } }),
        goal('down', { depends: ['up'], inputs: [{ from: 'up', output: 'missing' }] }),
      ],
    }));

    expect(problems).toContain('node "down".inputs output "missing" is not declared by source "up"');
  });

  it('拒绝非法 output key/path/kind、重复 path、数量与大小越界', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [
      `out_${i}`,
      { path: `f_${i}.txt`, kind: 'text' },
    ]));
    const oversized = { huge: { path: `${'x'.repeat(4100)}.txt`, kind: 'text' } };
    const check = (outputs: unknown) => problemsOf(() => validateDag({
      schemaVersion: 2,
      runId: 'bad-outputs',
      nodes: [goal('up', { outputs })],
    }));

    expect(check({ 'bad/key': { path: 'a.md', kind: 'markdown' } }).join('\n')).toContain('key must match');
    expect(check({ report: { path: '../a.md', kind: 'markdown' } }).join('\n')).toContain('portable relative path');
    expect(check({ report: { path: 'a.md', kind: 'spreadsheet' } }).join('\n')).toContain('kind must be one of');
    expect(check({ a: { path: 'same.md', kind: 'markdown' }, b: { path: 'same.md', kind: 'markdown' } }).join('\n'))
      .toContain('duplicate path');
    expect(check(tooMany).join('\n')).toContain('entries (max 32)');
    expect(check(oversized).join('\n')).toContain('exceeds 4096 serialized bytes');
  });

  it('Loop body 内部同样静态校验 output key', () => {
    const problems = problemsOf(() => validateDag({
      schemaVersion: 2,
      runId: 'loop-output-contract',
      nodes: [{
        id: 'repair',
        type: 'loop',
        depends: [],
        inputs: [],
        maxIterations: 2,
        body: { nodes: [
          goal('write', { outputs: { patch: { path: 'patch.md', kind: 'markdown' } } }),
          goal('verify', {
            depends: ['write'],
            inputs: [{ from: 'write', output: 'missing' }],
            resultSchema: {
              type: 'object',
              properties: { passed: { type: 'boolean' } },
              required: ['passed'],
            },
          }),
        ] },
        exit: { node: 'verify', when: { path: 'result.passed', equals: true } },
        output: { from: 'write' },
      }],
    }));

    expect(problems).toContain(
      'loop node "repair".body node "verify".inputs output "missing" is not declared by source "write"',
    );
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
const attemptLeaseProvider: AttemptLeaseProvider = {
  acquire: () => ({ auditKind: 'attemptLease' }),
  closeBeforeExecution: () => {},
  drainExternallyOwned: () => ({ status: 'closed', finalizeAfterProof: () => {} }),
  cleanupSettled: () => {},
};

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
  it('公开产物未满足时在上游阻断并要求修订 Workflow', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-output-violation-'));
    try {
      const dag = validateDag({
        schemaVersion: 2,
        runId: 'output-violation',
        nodes: [goal('up', { outputs: { report: { path: 'report.md', kind: 'markdown' } } })],
      });
      const runNode: RunNode = async (req) =>
        okResult(req, [fileEntry(req.outputDir, 'wrong.md', 'WRONG')]);

      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot, attemptLeaseProvider },
        { baseDir: base },
      );
      const blocked = readJournal(join(outcome.runDir, 'journal.ndjson'))
        .find((event) => event.type === 'nodeBlocked');

      expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'blocked', blockedNodeId: 'up' });
      expect(blocked).toMatchObject({
        type: 'nodeBlocked',
        errorClass: 'artifactContractInvalid',
        errorCode: 'OUTPUT_CONTRACT_VIOLATION',
        recovery: 'reviseWorkflow',
      });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('公开产物 kind 不符时阻断；未声明的额外文件不影响契约', async () => {
    const run = async (runId: string, reportKind: Manifest['files'][number]['kind']) => {
      const base = mkdtempSync(join(tmpdir(), 'v3-output-kind-'));
      const dag = validateDag({
        schemaVersion: 2,
        runId,
        nodes: [goal('up', { outputs: { report: { path: 'report.md', kind: 'markdown' } } })],
      });
      const runNode: RunNode = async (req) => {
        const report = fileEntry(req.outputDir, 'report.md', 'REPORT');
        report.kind = reportKind;
        const extra = fileEntry(req.outputDir, 'notes.md', 'NOTES');
        return okResult(req, [report, extra]);
      };
      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot, attemptLeaseProvider },
        { baseDir: base },
      );
      rmSync(base, { recursive: true, force: true });
      return outcome;
    };

    await expect(run('output-kind-ok', 'markdown')).resolves.toMatchObject({ runStatus: 'succeeded' });
    await expect(run('output-kind-bad', 'text')).resolves.toMatchObject({
      runStatus: 'blocked',
      blockedNodeId: 'up',
    });
  });

  it('v2 output key 按声明 path 注入，Manifest 展示名称不参与寻址', async () => {
    const base = mkdtempSync(join(tmpdir(), 'v3-output-key-'));
    try {
      const dag = validateDag({
        schemaVersion: 2,
        runId: 'output-key-run',
        nodes: [
          goal('up', { outputs: { report: { path: 'report.md', kind: 'markdown' } } }),
          goal('down', { depends: ['up'], inputs: [{ from: 'up', output: 'report' }] }),
        ],
      });
      let received: GoalInputs | undefined;
      const runNode: RunNode = async (req) => {
        if (req.node.id === 'up') {
          const file = fileEntry(req.outputDir, 'report.md', 'REPORT');
          file.name = 'Human readable report';
          return okResult(req, [file]);
        }
        received = JSON.parse(readFileSync(req.inputsPath, 'utf-8')) as GoalInputs;
        return okResult(req, [fileEntry(req.outputDir, 'done.md', 'DONE')]);
      };

      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot, attemptLeaseProvider },
        { baseDir: base },
      );

      expect(outcome.reason).toBe('terminal');
      expect(received?.inputs).toMatchObject([{
        from: 'up',
        output: 'report',
        name: 'Human readable report',
        kind: 'markdown',
      }]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

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
            // Keep this assertion deterministic: the miss node waits until the
            // independently asserted down node has captured its inputs.
            depends: ['up', 'down'],
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
      const outcome = await runWorkflow(
        dag,
        { runNode, validateManifest, resolveBotSnapshot, attemptLeaseProvider },
        { baseDir: base },
      );
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
