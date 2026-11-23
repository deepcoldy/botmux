import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSecureHostFileSync, writeSecureHostFileSync } from '../platform/secure-host-file.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { isCanonicalStableVersion } from './update-check.js';
import { checkoutDirFromWrapperText } from '../utils/local-dev-update.js';

export type SourceReleaseInstallState = 'prepared' | 'installed' | 'cancelled' | 'completed';

export interface SourceReleaseInstallRecord {
  /** Distinguishes two prepared records even when every launcher field matches. */
  id: string;
  state: SourceReleaseInstallState;
  version: string;
  target: string;
  /** Canonical running checkout whose dashboard owns this pending handoff. */
  sourceRoot: string;
  /** Canonical checkout parsed from the launcher being replaced, if it had one. */
  launcherRoot: string | null;
  backupLauncher: string | null;
  originalFingerprint: string | null;
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function canonicalRoot(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function fingerprint(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('source_release_launcher_changed');
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sourceLauncherRoot(path: string): string | null {
  try {
    const root = lstatSync(path).size < 64 * 1024
      ? checkoutDirFromWrapperText(readFileSync(path, 'utf8')) : null;
    return root ? canonicalRoot(root) : null;
  } catch { return null; }
}

function isTerminal(record: SourceReleaseInstallRecord): boolean {
  return record.state === 'cancelled' || record.state === 'completed';
}

/** Caller holds the shared install lock. Source files and dependencies are never changed. */
export class SourceReleaseInstall {
  readonly target: string;
  private readonly marker: string;
  private readonly stateLock: string;
  private recovered: { key: string; record: SourceReleaseInstallRecord | undefined } | undefined;

  constructor(private readonly home: string = homedir()) {
    this.target = join(home, '.botmux', 'bin', 'botmux');
    this.marker = join(home, '.botmux', '.source-release-install.json');
    // Short metadata critical sections only. The install lock is deliberately not
    // held by recovery: it remains held for the whole download, and status polling
    // must still be able to observe/recover the prepared→installed crash window.
    this.stateLock = join(home, '.botmux', '.source-release-install-state');
  }

  private locked<T>(fn: () => T): T {
    // Recovery verifies the candidate in this critical section. The production
    // verifier has a 30s spawn timeout; waiters must not turn a valid install
    // into FILE_LOCK_TIMEOUT while that probe is still running.
    return withFileLockSync(this.stateLock, fn, { maxWaitMs: 35_000 });
  }

  private readRecord(): { raw: string; record: SourceReleaseInstallRecord } | undefined {
    const raw = readSecureHostFileSync(this.marker, 16_384);
    if (!raw) return undefined;
    let record: SourceReleaseInstallRecord;
    try { record = JSON.parse(raw); } catch { fail('source_release_record_invalid'); }
    if (!record || typeof record.id !== 'string' || !record.id || record.id.length > 64
      || !['prepared', 'installed', 'cancelled', 'completed'].includes(record.state)
      || record.target !== this.target || !isCanonicalStableVersion(record.version)
      || typeof record.sourceRoot !== 'string'
      || !(record.launcherRoot === null || typeof record.launcherRoot === 'string')
      || !(record.backupLauncher === null || typeof record.backupLauncher === 'string')
      || !(record.originalFingerprint === null || /^[a-f0-9]{64}$/.test(record.originalFingerprint))) {
      fail('source_release_record_invalid');
    }
    return { raw, record };
  }

  private writeRecord(record: SourceReleaseInstallRecord): SourceReleaseInstallRecord {
    writeSecureHostFileSync(this.marker, JSON.stringify(record));
    this.recovered = undefined;
    return record;
  }

  private prepare(version: string, sourceRoot: string): SourceReleaseInstallRecord {
    return this.locked(() => {
      const originalFingerprint = fingerprint(this.target);
      const launcherRoot = sourceLauncherRoot(this.target);
      const runningRoot = canonicalRoot(sourceRoot);
      const previous = this.readRecord()?.record;
      // A direct A→C checkout switch can strand A's record after A disappears.
      // A new install by the checkout that now owns the launcher explicitly
      // supersedes it. Keep this exception here (under the global install lock),
      // not in read-only recovery, which still fails closed on foreign launchers.
      const replacementOwnsLauncher = launcherRoot !== null && launcherRoot === runningRoot;
      if (previous && !isTerminal(previous) && !replacementOwnsLauncher
        && previous.originalFingerprint !== originalFingerprint && launcherRoot !== previous.launcherRoot) {
        fail('source_release_restart_required');
      }
      let backupLauncher: string | null = null;
      if (originalFingerprint !== null) {
        const backupDir = join(this.home, '.botmux', 'source-update-backups', randomUUID());
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        backupLauncher = join(backupDir, 'launcher');
        copyFileSync(this.target, backupLauncher);
        chmodSync(backupLauncher, 0o700);
        if (fingerprint(backupLauncher) !== originalFingerprint) fail('source_release_launcher_changed');
      }
      return this.writeRecord({
        id: randomUUID(), state: 'prepared', version, target: this.target,
        sourceRoot: runningRoot, launcherRoot, backupLauncher, originalFingerprint,
      });
    });
  }

  private markInstalled(prepared: SourceReleaseInstallRecord): SourceReleaseInstallRecord {
    return this.locked(() => {
      const current = this.readRecord()?.record;
      if (!current || current.id !== prepared.id) fail('source_release_launcher_changed');
      // Completion by the already-running candidate is a successful post-swap
      // outcome, not launcher drift. Cancellation still means the user restored
      // the source launcher and must not be overwritten by a late success.
      if (current.state === 'completed') return current;
      if (current.state === 'cancelled') fail('source_release_launcher_changed');
      // A second dashboard may already have recovered the post-swap/pre-response
      // window and performed this same transition.
      if (current.state === 'installed') return current;
      return this.writeRecord({ ...current, state: 'installed' });
    });
  }

  private cleanupFailedInstall(prepared: SourceReleaseInstallRecord): void {
    this.locked(() => {
      const current = this.readRecord()?.record;
      if (!current || current.id !== prepared.id || isTerminal(current)) return;
      // Keep a prepared record if installation already changed the launcher;
      // recovery will verify the candidate before reporting it as installed.
      if (fingerprint(this.target) === prepared.originalFingerprint) rmSync(this.marker, { force: true });
      this.recovered = undefined;
    });
  }

  async install(
    version: string,
    sourceRoot: string,
    install: (target: string, beforeSwap: () => void) => Promise<void>,
  ): Promise<SourceReleaseInstallRecord> {
    if (!isCanonicalStableVersion(version)) fail('source_release_invalid_version');
    const prepared = this.prepare(version, sourceRoot);
    try {
      await install(this.target, () => {
        if (fingerprint(this.target) !== prepared.originalFingerprint) fail('source_release_launcher_changed');
      });
      return this.markInstalled(prepared);
    } catch (error) {
      this.cleanupFailedInstall(prepared);
      throw error;
    }
  }

  /** Recover a lost run→restart response without trusting a stale path or version. */
  recover(sourceRoot: string, verifyBinary: (target: string, version: string) => string): SourceReleaseInstallRecord | undefined {
    return this.locked(() => {
      const stored = this.readRecord();
      if (!stored || isTerminal(stored.record)) return undefined;
      const { raw, record } = stored;
      if (record.sourceRoot !== canonicalRoot(sourceRoot)) return undefined;
      let stat;
      try { stat = lstatSync(this.target); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && record.originalFingerprint === null) return undefined;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) fail('source_release_launcher_changed');
      const key = `${raw}:${stat.ino}:${stat.size}:${stat.ctimeMs}:${stat.mtimeMs}`;
      if (this.recovered?.key === key) return this.recovered.record;
      if (fingerprint(this.target) === record.originalFingerprint) {
        // A prepared record with the original launcher can still belong to an
        // in-flight download. Only an already-installed handoff is safe to retire
        // on this branch; prepared recovery must remain crash-safe.
        if (record.state === 'installed') this.writeRecord({ ...record, state: 'cancelled' });
        this.recovered = { key, record: undefined };
        return undefined;
      }
      // Restoring the checkout that the ORIGINAL launcher pointed at cancels the
      // pending switch, even when the running dashboard belongs to another root.
      const launcherRoot = sourceLauncherRoot(this.target);
      if (launcherRoot !== null && launcherRoot === record.launcherRoot) {
        this.writeRecord({ ...record, state: 'cancelled' });
        this.recovered = { key, record: undefined };
        return undefined;
      }
      if (launcherRoot !== null) fail('source_release_launcher_changed');
      if (verifyBinary(this.target, record.version) !== record.version) fail('source_release_launcher_changed');
      const installed = record.state === 'prepared' ? this.writeRecord({ ...record, state: 'installed' }) : record;
      const installedRaw = installed === record ? raw : JSON.stringify(installed);
      this.recovered = { key: `${installedRaw}:${stat.ino}:${stat.size}:${stat.ctimeMs}:${stat.mtimeMs}`, record: installed };
      return installed;
    });
  }

  /** Retire the handoff once the installed version is running from the target. */
  complete(executablePath: string, standalone: boolean, runningVersion: string): void {
    if (!standalone) return;
    this.locked(() => {
      const current = this.readRecord()?.record;
      if (!current || isTerminal(current)) return;
      if (canonicalRoot(current.target) !== canonicalRoot(executablePath)) return;
      if (runningVersion !== current.version) return;
      // An older standalone dashboard can share this target with a source
      // dashboard that is still downloading. A prepared record is completable
      // only after the launcher changed (the post-swap/pre-response crash window),
      // never merely because an already-running binary has the requested version.
      if (current.state === 'prepared' && fingerprint(this.target) === current.originalFingerprint) return;
      this.writeRecord({ ...current, state: 'completed' });
    });
  }
}
