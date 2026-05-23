import { EventLog } from './events/append.js';
import type { RunLoopResult } from './loop.js';
import type { WorkflowRuntimeContext } from './runtime.js';
import {
  scanColdWorkflowRuns,
  type ColdWorkflowRun,
} from './cold-scan.js';

export type ColdWorkflowWatcherHandle = {
  ready?: Promise<unknown>;
};

export type AttachColdWorkflowRunsOptions = {
  runsDir: string;
  ownerLarkAppId: string;
  isAttached?: (runId: string) => boolean;
  makeContext: (run: ColdWorkflowRun, log: EventLog) => WorkflowRuntimeContext;
  attachWatcher: (runId: string, ctx: WorkflowRuntimeContext) => ColdWorkflowWatcherHandle;
  driveRun: (runId: string, ctx: WorkflowRuntimeContext) => Promise<RunLoopResult>;
  awaitDrive?: boolean;
  onSkip?: (runId: string, reason: string) => void;
  onAttached?: (run: ColdWorkflowRun) => void;
  onDriveError?: (runId: string, err: unknown) => void;
};

export type AttachColdWorkflowRunsResult = {
  discovered: number;
  attached: string[];
};

/**
 * Daemon cold-start attach path: scan persisted runs owned by this Lark app,
 * attach fan-out watchers, then kick the runtime loop so recovery can settle
 * dangling effects / crashed workers.
 */
export async function attachColdWorkflowRunsForDaemon(
  opts: AttachColdWorkflowRunsOptions,
): Promise<AttachColdWorkflowRunsResult> {
  const runs = await scanColdWorkflowRuns({
    runsDir: opts.runsDir,
    ownerLarkAppId: opts.ownerLarkAppId,
    onSkip: opts.onSkip,
  });
  const attached: string[] = [];

  for (const run of runs) {
    if (opts.isAttached?.(run.runId)) continue;
    const log = new EventLog(run.runId, opts.runsDir);
    const ctx = opts.makeContext(run, log);
    const watcher = opts.attachWatcher(run.runId, ctx);
    try {
      await watcher.ready;
    } catch (err) {
      opts.onSkip?.(
        run.runId,
        `watcher-start-failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    attached.push(run.runId);
    opts.onAttached?.(run);

    const driven = opts.driveRun(run.runId, ctx);
    if (opts.awaitDrive) {
      await driven;
    } else {
      driven.catch((err) => opts.onDriveError?.(run.runId, err));
    }
  }

  return { discovered: runs.length, attached };
}
