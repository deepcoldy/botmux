import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync, FileLockTimeoutError, type FileLockOptions } from '../utils/file-lock.js';
import type { BotmuxWrapperFile } from './botmux-wrapper.js';

export interface WriteBotmuxWrapperFilesOptions {
  binDir: string;
  files: BotmuxWrapperFile[];
  runningExecutable: string;
  /** The same globalInstallUpdateLockTarget() used by release installation. */
  lockTarget: string;
  /** Test/deployment override; production normally uses the file-lock default. */
  lockOptions?: FileLockOptions;
}

export interface BotmuxWrapperWriteResult {
  written: string[];
  /** The wrapper is the caller's running executable. */
  skipped: string[];
  /** Another operation changed this launcher while the caller waited for the lock. */
  deferred: string[];
}

function launcherIdentity(path: string, stat: Stats): string {
  // Atomic wrapper/binary replacement changes the inode. Hash small regular
  // files too, so an in-place edit cannot masquerade as the original generation.
  const digest = stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024
    ? createHash('sha256').update(readFileSync(path)).digest('hex') : '';
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, digest].join(':');
}

function observeLauncher(path: string): string {
  try {
    const stat = lstatSync(path);
    const own = launcherIdentity(path, stat);
    if (!stat.isSymbolicLink()) return own;
    // atomicWriteFileSync resolves a symlink and replaces its TARGET. Observing
    // only the link's lstat would miss exactly that replacement while we wait.
    const linkText = readlinkSync(path);
    try {
      const resolved = realpathSync(path);
      return `${own}->${resolved}:${launcherIdentity(resolved, lstatSync(resolved))}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${own}->${linkText}:missing`;
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

function observeLaunchers(options: WriteBotmuxWrapperFilesOptions): Map<string, string> {
  return new Map(options.files.map(file => [file.name, observeLauncher(join(options.binDir, file.name))]));
}

function writeObservedLaunchers(
  options: WriteBotmuxWrapperFilesOptions,
  observed: Map<string, string>,
): BotmuxWrapperWriteResult {
  mkdirSync(options.binDir, { recursive: true });
  return withFileLockSync(options.lockTarget, () => {
    const written: string[] = [];
    const skipped: string[] = [];
    const deferred: string[] = [];
    for (const file of options.files) {
      const wrapper = join(options.binDir, file.name);
      const isMainWrapper = file.name === 'botmux' || file.name === 'botmux.cmd';
      // install.sh places the compiled binary at the main wrapper path. Never
      // replace that running executable with its own tiny shell launcher.
      let isRunningBinary = false;
      try {
        isRunningBinary = isMainWrapper
          && realpathSync(wrapper) === realpathSync(options.runningExecutable);
      } catch { /* wrapper absent or unreadable → not the running binary */ }
      if (isRunningBinary) {
        skipped.push(wrapper);
        continue;
      }
      const currentState = observeLauncher(wrapper);
      if (observed.get(file.name) !== currentState) {
        // A delayed daemon boot must not replay its stale source launcher over a
        // release installed while it waited. Another writer may already have
        // installed our desired content, in which case there is nothing to do.
        let desiredAlreadyPresent = false;
        try {
          const current = statSync(wrapper);
          if (current.isFile() && current.size <= 64 * 1024) {
            desiredAlreadyPresent = readFileSync(wrapper, 'utf-8') === file.content;
          }
        } catch { /* a concurrent removal is still a changed generation */ }
        if (!desiredAlreadyPresent) deferred.push(wrapper);
        continue;
      }
      let existing = '';
      try { existing = readFileSync(wrapper, 'utf-8'); } catch { /* first boot */ }
      if (existing !== file.content) {
        // Atomic: CLI sessions can exec this wrapper at any time.
        atomicWriteFileSync(wrapper, file.content, { mode: file.mode });
        written.push(wrapper);
      }
    }
    return { written, skipped, deferred };
  }, options.lockOptions);
}

/**
 * Materialize daemon wrappers while holding the global installation lock.
 * The generation snapshot is taken BEFORE waiting: if another operation changed
 * the launcher in that window, this automatic daemon write is abandoned rather
 * than overwriting the winner. Explicit `use:here` intentionally has different
 * semantics and does not use this automatic-write helper.
 */
export function writeBotmuxWrapperFiles(options: WriteBotmuxWrapperFilesOptions): BotmuxWrapperWriteResult {
  return writeObservedLaunchers(options, observeLaunchers(options));
}

export interface WriteBotmuxWrapperFilesRetryOptions extends WriteBotmuxWrapperFilesOptions {
  retryDelayMs?: number;
  onResult?: (result: BotmuxWrapperWriteResult) => void;
  onError: (error: unknown) => void;
}

/**
 * Retry only lock contention after the holder releases. The ORIGINAL generation
 * snapshot is reused across every retry, so a delayed retry can never overwrite
 * a release installed after this daemon first attempted its wrapper write.
 */
export function writeBotmuxWrapperFilesWithRetry(
  options: WriteBotmuxWrapperFilesRetryOptions,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let observed: Map<string, string> | undefined;
  const attempt = (): void => {
    timer = undefined;
    if (stopped) return;
    let result: BotmuxWrapperWriteResult;
    try {
      observed ??= observeLaunchers(options);
      result = writeObservedLaunchers(options, observed);
    } catch (error) {
      if (stopped) return;
      if (error instanceof FileLockTimeoutError) {
        timer = setTimeout(attempt, options.retryDelayMs ?? 1_000);
        timer.unref();
      } else {
        options.onError(error);
      }
      return;
    }
    options.onResult?.(result);
  };
  attempt();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
