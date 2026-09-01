import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'bun:test';

import {
  type Manifest,
  type ManifestFile,
  type ValidateManifest,
} from '../src/workflows/v3/artifact-contract.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { createInProcessAttemptLeaseProvider } from '../src/workflows/v3/in-process-attempt-lease.js';
import { appendEvent, readJournal } from '../src/workflows/v3/journal.js';
import { assertOrCreatePortableRunSnapshot } from '../src/workflows/v3/portable-run-snapshot.js';
import { runPortableWorkflow } from '../src/workflows/v3/portable-runtime.js';
import type {
  AgentExecutionRequest,
  AgentExecutor,
  AttemptLeaseProvider,
  ExecutionProfileSnapshot,
} from '../src/workflows/v3/runtime-host-contract.js';

const validateManifest: ValidateManifest = async (manifestPath) => {
  try {
    return {
      ok: true,
      manifest: JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest,
    };
  } catch (error) {
    return { ok: false, problems: [String(error)] };
  }
};

function profile(workingDirectory: string): ExecutionProfileSnapshot {
  return {
    profileId: 'fake-local',
    executorId: 'fake-agent',
    workingDirectory,
  };
}

function outputFile(
  request: AgentExecutionRequest,
  name: string,
  content: string,
  kind: ManifestFile['kind'],
): ManifestFile {
  writeFileSync(join(request.outputDir, name), content);
  return {
    name,
    path: name,
    kind,
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
    mime: kind === 'json' ? 'application/json' : 'text/markdown',
  };
}

function succeed(
  request: AgentExecutionRequest,
  files: ManifestFile[],
): ReturnType<AgentExecutor> {
  const manifestPath = request.env.BOTMUX_GOAL_MANIFEST_PATH!;
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    status: 'ok',
    summary: `fake host completed ${request.node.id}`,
    files,
  } satisfies Manifest));
  return Promise.resolve({ status: 'ok', manifestPath });
}

function trackedInProcessLeaseProvider(): {
  provider: AttemptLeaseProvider;
  acquire: ReturnType<typeof vi.fn>;
} {
  const delegate = createInProcessAttemptLeaseProvider();
  const acquire = vi.fn(delegate.acquire.bind(delegate));
  return {
    acquire,
    provider: {
      acquire,
      closeBeforeExecution: delegate.closeBeforeExecution.bind(delegate),
      drainExternallyOwned: delegate.drainExternallyOwned.bind(delegate),
      cleanupSettled: delegate.cleanupSettled.bind(delegate),
    },
  };
}

describe('portable workflow runtime', () => {
  it('fails closed for leases not acquired by this provider instance', () => {
    const provider = createInProcessAttemptLeaseProvider();
    const binding = {
      runId: 'lease-contract',
      attemptId: 'node#001/attempts/001',
      attemptDir: join(tmpdir(), 'lease-contract', 'node#001', 'attempts', '001'),
    };

    expect(provider.drainExternallyOwned(binding)).toEqual({ status: 'unknown' });
    const acquisition = provider.acquire(binding);
    expect(provider.drainExternallyOwned(binding)).toEqual({ status: 'pending' });

    provider.closeBeforeExecution(binding, acquisition, 'setup_failed');
    const closed = provider.drainExternallyOwned(binding);
    expect(closed.status).toBe('closed');
    if (closed.status !== 'closed') throw new Error('unreachable');
    closed.finalizeAfterProof();
    expect(provider.drainExternallyOwned(binding)).toEqual({ status: 'unknown' });
  });

  it('does not redispatch a recovered attempt before durable close proof', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-lease-recovery-'));
    try {
      const dag = validateDag({
        runId: 'portable-lease-recovery',
        nodes: [{ id: 'work', type: 'goal', goal: 'complete work' }],
      });
      const runDir = join(baseDir, dag.runId);
      const journalPath = join(runDir, 'journal.ndjson');
      const attemptId = 'work#001/attempts/001';
      mkdirSync(join(runDir, attemptId), { recursive: true });
      assertOrCreatePortableRunSnapshot(
        runDir,
        dag,
        new Map([['', profile(baseDir)]]),
      );
      appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
      appendEvent(journalPath, {
        type: 'nodeDispatched',
        nodeId: 'work',
        instanceId: 'work#001',
        attemptId,
      });

      let closeProven = false;
      const drain = vi.fn(() => closeProven
        ? {
            status: 'closed' as const,
            finalizeAfterProof: () => {},
          }
        : { status: 'unknown' as const });
      const provider: AttemptLeaseProvider = {
        acquire: () => ({ auditKind: 'attemptLease' }),
        closeBeforeExecution: () => {},
        drainExternallyOwned: drain,
        cleanupSettled: () => {},
      };
      const executeAgent = vi.fn<AgentExecutor>(async (request) =>
        succeed(request, [
          outputFile(request, 'result.md', 'completed', 'markdown'),
        ]));

      const drive = runPortableWorkflow(
        dag,
        {
          executeAgent,
          validateManifest,
          resolveExecutionProfile: () => profile(baseDir),
          attemptLeaseProvider: provider,
        },
        { baseDir },
      );

      await vi.waitFor(() => expect(drain).toHaveBeenCalled());
      expect(executeAgent).not.toHaveBeenCalled();
      expect(
        readJournal(journalPath).filter((event) => event.type === 'nodeDispatched'),
      ).toHaveLength(1);

      closeProven = true;
      await expect(drive).resolves.toMatchObject({
        reason: 'terminal',
        runStatus: 'succeeded',
      });
      expect(executeAgent).toHaveBeenCalledTimes(1);
      expect(executeAgent.mock.calls[0]?.[0].attemptId).toBe(
        'work#001/attempts/002',
      );
      const events = readJournal(journalPath);
      expect(events).toContainEqual(expect.objectContaining({
        type: 'nodeAttemptDrained',
        attemptId,
        reason: 'orphanRecovery',
      }));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('runs a structured loop end-to-end with a non-Botmux agent executor', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-loop-'));
    try {
      const dag = validateDag({
        runId: 'portable-loop',
        nodes: [
          { id: 'prepare', type: 'goal', goal: 'prepare' },
          {
            id: 'fix',
            type: 'loop',
            depends: ['prepare'],
            inputs: [{ from: 'prepare' }],
            maxIterations: 3,
            body: {
              nodes: [
                { id: 'code', type: 'goal', goal: 'repair' },
                {
                  id: 'test',
                  type: 'goal',
                  goal: 'verify',
                  depends: ['code'],
                  inputs: [{ from: 'code' }],
                  resultSchema: {
                    type: 'object',
                    properties: { passed: { type: 'boolean' } },
                    required: ['passed'],
                  },
                },
              ],
            },
            exit: {
              node: 'test',
              when: { path: 'result.passed', equals: true },
            },
            feedback: ['test.result'],
            output: { from: 'code' },
          },
          {
            id: 'report',
            type: 'goal',
            goal: 'report',
            depends: ['fix'],
            inputs: [{ from: 'fix' }],
          },
        ],
      });
      const calls: string[] = [];
      const executeAgent: AgentExecutor = async (request) => {
        expect(request.executionProfile.executorId).toBe('fake-agent');
        expect(request.attemptLease.attemptId).toBe(request.attemptId);
        expect(request.attemptLease.signal.aborted).toBe(false);
        calls.push(request.node.id);
        if (request.node.id.endsWith('.test')) {
          const passed = request.node.id.includes('.i002.');
          return succeed(request, [
            outputFile(
              request,
              'result.json',
              JSON.stringify({ passed }),
              'json',
            ),
          ]);
        }
        return succeed(request, [
          outputFile(
            request,
            `${request.node.id.replaceAll('.', '-')}.md`,
            request.node.id,
            'markdown',
          ),
        ]);
      };
      const lease = trackedInProcessLeaseProvider();

      const outcome = await runPortableWorkflow(
        dag,
        {
          executeAgent,
          validateManifest,
          resolveExecutionProfile: () => profile(baseDir),
          attemptLeaseProvider: lease.provider,
        },
        { baseDir },
      );

      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'succeeded',
        finalOutputs: [{
          nodeId: 'report',
          instanceId: 'report#001',
        }],
      });
      expect(calls.filter((id) => id.endsWith('.code'))).toEqual([
        'fix.i001.code',
        'fix.i002.code',
      ]);
      expect(calls.filter((id) => id.endsWith('.test'))).toEqual([
        'fix.i001.test',
        'fix.i002.test',
      ]);
      expect(calls.at(-1)).toBe('report');
      expect(lease.acquire).toHaveBeenCalledTimes(calls.length);
      const journal = readFileSync(
        join(baseDir, dag.runId, 'journal.ndjson'),
        'utf-8',
      );
      expect(journal).not.toContain('nodeWorkerFenceArmed');
      expect(journal).toContain('"decision":"continue"');
      expect(journal).toContain('"decision":"exit"');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it('runs a cross-node revisit end-to-end without daemon worker fences', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'portable-revisit-'));
    try {
      const dag = validateDag({
        runId: 'portable-revisit',
        nodes: [
          { id: 'A', type: 'goal', goal: 'draft' },
          {
            id: 'B',
            type: 'goal',
            goal: 'review',
            depends: ['A'],
            inputs: [{ from: 'A' }],
            revisitTo: ['A'],
          },
        ],
      });
      const calls: string[] = [];
      const executeAgent: AgentExecutor = async (request) => {
        calls.push(request.attemptId);
        if (
          request.node.id === 'B'
          && request.attemptId.startsWith('B#001/')
        ) {
          return succeed(request, [
            outputFile(
              request,
              'result.json',
              JSON.stringify({
                status: 'revisit',
                revisitTo: 'A',
                reason: 'draft needs one revision',
              }),
              'json',
            ),
          ]);
        }
        return succeed(request, request.node.id === 'B'
          ? [
              outputFile(
                request,
                'result.json',
                JSON.stringify({ status: 'done' }),
                'json',
              ),
            ]
          : [
              outputFile(
                request,
                `${request.node.id}.md`,
                request.attemptId,
                'markdown',
              ),
            ]);
      };

      const outcome = await runPortableWorkflow(
        dag,
        {
          executeAgent,
          validateManifest,
          resolveExecutionProfile: () => profile(baseDir),
        },
        { baseDir },
      );

      expect(outcome).toMatchObject({
        reason: 'terminal',
        runStatus: 'succeeded',
        finalOutputs: [{
          nodeId: 'B',
          instanceId: 'B#002',
          attemptId: 'B#002/attempts/001',
        }],
      });
      if (outcome.reason !== 'terminal') throw new Error('unreachable');
      expect(outcome.finalOutputs[0]?.resultPath).toBe(
        realpathSync(join(
          baseDir,
          dag.runId,
          'B#002',
          'attempts',
          '001',
          'work',
          'result.json',
        )),
      );
      expect(calls).toEqual([
        'A#001/attempts/001',
        'B#001/attempts/001',
        'A#002/attempts/001',
        'B#002/attempts/001',
      ]);
      const journal = readFileSync(
        join(baseDir, dag.runId, 'journal.ndjson'),
        'utf-8',
      );
      expect(journal).toContain('"type":"nodeRevisitRequested"');
      expect(journal).toContain('"instanceId":"A#002"');
      expect(journal).not.toContain('nodeWorkerFenceArmed');

      const resumed = await runPortableWorkflow(
        dag,
        {
          executeAgent: async () => {
            throw new Error('settled nodes must not redispatch on resume');
          },
          validateManifest,
          resolveExecutionProfile: () => profile(baseDir),
        },
        { baseDir },
      );
      expect(resumed).toEqual(outcome);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
