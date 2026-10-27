/**
 * One round of the orphan sandbox-tree sweep (daemon bootstrap + periodic
 * reconciler).
 *
 * `<dataDir>/sandboxes/<sid>` and the scratch slots are machine-wide: every bot
 * daemon runs on the same dataDir. A tree whose session is still ACTIVE must
 * survive even with no live process — the session may be suspended or waiting
 * for a cold resume, and its outbox/shim/deny-mask (or a scratch upper layer,
 * the only copy of the agent's work) is what that resume reattaches. So the
 * protection set is every bot's active rows, not just this daemon's sessions:
 * protecting only our own let any bot's sweep reclaim another bot's suspended
 * session tree (#2031).
 *
 * Fail-closed: if the cross-bot active set cannot be read completely, the
 * round is skipped — leaving residue for one more round is harmless, deleting
 * a live session's tree is not.
 */
import { sweepOrphanSandboxes } from '../adapters/backend/sandbox.js';
import { sweepOrphanScratchSandboxes } from '../adapters/backend/scratch-sandbox.js';
import { sweepOrphanMacScratchSandboxes } from '../adapters/backend/scratch-sandbox-darwin.js';
import { listActiveSessionIdsAcrossStores } from '../services/session-store.js';

export type SandboxOrphanSweep = (dataDir: string, protectedSessionIds: Set<string>) => void;

const DEFAULT_SWEEPS: readonly SandboxOrphanSweep[] = [
  sweepOrphanSandboxes,
  (dataDir, ids) => sweepOrphanScratchSandboxes(dataDir, ids),
  sweepOrphanMacScratchSandboxes,
];

export interface SandboxOrphanSweepOptions {
  dataDir: string;
  /** This daemon's in-memory sessions: covers a row not yet visible on disk. */
  ownActiveSessionIds: Iterable<string>;
  /** Log prefix, e.g. `sandbox-sweep` (bootstrap) / `sandbox-reconcile` (timer). */
  label: string;
  warn: (message: string) => void;
  /** Tests only. */
  readActiveAcrossStores?: (dataDir: string) => Set<string>;
  /** Tests only: the real Linux scratch slot pass is host-wide. */
  sweeps?: readonly SandboxOrphanSweep[];
}

export function runSandboxOrphanSweep(opts: SandboxOrphanSweepOptions): 'swept' | 'skipped' {
  let protectedIds: Set<string>;
  try {
    protectedIds = (opts.readActiveAcrossStores ?? listActiveSessionIdsAcrossStores)(opts.dataDir);
  } catch (err) {
    opts.warn(`[${opts.label}] skipped: cannot read every bot's active sessions: ${err instanceof Error ? err.message : String(err)}`);
    return 'skipped';
  }
  for (const id of opts.ownActiveSessionIds) protectedIds.add(id);
  for (const sweep of opts.sweeps ?? DEFAULT_SWEEPS) {
    try {
      sweep(opts.dataDir, protectedIds);
    } catch (err) {
      opts.warn(`[${opts.label}] failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return 'swept';
}
