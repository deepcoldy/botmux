/**
 * Which sandboxPaths entries may never be granted readWrite.
 *
 * The file sandbox is deny-by-default: the agent sees only what the policy
 * binds in. A readWrite grant on `/`, on the host user's HOME or on the botmux
 * data root (or on any ancestor of them) turns that around — the whole host
 * disk, every dotfile credential, or every bot's config/sessions become
 * writable from inside the sandbox. Deeper paths are untouched by this rule:
 * `~/projects/foo` stays a legitimate readWrite grant.
 *
 * Shared by the save path (sandbox-store rejects the write), the bots.json
 * load path (warn only) and the worker (downgrades an already-stored entry to
 * readOnly before compiling the policy), so all three agree on one list.
 */
import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { config } from '../config.js';

export type ForbiddenReadWriteReason = 'filesystem_root' | 'home' | 'botmux_home' | 'relative_path';

export interface ForbiddenReadWritePath {
  /** The entry exactly as configured. */
  path: string;
  reason: ForbiddenReadWriteReason;
  /** The protected root the entry equals or contains. */
  protectedRoot: string;
}

export interface ProtectedRoots {
  /** Host HOME(s): `$HOME` and the OS account home when they differ. */
  homeDirs: readonly string[];
  /** botmux data roots: the configured one and the default `~/.botmux`. */
  botmuxHomes: readonly string[];
}

/** The roots for this process: HOME, OS account home, configured + default botmux home. */
export function defaultProtectedRoots(): ProtectedRoots {
  const home = homedir();
  let osHome: string | undefined;
  try { osHome = userInfo().homedir; } catch { /* no passwd entry */ }
  return {
    homeDirs: [home, ...(osHome && osHome !== home ? [osHome] : [])],
    botmuxHomes: [...new Set([dirname(config.session.dataDir), join(home, '.botmux')])],
  };
}

/** Same `~` expansion the worker applies to sandboxPaths entries. */
function expandTilde(raw: string, home: string): string {
  return raw.replace(/^~(?=\/|$)/, home);
}

/** An entry the sandbox can pin to a host location: absolute after trim and
 *  `~` expansion. A bare `~user` is NOT expanded (same regex as the worker),
 *  so it counts as non-absolute. */
export function isAbsoluteSandboxEntry(raw: unknown, home: string = homedir()): raw is string {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  return isAbsolute(expandTilde(trimmed, home));
}

export type SandboxPathTierName = 'readWrite' | 'readOnly' | 'deny';

/**
 * Entries of ANY tier that are not absolute after `~` expansion. The save
 * path rejects them: a relative entry is stored verbatim and later resolved
 * by the worker against the SESSION working directory (the worker process
 * cwd), so `..` from `~/proj` silently means HOME and `../..` means `/` —
 * the exact grants this guard forbids when written absolutely.
 */
export function findNonAbsoluteSandboxEntries(
  tiers: { readWrite?: readonly string[]; readOnly?: readonly string[]; deny?: readonly string[] } | undefined,
  home: string = homedir(),
): { path: string; tier: SandboxPathTierName }[] {
  const out: { path: string; tier: SandboxPathTierName }[] = [];
  for (const tier of ['readWrite', 'readOnly', 'deny'] as const) {
    for (const raw of tiers?.[tier] ?? []) {
      if (!isAbsoluteSandboxEntry(raw, home)) out.push({ path: String(raw ?? ''), tier });
    }
  }
  return out;
}

/** One-line Chinese explanation for the save rejection of relative entries. */
export function nonAbsoluteSandboxEntriesMessage(
  found: readonly { path: string; tier: SandboxPathTierName }[],
): string {
  const tierLabel: Record<SandboxPathTierName, string> = {
    readWrite: '可读写', readOnly: '只读', deny: '封禁',
  };
  const lines = found.map(({ path, tier }) => `${tierLabel[tier]}「${path}」`);
  return `沙盒路径必须是以 / 或 ~/ 开头的绝对路径，相对路径会按会话工作目录解析、位置随会话改变：${lines.join('；')}。请改成绝对路径后再保存。`;
}

/** Lexical form plus, when the path exists, its realpath — so a symlink that
 *  resolves to `/` or to HOME is caught as well. */
function variants(path: string): string[] {
  const lexical = resolve(path);
  const out = new Set([lexical]);
  try { out.add(realpathSync(lexical)); } catch { /* missing: lexical only */ }
  return [...out];
}

/** Is `ancestor` equal to or above `child`? Both absolute and resolved. */
function covers(ancestor: string, child: string): boolean {
  if (ancestor === child || ancestor === '/') return true;
  return child.startsWith(`${ancestor}/`);
}

/**
 * The readWrite entries that must never reach the sandbox policy: entries
 * equal to or containing a protected root, plus relative entries. A relative
 * entry is not harmless just because its target is unknown here — the worker
 * resolves it against the session working directory, so `..` pinned while
 * working in `~/proj` is a write grant on HOME and `../..` one on `/`.
 */
export function findForbiddenReadWritePaths(
  readWrite: readonly string[] | undefined,
  roots: ProtectedRoots = defaultProtectedRoots(),
): ForbiddenReadWritePath[] {
  const home = roots.homeDirs[0] ?? homedir();
  const protectedRoots: Array<{ root: string; reason: ForbiddenReadWriteReason }> = [
    { root: '/', reason: 'filesystem_root' },
    ...roots.homeDirs.flatMap(dir => variants(dir).map(root => ({ root, reason: 'home' as const }))),
    ...roots.botmuxHomes.flatMap(dir => variants(dir).map(root => ({ root, reason: 'botmux_home' as const }))),
  ];
  const out: ForbiddenReadWritePath[] = [];
  for (const raw of readWrite ?? []) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const expanded = expandTilde(trimmed, home);
    if (!isAbsolute(expanded)) {
      out.push({ path: raw, reason: 'relative_path', protectedRoot: '' });
      continue;
    }
    const candidates = variants(expanded);
    // First match wins in the order above: `/` before HOME before botmux home,
    // so an entry is reported by the broadest thing it exposes.
    const hit = protectedRoots.find(({ root }) => candidates.some(candidate => covers(candidate, root)));
    if (hit) out.push({ path: raw, reason: hit.reason, protectedRoot: hit.root });
  }
  return out;
}

/** One-line Chinese explanation per entry, for the dashboard and logs. */
export function forbiddenReadWriteMessage(found: readonly ForbiddenReadWritePath[]): string {
  const lines = found.map(({ path, reason, protectedRoot }) => {
    switch (reason) {
      case 'filesystem_root':
        return `「${path}」是根目录，设成可写会让整个宿主磁盘在沙盒里可写`;
      case 'home':
        return `「${path}」是宿主用户主目录 ${protectedRoot} 或它的上级，设成可写会让沙盒能改写主目录下的所有配置和凭据`;
      case 'botmux_home':
        return `「${path}」是 botmux 数据目录 ${protectedRoot} 或它的上级，设成可写会让沙盒能改写所有 Bot 的配置和会话数据`;
      case 'relative_path':
        return `「${path}」是相对路径，沙盒路径会按会话工作目录解析（工作目录在主目录下时，.. 就指向主目录，../.. 指向根目录），必须写成以 / 或 ~/ 开头的绝对路径`;
    }
  });
  // A relative entry is rejected in EVERY tier (readOnly too), so the usual
  // "move it to read-only" hint would lead straight into the second error.
  if (found.some(({ reason }) => reason === 'relative_path')) {
    return `沙盒「可读写」里不能放这些路径：${lines.join('；')}。请改成以 / 或 ~/ 开头的具体项目目录后再保存（相对路径放进只读也不接受）。`;
  }
  return `沙盒「可读写」里不能放这些路径：${lines.join('；')}。请改成具体的项目目录，或改放到「只读」。`;
}

/**
 * readOnly entries that name the filesystem root itself (any spelling, or a
 * link that resolves to it). A read-only bind of `/` cannot start: the policy
 * mounts fresh tmpfs at /run, /tmp, … before the user's binds, `--ro-bind / /`
 * then covers them with the host's read-only directories, and the next mount
 * point the launcher needs (`/run/sbxbin`) cannot be created — measured with
 * bubblewrap 0.8.0, with and without a user namespace:
 * `bwrap: Can't mkdir /run/sbxbin: Read-only file system`. Deeper paths
 * (`/usr`, HOME as readOnly) are unaffected.
 */
export function findReadOnlyFilesystemRoot(
  readOnly: readonly string[] | undefined,
  home: string = homedir(),
): string[] {
  const out: string[] = [];
  for (const raw of readOnly ?? []) {
    if (!isAbsoluteSandboxEntry(raw, home)) continue;
    if (variants(expandTilde(raw.trim(), home)).includes('/')) out.push(raw);
  }
  return out;
}

/** One-line Chinese explanation for the save rejection of a readOnly `/`. */
export function readOnlyRootMessage(found: readonly string[]): string {
  const names = found.map(path => `「${path}」`).join('、');
  return `沙盒「只读」里不能放根目录${names}：把整个根目录只读绑进沙盒后，沙盒需要的挂载点无法创建，会话一启动就退出。请改成具体目录（如 /usr、/opt/工具目录、~/projects）后再保存。`;
}

/**
 * Spawn-time handling of a stored readOnly `/` (saved before the save path
 * refused it, or hand-edited into bots.json): dropped, so the session starts
 * deny-by-default instead of exiting at launch.
 */
export function dropReadOnlyFilesystemRoot<T extends { readOnly?: string[] }>(
  lists: T | undefined,
  home: string = homedir(),
): { lists: T | undefined; dropped: string[] } {
  const dropped = findReadOnlyFilesystemRoot(lists?.readOnly, home);
  if (!lists || dropped.length === 0) return { lists, dropped };
  const removed = new Set(dropped);
  return { lists: { ...lists, readOnly: (lists.readOnly ?? []).filter(path => !removed.has(path)) }, dropped };
}

/**
 * Spawn-time handling of an entry that is already stored (written before this
 * check existed, or edited into bots.json by hand), instead of refusing the
 * session:
 *  - HOME, the botmux data root and their ancestors move from readWrite to
 *    readOnly: the user keeps the read access they asked for, the write grant
 *    over every dotfile credential / every bot's data is gone.
 *  - `/` is dropped outright, not moved to readOnly: a read-only bind of the
 *    host root cannot start either (see findReadOnlyFilesystemRoot), so the
 *    CLI would exit at launch. A deny-by-default sandbox without the entry
 *    still starts.
 *  - Relative entries are dropped outright as well: their target depends on
 *    the session working directory, and moving one to readOnly would still
 *    grant reads of whatever the cwd-relative resolution happens to hit.
 */
export function downgradeForbiddenReadWrite<T extends { readWrite?: string[]; readOnly?: string[] }>(
  lists: T | undefined,
  roots: ProtectedRoots = defaultProtectedRoots(),
): { lists: T | undefined; downgraded: ForbiddenReadWritePath[]; dropped: ForbiddenReadWritePath[] } {
  const found = findForbiddenReadWritePaths(lists?.readWrite, roots);
  const downgraded = found.filter(entry => entry.reason === 'home' || entry.reason === 'botmux_home');
  const dropped = found.filter(entry => !downgraded.includes(entry));
  if (!lists || found.length === 0) return { lists, downgraded, dropped };
  const removed = new Set(found.map(entry => entry.path));
  return {
    lists: {
      ...lists,
      readWrite: (lists.readWrite ?? []).filter(path => !removed.has(path)),
      readOnly: [...(lists.readOnly ?? []), ...downgraded.map(entry => entry.path)],
    },
    downgraded,
    dropped,
  };
}
