/**
 * A1-companion — end-to-end dogfood: the `schedule-demo` workflow drives
 * `botmux-schedule` host executor through dispatchWork → effectAttempted →
 * activitySucceeded.  Confirms:
 *   1. CLI/IM-shaped runtime context (default registry, default reconcilers)
 *      hands off to the executor without extra wiring.
 *   2. The schedule-store task lands with `id = idempotencyKey` so the
 *      reconciler's `readOnlyLookup(idempotencyKey)` resolves it later.
 *   3. The event sequence on disk matches the side-effect protocol so
 *      cold resume can classify the activity correctly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWorkflowDefinition } from '../src/workflows/definition.js';
import { EventLog } from '../src/workflows/events/append.js';
import { runLoop } from '../src/workflows/loop.js';
import { createRun } from '../src/workflows/run-init.js';

const FIXTURE_PATH = join(__dirname, '..', 'workflows', 'schedule-demo.workflow.json');

let runsDir: string;
let scheduleDataDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'wf-a1-runs-'));
  scheduleDataDir = mkdtempSync(join(tmpdir(), 'wf-a1-sched-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(scheduleDataDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('schedule-demo workflow — A1 dogfood', () => {
  it('drives botmux-schedule end-to-end and lands externalRefs.taskId', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: {
        session: {
          get dataDir() {
            return scheduleDataDir;
          },
        },
      },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    // Lazy-load after mocks so registry / schedule-store pick them up.
    const { createDefaultHostExecutorRegistry } = await import(
      '../src/workflows/hostExecutors/registry.js'
    );
    const { getTask } = await import('../src/services/schedule-store.js');
    const { createStubSpawnFn } = await import('../src/workflows/spawn-bot.js');

    const raw = await fs.readFile(FIXTURE_PATH, 'utf-8');
    const def = parseWorkflowDefinition(JSON.parse(raw));
    expect(def.workflowId).toBe('schedule-demo');

    const runId = `schedule-demo-${Date.now()}`;
    const log = new EventLog(runId, runsDir);

    await createRun(log, {
      def,
      params: {},
      initiator: 'a1-companion-test',
      botResolver: () => ({}),
    });

    const ctx = {
      log,
      def,
      spawnSubagent: createStubSpawnFn(() => ({ never: 'called' })),
      hostExecutors: createDefaultHostExecutorRegistry(),
    };
    const result = await runLoop(ctx, { maxTicks: 50 });

    expect(result.reason).toBe('terminal');
    expect(result.lastSnapshot.run.status).toBe('succeeded');

    const events = await log.readAll();
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'runCreated',
      'runStarted',
      'attemptCreated',
      'effectAttempted',
      'activitySucceeded',
      'nodeSucceeded',
      'runSucceeded',
    ]);

    const effect = events.find((e) => e.type === 'effectAttempted')! as {
      payload: { provider: string; idempotencyKey: string; inputHash: string };
    };
    expect(effect.payload.provider).toBe('botmux-schedule');
    expect(effect.payload.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const succeeded = events.find((e) => e.type === 'activitySucceeded')! as {
      payload: {
        externalRefs: { taskId: string };
        outputRef: { outputPath: string; outputHash: string; contentType?: string };
      };
    };
    expect(succeeded.payload.externalRefs.taskId).toBe(effect.payload.idempotencyKey);
    expect(succeeded.payload.outputRef.contentType).toBe('application/json');

    // B-output: outputRef points at a readable JSON blob containing
    // both `output` (executor's typed return) and `externalRefs`.
    const blob = JSON.parse(await fs.readFile(succeeded.payload.outputRef.outputPath, 'utf-8'));
    expect(blob).toEqual({
      output: { taskId: effect.payload.idempotencyKey },
      externalRefs: { taskId: effect.payload.idempotencyKey },
    });

    const task = getTask(effect.payload.idempotencyKey);
    expect(task?.name).toBe('schedule-demo daily 9am');
    expect(task?.schedule).toBe('0 9 * * *');
  });
});
