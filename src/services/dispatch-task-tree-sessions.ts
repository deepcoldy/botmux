/**
 * The exact session lookup the dispatch task-tree card wires in the daemon:
 * a narrow root-indexed read across all bot stores (never a full
 * loadAllSessionsSnapshot — a card refresh runs on the per-report hot path),
 * projected to the minimal rows the tree builder consumes.
 *
 * Kept as a separately exported seam so tests exercise the real reader+projection
 * composition (including larkAppId backfill for rows missing it), rather than a
 * test-local listSessions double. `larkAppId` is guaranteed populated here:
 * readSessionsByRoots backfills it from the owning store (disk) or the process
 * app id (memory); callers must not assume raw stored rows carry it.
 */
import type { TaskTreeSessionRow } from '../core/dispatch-task-tree.js';
import { readSessionsByRoots } from './session-store.js';

export function listDispatchTreeSessionRows(
  roots: ReadonlySet<string>,
  dataDir: string,
): TaskTreeSessionRow[] {
  return readSessionsByRoots(roots, { dataDir }).map(s => ({
    sessionId: s.sessionId,
    larkAppId: s.larkAppId,
    rootMessageId: s.rootMessageId,
    status: s.status,
  }));
}
