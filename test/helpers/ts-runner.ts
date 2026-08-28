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
