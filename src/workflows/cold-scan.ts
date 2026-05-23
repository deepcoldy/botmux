import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { parseWorkflowDefinition, type WorkflowDefinition } from './definition.js';
import { EventLog } from './events/append.js';
import { replay, type Snapshot } from './events/replay.js';
import { getRunsDir } from './runs-dir.js';
import { readRunChatBinding, type RunChatBinding } from './loader.js';

export type ColdWorkflowRun = {
  runId: string;
  def: WorkflowDefinition;
  snapshot: Snapshot;
  binding: RunChatBinding;
};

export type ScanColdWorkflowRunsOptions = {
  runsDir?: string;
  /**
   * Only this daemon should attach runs whose approval cards / IM entrypoint
   * were bound to its Lark app.  CLI-only runs have no chat-binding and are
   * skipped; users can recover those via `botmux workflow resume`.
   */
  ownerLarkAppId: string;
  onSkip?: (runId: string, reason: string) => void;
};

export async function scanColdWorkflowRuns(
  opts: ScanColdWorkflowRunsOptions,
): Promise<ColdWorkflowRun[]> {
  const runsDir = opts.runsDir ?? getRunsDir();
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(runsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: ColdWorkflowRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const dir = join(runsDir, runId);

    let binding: RunChatBinding;
    try {
      binding = await readRunChatBinding(runId, { runDir: dir });
    } catch {
      opts.onSkip?.(runId, 'missing-or-invalid-chat-binding');
      continue;
    }
    if (binding.larkAppId !== opts.ownerLarkAppId) {
      opts.onSkip?.(runId, 'owned-by-another-lark-app');
      continue;
    }

    let def: WorkflowDefinition;
    try {
      const raw = await fs.readFile(join(dir, 'workflow.json'), 'utf-8');
      def = parseWorkflowDefinition(JSON.parse(raw));
    } catch (err) {
      opts.onSkip?.(
        runId,
        `invalid-workflow-json: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    let snapshot: Snapshot;
    try {
      const log = new EventLog(runId, runsDir);
      const events = await log.readAll();
      if (events.length === 0) {
        opts.onSkip?.(runId, 'empty-event-log');
        continue;
      }
      snapshot = replay(events);
    } catch (err) {
      opts.onSkip?.(
        runId,
        `unreplayable-event-log: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (
      snapshot.run.status === 'succeeded' ||
      snapshot.run.status === 'failed' ||
      snapshot.run.status === 'cancelled'
    ) {
      opts.onSkip?.(runId, `terminal-${snapshot.run.status}`);
      continue;
    }

    out.push({ runId, def, snapshot, binding });
  }
  return out;
}
