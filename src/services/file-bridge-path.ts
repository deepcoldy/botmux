/**
 * Pure path lookup for file-based structured-bridge CLIs (JSONL / events).
 *
 * Converges the duplicated isCoco/isPi/isGrok/isTraex/codex switch trees in
 * the worker timer + notify paths. Does NOT own attach mode, watchers, or
 * SQLite bridges (hermes/mtr) — those stay on dedicated worker paths.
 *
 * Discovery is declared by each adapter (`CliAdapter.bridgeSpec.locate`,
 * resolved statelessly through `bridgeSpecFor`); this module only owns the
 * shared lookup order: sessionId (when provided) first, then pid. Returns the
 * first existing path, or undefined.
 */
import { bridgeSpecFor } from '../adapters/cli/registry.js';

export interface FileBridgePathOpts {
  sessionId?: string;
  cwd?: string;
  pid?: number;
}

/** Resolve a transcript/events path for a file-backed structured-bridge CLI. */
export function resolveFileBridgePath(
  cliId: string | undefined,
  opts: FileBridgePathOpts,
): string | undefined {
  const spec = bridgeSpecFor(cliId);
  if (!spec) return undefined;
  const { sessionId, cwd, pid } = opts;

  if (sessionId) {
    const bySid = spec.locate.bySessionId(sessionId, cwd);
    if (bySid) return bySid;
  }
  if (pid != null && Number.isInteger(pid) && pid > 0) {
    return spec.locate.byPid?.(pid);
  }
  return undefined;
}
