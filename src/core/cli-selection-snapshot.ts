import type { CliId } from '../adapters/cli/types.js';
import { resolveCliRuntime, snapshotCliRuntime } from '../adapters/cli/runtime.js';
import type { SessionCliLaunchSnapshotV1 } from '../types.js';

/** Pending per-session CLI choice; the next fork resolves it onto the session. */
export function cliSelectionSnapshot(cliId: CliId): SessionCliLaunchSnapshotV1 {
  const runtime = snapshotCliRuntime(resolveCliRuntime({
    cliId,
    context: `CLI selection ${cliId}`,
  }));
  return {
    version: 1,
    state: 'pending',
    entryId: cliId,
    cliId,
    cliRuntime: runtime ?? null,
    cliPathOverride: runtime?.source === 'configured' || runtime?.source === 'legacy-path' ? runtime.executable : null,
    wrapperCli: null,
    cliLaunchMode: null,
    model: null,
    reasoningEffort: null,
    modelBackendVariant: null,
    launchShell: null,
    startupCommands: [],
  };
}
