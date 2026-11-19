import { closeSync, openSync, readSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { accessForPath, type FsRule } from '../adapters/cli/fs-policy.js';

/**
 * wrapperCli under the file sandbox: the wrapper is the program the sandbox
 * executes (same namespace and allowlist as the CLI, never outside it).
 *
 * What is let in automatically is deliberately tiny:
 *  - the wrapper's own executable FILE (not its directory) — without it the
 *    sandbox cannot even exec it;
 *  - botmux-generated per-session launch shims (e.g. the aiden x codex shim);
 *  - a `<cli name>` alias in the sandbox's private shim dir pointing at the
 *    real CLI binary that is already allowed, so a wrapper that execs the CLI
 *    by name finds it.
 * Everything else the wrapper needs (its install tree, interpreter, config or
 * profile dirs) must come from the bot's explicit `sandboxPaths`. The
 * preflight below names what is missing instead of letting the pane die with
 * a bare ENOENT.
 */
export interface SandboxWrapperLaunch {
  /** The configured prefix, for messages. */
  wrapperCli: string;
  /** Program the sandbox executes (the wrapper or a botmux launch shim). */
  bin: string;
  args: string[];
  /** The real CLI binary the wrapper eventually runs. */
  cliBin: string;
  /** botmux-generated directories the launch needs (read-only). */
  botmuxOwnedDirs?: string[];
}

export interface WrapperFsIo {
  realpath(p: string): string;
  /** Regular file (after following links). */
  isFile(p: string): boolean;
  /** First bytes of a file, or undefined when unreadable. */
  readHead(p: string): string | undefined;
  /** Resolve a bare command name on the sandbox's effective PATH. */
  which(name: string): string | undefined;
}

export const defaultWrapperFsIo = (which: (name: string) => string | undefined): WrapperFsIo => ({
  realpath: p => realpathSync(p),
  isFile: p => { try { return statSync(p).isFile(); } catch { return false; } },
  readHead: p => {
    // Only the shebang line matters; never read a large binary wrapper whole.
    let fd: number | undefined;
    try {
      fd = openSync(p, 'r');
      const buf = Buffer.alloc(256);
      return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  },
  which,
});

/**
 * A handoff path the sandbox will exec or open: canonical, because the file
 * sandbox's fresh root binds canonical paths only (a symlinked $HOME or
 * install dir does not exist there under its lexical name). Unresolvable
 * values (bare names, missing files) are kept as given.
 */
export function canonicalHandoffPath(p: string, realpath: (p: string) => string = realpathSync): string {
  if (!isAbsolute(p)) return p;
  try { return realpath(p); } catch { return p; }
}

/** Wrapper-binary resolver for a launch that runs inside the sandbox. The
 *  resolver's output is only ever the launch program or the shim → wrapper
 *  handoff, never a CLI argument, so canonicalising it changes no CLI argv. */
export function sandboxHandoffResolver(
  resolve: (bin: string) => string,
  realpath: (p: string) => string = realpathSync,
): (bin: string) => string {
  return bin => canonicalHandoffPath(resolve(bin), realpath);
}

/**
 * The three path choices a wrapper launch makes, in one place so the worker's
 * wiring is testable: where the aiden shim lives, how wrapper binaries are
 * resolved, and which real CLI the shim hands off to. Inside the sandbox all
 * three must be canonical (the fresh root binds canonical paths only); an
 * unsandboxed launch keeps its exact lexical paths.
 */
export function wrapperLaunchWiring(input: {
  insideSandbox: boolean;
  /** Lexical SESSION_DATA_DIR. */
  sessionDataDir: string | undefined;
  /** The worker's identity data dir (canonical under the sandbox). */
  identityDataDir: string | undefined;
  resolveBin: (bin: string) => string;
  realCliBin: string;
  realpath?: (p: string) => string;
}): { shimDataDir: string | undefined; binResolver: (bin: string) => string; aidenCodexRealBin: string } {
  const realpath = input.realpath ?? realpathSync;
  if (!input.insideSandbox) {
    return { shimDataDir: input.sessionDataDir, binResolver: input.resolveBin, aidenCodexRealBin: input.realCliBin };
  }
  return {
    shimDataDir: input.identityDataDir,
    binResolver: sandboxHandoffResolver(input.resolveBin, realpath),
    aidenCodexRealBin: canonicalHandoffPath(input.realCliBin, realpath),
  };
}

/**
 * Whether this spawn builds a wrapper launch to run inside the sandbox.
 * Only local pty/tmux backends wrap a local command in a sandbox. A warm
 * reattach keeps the live pane exactly as it is: attach paths never consume
 * the launch, and building it (the aiden shim install can fail closed) must
 * not be able to refuse a healthy pane.
 */
export function buildsSandboxWrapperLaunch(input: {
  wrapperConfigured: boolean;
  sandboxRequested: boolean;
  backendType: string;
  reattach: boolean;
}): boolean {
  return input.wrapperConfigured && input.sandboxRequested && !input.reattach
    && (input.backendType === 'pty' || input.backendType === 'tmux');
}

/**
 * The sandboxed launch, or undefined when the wrapper did not rewrite it.
 * "Rewritten" is decided by the wrapper builder, not by comparing binaries:
 * a prefix that starts with the CLI's own name (`codex --profile x`) keeps
 * the binary and only adds arguments, and must still run as configured.
 */
export function sandboxWrapperLaunchFrom(input: {
  applied: boolean;
  wrapperCli: string;
  bin: string;
  args: readonly string[];
  cliBin: string;
  aidenCodexShimDir?: string;
}): SandboxWrapperLaunch | undefined {
  if (!input.applied) return undefined;
  return {
    wrapperCli: input.wrapperCli.trim(),
    bin: input.bin,
    args: [...input.args],
    cliBin: input.cliBin,
    ...(input.aidenCodexShimDir ? { botmuxOwnedDirs: [input.aidenCodexShimDir] } : {}),
  };
}

const isUnder = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The executables the wrapper launch itself consists of: the program the
 *  sandbox runs and — when that is a botmux shim — the user's wrapper binary
 *  the shim hands off to (its first absolute argument). */
export function wrapperEntryFiles(launch: SandboxWrapperLaunch): string[] {
  const out = [launch.bin];
  const shimmed = (launch.botmuxOwnedDirs ?? []).some(d => isUnder(launch.bin, d));
  if (shimmed && launch.args[0] && isAbsolute(launch.args[0])) out.push(launch.args[0]);
  return out;
}

/** Files to allow read-only automatically (canonical). */
export function wrapperAutoAllowPaths(launch: SandboxWrapperLaunch, io: Pick<WrapperFsIo, 'realpath' | 'isFile'>): string[] {
  const out = new Set<string>();
  for (const f of wrapperEntryFiles(launch)) {
    // Files only: an entry that resolves to a directory must never open a subtree.
    try { const real = io.realpath(f); if (io.isFile(real)) out.add(real); } catch { /* missing — the preflight reports it */ }
  }
  for (const d of launch.botmuxOwnedDirs ?? []) {
    try { out.add(io.realpath(d)); } catch { /* */ }
  }
  return [...out];
}

export interface WrapperDependency {
  path: string;
  /** Short human reason, e.g. "wrapper 可执行文件" / "脚本解释器 node". */
  what: string;
  /** Directory to suggest adding to sandboxPaths. */
  suggest: string;
}

/** Package root of a file inside node_modules (handles @scope/name). */
function nodePackageRoot(p: string): string | undefined {
  const parts = p.split(sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 1 >= parts.length - 1) return undefined;
  const len = parts[i + 1]!.startsWith('@') ? i + 3 : i + 2;
  return len <= parts.length - 1 ? parts.slice(0, len).join(sep) : undefined;
}

/**
 * What the wrapper needs to start: its entry files, the interpreter of a
 * script entry (`#!/abs/interp` or `#!/usr/bin/env name`), and the package
 * tree of an entry that lives inside node_modules. Best-effort and static —
 * a wrapper's own runtime reads (config, profiles) are not discoverable, the
 * exit hint covers those.
 */
export function wrapperDependencies(launch: SandboxWrapperLaunch, io: WrapperFsIo): WrapperDependency[] {
  const deps: WrapperDependency[] = [];
  const seen = new Set<string>();
  const add = (d: WrapperDependency) => { if (!seen.has(d.path)) { seen.add(d.path); deps.push(d); } };
  for (const entry of wrapperEntryFiles(launch)) {
    let real: string;
    try { real = io.realpath(entry); }
    catch { add({ path: entry, what: 'wrapper 可执行文件（宿主上不存在）', suggest: dirname(entry) }); continue; }
    add({ path: real, what: 'wrapper 可执行文件', suggest: dirname(real) });
    const pkg = nodePackageRoot(real);
    if (pkg) add({ path: pkg, what: 'wrapper 所在的 npm 包', suggest: pkg });
    const head = io.readHead(real);
    const shebang = head?.startsWith('#!') ? head.slice(2).split('\n', 1)[0]!.trim().split(/\s+/) : undefined;
    if (!shebang?.[0]) continue;
    let interp = shebang[0];
    if (basename(interp) === 'env') {
      const name = envCommandName(shebang.slice(1));
      if (!name) continue;  // not statically parseable — leave it to the exit hint
      const found = io.which(name);
      if (!found) { add({ path: name, what: `脚本解释器 ${name}（PATH 上找不到）`, suggest: name }); continue; }
      interp = found;
    }
    let realInterp = interp;
    try { realInterp = io.realpath(interp); } catch { /* keep lexical */ }
    add({ path: realInterp, what: `脚本解释器 ${basename(interp)}`, suggest: dirname(realInterp) });
  }
  return deps;
}

/** Command `env [options] [NAME=VALUE]... COMMAND` would run; undefined when unsure. */
function envCommandName(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '-S' || t === '-i' || t === '-' || t === '--ignore-environment') continue;
    if (t === '-u' || t === '--unset' || t === '-C' || t === '--chdir') { i++; continue; }
    if (t.startsWith('-')) return undefined;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    return t;
  }
  return undefined;
}

/** Dependencies the compiled policy does not let the sandbox read. */
export function uncoveredWrapperDependencies(
  deps: readonly WrapperDependency[],
  rules: readonly FsRule[],
): WrapperDependency[] {
  return deps.filter(d => {
    if (!isAbsolute(d.path)) return true;
    const access = accessForPath(rules, d.path).access;
    return access !== 'readOnly' && access !== 'readWrite';
  });
}

export function wrapperSandboxPreflightError(wrapperCli: string, missing: readonly WrapperDependency[]): string {
  const lines = missing.map(m => `  - ${m.what}: ${m.path}`);
  const suggest = [...new Set(missing.map(m => m.suggest).filter(isAbsolute))];
  return [
    `wrapperCli「${wrapperCli}」在文件沙盒内运行，但它启动需要的路径不在沙盒白名单内：`,
    ...lines,
    suggest.length
      ? `请在该 Bot 的 sandboxPaths.readOnly 加入：${suggest.join('、')}（wrapper 要写的目录放 readWrite），或关闭文件沙盒。`
      : '请确认 wrapper 已安装且在 Bot 的 PATH 上，或关闭文件沙盒。',
  ].join('\n');
}

/**
 * Pre-spawn check for a sandboxed wrapper launch: the readable error, or
 * undefined to proceed. A warm reattach is never refused — the live pane is
 * kept as it is (it may predate wrappers running inside the sandbox), and
 * refusing it would strand a healthy CLI.
 */
export function sandboxWrapperPreflight(input: {
  launch: SandboxWrapperLaunch | undefined;
  reattach: boolean;
  rules: readonly FsRule[];
  io: WrapperFsIo;
}): string | undefined {
  if (!input.launch || input.reattach) return undefined;
  const missing = uncoveredWrapperDependencies(wrapperDependencies(input.launch, input.io), input.rules);
  return missing.length > 0 ? wrapperSandboxPreflightError(input.launch.wrapperCli, missing) : undefined;
}

/** Appended to the crash diagnostic when a sandboxed wrapper launch exits
 *  before the CLI ever became ready. */
export function wrapperSandboxExitHint(wrapperCli: string, mode: 'fs-policy' | 'scratch' = 'fs-policy'): string {
  // scratch is a full-root copy-on-write view: everything is readable, only
  // scratchDenyPaths are hidden, and sandboxPaths are not consulted at all.
  if (mode === 'scratch') {
    return `[botmux] wrapperCli「${wrapperCli}」运行在 scratch 沙盒内（全盘可读，写入不落回宿主）。`
      + '如果上面是找不到文件或权限不足，检查该 Bot 的 scratchDenyPaths 是否挡住了 wrapper 依赖的路径。';
  }
  return `[botmux] wrapperCli「${wrapperCli}」运行在文件沙盒内，只能访问沙盒白名单里的路径。`
    + '如果上面是找不到文件、命令或权限不足，把 wrapper 依赖的目录加到该 Bot 的 sandboxPaths'
    + '（只读放 readOnly，需要写的放 readWrite）。';
}

/** `<cli name>` alias for the sandbox's private shim dir; undefined when the
 *  name would shadow botmux's own shim or cannot be resolved. */
export function cliNameLink(cliBin: string, io: Pick<WrapperFsIo, 'realpath'>): { name: string; target: string } | undefined {
  const name = basename(cliBin);
  if (!name || name === 'botmux' || name.includes(sep)) return undefined;
  try { return { name, target: io.realpath(cliBin) }; } catch { return undefined; }
}

/** (Re)create `<shimDir>/<name>` → target. Replaced every launch so a CLI
 *  upgrade never leaves the alias on the old binary. Best-effort: a wrapper
 *  that runs the CLI by absolute path does not need it. */
export function writeCliNameLink(shimDir: string, link: { name: string; target: string } | undefined): void {
  if (!link) return;
  const path = join(shimDir, link.name);
  try { rmSync(path, { force: true }); symlinkSync(link.target, path); } catch { /* */ }
}
