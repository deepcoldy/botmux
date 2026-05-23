import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLog } from '../src/workflows/events/append.js';
import { replay } from '../src/workflows/events/replay.js';
import {
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflows/definition.js';
import { createRun, type BotResolver } from '../src/workflows/run-init.js';
import {
  type WorkflowRuntimeContext,
  type WorkerSpawnFn,
  type AbortCancelReason,
} from '../src/workflows/runtime.js';
import { runLoop } from '../src/workflows/loop.js';
import { cancelWorkflowRun } from '../src/workflows/cancel-run.js';
import { requestCancel } from '../src/workflows/cancel.js';

const noopResolver: BotResolver = () => ({});

let baseDir: string;
beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-cancel-final-'));
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('cancel finalize e2e — running cancel walks chain to terminal', () => {
  it('case 10: writes full cancelRequested→activityCanceled→nodeCanceled→runCanceled chain and clears intent', async () => {
    // Reproduces the daemon-side finalize closure (Part 1b of v0.1.4-a):
    //   1. runLoop is in flight running B & C in parallel
    //   2. caller writes cancelRequested + fires AbortControllers
    //   3. workers return `kind: 'cancelled'`, dispatchWork writes
    //      activityCanceled
    //   4. caller awaits the loop draining and invokes cancelWorkflowRun
    //      to drive the cancel chain to a terminal run
    //
    // The test stitches these moves together without booting the daemon
    // process, so it locks the cooperative contract between runLoop and
    // cancelWorkflowRun under the new parallel + cancel-intent semantics.
    const def: WorkflowDefinition = parseWorkflowDefinition({
      workflowId: 'finalize-fanout',
      version: 1,
      nodes: {
        a: { type: 'subagent', bot: 'cli_root', prompt: 'kick' },
        b: { type: 'subagent', bot: 'cli_x', prompt: 'b', depends: ['a'] },
        c: { type: 'subagent', bot: 'cli_y', prompt: 'c', depends: ['a'] },
      },
    });
    const log = new EventLog('finalize-fanout', baseDir);
    await createRun(log, { def, params: {}, initiator: 'tester', botResolver: noopResolver });

    // Aborters stash so the test can fire cancel like the daemon would.
    let aborters: Map<string, AbortController> | undefined;

    // First worker (A) returns success; B/C wait on cancelSignal then
    // report cancelled.  This means once cancel fires, both will resolve
    // with `kind: 'cancelled'` and dispatchWork writes activityCanceled.
    const enteredBC = new Promise<void>((resolve) => {
      const seen = new Set<string>();
      (globalThis as any).__bc = (node: string) => {
        seen.add(node);
        if (seen.has('b') && seen.has('c')) resolve();
      };
    });
    const spawn: WorkerSpawnFn = async (input) => {
      if (input.nodeId === 'a') {
        return {
          kind: 'success',
          output: { ok: true },
          session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
        };
      }
      (globalThis as any).__bc?.(input.nodeId);
      await new Promise<void>((resolve) => {
        if (input.cancelSignal?.aborted) return resolve();
        input.cancelSignal?.addEventListener('abort', () => resolve());
      });
      const reason = input.cancelSignal!.reason as AbortCancelReason;
      return {
        kind: 'cancelled',
        cancelOriginEventId: reason.cancelOriginEventId,
        session: { sessionId: `s-${input.activityId}`, botName: input.botName, startedAt: 0 },
      };
    };
    const ctx: WorkflowRuntimeContext = {
      log,
      def,
      spawnSubagent: spawn,
      registerAborters: (map) => {
        aborters = map;
      },
    };

    // Drive the loop in the background.
    const looping = runLoop(ctx);
    // Wait until B and C are both inside their spawn closures.
    await enteredBC;

    // Caller (simulating daemon's cancelWorkflowRunOnDaemon entry.running
    // branch) writes cancelRequested + fires the aborters.
    const cancel = await requestCancel(
      log,
      { target: { kind: 'run', runId: log.runId }, reason: 'finalize-test', by: 'tester' },
      'human',
    );
    expect(aborters).toBeDefined();
    expect(aborters!.size).toBe(2);
    for (const ac of aborters!.values()) {
      ac.abort({ cancelOriginEventId: cancel.eventId } satisfies AbortCancelReason);
    }

    // Loop completes its current tick (B/C return cancelled), then
    // observes the orchestrator short-circuit on the next tick → returns
    // no-progress.  This mirrors the daemon awaiting `entry.running`.
    const firstLoop = await looping;
    expect(['no-progress', 'terminal']).toContain(firstLoop.reason);

    // Now the daemon's finalize step: cancelWorkflowRun drives the
    // chain to runCanceled.
    const finalize = await cancelWorkflowRun({
      ctx,
      reason: 'finalize-test',
      by: 'tester',
      actor: 'human',
      maxTicks: 200,
    });
    expect(finalize.snapshot.run.status).toBe('cancelled');

    // Verify the full event chain and the intent cleared post-finalize.
    const events = await log.readAll();
    const types = new Set(events.map((e) => e.type));
    expect(types.has('cancelRequested')).toBe(true);
    expect(types.has('activityCanceled')).toBe(true);
    expect(types.has('nodeCanceled')).toBe(true);
    expect(types.has('runCanceled')).toBe(true);
    const finalSnap = replay(events);
    expect(finalSnap.cancelledRunIntent).toBeUndefined();
    expect(finalSnap.run.status).toBe('cancelled');

    delete (globalThis as any).__bc;
  });
});
