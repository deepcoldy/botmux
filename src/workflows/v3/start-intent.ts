/** Durable host acknowledgement boundary for daemon-started v3 runs. */

import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { withJournalMutationSync } from './journal.js';
import { readRunEnvelope } from './run-envelope.js';

/**
 * Persist exactly one matching runStarted event before a host returns success
 * or schedules detached execution. A non-empty journal without that identity
 * is corruption, not an invitation to append a new history root.
 *
 * A run whose validated `run.json` pins `nodeExecutor: "bot"` gets that stamp
 * on this one root (the runtime only stamps a journal it finds empty, and
 * this boundary always comes first). A journal rooted earlier without it is
 * left as written (append-only): readers decide from run.json for those.
 */
export function persistV3StartIntent(runId: string, runDir: string): void {
  if (basename(runDir) !== runId) {
    throw new Error(`run directory identity mismatch: directory=${basename(runDir)}, runId=${runId}`);
  }
  const journalPath = join(runDir, 'journal.ndjson');
  // The very first start can arrive concurrently through CLI, IM, or a
  // retried daemon request. The lock file lives beside the journal, so make
  // the already-authorized run directory available before acquiring it.
  mkdirSync(runDir, { recursive: true });
  withJournalMutationSync(journalPath, ({ events, append }) => {
    const starts = events.filter((event) => event.type === 'runStarted');
    if (events.length === 0) {
      // A torn-only physical tail was durably truncated by the mutation
      // boundary. It contained no committed record, so this remains the one
      // history root rather than appending after corrupt bytes.
      append({ type: 'runStarted', runId, ...(pinsBotExecutor(runDir, runId) ? { nodeExecutor: 'bot' as const } : {}) }, { durable: true });
      return;
    }
    if (starts.length !== 1 || starts[0]!.runId !== runId) {
      throw new Error(
        `run journal identity mismatch: expected one runStarted(${runId}), found ` +
        `${starts.map((event) => event.runId).join(', ') || '(none)'}`,
      );
    }
  });
}

/** The validated envelope pins bot execution. Missing / invalid = no stamp
 *  (an invalid envelope is refused by every start path on its own). */
function pinsBotExecutor(runDir: string, runId: string): boolean {
  const read = readRunEnvelope(runDir, runId);
  return read.kind === 'ok' && 'nodeExecutor' in read.envelope && read.envelope.nodeExecutor === 'bot';
}
