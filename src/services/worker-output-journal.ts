import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { mergeOutputReplay, validateOutputSnapshot, isOutputJournalAppId, type OutputSnapshot } from './universal-output-handoff.js';

/** Independent of transcript format, local/remote backend and native queue.
 * No eviction: a failed write must retain the producer's original owner. */
export class WorkerOutputJournal {
  readonly directory: string;
  constructor(dataDir: string, readonly appId: string, readonly sessionId: string) {
    if (!isOutputJournalAppId(appId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error('invalid_output_journal_identity');
    this.directory = join(dataDir, 'worker-final-outputs', appId, sessionId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('unsafe_output_journal');
  }
  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_output_journal_id');
    return join(this.directory, `${id}.json`);
  }
  save(snapshot: OutputSnapshot): void {
    let value = validateOutputSnapshot(this.appId, snapshot);
    if (value.output.sessionId !== this.sessionId) throw new Error('output_journal_session_mismatch');
    const path = this.path(value.id);
    withFileLockSync(path, () => {
      if (existsSync(path)) {
        const previous = this.read(path);
        value = mergeOutputReplay(previous, value);
      }
      atomicWriteFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, durable: true, followTargetSymlink: false });
    });
  }
  remove(snapshot: OutputSnapshot): void {
    const path = this.path(snapshot.id);
    withFileLockSync(path, () => {
      if (!existsSync(path)) return;
      if (this.read(path).fingerprint !== snapshot.fingerprint) throw new Error('output_journal_receipt_mismatch');
      rmSync(path);
    });
  }
  readPending(): OutputSnapshot[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => this.read(join(this.directory, name))).sort((a, b) => a.createdAt - b.createdAt);
  }
  private read(path: string): OutputSnapshot {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_output_journal_record');
    return validateOutputSnapshot(this.appId, JSON.parse(readFileSync(path, 'utf8')));
  }
}
