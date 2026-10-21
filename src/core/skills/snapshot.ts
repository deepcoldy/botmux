/**
 * Per-session skill SNAPSHOTS — only for sources botmux itself manages.
 *
 * `botmux skill show/read/resources` serve the skills enabled for a session.
 * Under the file sandbox their sources are unreachable (deny-by-default), and
 * granting host dirs into the sandbox does not converge (aliases, credential
 * trees, sibling BOT_HOMEs, redirected CLI roots …). So at CLI spawn the daemon
 * COPIES each enabled skill whose source is botmux-MANAGED into this session's
 * own runtime dir (`<dataDir>/runtime-skills/<sid>/snapshot/<name>/`, a
 * session-owned root the sandbox policy exposes read-only) and points the
 * session manifest there.
 *
 * Trusted sources only — a store-installed skill whose canonical root lies
 * strictly inside the canonical skill store (`~/.botmux/skills/store/<name>`),
 * or a plugin skill inside a plugin bundle (`~/.botmux/plugins/<id>/dist`), and
 * whose root / copied subtree touches no credential location (session data dir,
 * any BOT_HOME, botmux internals, sandbox-denied host paths — see
 * resolveManagedSkillSource). Every other source — a linked dir (`local-link`), a
 * native-CLI skill dir, … — is NEVER copied: it keeps its original path, so it
 * works wherever the CLI can already read it (no sandbox, scratch,
 * credential-only) and is simply unavailable inside the file sandbox, where
 * `botmux skill show` says so and suggests a copy install. Project skills
 * (inside the session's own working dir, readable anyway) are not copied either.
 *
 * Copy rules — the snapshot never carries anything reached through a link:
 *  - the tree is walked from `/` with every component opened no-follow
 *    (Linux: fd-relative via /proc/self/fd + O_NOFOLLOW; macOS: O_NOFOLLOW_ANY),
 *    so a directory swapped for a symlink mid-copy fails instead of being
 *    followed; symlink entries are skipped and reported;
 *  - hard-linked files (nlink > 1) and special files are skipped and reported;
 *  - the destination is written the same way into a fresh private temp dir
 *    (exclusive creates, no recursive mkdir) and renamed into place;
 *  - entries (files + dirs, skipped ones included), dirs, files, bytes and
 *    depth are capped: an oversized skill is not snapshotted at all and the
 *    reason is recorded.
 * A skill that is not snapshotted keeps its original rootDir — there is no
 * fallback grant: in the sandbox it is unreadable and the reader explains why.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../../config.js';
import { skillStoreDir } from './registry-paths.js';
import { pluginsHome } from '../plugins/paths.js';
import { isPathWithin, isValidSkillName } from './package.js';
import { baselineDeniedHostPaths, resolveLarkCliLinuxStoreDir } from '../../adapters/cli/fs-policy.js';
import { removeSessionSkillManifest } from './manifest-store.js';
import type { ResolvedSkill, SessionSkillManifest, SkillDiagnostic } from './types.js';

export interface SkillSnapshotLimits {
  /** Every directory entry visited (files + dirs + skipped entries). */
  maxEntries: number;
  maxDirs: number;
  maxFiles: number;
  maxBytes: number;
  maxDepth: number;
}

export const DEFAULT_SKILL_SNAPSHOT_LIMITS: SkillSnapshotLimits = {
  maxEntries: 4000,
  maxDirs: 500,
  maxFiles: 2000,
  maxBytes: 32 * 1024 * 1024,
  maxDepth: 16,
};

export function sessionSkillRuntimeDir(sessionId: string, dataDir: string = config.session.dataDir): string {
  return join(dataDir, 'runtime-skills', sessionId);
}

export function sessionSkillSnapshotRoot(sessionId: string, dataDir: string = config.session.dataDir): string {
  return join(sessionSkillRuntimeDir(sessionId, dataDir), 'snapshot');
}

/** Session-close cleanup: this session's manifest + every per-session skill
 *  artefact (snapshot, Claude plugin copy, Pi skill root). Best effort. */
export function removeSessionSkillRuntime(sessionId: string, dataDir: string = config.session.dataDir): void {
  try { removeSessionSkillManifest(sessionId); } catch { /* best effort */ }
  try { rmSync(sessionSkillRuntimeDir(sessionId, dataDir), { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Where botmux keeps the sources it manages, and every place a snapshot
 *  must never copy from. Defaults come from the live layout. */
export interface SkillSnapshotTrust {
  storeDir: string;
  pluginsDir: string;
  sessionDataDir: string;
  /** Every BOT_HOME parent (`<botmux>/bots`) — this bot's AND its siblings'. */
  botsDirs: readonly string[];
  /** The session working dir. NOT a credential location — only used so a copy
   *  never swallows the whole project (cover-only, see resolveManagedSkillSource).
   *  It is routinely `~` (the default when a bot configures none). */
  workingDir: string;
  /** Configured + default botmux homes: outside `skills/store` and
   *  `plugins/<id>/dist`, everything in them is botmux-internal. */
  botmuxRoots?: readonly string[];
  /** Host paths the file sandbox explicitly denies (fs-policy baseline crown
   *  jewels, lark-cli stores). */
  protectedPaths?: readonly string[];
}

export function defaultSkillSnapshotTrust(input: { workingDir: string; dataDir?: string }): SkillSnapshotTrust {
  const dataDir = input.dataDir ?? config.session.dataDir;
  const home = homedir();
  const configuredBotmux = dirname(dataDir);
  const defaultBotmux = join(home, '.botmux');
  const storeDir = skillStoreDir();
  const pluginsDir = pluginsHome();
  return {
    storeDir,
    pluginsDir,
    sessionDataDir: dataDir,
    // Kept for ANY layout: BOT_HOMEs live at `<dirname(dataDir)>/bots/<appId>`
    // even when that parent is not a plausible botmux home (e.g. `$HOME/bots`).
    botsDirs: [...new Set([join(configuredBotmux, 'bots'), join(defaultBotmux, 'bots')])],
    workingDir: input.workingDir,
    botmuxRoots: [...new Set([
      defaultBotmux,
      ...(plausibleConfiguredBotmuxHome(configuredBotmux, { defaultBotmux, storeDir, pluginsDir }) ? [configuredBotmux] : []),
    ])],
    protectedPaths: [
      ...baselineDeniedHostPaths(process.platform === 'darwin' ? 'darwin' : 'linux', home),
      join(home, '.lark-cli-bots'),
      join(home, '.local', 'share', 'lark-cli'),
      join(home, 'Library', 'Application Support', 'lark-cli'),
      resolveLarkCliLinuxStoreDir(process.env.LARKSUITE_CLI_DATA_DIR, home),
    ],
  };
}

/**
 * Whether `dirname(SESSION_DATA_DIR)` may be treated as a botmux home, i.e.
 * have EVERY entry outside `skills/store` and `plugins/<id>/dist` count as
 * botmux-internal (botmuxInternalPaths). That parent is a botmux home in the
 * standard (`~/.botmux/data`) and custom-instance (`$HOME/inst/data`) layouts,
 * but with `SESSION_DATA_DIR=$HOME/data` it is `$HOME` itself and with `/data`
 * it is `/`: treating those as botmux homes lists ~/.botmux (and so the skill
 * store) as "internal" and fail-closes every managed skill. Not plausible:
 *  - it contains the DEFAULT botmux home `$HOME/.botmux` (a botmux home never
 *    nests another) — which is exactly the case for `$HOME`, `/` and every
 *    other ancestor of the user's home;
 *  - it contains the skill store / plugins dir anywhere but at its own
 *    `skills/store` / `plugins` (the store belongs to some other home then).
 * Dropping it only removes that blanket "everything here is internal" rule;
 * the credential locations it would have covered stay refused on their own:
 * the session data dir, `<that parent>/bots` (botsDirs keeps it for every
 * layout), the default botmux home's internals (`defaultBotmux` is ALWAYS a
 * botmux root — it is one by definition, even with an aliased store), the
 * sandbox-denied host paths and the lark-cli stores. Compared by realpath.
 */
export function plausibleConfiguredBotmuxHome(
  candidate: string,
  layout: { defaultBotmux: string; storeDir: string; pluginsDir: string },
): boolean {
  const real = (p: string) => realOrNull(p) ?? p;
  const c = real(candidate);
  if (c === real(layout.defaultBotmux)) return true;
  if (isPathWithin(c, real(layout.defaultBotmux))) return false;
  for (const [dir, own] of [[layout.storeDir, join(candidate, 'skills', 'store')], [layout.pluginsDir, join(candidate, 'plugins')]]) {
    const d = real(dir);
    if (isPathWithin(c, d) && d !== real(own)) return false;
  }
  return true;
}

const realOrNull = (path: string): string | null => {
  try { return realpathSync(path); } catch { return null; }
};

/** Lexical + canonical forms of each existing-or-not path. */
function allForms(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    const real = realOrNull(p);
    if (real) out.add(real);
  }
  return [...out];
}

/** botmux-internal entries of each botmux home: everything except the skill
 *  store and plugin bundles (`dist`). A store aliased onto the botmux home
 *  (`skills/store -> ~/.botmux`) therefore still cannot hand out BOT_HOMEs,
 *  the data dir, bots.json, a plugin's `private/` … as "store skills". */
function botmuxInternalPaths(roots: readonly string[]): string[] {
  const out: string[] = [];
  const children = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
  for (const root of roots) {
    for (const name of children(root)) {
      if (name === 'skills') {
        for (const sub of children(join(root, 'skills'))) if (sub !== 'store') out.push(join(root, 'skills', sub));
      } else if (name === 'plugins') {
        for (const id of children(join(root, 'plugins'))) {
          for (const part of children(join(root, 'plugins', id))) {
            if (part !== 'dist') out.push(join(root, 'plugins', id, part));
          }
        }
      } else {
        out.push(join(root, name));
      }
    }
  }
  return out;
}

/** Source kinds botmux installs into its OWN skill store. A linked skill is
 *  never trusted, even when its path happens to sit under the store. Plugin
 *  skills (kind `plugin`) are the other managed kind, rooted in a plugin's
 *  `dist`; MANAGED_SOURCE_TYPES below is the union of both. */
const STORE_SOURCE_TYPES: ReadonlySet<string | undefined> = new Set(['local-copy', 'git', 'github', 'agentbuddy']);
/** Every botmux-managed kind (store kinds + `plugin`): a skill of one of these
 *  kinds that still fails resolveManagedSkillSource is anomalous and diagnosed. */
const MANAGED_SOURCE_TYPES: ReadonlySet<string | undefined> = new Set([...STORE_SOURCE_TYPES, 'plugin']);

/**
 * The canonical root to copy when `skill` is a botmux-managed source, or the
 * reason it is not. Judged on the ACTUAL source root (realpath) and therefore
 * the whole subtree the copy will walk (the copy never follows a link):
 *  - only store-installed kinds strictly inside the canonical store, or plugin
 *    skills strictly inside a canonical `plugins/<id>/dist`;
 *  - the root must neither sit inside nor contain a CREDENTIAL location: the
 *    session data dir, ANY BOT_HOME (this bot's or a sibling's), a
 *    botmux-internal entry or a host path the sandbox explicitly denies —
 *    whatever the store itself resolves to;
 *  - the store / plugins dir itself must not resolve into one of those either;
 *  - the copied subtree must not contain a whole botmux home or the whole
 *    session working dir (cover-only — see below).
 * The copy must use exactly the returned path (opened without following any
 * link), so a source swapped after this check fails instead of re-resolving.
 */
export function resolveManagedSkillSource(
  skill: Pick<ResolvedSkill, 'rootDir' | 'source'>,
  trust: SkillSnapshotTrust,
): { ok: true; root: string } | { ok: false; reason: 'source_missing' | 'not_botmux_managed' | 'source_overlaps_protected' } {
  const root = realOrNull(skill.rootDir);
  if (!root) return { ok: false, reason: 'source_missing' };
  const type = skill.source?.type;
  const base = STORE_SOURCE_TYPES.has(type) ? realOrNull(trust.storeDir)
    : type === 'plugin' ? realOrNull(trust.pluginsDir) : null;
  if (!base || root === base || !isPathWithin(base, root)) return { ok: false, reason: 'not_botmux_managed' };
  if (type === 'plugin' && root.slice(base.length + 1).split('/')[1] !== 'dist') {
    return { ok: false, reason: 'not_botmux_managed' };
  }
  // Credential locations — never copied from: neither the root may sit inside
  // one, nor may the copied subtree contain one.
  const insideOrCover = allForms([
    trust.sessionDataDir,
    ...trust.botsDirs,
    ...botmuxInternalPaths(trust.botmuxRoots ?? []),
    ...(trust.protectedPaths ?? []),
  ]);
  // Cover-only: the store lives INSIDE a botmux home, and routinely inside the
  // working dir too (it is `~` whenever a bot configures none), so these only
  // count when the copied subtree would contain them whole (a store aliased to
  // `/` or `~`). The working dir is no credential location — what must stay
  // out of a snapshot under `~` (sibling BOT_HOMEs, ~/.ssh, the data dir …) is
  // refused by the credential list above on its own. Treating the working dir
  // as inside-or-cover refused EVERY store skill for a `~` working dir; that a
  // `~`-rooted session could rewrite store content is a pre-existing
  // integrity matter of such a wide grant, not a confidentiality one (the copy
  // still never follows a link out of the skill root).
  const coverOnly = allForms([...(trust.botmuxRoots ?? []), trust.workingDir]);
  // The managed dir itself must not live inside a credential location.
  if (insideOrCover.some(p => isPathWithin(p, base))) return { ok: false, reason: 'source_overlaps_protected' };
  const roots = allForms([skill.rootDir, root]);
  if (insideOrCover.some(p => roots.some(r => isPathWithin(p, r) || isPathWithin(r, p)))
    || coverOnly.some(p => roots.some(r => isPathWithin(r, p)))) {
    return { ok: false, reason: 'source_overlaps_protected' };
  }
  return { ok: true, root };
}

// ── no-symlink file access ─────────────────────────────────────────────────

const O_NOFOLLOW_ANY_DARWIN = 0x20000000;
const IS_LINUX = process.platform === 'linux';
const IS_DARWIN = process.platform === 'darwin';
// Resolved on use, not at module load: this module sits in widely imported
// graphs (session-skill-runtime, the v3 ephemeral pool), and a test that
// partially mocks node:fs without `constants` must still be able to import them.
export const __testOnly_snapshotNofollowFlags = (platform: NodeJS.Platform): number =>
  platform === 'darwin' ? O_NOFOLLOW_ANY_DARWIN : fsConstants.O_NOFOLLOW;
// Darwin rejects O_NOFOLLOW | O_NOFOLLOW_ANY with EINVAL. O_NOFOLLOW_ANY
// already covers the final component as well as every ancestor.
const nofollow = (): number => __testOnly_snapshotNofollowFlags(process.platform);

/** An open directory plus the path used for diagnostics / darwin lookups. */
interface Dir { fd: number; path: string }

/** Path through which `name` inside `dir` is reached WITHOUT re-resolving the
 *  dir's path: Linux goes through the pinned fd (/proc/self/fd/N), so a parent
 *  swapped for a symlink after it was opened is never followed; macOS relies
 *  on O_NOFOLLOW_ANY rejecting a symlink anywhere in the path. */
function childPath(dir: Dir, name: string): string {
  return IS_LINUX ? `/proc/self/fd/${dir.fd}/${name}` : join(dir.path, name);
}

function openDirNoSymlinks(absPath: string): Dir {
  if (IS_DARWIN) {
    return { fd: openSync(absPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | nofollow()), path: absPath };
  }
  if (!IS_LINUX) throw new Error('skill snapshots are supported on Linux and macOS only');
  let fd = openSync('/', fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    for (const part of absPath.split('/').filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${part}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | nofollow());
      closeSync(fd);
      fd = next;
    }
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return { fd, path: absPath };
}

function listDir(dir: Dir): string[] {
  return readdirSync(IS_LINUX ? `/proc/self/fd/${dir.fd}` : dir.path).sort();
}

function openSubdir(parent: Dir, name: string): Dir {
  return {
    fd: openSync(childPath(parent, name), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | nofollow()),
    path: join(parent.path, name),
  };
}

class SnapshotLimitError extends Error {}

let raceHookForTests: ((relDir: string) => void) | undefined;
/** Test seam: runs after a source dir was listed and before its entries are
 *  opened — lets a test swap a directory for a symlink at the worst moment. */
export function __testOnly_setSnapshotRaceHook(hook: ((relDir: string) => void) | undefined): void {
  raceHookForTests = hook;
}

interface CopyStats { entries: number; dirs: number; files: number; bytes: number; skipped: string[] }

function copyManagedTree(rootReal: string, dst: Dir, limits: SkillSnapshotLimits): CopyStats {
  const stats: CopyStats = { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: [] };

  const copyFile = (src: Dir, name: string, rel: string, out: Dir): void => {
    const fd = openSync(childPath(src, name), fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | nofollow());
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) { stats.skipped.push(`${rel} (not a regular file)`); return; }
      if (st.nlink > 1) { stats.skipped.push(`${rel} (hard-linked)`); return; }
      stats.files += 1;
      if (stats.files > limits.maxFiles) throw new SnapshotLimitError(`more than ${limits.maxFiles} files`);
      stats.bytes += st.size;
      if (stats.bytes > limits.maxBytes) throw new SnapshotLimitError(`more than ${limits.maxBytes} bytes`);
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      const outFd = openSync(childPath(out, name),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollow(),
        (st.mode & 0o111) ? 0o755 : 0o644);
      try { writeSync(outFd, buf, 0, off); } finally { closeSync(outFd); }
    } finally {
      closeSync(fd);
    }
  };

  const walk = (src: Dir, out: Dir, rel: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new SnapshotLimitError(`deeper than ${limits.maxDepth} levels`);
    const names = listDir(src);
    raceHookForTests?.(rel);
    for (const name of names) {
      const entryRel = rel ? `${rel}/${name}` : name;
      stats.entries += 1;
      if (stats.entries > limits.maxEntries) throw new SnapshotLimitError(`more than ${limits.maxEntries} entries`);
      let st: Stats;
      try { st = lstatSync(childPath(src, name)); } catch { stats.skipped.push(`${entryRel} (vanished)`); continue; }
      if (st.isSymbolicLink()) { stats.skipped.push(`${entryRel} (symlink)`); continue; }
      if (st.isFile()) {
        try {
          copyFile(src, name, entryRel, out);
        } catch (err: any) {
          if (err?.code === 'ELOOP') { stats.skipped.push(`${entryRel} (symlink)`); continue; }
          throw err;
        }
        continue;
      }
      if (!st.isDirectory()) { stats.skipped.push(`${entryRel} (special file)`); continue; }
      stats.dirs += 1;
      if (stats.dirs > limits.maxDirs) throw new SnapshotLimitError(`more than ${limits.maxDirs} directories`);
      let child: Dir;
      try {
        child = openSubdir(src, name);
      } catch (err: any) {
        if (err?.code === 'ELOOP' || err?.code === 'ENOTDIR') { stats.skipped.push(`${entryRel} (symlink)`); continue; }
        throw err;
      }
      try {
        mkdirSync(childPath(out, name), { mode: 0o755 });
        const outChild = openSubdir(out, name);
        try { walk(child, outChild, entryRel, depth + 1); } finally { closeSync(outChild.fd); }
      } finally {
        closeSync(child.fd);
      }
    }
  };

  const root = openDirNoSymlinks(rootReal);
  try { walk(root, dst, '', 0); } finally { closeSync(root.fd); }
  return stats;
}

export interface SessionSkillSnapshotResult {
  manifest: SessionSkillManifest;
  /** Human-readable lines for the worker log (limits, failures, skipped entries). */
  diagnostics: string[];
}

/**
 * Snapshot every enabled botmux-managed skill of `manifest` into this
 * session's runtime dir and return the manifest rewritten to read from it.
 * Non-managed and project skills are left exactly as they were. A managed
 * skill that cannot be snapshotted (limits, I/O) also keeps its original
 * path, with an error diagnostic (`skillName`) the reader surfaces when that
 * path is unreadable in a sandboxed session.
 */
export function snapshotSessionSkills(
  manifest: SessionSkillManifest,
  opts: { dataDir?: string; trust?: SkillSnapshotTrust; limits?: SkillSnapshotLimits } = {},
): SessionSkillSnapshotResult {
  const dataDir = opts.dataDir ?? config.session.dataDir;
  const trust = opts.trust ?? defaultSkillSnapshotTrust({ workingDir: manifest.workingDir, dataDir });
  const limits = opts.limits ?? DEFAULT_SKILL_SNAPSHOT_LIMITS;
  const runtimeDir = sessionSkillRuntimeDir(manifest.sessionId, dataDir);
  const finalRoot = sessionSkillSnapshotRoot(manifest.sessionId, dataDir);
  const diagnostics: SkillDiagnostic[] = [];
  const log: string[] = [];
  const snapshotted = new Set<string>();

  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const tmpPath = mkdtempSync(join(runtimeDir, '.snapshot-'));
  try {
    const tmp = openDirNoSymlinks(realpathSync(tmpPath));
    try {
      for (const skill of manifest.prioritySkills) {
        if (skill.source?.type === 'project') continue;
        const fail = (code: string, message: string) => {
          diagnostics.push({ level: 'error', code, message, skillName: skill.name });
          log.push(message);
        };
        const source = resolveManagedSkillSource(skill, trust);
        if (!source.ok) {
          // Linked / external skills are never copied and keep their own path
          // (expected, no diagnostic). A store- or plugin-installed one that
          // does NOT resolve to the managed location (store aliased into a
          // session-writable place, entry replaced by a link, …) is anomalous:
          // record why, so the reader can say so instead of "linked skill".
          if (MANAGED_SOURCE_TYPES.has(skill.source?.type)) {
            fail('skill_snapshot_untrusted_source',
              `skill "${skill.name}" was not snapshotted: its installed copy ${skill.rootDir} does not resolve inside the botmux-managed skill store / plugin bundle, or that location resolves into a session-writable directory (${source.reason})`);
          }
          continue;
        }
        if (!isValidSkillName(skill.name) || snapshotted.has(skill.name)) {
          fail('skill_snapshot_failed', `skill "${skill.name}" was not snapshotted: invalid or duplicate skill name`);
          continue;
        }
        try {
          mkdirSync(childPath(tmp, skill.name), { mode: 0o755 });
          const out = openSubdir(tmp, skill.name);
          let stats: CopyStats;
          try { stats = copyManagedTree(source.root, out, limits); } finally { closeSync(out.fd); }
          if (!lstatSync(join(tmp.path, skill.name, skill.entrypoint)).isFile()) {
            throw new Error(`entrypoint ${skill.entrypoint} missing from the snapshot`);
          }
          snapshotted.add(skill.name);
          if (stats.skipped.length > 0) {
            const message = `skill "${skill.name}": skipped ${stats.skipped.length} entr${stats.skipped.length === 1 ? 'y' : 'ies'} not copied into the session snapshot: ${stats.skipped.slice(0, 10).join(', ')}${stats.skipped.length > 10 ? ', …' : ''}`;
            diagnostics.push({ level: 'warn', code: 'skill_snapshot_entries_skipped', message, skillName: skill.name });
            log.push(message);
          }
        } catch (err) {
          rmSync(join(tmp.path, skill.name), { recursive: true, force: true });
          if (err instanceof SnapshotLimitError) {
            fail('skill_snapshot_too_large',
              `skill "${skill.name}" exceeds the session snapshot limit (${limits.maxEntries} entries / ${limits.maxDirs} dirs / ${limits.maxFiles} files / ${limits.maxBytes} bytes / depth ${limits.maxDepth}): ${err.message}`);
          } else {
            fail('skill_snapshot_failed',
              `skill "${skill.name}" could not be snapshotted: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } finally {
      closeSync(tmp.fd);
    }

    rmSync(finalRoot, { recursive: true, force: true });
    let realFinal = finalRoot;
    if (snapshotted.size > 0) {
      renameSync(tmpPath, finalRoot);
      // Canonical: the sandbox binds canonical paths and pins a canonical
      // SESSION_DATA_DIR; a lexical (symlinked-HOME) rootDir would not resolve.
      realFinal = realpathSync(finalRoot);
    }
    const prioritySkills: ResolvedSkill[] = manifest.prioritySkills.map(skill => snapshotted.has(skill.name)
      ? { ...skill, rootDir: join(realFinal, skill.name), snapshotOf: skill.rootDir }
      : skill);
    return {
      manifest: { ...manifest, prioritySkills, diagnostics: [...manifest.diagnostics, ...diagnostics] },
      diagnostics: log,
    };
  } finally {
    rmSync(tmpPath, { recursive: true, force: true });
  }
}
