import * as nodeFs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Bound at first evaluation, from the runners' setup / preload: a test that
// mocks node:fs must not change what the fence resolves.
const { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } = { ...nodeFs };

/**
 * Test-wide systemd fence: no test may reach the host's systemd through
 * `systemd-run`, `busctl` or `systemctl --user`.
 *
 * WHY: every one of those hands the manager a PID or acts on units by name, and
 * a test process is not a place either may come from. Run from a sandbox with
 * its own PID namespace that shares the host's user bus, `systemd-run --user
 * --scope` sends its namespace-local PID and user systemd moves the host
 * process carrying that number into a botmux probe scope (host daemons were
 * found in such scopes, a third of them put there by regression tests); on a
 * plain host the same tests created and stopped real scopes. Scope code takes
 * injectable `run` / `readlink` fakes, and tests use those.
 *
 * Two layers, shared by both runners (vitest setup file, `bun test` preload):
 *   1. in process: node:child_process spawn/exec (and Bun.spawn / spawnSync)
 *      of a program that resolves to the real binary or to a layer-2 shim
 *      throws and is recorded; a recorded call fails the test even when the
 *      code under test swallowed the error. Looked through: `env` (also -S),
 *      timeout / nice / ionice / stdbuf / setsid / nohup / chrt / taskset /
 *      sudo, and shell scripts (`sh -c`, `sh <file>`, the shell option), where
 *      words in command position count, `"$@"` and `$1` included (after any
 *      number of the script's `shift`s). A fake
 *      `systemd-run` first on the child's PATH is not the real one and passes.
 *   2. shims first on PATH: `systemd-run` and `busctl` always exit 1, and
 *      `systemctl` does whenever `--user` is among its arguments (the system
 *      manager's read-only verbs pass through). These cover child processes:
 *      a real worker spawned by an integration test probes scope support and
 *      gets the refusal it would get on a host without a user manager (CI).
 *      A refusal in a child does not fail the test — those probes are
 *      production behaviour, and the child decides by itself.
 * Not covered: a child spawned with a hand-built PATH that drops the shims and
 * then calls systemd itself; in process, a program name a script computes at
 * run time (`$cmd`, eval) or feeds on stdin. Not mounted for the e2e project,
 * whose PM2 migration test drives the user manager on purpose.
 */

const FENCED = new Set(['systemd-run', 'busctl', 'systemctl']);
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
/** Programs that run the command they are given: options that take a separate
 *  value, and how many operands come before the command. */
const WRAPPERS: Record<string, { valued: readonly string[]; operands: number }> = {
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], operands: 1 },
  nice: { valued: ['-n', '--adjustment'], operands: 0 },
  ionice: { valued: ['-c', '--class', '-n', '--classdata'], operands: 0 },
  stdbuf: { valued: ['-i', '--input', '-o', '--output', '-e', '--error'], operands: 0 },
  setsid: { valued: [], operands: 0 },
  nohup: { valued: [], operands: 0 },
  chrt: { valued: [], operands: 1 },
  taskset: { valued: [], operands: 1 },
  sudo: { valued: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user'], operands: 0 },
  // Shell builtins, met in scripts.
  exec: { valued: ['-a'], operands: 0 },
  command: { valued: [], operands: 0 },
  time: { valued: [], operands: 0 },
};
const SHELL_PREFIX_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
const SHIM_DIR_NAME = 'systemd-fence-bin';
const ORIGINALS = Symbol.for('botmux.test.systemdFence.originals');
const GUARDED_APIS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync'] as const;
const SCRIPT_READ_LIMIT = 256 * 1024;

type ChildProcessModule = typeof import('node:child_process');
type GuardedApi = typeof GUARDED_APIS[number] | 'Bun.spawn' | 'Bun.spawnSync';
type Originals = Pick<ChildProcessModule, typeof GUARDED_APIS[number]>;
interface BunSpawners { spawn: (...args: any[]) => any; spawnSync: (...args: any[]) => any }
interface Call { file: string; args: readonly string[]; options: Record<string, any> | undefined; shell: boolean }

let shimDir: string | undefined;
const realBinaries = new Set<string>();
const violations: string[] = [];

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function createShims(binDir: string, pathValue: string | undefined): void {
  const searched = [...(pathValue ?? '').split(delimiter), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin']
    .filter(dir => dir && dir !== binDir && basename(dir) !== SHIM_DIR_NAME);
  let realSystemctl: string | undefined;
  for (const name of FENCED) {
    for (const dir of searched) {
      const candidate = join(dir, name);
      if (!isFile(candidate)) continue;
      try { realBinaries.add(realpathSync(candidate)); } catch { continue; }
      if (name === 'systemctl') realSystemctl ??= candidate;
    }
  }
  mkdirSync(binDir, { recursive: true });
  const refuse = (name: string) => `echo "botmux test systemd fence: refusing ${name} $*" >&2; exit 1`;
  const scripts: Record<string, string> = {
    'systemd-run': `${refuse('systemd-run')}\n`,
    busctl: `${refuse('busctl')}\n`,
    systemctl: `for a in "$@"; do\n  case "$a" in --user) ${refuse('systemctl')} ;; esac\ndone\n`
      + (realSystemctl ? `exec ${shellSingleQuote(realSystemctl)} "$@"\n` : 'echo "systemctl: not found" >&2\nexit 127\n'),
  };
  for (const [name, body] of Object.entries(scripts)) {
    const shim = join(binDir, name);
    writeFileSync(shim, `#!/bin/sh\n# Generated by test/helpers/systemd-fence.ts\n${body}`);
    chmodSync(shim, 0o755);
  }
  shimDir = binDir;
}

function prependShims(binDir: string, env: NodeJS.ProcessEnv): void {
  const parts = (env.PATH ?? '').split(delimiter).filter(part => part && basename(part) !== SHIM_DIR_NAME);
  env.PATH = [binDir, ...parts].join(delimiter);
}

const callCwd = (call: Call): string => (typeof call.options?.cwd === 'string' ? call.options.cwd : process.cwd());

/** What `program` would execute as, looked up the way child_process does. */
function resolveProgram(program: string, call: Call): string | undefined {
  const cwd = callCwd(call);
  if (program.includes('/')) return resolve(cwd, program);
  // An explicit env without PATH makes libuv search its default path.
  const pathValue = call.options?.env ? (call.options.env.PATH ?? '/usr/bin:/bin') : process.env.PATH;
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(cwd, dir, program);
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function reachesSystemd(program: string, call: Call): boolean {
  const resolved = resolveProgram(program, call);
  if (!resolved) return false;
  if (shimDir && dirname(resolved) === shimDir) return true;
  try { return realBinaries.has(realpathSync(resolved)); } catch { return false; }
}

interface Invocation { program: string; args: readonly string[] }

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const unquote = (word: string): string => word.replace(
  /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/g,
  (_match, single?: string, double?: string, escaped?: string) =>
    single ?? (double !== undefined ? double.replace(/\\(.)/g, '$1') : escaped ?? ''),
);

/** Words of one simple shell command, quotes removed and the positional
 *  parameters (`"$@"`, `$*`, `$1`) expanded; nothing else is expanded. */
function shellWords(segment: string, positional: readonly string[]): string[] {
  return (segment.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g) ?? []).flatMap(word => {
    if (/^"?\$[@*]"?$/.test(word)) return positional.slice(1);
    const n = /^"?\$(\d)"?$/.exec(word)?.[1];
    if (n !== undefined) return positional[Number(n)] === undefined ? [] : [positional[Number(n)]];
    return [unquote(word)];
  });
}

/** Index of the command word: past `if`/`do`/…, assignments and redirections. */
function commandIndex(words: readonly string[]): number {
  let i = 0;
  while (i < words.length) {
    if (SHELL_PREFIX_WORDS.has(words[i]) || ASSIGNMENT.test(words[i])) i += 1;
    else if (/^\d*[<>]/.test(words[i])) i += /[<>]$/.test(words[i]) ? 2 : 1;
    else break;
  }
  return i;
}

/** The command of each simple command in a shell script. Splits on operators
 *  even inside quotes, so `"$(systemctl …)"` is seen too. Which of the
 *  `shift`s met so far ran is not tracked: positional parameters are tried
 *  with each count of them shifted away. */
function scriptInvocations(script: string, positional: readonly string[], cwd: string, depth: number): Invocation[] {
  let shifts = 0;
  return script.replace(/\$\{([@*]|\d)\}/g, '$$$1').split(/[;&|\n()`{}]+/).flatMap(segment => {
    const found: Invocation[] = [];
    for (let shifted = 0; shifted <= Math.min(shifts, positional.length); shifted++) {
      const words = shellWords(segment, [positional[0] ?? '', ...positional.slice(1 + shifted)]);
      const i = commandIndex(words);
      if (i < words.length) found.push(...commandInvocations(words[i], words.slice(i + 1), cwd, depth));
    }
    const words = shellWords(segment, []);
    const i = commandIndex(words);
    if (words[i] === 'shift') shifts += Number(words[i + 1]) || 1;
    return found;
  });
}

/** `sh -c script [$0 args…]` or `sh file [args…]`, read from disk. */
function shellInvocations(args: readonly string[], cwd: string, depth: number): Invocation[] {
  let i = 0;
  let inline = false;
  while (i < args.length && /^[-+]./.test(args[i]) && args[i] !== '--') {
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(args[i])) inline = true;
    i += /^[-+]o$/.test(args[i]) ? 2 : 1;
  }
  if (args[i] === '--') i += 1;
  if (i >= args.length) return [];
  if (inline) return scriptInvocations(args[i], args.slice(i + 1), cwd, depth);
  const file = resolve(cwd, args[i]);
  try {
    if (statSync(file).size > SCRIPT_READ_LIMIT) return [];
    return scriptInvocations(readFileSync(file, 'utf8'), args.slice(i), cwd, depth);
  } catch {
    return [];
  }
}

/** The command `env [-i] [-u NAME] [-S 'words'] [NAME=value]… command` runs. */
function envCommand(args: readonly string[]): Invocation | undefined {
  const words = [...args];
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    const separate = word === '-S' || word === '--split-string';
    const split = separate ? words[i + 1] : /^(?:-S|--split-string=)(.+)$/.exec(word)?.[1];
    if (split !== undefined) {
      words.splice(i, separate ? 2 : 1, ...shellWords(split, []));
    } else if (word === '--') {
      i += 1;
      break;
    } else if (word.startsWith('-') || ASSIGNMENT.test(word)) {
      i += ['-u', '--unset', '-C', '--chdir'].includes(word) ? 2 : 1;
    } else {
      break;
    }
  }
  return i < words.length ? { program: words[i], args: words.slice(i + 1) } : undefined;
}

/** The command a WRAPPERS program runs. */
function wrappedCommand(name: string, args: readonly string[]): Invocation | undefined {
  const spec = WRAPPERS[name];
  if (!spec || (name === 'command' && args.some(arg => arg === '-v' || arg === '-V'))) return undefined;
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i].length > 1) {
    if (args[i] === '--') { i += 1; break; }
    i += spec.valued.includes(args[i]) ? 2 : 1;
  }
  while (name === 'sudo' && i < args.length && ASSIGNMENT.test(args[i])) i += 1;
  i += spec.operands;
  return i < args.length ? { program: args[i], args: args.slice(i + 1) } : undefined;
}

function commandInvocations(program: string, args: readonly string[], cwd: string, depth = 0): Invocation[] {
  const found: Invocation[] = [{ program, args }];
  if (depth > 6) return found;
  const name = basename(program);
  const inner = name === 'env' ? envCommand(args) : wrappedCommand(name, args);
  if (inner) found.push(...commandInvocations(inner.program, inner.args, cwd, depth + 1));
  else if (SHELLS.has(name)) found.push(...shellInvocations(args, cwd, depth + 1));
  return found;
}

function check(api: GuardedApi, call: Call): void {
  const invocations = call.shell
    ? scriptInvocations([call.file, ...call.args].join(' '), [], callCwd(call), 0)
    : commandInvocations(call.file, call.args, callCwd(call));
  for (const { program, args } of invocations) {
    const name = basename(program);
    if (!FENCED.has(name) || (name === 'systemctl' && !args.includes('--user'))) continue;
    if (!reachesSystemd(program, call)) continue;
    const attempt = `${api}(${[call.file, ...call.args].join(' ')})`.slice(0, 500);
    violations.push(attempt);
    throw systemdFenceError([attempt]);
  }
}

const asArgs = (value: unknown): readonly string[] | undefined => (Array.isArray(value) ? value.map(String) : undefined);
const asOptions = (value: unknown): Record<string, any> | undefined =>
  (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined);

/** (file, args?, options?, callback?) of spawn / spawnSync / execFile / execFileSync. */
function fileCall([file, second, third]: unknown[]): Call {
  const args = asArgs(second);
  const options = args ? asOptions(third) : asOptions(second);
  return { file: String(file), args: args ?? [], options, shell: !!options?.shell };
}

/** (command, options?, callback?) of exec / execSync: always a shell script. */
function commandCall([command, options]: unknown[]): Call {
  return { file: String(command), args: [], options: asOptions(options), shell: true };
}

function guard<F extends (...args: any[]) => any>(
  api: GuardedApi,
  original: F,
  toCall: (args: unknown[]) => Call,
  prepare: (args: unknown[]) => unknown[] = args => args,
): F {
  const wrap = (target: (...args: any[]) => any) => function (this: unknown, ...args: unknown[]) {
    check(api, toCall(args));
    return target.apply(this, prepare(args));
  };
  const guarded = wrap(original);
  const custom = (original as any)[promisify.custom];
  if (typeof custom === 'function') Object.defineProperty(guarded, promisify.custom, { value: wrap(custom) });
  return guarded as unknown as F;
}

function guardedApis(originals: Originals): Originals {
  return {
    spawn: guard('spawn', originals.spawn, fileCall),
    spawnSync: guard('spawnSync', originals.spawnSync, fileCall),
    execFile: guard('execFile', originals.execFile, fileCall),
    execFileSync: guard('execFileSync', originals.execFileSync, fileCall),
    exec: guard('exec', originals.exec, commandCall),
    execSync: guard('execSync', originals.execSync, commandCall),
  };
}

function pickOriginals(module: Originals): Originals {
  return Object.fromEntries(GUARDED_APIS.map(api => [api, module[api]])) as unknown as Originals;
}

/** Shims in `<root>/systemd-fence-bin`, first on this process's PATH. */
function installShims(root: string): void {
  if (process.platform === 'win32') return;
  const binDir = join(root, SHIM_DIR_NAME);
  createShims(binDir, process.env.PATH);
  prependShims(binDir, process.env);
}

/** Bun.spawn / Bun.spawnSync: (cmd, options?) or ({ cmd, ...options }). */
function bunCall([first, second]: unknown[]): Call {
  const options = asOptions(Array.isArray(first) ? second : first);
  const cmd = asArgs(Array.isArray(first) ? first : options?.cmd) ?? [];
  return { file: cmd[0] ?? '', args: cmd.slice(1), options, shell: false };
}

/** Bun gives a child spawned without `env` the environment Bun started with,
 *  not process.env, and with it a PATH without the shims. */
function withCurrentEnv([first, second, ...rest]: unknown[]): unknown[] {
  if (Array.isArray(first)) {
    const options = asOptions(second);
    return options?.env ? [first, second, ...rest] : [first, { ...options, env: process.env }, ...rest];
  }
  const options = asOptions(first);
  return !options || options.env ? [first, second, ...rest] : [{ ...options, env: process.env }, second, ...rest];
}

/** Patches the builtin module object itself and returns it. Under Node
 *  (syncBuiltinESMExports) named ESM imports, the default import, `require`
 *  and `vi.mock(..., importOriginal)` then all see the guarded functions.
 *  Under Bun the patch reaches `require`, but ESM bindings made before it (an
 *  earlier preload imports the module) keep the originals, so the `bun test`
 *  preload also hands the returned object to `mock.module`, which in turn
 *  misses `require`. Bun's own spawners are guarded here too. */
export function installSystemdFence(root: string): ChildProcessModule {
  installShims(root);
  const cjs = createRequire(import.meta.url)('node:child_process') as ChildProcessModule & { [ORIGINALS]?: Originals };
  // One fork may run several files: guard the originals, never a guard.
  cjs[ORIGINALS] ??= pickOriginals(cjs);
  Object.assign(cjs, guardedApis(cjs[ORIGINALS]));
  syncBuiltinESMExports();
  const bun = (globalThis as { Bun?: BunSpawners & { [ORIGINALS]?: BunSpawners } }).Bun;
  if (bun) {
    bun[ORIGINALS] ??= { spawn: bun.spawn, spawnSync: bun.spawnSync };
    bun.spawn = guard('Bun.spawn', bun[ORIGINALS].spawn, bunCall, withCurrentEnv);
    bun.spawnSync = guard('Bun.spawnSync', bun[ORIGINALS].spawnSync, bunCall, withCurrentEnv);
  }
  return cjs;
}

/** Calls the in-process layer refused since the last take. */
export function takeSystemdFenceViolations(): string[] {
  return violations.splice(0);
}

export function systemdFenceError(attempts: readonly string[]): Error {
  return new Error(
    `systemd test fence refused ${attempts.length} call(s) that would reach the real systemd `
    + '(systemd-run, busctl, systemctl --user); inject a fake run / readlink instead:\n'
    + attempts.join('\n'),
  );
}
