import type { CliId } from '../cli/types.js';
import { cliIdForComm, findLaunchedCliPid, readComm } from '../../core/session-discovery.js';

export type TmuxReattachDecision =
  | { reattach: true }
  | { reattach: false; cleanupStale: boolean; reason?: string };

/** Workflow workers may only reuse a tmux pane when the configured Agent CLI
 * is positively identified in that pane's process tree. Ordinary sessions keep
 * the historical existence-only reattach behavior. */
export function decideTmuxReattach(opts: {
  workflowWorker: boolean;
  sessionExists: boolean;
  targetCliAlive?: boolean;
}): TmuxReattachDecision {
  if (!opts.sessionExists) return { reattach: false, cleanupStale: false };
  if (!opts.workflowWorker) return { reattach: true };
  if (opts.targetCliAlive) return { reattach: true };
  return {
    reattach: false,
    cleanupStale: true,
    reason: 'workflow tmux pane has no live target Agent CLI',
  };
}

export function tmuxPaneHasTargetCli(
  panePid: number | null,
  targetCliId: CliId,
  filterExecutable?: string,
): boolean {
  if (!panePid) return false;
  const comm = readComm(panePid);
  if (comm && cliIdForComm(comm, targetCliId, filterExecutable) === targetCliId) return true;
  return findLaunchedCliPid(panePid, targetCliId, 6, {}, filterExecutable) !== null;
}
