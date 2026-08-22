import { spawn, fork, type ChildProcess, type StdioOptions } from 'node:child_process';
import { join, dirname } from 'node:path';

/**
 * Spawn one of botmux's own entry modules (daemon / core-only / worker /
 * supervisor / dashboard) as a child process, transparently across two runtime
 * shapes:
 *
 *   • Node (npm install, dev): the entry is a real file on disk under dist/, so
 *     we spawn `node dist/<entry>.js` exactly as before — ZERO behavior change.
 *   • Bun single-file executable (`bun build --compile`): there is no dist/ on
 *     disk (everything is bundled inside /$bunfs/), so `node dist/<entry>.js`
 *     cannot work. Instead we re-exec THIS binary (`process.execPath`) with a
 *     hidden subcommand (`__core-only` / `__daemon` / `__worker` / `__supervisor`
 *     / `__dashboard`) that the CLI dispatcher routes to the same entry module,
 *     imported inline.
 *
 * `Bun.isStandaloneExecutable` is the authoritative "am I a compiled binary"
 * check (true only inside `bun build --compile` output; false under `bun run`
 * and undefined under Node). We read it defensively so this module also imports
 * cleanly under Node/tsc where the `Bun` global is absent.
 *
 * IPC parity: `child_process.fork(file)` sets up a Node IPC channel via a magic
 * `ipc` stdio slot. `spawn(execPath, [subcmd], { stdio: [...,'ipc'] })` sets up
 * the SAME channel (verified on Bun 1.3.14: bidirectional process.send /
 * on('message') both ways), so worker code that talks over IPC is unchanged.
 */

export type BotmuxEntry = 'core-only' | 'daemon' | 'worker' | 'supervisor' | 'dashboard';

/** Hidden CLI subcommand that runs a given entry inline (see cli.ts dispatch). */
const ENTRY_SUBCOMMAND: Record<BotmuxEntry, string> = {
  'core-only': '__core-only',
  'daemon': '__daemon',
  'worker': '__worker',
  'supervisor': '__supervisor',
  'dashboard': '__dashboard',
};

/** dist/<entry>.js filename for the Node path. */
const ENTRY_SCRIPT: Record<BotmuxEntry, string> = {
  'core-only': 'index-core-only.js',
  'daemon': 'index-daemon.js',
  'worker': 'worker.js',
  'supervisor': 'index-supervisor.js',
  'dashboard': 'index-dashboard.js',
};

/** True only when running as a `bun build --compile` single-file executable.
 *
 *  `Bun.isStandaloneExecutable` SOUNDS authoritative but is unreliable in
 *  practice (observed `undefined` inside a real --compile binary on Bun 1.3.14),
 *  so we primarily detect the embedded-filesystem marker: a compiled binary's
 *  entry module lives under the virtual `/$bunfs/` root, so `process.argv[1]`
 *  (and `import.meta`/module paths) start with it — in BOTH the top-level process
 *  and any child we re-exec via `process.execPath` (verified: the child still
 *  reports the /$bunfs/ argv[1]). We OR the two signals so a future Bun that
 *  fixes the flag also works. */
export function isStandaloneBinary(): boolean {
  // @ts-ignore — Bun global is absent under Node/tsc; guard at runtime.
  if (typeof Bun !== 'undefined' && Bun.isStandaloneExecutable === true) return true;
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.startsWith('/$bunfs/');
}

/**
 * Resolve the command + leading args to launch a botmux entry.
 * @param entry   which entry module to run
 * @param distDir absolute path to the dist/ directory (Node path only; ignored
 *                for the standalone binary). Callers pass their own `__dirname`-
 *                derived dist path so this module stays location-agnostic.
 */
export function resolveEntrySpawn(entry: BotmuxEntry, distDir: string): { command: string; args: string[] } {
  if (isStandaloneBinary()) {
    return { command: process.execPath, args: [ENTRY_SUBCOMMAND[entry]] };
  }
  return { command: process.execPath, args: [join(distDir, ENTRY_SCRIPT[entry])] };
}

/** The set of hidden subcommand tokens, so the CLI dispatcher can recognize them. */
export const ENTRY_SUBCOMMANDS: ReadonlySet<string> = new Set(Object.values(ENTRY_SUBCOMMAND));

/** Map a hidden subcommand token back to its entry (null if not one). */
export function entryForSubcommand(token: string): BotmuxEntry | null {
  for (const [entry, sub] of Object.entries(ENTRY_SUBCOMMAND)) {
    if (sub === token) return entry as BotmuxEntry;
  }
  return null;
}

/**
 * Fork-equivalent spawn of the worker entry with a Node IPC channel. Used by the
 * worker pool in place of the old direct `fork(dist/worker.js)`.
 *
 *   • Node: uses `child_process.fork(dist/worker.js, [], {execArgv, ...})` —
 *     byte-for-byte the previous behavior, so `execArgv` (heap flags) still apply
 *     and existing tests that mock `child_process.fork` keep intercepting it.
 *   • Standalone binary: there is no dist/worker.js on disk, and `fork` needs a
 *     module file — so use `spawn(process.execPath, ['__worker'], {stdio:[...,'ipc']})`,
 *     which gives the SAME Node IPC channel (verified on Bun 1.3.14: bidirectional
 *     process.send / on('message')). execArgv is dropped (a compiled binary has no
 *     separate interpreter args).
 */
export function spawnWorker(opts: {
  distDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  execArgv?: string[];
  stdio?: StdioOptions;
}): ChildProcess {
  const stdio = opts.stdio ?? ['ignore', 'pipe', 'pipe', 'ipc'];
  if (isStandaloneBinary()) {
    const { command, args } = resolveEntrySpawn('worker', opts.distDir);
    return spawn(command, args, { windowsHide: true, stdio, cwd: opts.cwd, env: opts.env });
  }
  // Node path: keep using fork() so behavior + test mocks are unchanged.
  return fork(join(opts.distDir, ENTRY_SCRIPT.worker), [], {
    windowsHide: true,
    stdio,
    execArgv: opts.execArgv,
    cwd: opts.cwd,
    env: opts.env,
  } as Parameters<typeof fork>[2]);
}
