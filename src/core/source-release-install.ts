import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSecureHostFileSync, writeSecureHostFileSync } from '../platform/secure-host-file.js';
import { isCanonicalStableVersion } from './update-check.js';
import { checkoutDirFromWrapperText } from '../utils/local-dev-update.js';

export interface SourceReleaseInstallRecord {
  version: string;
  target: string;
  sourceRoot: string;
  backupLauncher: string | null;
  originalFingerprint: string | null;
}

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
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
    return lstatSync(path).size < 64 * 1024
      ? checkoutDirFromWrapperText(readFileSync(path, 'utf8')) : null;
  } catch { return null; }
}

/** Caller holds the shared install lock. Source files and dependencies are never changed. */
export class SourceReleaseInstall {
  readonly target: string;
  private readonly marker: string;
  private recovered: { key: string; record: SourceReleaseInstallRecord | undefined } | undefined;

  constructor(private readonly home: string = homedir()) {
    this.target = join(home, '.botmux', 'bin', 'botmux');
    this.marker = join(home, '.botmux', '.source-release-install.json');
  }

  private readRecord(): { raw: string; record: SourceReleaseInstallRecord } | undefined {
    const raw = readSecureHostFileSync(this.marker, 16_384);
    if (!raw) return undefined;
    let record: SourceReleaseInstallRecord;
    try { record = JSON.parse(raw); } catch { fail('source_release_record_invalid'); }
    if (!record || record.target !== this.target || !isCanonicalStableVersion(record.version)
      || typeof record.sourceRoot !== 'string'
      || !(record.backupLauncher === null || typeof record.backupLauncher === 'string')
      || !(record.originalFingerprint === null || /^[a-f0-9]{64}$/.test(record.originalFingerprint))) {
      fail('source_release_record_invalid');
    }
    return { raw, record };
  }

  async install(
    version: string,
    sourceRoot: string,
    install: (target: string, beforeSwap: () => void) => Promise<void>,
  ): Promise<SourceReleaseInstallRecord> {
    if (!isCanonicalStableVersion(version)) fail('source_release_invalid_version');
    const originalFingerprint = fingerprint(this.target);
    const previous = this.readRecord()?.record;
    if (previous && previous.originalFingerprint !== originalFingerprint && sourceLauncherRoot(this.target) !== sourceRoot) {
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
    const record = { version, target: this.target, sourceRoot, backupLauncher, originalFingerprint };
    // Prepared before the atomic binary swap: a dashboard crash after rename
    // can recover the installed candidate even if the HTTP response was lost.
    writeSecureHostFileSync(this.marker, JSON.stringify(record));
    this.recovered = undefined;
    try {
      await install(this.target, () => {
        if (fingerprint(this.target) !== originalFingerprint) fail('source_release_launcher_changed');
      });
      return record;
    } catch (error) {
      // Keep a prepared record if installation already changed the launcher;
      // recovery will verify the candidate before reporting it as installed.
      if (fingerprint(this.target) === originalFingerprint) rmSync(this.marker, { force: true });
      throw error;
    }
  }

  /** Recover a lost run→restart response without trusting a stale path or version. */
  recover(sourceRoot: string, verifyBinary: (target: string, version: string) => string): SourceReleaseInstallRecord | undefined {
    const stored = this.readRecord();
    if (!stored) return undefined;
    const { raw, record } = stored;
    if (record.sourceRoot !== sourceRoot) return undefined;
    let stat;
    try { stat = lstatSync(this.target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && record.originalFingerprint === null) return undefined;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('source_release_launcher_changed');
    const key = `${raw}:${stat.ino}:${stat.size}:${stat.ctimeMs}:${stat.mtimeMs}`;
    if (this.recovered?.key === key) return this.recovered.record;
    if (fingerprint(this.target) === record.originalFingerprint) {
      this.recovered = { key, record: undefined };
      return undefined;
    }
    // Explicitly restoring this source runtime cancels the pending switch,
    // including restorations that select a different interpreter path.
    const launcherRoot = sourceLauncherRoot(this.target);
    if (launcherRoot === sourceRoot) return undefined;
    if (launcherRoot !== null) fail('source_release_launcher_changed');
    if (verifyBinary(this.target, record.version) !== record.version) fail('source_release_launcher_changed');
    this.recovered = { key, record };
    return record;
  }
}
