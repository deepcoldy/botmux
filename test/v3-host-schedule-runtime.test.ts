import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDataDir = '';

vi.mock('../src/config.js', () => ({
  config: {
    session: { get dataDir() { return tempDataDir; } },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createDefaultHostExecutorRegistry } from '../src/workflows/hostExecutors/registry.js';
import { getTask, listTasks } from '../src/services/schedule-store.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import { prepareV3HostInputArtifact } from '../src/workflows/v3/host-execution.js';
import { readJournal } from '../src/workflows/v3/journal.js';
import { readAndValidateManifest, ManifestValidationError } from '../src/workflows/v3/manifest.js';
import { runWorkflow, type V3RuntimeDeps } from '../src/workflows/v3/runtime.js';

const validateManifest: V3RuntimeDeps['validateManifest'] = async (manifestPath, outputDir) => {
  try {
    return { ok: true, manifest: await readAndValidateManifest(manifestPath, outputDir) };
  } catch (err) {
    return {
      ok: false,
      problems: err instanceof ManifestValidationError ? err.problems : [String(err)],
    };
  }
};

beforeEach(() => {
  tempDataDir = mkdtempSync(join(tmpdir(), 'v3-host-schedule-store-'));
});

afterEach(() => {
  rmSync(tempDataDir, { recursive: true, force: true });
});

describe('v3 botmux-schedule host runtime', () => {
  it('freezes a relative schedule and commits a durable P2P task through the host protocol', async () => {
    const runsDir = join(tempDataDir, 'v3-runs');
    const dag = validateDag({
      runId: 'host-schedule-p2p',
      nodes: [{
        id: 'schedule',
        type: 'host',
        executor: 'botmux-schedule',
        input: {
          name: 'Follow up',
          schedule: '30m',
          prompt: 'Review the workflow result',
          workingDir: '/workspace/project',
          larkAppId: { $ref: 'context.larkAppId' },
          chatId: { $ref: 'context.chatId' },
          chatType: { $ref: 'context.chatType' },
          rootMessageId: { $ref: 'context.rootMessageId' },
          scope: 'chat',
          deliver: 'origin',
        },
        depends: [],
        inputs: [],
        humanGate: { prompt: 'Create this schedule?' },
      }],
    });
    const outcome = await runWorkflow(dag, {
      runNode: async () => { throw new Error('host-only DAG must not spawn a goal worker'); },
      validateManifest,
      resolveBotSnapshot: () => { throw new Error('host-only DAG must not resolve a bot'); },
      hostExecutors: createDefaultHostExecutorRegistry(),
      hostReconcilers: new Map(),
      resolveGate: async () => ({ resolution: 'approved', by: 'ou_user', selected: 'approve' }),
    }, {
      baseDir: runsDir,
      gateMode: 'blocking',
      resolvedWorkflowData: {
        params: {},
        context: {
          larkAppId: 'cli_test',
          chatId: 'oc_p2p',
          chatType: 'p2p',
          rootMessageId: 'om_root',
        },
      },
    });

    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    const [task] = listTasks();
    expect(task).toMatchObject({
      name: 'Follow up',
      schedule: '30m',
      chatId: 'oc_p2p',
      chatType: 'p2p',
      rootMessageId: 'om_root',
      scope: 'chat',
      larkAppId: 'cli_test',
    });
    expect(task?.parsed.kind).toBe('once');
    expect(Date.parse(task?.parsed.runAt ?? '')).toBeGreaterThan(Date.now());
    expect(getTask(task!.id)?.chatType).toBe('p2p');
  });

  it('adopts a crash-left relative schedule sidecar without reparsing wall time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T08:00:00.000Z'));
    try {
      const runsDir = join(tempDataDir, 'v3-runs');
      const runId = 'host-schedule-crash-left-freeze';
      const runDir = join(runsDir, runId);
      const attemptDir = join(runDir, 'schedule#001', 'attempts', '001');
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const registry = createDefaultHostExecutorRegistry();
      const registered = registry.get('botmux-schedule')!;
      const resolvedInput = {
        name: 'Follow up',
        schedule: '30m',
        prompt: 'Review the workflow result',
        workingDir: '/workspace/project',
        larkAppId: 'cli_test',
        chatId: 'oc_p2p',
        chatType: 'p2p',
        rootMessageId: 'om_root',
        scope: 'chat',
        deliver: 'origin',
      };
      const frozen = prepareV3HostInputArtifact({
        runDir,
        attemptDir,
        runId,
        nodeId: 'schedule',
        instanceId: 'schedule#001',
        attemptId: 'schedule#001/attempts/001',
        executorName: 'botmux-schedule',
        resolvedInput,
        registered,
      });
      const frozenRunAt = (frozen.prepared.parsedInput as any).parsed.runAt;

      // Simulate a crash before hostInputPrepared was appended, then restart
      // far enough later that reparsing "30m" would produce different bytes.
      vi.setSystemTime(new Date('2026-07-11T08:10:00.000Z'));
      const workflow = validateDag({
        runId,
        nodes: [{
          id: 'schedule',
          type: 'host',
          executor: 'botmux-schedule',
          input: {
            name: 'Follow up',
            schedule: '30m',
            prompt: 'Review the workflow result',
            workingDir: '/workspace/project',
            larkAppId: { $ref: 'context.larkAppId' },
            chatId: { $ref: 'context.chatId' },
            chatType: { $ref: 'context.chatType' },
            rootMessageId: { $ref: 'context.rootMessageId' },
            scope: 'chat',
            deliver: 'origin',
          },
          depends: [],
          inputs: [],
          humanGate: { prompt: 'Create this schedule?' },
        }],
      });
      const outcome = await runWorkflow(workflow, {
        runNode: async () => { throw new Error('host-only DAG must not spawn a goal worker'); },
        validateManifest,
        resolveBotSnapshot: () => { throw new Error('host-only DAG must not resolve a bot'); },
        hostExecutors: registry,
        hostReconcilers: new Map(),
      }, {
        baseDir: runsDir,
        gateMode: 'suspend',
        resolvedWorkflowData: {
          params: {},
          context: {
            larkAppId: 'cli_test',
            chatId: 'oc_p2p',
            chatType: 'p2p',
            rootMessageId: 'om_root',
          },
        },
      });

      expect(outcome).toMatchObject({
        reason: 'awaitingGate',
        pendingWaits: [expect.objectContaining({ nodeId: 'schedule' })],
      });
      const events = readJournal(join(runDir, 'journal.ndjson'));
      expect(events.filter((event) => event.type === 'hostInputPrepared')).toEqual([
        expect.objectContaining({
          attemptId: 'schedule#001/attempts/001',
          inputHash: frozen.prepared.inputHash,
        }),
      ]);
      expect(events.some((event) => event.type === 'nodeFailed')).toBe(false);
      expect(events.some((event) => event.type === 'nodeBlocked')).toBe(false);
      expect((JSON.parse(readFileSync(frozen.absolutePath, 'utf-8')) as any).parsedInput.parsed.runAt)
        .toBe(frozenRunAt);
      expect(Date.parse(frozenRunAt)).toBe(new Date('2026-07-11T08:30:00.000Z').getTime());
      expect(listTasks()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
