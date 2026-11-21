/**
 * Startup + periodic reconciliation of per-session runtime directories that
 * outlive their session: session scratch (#1748) and MCP Gateway socket
 * directories (#1937), and Riff host-operation receipts. The normal close
 * removes scratch and Gateway state once the worker exits;
 * a daemon crash or SIGKILL, and close paths that bypass the worker pool,
 * leave them for this sweep.
 *
 * Every bot daemon runs on the same data dir, so the protection set is every
 * active row of every bot's store, plus this daemon's in-memory sessions. When
 * that set cannot be read completely the round is skipped: removing a
 * suspended session's scratch loses work, skipping a round loses nothing.
 *
 * Rewind backups (#3572) — the data dir's `rewind-backups/<sessionId>/` and
 * the directories next to transcripts registered when a cut wrote there — go
 * by age and count alone (rewind-backup-retention.ts): they need no
 * protection set and are pruned even in a round skipped for want of one. A
 * cut prunes its own backup directory too; this catches sessions that never
 * rewind again.
 */
import * as sessionStore from '../services/session-store.js';
import { findLiveProcessReferences, type LiveReferenceProbe } from '../utils/dir-process-probe.js';
import { sweepOrphanSessionMcpGatewayDirs } from './plugins/mcp/socket-dir.js';
import { sweepOrphanSessionTempDirs } from './session-temp.js';
import { sweepOrphanRiffHostReceiptDirs } from './riff-host-receipt-cleanup.js';
import { sweepRewindBackups } from './rewind-backup-retention.js';

export interface SessionRuntimeSweepDeps {
  dataDir: string;
  ownActiveSessionIds(): Iterable<string>;
  readAllActiveSessionIds?: (dataDir: string) => ReadonlySet<string>;
  liveReferences?: LiveReferenceProbe;
  sweepScratch?: typeof sweepOrphanSessionTempDirs;
  sweepGateway?: typeof sweepOrphanSessionMcpGatewayDirs;
  sweepRiffReceipts?: typeof sweepOrphanRiffHostReceiptDirs;
  log: { info(message: string): void; warn(message: string): void };
}

/** Single-flight: a slow round never overlaps the next tick. */
export function createSessionRuntimeSweeper(deps: SessionRuntimeSweepDeps): () => Promise<void> {
  const readAll = deps.readAllActiveSessionIds ?? ((dataDir: string) => sessionStore.listActiveSessionIdsAcrossStores(dataDir));
  const liveReferences: LiveReferenceProbe = deps.liveReferences ?? (needles => findLiveProcessReferences(needles));
  const sweepScratch = deps.sweepScratch ?? sweepOrphanSessionTempDirs;
  const sweepGateway = deps.sweepGateway ?? sweepOrphanSessionMcpGatewayDirs;
  const sweepRiffReceipts = deps.sweepRiffReceipts ?? sweepOrphanRiffHostReceiptDirs;
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      try {
        const backups = await sweepRewindBackups(deps.dataDir);
        if (backups.length > 0) deps.log.info(`[runtime-sweep] removed ${backups.length} rewind backup(s) past retention`);
      } catch (error) {
        deps.log.warn(`[runtime-sweep] rewind backup sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      let protectedIds: Set<string>;
      try {
        protectedIds = new Set([...deps.ownActiveSessionIds(), ...readAll(deps.dataDir)]);
      } catch (error) {
        deps.log.warn(`[runtime-sweep] skipped: active sessions of all bots unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const scratch = await sweepScratch(deps.dataDir, protectedIds, { liveReferences });
      const gateway = await sweepGateway(deps.dataDir, protectedIds, { liveReferences });
      const riffReceipts = await sweepRiffReceipts(deps.dataDir, protectedIds, { liveReferences });
      if (scratch.length > 0 || gateway.length > 0 || riffReceipts.length > 0) {
        deps.log.info(`[runtime-sweep] removed ${scratch.length} orphan scratch dir(s), ${gateway.length} orphan Gateway dir(s), ${riffReceipts.length} orphan Riff receipt dir(s)`);
      }
    } catch (error) {
      deps.log.warn(`[runtime-sweep] failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
}
