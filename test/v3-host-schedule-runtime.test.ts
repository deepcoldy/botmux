import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDataDir = '';

vi.mock('../src/config.js', () => ({
  config: {
    session: { get dataDir() { return join(tempDataDir, 'data'); } },
  },
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createDefaultHostExecutorRegistry } from '../src/workflows/hostExecutors/registry.js';
import { getTask, listTasks, setScheduleScope } from '../src/services/schedule-store.js';
import { validateDag } from '../src/workflows/v3/dag.js';
import type { V3Dag } from '../src/workflows/v3/dag.js';
import { prepareV3HostInputArtifact } from '../src/workflows/v3/host-execution.js';
import { resolveV3HostInputTemplate } from '../src/workflows/v3/host-bindings.js';
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
  setScheduleScope('cli_test');
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

  // End-to-end cases through runWorkflow: it re-runs validateDag on dag.json,
  // whose botmux-schedule input allow-list (src/workflows/v3/dag.ts) includes
  // ownerOpenId, so the authored exact-$ref survives validation and reaches
  // the same resolve → parse → invoke chain as every saved/portable/envelope
  // run path.
  function ownerScheduleDag(runId: string, includeOwnerRef: boolean): V3Dag {
    const input: Record<string, unknown> = {
      name: 'Owner stamped',
      schedule: '30m',
      prompt: 'Review the workflow result',
      workingDir: '/workspace/project',
      larkAppId: { $ref: 'context.larkAppId' },
      chatId: { $ref: 'context.chatId' },
      chatType: { $ref: 'context.chatType' },
      scope: 'chat',
      deliver: 'origin',
    };
    if (includeOwnerRef) input.ownerOpenId = { $ref: 'context.initiatorOpenId' };
    return {
      runId,
      nodes: [{
        id: 'schedule',
        type: 'host',
        executor: 'botmux-schedule',
        input,
        depends: [],
        inputs: [],
        humanGate: { prompt: 'Create this schedule?' },
      }],
    } as unknown as V3Dag;
  }

  const runOwnerWorkflow = async (context: Record<string, string>, includeOwnerRef: boolean) => {
    const dag = ownerScheduleDag(
      `host-schedule-owner-${listTasks().length}-${context.initiatorOpenId ? 1 : 0}-${includeOwnerRef ? 1 : 0}`,
      includeOwnerRef,
    );
    return runWorkflow(dag, {
      runNode: async () => { throw new Error('host-only DAG must not spawn a goal worker'); },
      validateManifest,
      resolveBotSnapshot: () => { throw new Error('host-only DAG must not resolve a bot'); },
      hostExecutors: createDefaultHostExecutorRegistry(),
      hostReconcilers: new Map(),
      resolveGate: async () => ({ resolution: 'approved', by: 'ou_user', selected: 'approve' }),
    }, {
      baseDir: join(tempDataDir, 'v3-runs'),
      gateMode: 'blocking',
      resolvedWorkflowData: { params: {}, context },
    });
  };

  it('persists the run initiator open id onto the task via an exact context $ref', async () => {
    const outcome = await runOwnerWorkflow({
      larkAppId: 'cli_test',
      chatId: 'oc_owner',
      chatType: 'group',
      initiatorOpenId: 'ou_initiator',
    }, true);

    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    const [task] = listTasks();
    expect(task?.ownerOpenId).toBe('ou_initiator');
    expect(getTask(task!.id)?.ownerOpenId).toBe('ou_initiator');
  });

  it('fails closed when the node binds ownerOpenId but the run context carries no initiatorOpenId', async () => {
    const outcome = await runOwnerWorkflow({
      larkAppId: 'cli_test',
      chatId: 'oc_owner',
      chatType: 'group',
    }, true);

    // The host binding walk throws on the missing context segment before
    // invoking createTask — no task row may exist.
    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'failed', failedNodeId: 'schedule' });
    expect(listTasks()).toHaveLength(0);
  });

  it('leaves the persisted task ownerless when the node omits ownerOpenId', async () => {
    const outcome = await runOwnerWorkflow({
      larkAppId: 'cli_test',
      chatId: 'oc_ownerless',
      chatType: 'group',
      initiatorOpenId: 'ou_initiator',
    }, false);

    expect(outcome).toMatchObject({ reason: 'terminal', runStatus: 'succeeded' });
    const [task] = listTasks();
    expect(task?.ownerOpenId).toBeUndefined();
    const persisted = JSON.parse(readFileSync(
      join(tempDataDir, 'bots', 'cli_test', 'schedules.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect((persisted[task!.id] as Record<string, unknown>).ownerOpenId).toBeUndefined();
  });
});

describe('v3 botmux-schedule host ownerOpenId chain (binding resolution + executor)', () => {
  // Same modules runWorkflow drives for a host node: the authored $ref tree is
  // resolved against the run context, parsed by the executor, then invoke()
  // forwards ownerOpenId to schedule-store.createTask.
  function authoredInput(includeOwnerRef: boolean): Record<string, unknown> {
    const input: Record<string, unknown> = {
      name: 'Owner stamped',
      schedule: '30m',
      prompt: 'Review the workflow result',
      workingDir: '/workspace/project',
      larkAppId: { $ref: 'context.larkAppId' },
      chatId: { $ref: 'context.chatId' },
      chatType: { $ref: 'context.chatType' },
      scope: 'chat',
      deliver: 'origin',
    };
    if (includeOwnerRef) input.ownerOpenId = { $ref: 'context.initiatorOpenId' };
    return input;
  }

  async function invokeWith(context: Record<string, string>, includeOwnerRef: boolean, key: string) {
    const registry = createDefaultHostExecutorRegistry();
    const registered = registry.get('botmux-schedule')!;
    const resolved = await resolveV3HostInputTemplate(authoredInput(includeOwnerRef), {
      params: {},
      context,
      loadResult: () => { throw new Error('schedule input must not reference node results'); },
    });
    const parsed = registered.parseInput(resolved);
    return registered.executor.invoke(parsed, key);
  }

  it('forwards the run initiator open id from an exact context $ref into createTask', async () => {
    const result = await invokeWith({
      larkAppId: 'cli_test',
      chatId: 'oc_owner',
      chatType: 'group',
      initiatorOpenId: 'ou_initiator',
    }, true, `wf3_${'a'.repeat(46)}`);

    const taskId = (result.externalRefs as { taskId: string }).taskId;
    expect(taskId).toHaveLength(50);
    expect(getTask(taskId)?.ownerOpenId).toBe('ou_initiator');
  });

  it('throws at binding resolution and creates no task when context lacks initiatorOpenId', async () => {
    await expect(invokeWith({
      larkAppId: 'cli_test',
      chatId: 'oc_owner',
      chatType: 'group',
    }, true, `wf3_${'b'.repeat(46)}`)).rejects.toThrow(/initiatorOpenId/);
    expect(listTasks()).toHaveLength(0);
  });

  it('creates an ownerless task (no bot fallback) when the node omits ownerOpenId', async () => {
    const result = await invokeWith({
      larkAppId: 'cli_test',
      chatId: 'oc_ownerless',
      chatType: 'group',
      initiatorOpenId: 'ou_initiator',
    }, false, `wf3_${'c'.repeat(46)}`);

    const taskId = (result.externalRefs as { taskId: string }).taskId;
    const task = getTask(taskId);
    expect(task?.ownerOpenId).toBeUndefined();
    const persisted = JSON.parse(readFileSync(
      join(tempDataDir, 'bots', 'cli_test', 'schedules.json'),
      'utf-8',
    )) as Record<string, unknown>;
    expect((persisted[taskId] as Record<string, unknown>).ownerOpenId).toBeUndefined();
  });
});

describe('v3 botmux-schedule task-position guards', () => {
  function validate(input: Record<string, unknown>) {
    const registry = createDefaultHostExecutorRegistry();
    const registered = registry.get('botmux-schedule')!;
    const parsed = registered.parseInput({
      name: 'Task topic',
      schedule: '30m',
      prompt: 'Run in the per-task topic',
      workingDir: '/workspace/project',
      chatId: 'oc_task',
      chatType: 'group',
      executionPosition: 'task',
      ...input,
    });
    return registered.executor.validateBeforeIntent(parsed, Date.parse('2026-03-01T00:00:00Z'));
  }

  it('rejects a task-position node that carries an externally supplied rootMessageId', () => {
    // The per-task topic root is minted by the daemon on first fire and written
    // back to the store; accepting an authored root would let a workflow plant
    // its session inside an arbitrary existing topic.
    const result = validate({ rootMessageId: 'om_authored_root' });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'HOST_SCHEDULE_TASK_ROOT_FORBIDDEN',
    });
  });

  it('accepts a rootless task-position node (the only authored shape)', () => {
    expect(validate({})).toEqual({ ok: true });
  });
});
