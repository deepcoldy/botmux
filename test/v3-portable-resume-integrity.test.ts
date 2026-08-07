import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  Manifest,
  ValidateManifest,
} from '../src/workflows/v3/artifact-contract.js';
import { validateDag, type V3Dag } from '../src/workflows/v3/dag.js';
import {
  PORTABLE_RUN_SNAPSHOT_FILE,
} from '../src/workflows/v3/portable-run-snapshot.js';
import { runPortableWorkflow } from '../src/workflows/v3/portable-runtime.js';
import type {
  AgentExecutionRequest,
  AgentExecutor,
  ExecutionProfileSnapshot,
} from '../src/workflows/v3/runtime-host-contract.js';

const validateManifest: ValidateManifest = async (manifestPath) => ({
  ok: true,
  manifest: JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest,
});

function definition(goal = 'produce the report'): V3Dag {
  return validateDag({
    runId: 'portable-resume-integrity',
    nodes: [{ id: 'report', type: 'goal', goal }],
  });
}

function profile(
  baseDir: string,
  overrides: Partial<ExecutionProfileSnapshot> = {},
): ExecutionProfileSnapshot {
  return {
    profileId: 'profile-a',
    executorId: 'fake-agent',
    workingDirectory: baseDir,
    model: 'model-a',
    adapterData: { transport: 'local' },
    ...overrides,
  };
}

function complete(request: AgentExecutionRequest): ReturnType<AgentExecutor> {
  const content = 'portable result';
  writeFileSync(join(request.outputDir, 'result.md'), content);
  const manifestPath = request.env.BOTMUX_GOAL_MANIFEST_PATH!;
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    status: 'ok',
    summary: 'done',
    files: [{
      name: 'result.md',
      path: 'result.md',
      kind: 'markdown',
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      mime: 'text/markdown',
    }],
  } satisfies Manifest));
  return Promise.resolve({ status: 'ok', manifestPath });
}

describe('portable workflow resume integrity', () => {
  it('fails closed when a legacy run has no portable snapshot', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-legacy-resume-'));
    try {
      const dag = definition();
      const runDir = join(baseDir, dag.runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, 'journal.ndjson'), '');
      const executeAgent = vi.fn<AgentExecutor>();

      await expect(runPortableWorkflow(
        dag,
        {
          executeAgent,
          validateManifest,
          resolveExecutionProfile: () => profile(baseDir),
        },
        { baseDir },
      )).rejects.toThrow(/cannot safely resume run without portable-run\.snapshot\.json/);
      expect(executeAgent).not.toHaveBeenCalled();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('resumes only the exact DAG and execution profiles without redispatch', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-resume-integrity-'));
    try {
      const dag = definition();
      const baselineProfile = profile(baseDir);
      const firstExecutor = vi.fn<AgentExecutor>(complete);
      const outcome = await runPortableWorkflow(
        dag,
        {
          executeAgent: firstExecutor,
          validateManifest,
          resolveExecutionProfile: () => baselineProfile,
        },
        { baseDir },
      );
      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'succeeded',
      });
      expect(firstExecutor).toHaveBeenCalledTimes(1);

      const runDir = join(baseDir, dag.runId);
      const artifacts = [
        PORTABLE_RUN_SNAPSHOT_FILE,
        'dag.json',
        'bots.snapshot.json',
      ];
      const originalBytes = new Map(
        artifacts.map((name) => [name, readFileSync(join(runDir, name), 'utf-8')]),
      );

      const resumeExecutor = vi.fn<AgentExecutor>(async () => {
        throw new Error('a settled node must not be redispatched');
      });
      await expect(runPortableWorkflow(
        definition(),
        {
          executeAgent: resumeExecutor,
          validateManifest,
          resolveExecutionProfile: () => profile(baseDir),
        },
        { baseDir },
      )).resolves.toEqual(outcome);
      expect(resumeExecutor).not.toHaveBeenCalled();

      const variants: Array<{
        label: string;
        dag: V3Dag;
        executionProfile: ExecutionProfileSnapshot;
        error: RegExp;
      }> = [
        {
          label: 'DAG',
          dag: definition('produce a different report'),
          executionProfile: baselineProfile,
          error: /workflow definition differs/,
        },
        {
          label: 'model',
          dag,
          executionProfile: profile(baseDir, { model: 'model-b' }),
          error: /execution profiles differ/,
        },
        {
          label: 'working directory',
          dag,
          executionProfile: profile(join(baseDir, 'other-directory')),
          error: /execution profiles differ/,
        },
        {
          label: 'executor',
          dag,
          executionProfile: profile(baseDir, { executorId: 'other-agent' }),
          error: /execution profiles differ/,
        },
        {
          label: 'profile identity',
          dag,
          executionProfile: profile(baseDir, { profileId: 'profile-b' }),
          error: /execution profiles differ/,
        },
        {
          label: 'adapter data',
          dag,
          executionProfile: profile(baseDir, {
            adapterData: { transport: 'remote' },
          }),
          error: /execution profiles differ/,
        },
      ];
      for (const variant of variants) {
        const rejectedExecutor = vi.fn<AgentExecutor>(async () => {
          throw new Error(`${variant.label} mismatch must reject before dispatch`);
        });
        await expect(runPortableWorkflow(
          variant.dag,
          {
            executeAgent: rejectedExecutor,
            validateManifest,
            resolveExecutionProfile: () => variant.executionProfile,
          },
          { baseDir },
        )).rejects.toThrow(variant.error);
        expect(rejectedExecutor).not.toHaveBeenCalled();
        for (const name of artifacts) {
          expect(
            readFileSync(join(runDir, name), 'utf-8'),
            `${variant.label} must not overwrite ${name}`,
          ).toBe(originalBytes.get(name));
        }
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
