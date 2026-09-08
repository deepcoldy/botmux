/**
 * Runtime-aware child-process spawn for TESTS.
 *
 * WHY: 42 test files hardcoded `spawn(process.execPath, ['--import', 'tsx',
 * <script>, …])`. That is a NODE-ONLY invocation: under Bun `process.execPath`
 * is the bun binary and `bun --import tsx` is not a valid form, so every one of
 * those children fails to start. Since dev/CI now run under Bun as well, the
 * spawn shape has to be resolved from the runtime instead of assumed.
 *
 * The contract (both verified by running them, not assumed):
 *   • Node: `node --import tsx script.ts args…`  (tsx transpiles TypeScript)
 *   • Bun:  `bun script.ts args…`                (native TS, no loader flag)
 * Both put the script and its args in the same argv positions and produce the
 * same stdout, so a caller only has to swap the command+prefix — which is all
 * this module does.
 *
 * Inline evaluation differs the same way:
 *   • Node: `node --input-type=module -e <src>`
 *   • Bun:  `bun -e <src>`
 *
 * This mirrors `src/core/self-spawn.ts`, which solved the identical problem for
 * production spawns. Kept as a separate test helper because the production one
 * resolves *botmux entry modules* by name (and re-execs a compiled binary via
 * hidden `__subcommand` tokens), whereas tests spawn arbitrary script paths and
 * inline snippets.
 *
 * `stdio` and every other SpawnOptions field are passed through untouched — some
 * tests rely on an `'ipc'` slot, and Node-IPC parity under Bun's
 * `spawn(execPath, …, {stdio:[…,'ipc']})` is exactly what self-spawn.ts verified.
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** PATH can contain a DIRECTORY named `node` (mise/n layout). Directories are
 *  X_OK on Unix ("searchable"), so accessSync alone would return them and
 *  posix_spawn then dies with EACCES. */
function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** True when the current test process is running under Bun rather than Node. */
export function isBunRuntime(): boolean {
  // @ts-ignore — the Bun global is absent under Node/tsc.
  return typeof Bun !== 'undefined';
}

/**
 * Command + leading args that run a TypeScript/JavaScript FILE as a child of the
 * current runtime. Callers append the script path and its arguments.
 *
 * Node yields `['--import','tsx']`; Bun yields `[]`.
 */
export function tsRunnerPrefix(): { command: string; prefixArgs: string[] } {
  return isBunRuntime()
    ? { command: process.execPath, prefixArgs: [] }
    : { command: process.execPath, prefixArgs: ['--import', 'tsx'] };
}

/**
 * Command + args that evaluate an inline ES-module source string.
 *
 * Node needs `--input-type=module` for `-e` to be treated as ESM; Bun does not.
 *
 * ⚠️ IMPORTANT — this alone is only enough for a SELF-CONTAINED snippet (one that
 * imports nothing from this repo, or only Node built-ins). If the snippet imports
 * a repo module through a `.js` specifier that is really a `.ts` file on disk
 * (the convention across `src/`), Node still needs the tsx loader: verified that
 * `node --input-type=module -e "import … from './src/core/data-dir.js'"` dies with
 * `ERR_MODULE_NOT_FOUND`, and adding `--import tsx` fixes it. Bun resolves it
 * natively either way.
 *
 * For that case combine both helpers — take the loader prefix AND the eval args:
 *
 *   const { command, prefixArgs } = tsRunnerPrefix();
 *   const { args } = tsEvalArgs(src);
 *   spawn(command, [...prefixArgs, ...args], opts);
 */
export function tsEvalArgs(source: string): { command: string; args: string[] } {
  return isBunRuntime()
    ? { command: process.execPath, args: ['-e', source] }
    : { command: process.execPath, args: ['--input-type=module', '-e', source] };
}

/**
 * Spawn a TS/JS script file under the current runtime.
 *
 * Replaces `spawn(process.execPath, ['--import','tsx', script, ...args], opts)`.
 */
export function spawnTsScript(
  script: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const { command, prefixArgs } = tsRunnerPrefix();
  return spawn(command, [...prefixArgs, script, ...args], options);
}

/** Synchronous variant of {@link spawnTsScript}. */
export function spawnSyncTsScript(
  script: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const { command, prefixArgs } = tsRunnerPrefix();
  return spawnSync(command, [...prefixArgs, script, ...args], options);
}

/** Spawn an inline ES-module snippet under the current runtime.
 *
 *  Only for SELF-CONTAINED snippets (no repo imports) — see the warning on
 *  {@link tsEvalArgs}. Use {@link spawnTsEvalWithRepoImports} when the snippet
 *  imports repo modules via `.js` specifiers. */
export function spawnTsEval(source: string, options: SpawnOptions = {}): ChildProcess {
  const { command, args } = tsEvalArgs(source);
  return spawn(command, args, options);
}

/** Synchronous variant of {@link spawnTsEval} (self-contained snippets only). */
export function spawnSyncTsEval(
  source: string,
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const { command, args } = tsEvalArgs(source);
  return spawnSync(command, args, options);
}

/**
 * Spawn an inline snippet that DOES import repo modules (via `.js` specifiers
 * that resolve to `.ts` on disk). Adds the loader prefix Node needs on top of
 * the eval args; a no-op extra on Bun, which resolves TypeScript natively.
 */
export function spawnTsEvalWithRepoImports(source: string, options: SpawnOptions = {}): ChildProcess {
  const { command, prefixArgs } = tsRunnerPrefix();
  const { args } = tsEvalArgs(source);
  return spawn(command, [...prefixArgs, ...args], options);
}

/** Synchronous variant of {@link spawnTsEvalWithRepoImports}. */
export function spawnSyncTsEvalWithRepoImports(
  source: string,
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const { command, prefixArgs } = tsRunnerPrefix();
  const { args } = tsEvalArgs(source);
  return spawnSync(command, [...prefixArgs, ...args], options);
}

/**
 * Node binary for tests that must spawn Node, not the current runtime.
 *
 * PM2, shebang `#!/usr/bin/env node` scripts, and fixtures that assert
 * `comm === "node"` are Node programs. Under `bun test`, `process.execPath` is
 * the bun binary — handing it to those children is a dual-runtime bug, not a
 * platform difference. CI's bun-test job still runs `actions/setup-node`, so
 * `node` is on PATH there as well as on a developer Mac.
 *
 * When the test process already IS Node, execPath is the right answer (it is
 * the same binary vitest used, including version managers).
 */
export function resolveNodeExecutable(pathValue: string = process.env.PATH ?? ''): string | undefined {
  if (!isBunRuntime()) return process.execPath;
  const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Always Node + tsx, even when the test process is bun.
 *
 * Worker / PTY / shebang fixtures are Node programs (`node-pty`,
 * `#!/usr/bin/env node`). Driving them with `bun src/worker.ts` is a different
 * runtime: CI measured the fake CLI child getting SIGHUP (signal 1) and a
 * blank session-picker TUI. CI's bun-test job still installs Node.
 */
export function nodeTsRunnerPrefix(pathValue: string = process.env.PATH ?? ''): { command: string; prefixArgs: string[] } {
  const nodeBin = resolveNodeExecutable(pathValue);
  if (!nodeBin) {
    throw new Error('node not found on PATH; this test needs a real Node executable');
  }
  return { command: nodeBin, prefixArgs: ['--import', 'tsx'] };
}

/** Spawn a TS/JS script under Node+tsx regardless of the parent runtime. */
export function spawnNodeTsScript(
  script: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  const { command, prefixArgs } = nodeTsRunnerPrefix();
  return spawn(command, [...prefixArgs, script, ...args], options);
}

/** Resolve an executable Bun from the inherited PATH without invoking a shell. */
export function resolveBunExecutable(pathValue: string = process.env.PATH ?? ''): string | undefined {
  const names = process.platform === 'win32' ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun'];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Spawn an inline repo-importing snippet under Bun even when the parent test
 * process runs under Node. Use only for behavior that is specifically Bun-only.
 */
export function spawnSyncBunTsEvalWithRepoImports(
  source: string,
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  const command = resolveBunExecutable();
  if (!command) {
    throw new Error('bun not found on PATH; cannot run the required Bun-specific regression');
  }
  return spawnSync(command, ['-e', source], options);
}
