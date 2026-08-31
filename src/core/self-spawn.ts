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
 * the SAME channel (verified on Bun 1.3.14 and still the pinned behavior on 1.4:
 * bidirectional process.send / on('message') both ways), so worker code that
 * talks over IPC is unchanged.
 */

export type BotmuxEntry =
  | 'core-only' | 'daemon' | 'worker' | 'supervisor' | 'dashboard'
  // CLI-adapter runners. Unlike the entries above these are not fleet processes:
  // an adapter spawns one as the CLI session itself (`resolvedBin` is
  // process.execPath and the runner is argv[0]). They need the same treatment for
  // the same reason — see RUNNER_ENTRIES below.
  | 'codex-app-runner' | 'dsh-runner' | 'mira-runner' | 'mir-runner';

/** Hidden CLI subcommand that runs a given entry inline (see cli.ts dispatch). */
const ENTRY_SUBCOMMAND: Record<BotmuxEntry, string> = {
  'core-only': '__core-only',
  'daemon': '__daemon',
  'worker': '__worker',
  'supervisor': '__supervisor',
  'dashboard': '__dashboard',
  'codex-app-runner': '__codex-app-runner',
  'dsh-runner': '__dsh-runner',
  'mira-runner': '__mira-runner',
  'mir-runner': '__mir-runner',
};

/** dist/<entry>.js filename for the Node path. */
const ENTRY_SCRIPT: Record<BotmuxEntry, string> = {
  'core-only': 'index-core-only.js',
  'daemon': 'index-daemon.js',
  'worker': 'worker.js',
  'supervisor': 'index-supervisor.js',
  'dashboard': 'index-dashboard.js',
  'codex-app-runner': 'codex-app-runner.js',
  'dsh-runner': 'dsh-runner.js',
  'mira-runner': 'mira-runner.js',
  'mir-runner': 'mir-runner.js',
};

/**
 * The CLI-adapter runners, i.e. the entries a `createXAdapter()` launches as the
 * session process rather than as part of the fleet.
 *
 * WHY THEY BELONG HERE: each adapter used to locate its runner by walking up from
 * its own module path (`resolve(here,'..','..','<name>-runner.js')`, plus a
 * dist/ fallback). In the compiled binary `here` is `/$bunfs/root`, so both
 * candidates collapse onto the real filesystem root — MEASURED: `/codex-app-runner.js`
 * and `/dist/codex-app-runner.js`, both `existsSync === false`. `runnerPath()` has
 * no fail-closed branch: it returns the non-existent sibling anyway, the binary
 * re-execs ITSELF with that path as argv[0], normal CLI dispatch does not recognise
 * it, and the process PRINTS HELP AND EXITS 0. The user gets a help dump instead of
 * a session, with nothing logged as an error.
 *
 * Exported so a test can assert every runner is wired end to end (token → dispatch
 * → dist filename) rather than checking one and assuming the rest.
 */
export const RUNNER_ENTRIES: readonly BotmuxEntry[] = [
  'codex-app-runner', 'dsh-runner', 'mira-runner', 'mir-runner',
] as const;

/**
 * The FIRST argv entry an adapter must pass so `resolvedBin` (= process.execPath)
 * becomes the given runner.
 *
 * Compiled binary: the hidden token — `<binary> __mira-runner …`.
 * Node: the script path as the caller resolved it — `<node> …/mira-runner.js …`.
 *
 * A single function instead of four inline ternaries: the adapters are otherwise
 * identical here, and four copies of one predicate is exactly how the three
 * hook-command call sites drifted apart.
 *
 * `scriptPath` is supplied by the caller because each adapter owns its own
 * resolution order (a test-scoped env override, a compiled sibling, a source-tree
 * dist/) and this module stays location-agnostic. Its VALUE is unused in the
 * compiled branch — the argument is still evaluated, as JS is strict about that,
 * so an adapter may pass a path it knows does not exist there but must not put a
 * side effect in the expression that produces it.
 */
export function runnerArgv0(entry: BotmuxEntry, scriptPath: string): string {
  return isStandaloneBinary() ? ENTRY_SUBCOMMAND[entry] : scriptPath;
}

/** True only when running as a `bun build --compile` single-file executable.
 *
 *  `Bun.isStandaloneExecutable` SOUNDS authoritative but WAS unreliable (observed
 *  `undefined` inside a real --compile binary on Bun 1.3.14; Bun 1.4 fixes it —
 *  verified it returns a proper boolean there). We still primarily detect the
 *  embedded-filesystem marker: a compiled binary's entry module lives under the
 *  virtual `/$bunfs/` root, so `process.argv[1]` (and `import.meta`/module paths)
 *  start with it — in BOTH the top-level process and any child we re-exec via
 *  `process.execPath` (verified: the child still reports the /$bunfs/ argv[1]).
 *  We OR the two signals: the flag (now correct on 1.4) plus the marker that also
 *  covered the older Bun — so the check is robust across both pinned and future
 *  Bun versions. */
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

/**
 * Resolve the command + args to run one of OUR OWN ordinary CLI subcommands
 * (`start-bot`, `restart`, …) as a child process.
 *
 * This is the `resolveEntrySpawn` rule applied to the public CLI rather than to a
 * hidden entry token, and it exists because getting it wrong FAILS SILENTLY.
 * Under Node the shape is `node <dist/cli.js> <sub…>`; a single-file executable IS
 * the CLI, so passing a script path shifts the subcommand one slot right, where
 * nothing reads it. MEASURED on the real v3.18.8 binary — the compiled form of
 * `spawn(execPath, [botmuxCliEntry(), 'start-bot', appId, '--json'])` is
 *
 *     <binary> /dist/cli.js start-bot <appId> --json
 *
 * (`botmuxCliEntry()` yields `/dist/cli.js` because `packageRoot()` walks up from
 * `/$bunfs/` to `/`), and the binary PRINTS THE HELP BANNER AND EXITS 0. A caller
 * that reads `code === 0` as success — `dashboard/managed-spawn.ts` does — reports
 * the operation as having worked while nothing happened at all.
 *
 * `scriptPath` is supplied by the caller (each has its own resolution order) and is
 * unused in the compiled branch, exactly as in {@link runnerArgv0}.
 */
export function resolveCliSpawn(
  scriptPath: string,
  subcommand: readonly string[],
): { command: string; args: string[] } {
  if (isStandaloneBinary()) {
    return { command: process.execPath, args: [...subcommand] };
  }
  return { command: process.execPath, args: [scriptPath, ...subcommand] };
}

/** The set of hidden subcommand tokens, so the CLI dispatcher can recognize them. */
export const ENTRY_SUBCOMMANDS: ReadonlySet<string> = new Set(Object.values(ENTRY_SUBCOMMAND));

/**
 * The hidden token a compiled binary is launched with to become a worker, i.e.
 * `<binary> __worker`. Exported because the orphan reaper has to RECOGNIZE that
 * command line in `ps` output: in the compiled form there is no `worker.js` path
 * to match on, and a hardcoded `'__worker'` literal at the matching site would
 * drift away from this map the moment the token changed.
 */
export const WORKER_ENTRY_SUBCOMMAND: string = ENTRY_SUBCOMMAND.worker;

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
 *     which gives the SAME Node IPC channel (verified on Bun 1.3.14, unchanged on
 *     the 1.4 pin: bidirectional process.send / on('message')). execArgv is
 *     dropped (a compiled binary has no
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
