import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { CliId } from '../adapters/cli/types.js';
import { botHomePath } from '../adapters/cli/read-isolation.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { expandHome } from '../core/working-dir.js';
import { findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId } from './codex-transcript.js';
import { codexHome as configuredCodexHome } from './codex-paths.js';
import { cocoEventsPathForSession } from './coco-transcript.js';
import { findCursorTranscriptByChatId } from './cursor-transcript.js';
import { findTraexRolloutBySessionId, findTraexSessionIdByBotmuxSessionId } from './traex-transcript.js';
import { findPiTranscriptBySessionId } from './pi-transcript.js';
import { findGrokUpdatesBySessionId } from './grok-transcript.js';

export type TranscriptKind = 'claude' | 'codex' | 'coco' | 'cursor' | 'traex' | 'pi' | 'grok' | 'antigravity';

export interface TranscriptPathQuery {
  cliId?: CliId | 'unknown';
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  /** Owning bot's Lark app id. Enables the BOT_HOME fallback for sandboxed
   *  (CLI-data-redirected) bots whose transcripts live under
   *  `<botmuxHome>/bots/<appId>/claude` instead of the global data dir. */
  larkAppId?: string;
  /** Bypass a cached miss for lazily-created transcripts. */
  fresh?: boolean;
}

export interface ResolvedTranscriptPath {
  path: string;
  kind: TranscriptKind;
}

const sessionPathCache = new Map<string, { path: string | null; atMs: number }>();
const SESSION_PATH_CACHE_MAX_ENTRIES = 1024;
/** A missed lookup (transcript not on disk yet) is retried only after this
 *  window — fresh sessions otherwise trigger a directory scan per row render. */
const PATH_MISS_RETRY_MS = 30_000;

export function __resetTranscriptResolverCacheForTest(): void {
  sessionPathCache.clear();
}

/** Memoize a transcript-path lookup. `hitTtlMs === null` means a found path
 *  is trusted forever (rollout/transcript files never move); misses are
 *  retried after PATH_MISS_RETRY_MS — or immediately when `retryMiss` is set
 *  (ledger reads must see lazily created transcripts at turn boundaries). */
export function cachedTranscriptPathLookup(
  key: string,
  hitTtlMs: number | null,
  lookup: () => string | null,
  opts?: { retryMiss?: boolean; refreshHit?: boolean },
): string | null {
  const now = Date.now();
  const cached = sessionPathCache.get(key);
  if (cached) {
    if (cached.path !== null) {
      if (!opts?.refreshHit && (hitTtlMs === null || now - cached.atMs < hitTtlMs)) return cached.path;
    } else if (!opts?.retryMiss && now - cached.atMs < PATH_MISS_RETRY_MS) {
      return null;
    }
  }
  if (sessionPathCache.size >= SESSION_PATH_CACHE_MAX_ENTRIES && !sessionPathCache.has(key)) {
    const oldest = sessionPathCache.keys().next().value;
    if (oldest !== undefined) sessionPathCache.delete(oldest);
  }
  const path = lookup();
  sessionPathCache.set(key, { path, atMs: now });
  return path;
}

/** cwd → the path Claude Code keys its project dir by: the REALPATH (symlinks
 *  resolved), falling back to a lexical resolve only when the path isn't on disk.
 *  Claude keys projects by realpath, so a symlinked cwd (e.g. /home/x →
 *  /data00/home/x) must resolve to the same string the CLI used — a lexical
 *  resolve() would point at a project key Claude never writes to. */
function realCwd(cwd: string): string {
  const expanded = expandHome(cwd);
  try { return realpathSync(expanded); } catch { return resolve(expanded); }
}

export function getClaudeSessionJsonlPath(
  sessionId: string,
  cwd: string,
  dataDir: string,
  opts?: { noFollow?: boolean },
): string | null {
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = the REALPATH of cwd with non [A-Za-z0-9-] chars → '-'.
  // Resolve symlinks (realCwd), NOT just resolve(): under a symlinked cwd a
  // lexical key points at a dir Claude never wrote, so the transcript is never
  // found and the usage ledger silently writes no delta (claude-code.ts's
  // realpathCwd already does this for the idle bridge — this path was the laggard).
  const projectKey = realCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  const projectsDir = join(dataDir, 'projects');
  const projectDir = join(projectsDir, projectKey);
  const jsonlPath = join(projectDir, `${sessionId}.jsonl`);
  if (!opts?.noFollow) return existsSync(jsonlPath) ? jsonlPath : null;
  return isDirectoryNoFollow(dataDir)
    && isDirectoryNoFollow(projectsDir)
    && isDirectoryNoFollow(projectDir)
    && regularFileMtime(jsonlPath) !== null
    ? jsonlPath
    : null;
}

/** Resolve a Claude-family fork's (seed / relay) data root EXACTLY as the worker
 *  does, so usage/insight reads hit the same transcript the CLI wrote. */
const claudeForkDataDirCache = new Map<string, string>();
function claudeForkDataDir(cliId: 'seed' | 'relay'): string {
  const cached = claudeForkDataDirCache.get(cliId);
  if (cached) return cached;
  const dir = createCliAdapterSync(cliId).claudeDataDir ?? join(homedir(), '.claude-runtime');
  claudeForkDataDirCache.set(cliId, dir);
  return dir;
}

/** Resolve one CLI data root redirected beneath a sandboxed bot's BOT_HOME.
 * botmuxHome is derived exactly like worker.ts (`dirname(SESSION_DATA_DIR)`);
 * no SESSION_DATA_DIR means no redirect ever happened, so there is no fallback.
 * Deliberately probe by existence rather than re-deriving the redirect decision
 * (sandbox × adapter capability × wrapper), which could drift from the worker. */
function botHomeCliDataDir(
  larkAppId: string | undefined,
  cliDirName: 'claude' | 'codex',
): string | null {
  if (!larkAppId) return null;
  const sessionDataDir = process.env.SESSION_DATA_DIR;
  if (!sessionDataDir) return null;
  try {
    const botHome = botHomePath(dirname(sessionDataDir), larkAppId);
    const cliDataDir = join(botHome, cliDirName);
    // BOT_HOME is an agent-writable mount. Reject a replaced app root or CLI
    // root before any descendant lookup; checking only the final transcript
    // component would still follow these intermediate symlinks.
    if (!isDirectoryNoFollow(botHome) || !isDirectoryNoFollow(cliDataDir)) return null;
    return cliDataDir;
  } catch {
    return null; // unsafe app id — never build a path from it
  }
}

function claudeJsonlWithBotHomeFallback(sid: string, q: TranscriptPathQuery, primaryDataDir: string): string | null {
  if (!q.cwd) return null;
  const globalPath = getClaudeSessionJsonlPath(sid, q.cwd, primaryDataDir);
  const botHomeDir = botHomeCliDataDir(q.larkAppId, 'claude');
  const botHomeJsonl = botHomeDir
    ? getClaudeSessionJsonlPath(sid, q.cwd, botHomeDir, { noFollow: true })
    : null;
  // Both exist when a persistent session straddles a sandbox flip (the CLI kept
  // its session id but moved data dirs — either direction). The stale copy stops
  // growing while the live one keeps its mtime fresh, so newest-wins tracks the
  // file the CLI is actually writing; a fixed preference would freeze usage at
  // the flip point forever.
  return newerFile(
    globalPath,
    botHomeJsonl,
    regularFileMtime,
    path => botHomeDir ? noFollowRegularFileMtime(botHomeDir, path) : null,
  );
}

/** Return a no-follow regular file's mtime, rejecting symlinks, directories,
 * FIFOs, and stale cache entries. BOT_HOME is writable by the sandboxed agent,
 * so transcript readers must never follow an agent-created link out of it. */
function regularFileMtime(path: string | null): number | null {
  if (!path) return null;
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function isDirectoryNoFollow(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Validate every component beneath an untrusted root with lstat. This closes
 * the positive-cache hole where an agent replaces a previously valid parent
 * directory with a symlink while keeping the same lexical rollout path. */
function noFollowRegularFileMtime(root: string, candidate: string | null): number | null {
  if (!candidate) return null;
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const suffix = relative(resolvedRoot, resolvedCandidate);
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) return null;
  if (!isDirectoryNoFollow(resolvedRoot)) return null;

  const components = suffix.split(sep).filter(Boolean);
  let current = resolvedRoot;
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i]);
    try {
      const stat = lstatSync(current);
      if (i === components.length - 1) return stat.isFile() ? stat.mtimeMs : null;
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Pick the newest surviving candidate. Ties keep `a` (the global/stock path);
 * each side is statted independently so one deleted candidate cannot mask the
 * other. */
function newerFile(
  a: string | null,
  b: string | null,
  aMtimeReader = regularFileMtime,
  bMtimeReader = regularFileMtime,
): string | null {
  const aMtime = aMtimeReader(a);
  const bMtime = bMtimeReader(b);
  if (aMtime === null) return bMtime === null ? null : b;
  if (bMtime === null) return a;
  return bMtime > aMtime ? b : a;
}

function codexRolloutInHome(
  q: TranscriptPathQuery,
  codexHome: string,
  noFollow: boolean,
): string | null {
  const key = `codex:${noFollow ? 'untrusted' : 'global'}:${codexHome}:${q.sessionId}:${q.cliSessionId ?? ''}`;
  const finderOpts = noFollow ? { codexHome, noFollow: true } : { codexHome };
  const candidateMtime = (path: string | null) => noFollow
    ? noFollowRegularFileMtime(codexHome, path)
    : regularFileMtime(path);
  const lookup = () => {
    // cliSessionId comes from the live/adopted CLI and is authoritative. Avoid
    // both the bounded history scan and any chance that an unrelated history
    // row changes the selected rollout.
    const mappedSid = q.cliSessionId
      ? undefined
      : findCodexSessionIdByBotmuxSessionId(q.sessionId, finderOpts);
    const codexSid = q.cliSessionId || mappedSid || q.sessionId;
    return findCodexRolloutBySessionId(codexSid, finderOpts) ?? null;
  };
  let path = cachedTranscriptPathLookup(
    key,
    null,
    lookup,
    { retryMiss: q.fresh },
  );
  // Positive entries were historically cached forever. Refresh immediately if
  // the file vanished or was replaced by a symlink/non-regular node.
  if (path && candidateMtime(path) === null) {
    path = cachedTranscriptPathLookup(key, null, lookup, { refreshHit: true, retryMiss: true });
  }
  return candidateMtime(path) === null ? null : path;
}

/** CLIs whose sessions expose a botmux-resolvable native transcript (the only
 *  source of Context / Token usage). Kept byte-for-byte in sync with the
 *  switch in {@link resolveSessionTranscriptPath}; a CLI absent here can never
 *  surface usage, so UI should hide usage-display options for it rather than
 *  offer a control that is always empty. */
const USAGE_RESOLVABLE_CLI_IDS: ReadonlySet<string> = new Set([
  'claude-code', 'aiden', 'seed', 'relay', 'codex', 'coco', 'cursor', 'traex', 'grok', 'antigravity',
]);

/** True when this CLI can produce native usage (has a resolvable transcript).
 *  UI uses this to decide whether to offer usage-display configuration. */
export function cliSupportsNativeUsage(cliId: string | undefined): boolean {
  return !!cliId && USAGE_RESOLVABLE_CLI_IDS.has(cliId);
}

export function resolveSessionTranscriptPath(q: TranscriptPathQuery): ResolvedTranscriptPath | null {
  const sid = q.cliSessionId || q.sessionId;
  switch (q.cliId) {
    case 'claude-code': {
      const path = claudeJsonlWithBotHomeFallback(sid, q, join(homedir(), '.claude'));
      return path ? { path, kind: 'claude' } : null;
    }
    case 'aiden': {
      const path = claudeJsonlWithBotHomeFallback(sid, q, join(homedir(), '.claude'));
      return path ? { path, kind: 'claude' } : null;
    }
    case 'seed':
    case 'relay': {
      const path = claudeJsonlWithBotHomeFallback(sid, q, claudeForkDataDir(q.cliId));
      return path ? { path, kind: 'claude' } : null;
    }
    case 'codex': {
      // Resolve on every call: CODEX_HOME is intentionally dynamic, and the
      // absolute path is part of the cache key so changing it cannot reuse a
      // rollout discovered under a previous root.
      const globalCodexHome = resolve(configuredCodexHome());
      const globalPath = codexRolloutInHome(q, globalCodexHome, false);
      const botHomeDir = botHomeCliDataDir(q.larkAppId, 'codex');
      const resolvedBotHomeDir = botHomeDir ? resolve(botHomeDir) : null;
      const botHomeRollout = resolvedBotHomeDir
        ? codexRolloutInHome(q, resolvedBotHomeDir, true)
        : null;
      // A persistent session can straddle a sandbox flip while retaining its
      // CLI session id. Compare the two cached path candidates on every read
      // so a stale positive hit never pins usage to the pre-flip transcript.
      const path = newerFile(
        globalPath,
        botHomeRollout,
        regularFileMtime,
        candidate => resolvedBotHomeDir
          ? noFollowRegularFileMtime(resolvedBotHomeDir, candidate)
          : null,
      );
      return path ? { path, kind: 'codex' } : null;
    }
    case 'coco': {
      const path = cocoEventsPathForSession(sid);
      return path ? { path, kind: 'coco' } : null;
    }
    case 'cursor': {
      const path = cachedTranscriptPathLookup(`cursor:${sid}`, null, () => findCursorTranscriptByChatId(sid) ?? null, { retryMiss: q.fresh });
      return path ? { path, kind: 'cursor' } : null;
    }
    case 'traex': {
      const path = cachedTranscriptPathLookup(`traex:${q.sessionId}:${q.cliSessionId ?? ''}`, null, () => {
        const mappedSid = q.cliSessionId
          ? undefined
          : findTraexSessionIdByBotmuxSessionId(q.sessionId);
        const traexSid = q.cliSessionId || mappedSid || q.sessionId;
        return findTraexRolloutBySessionId(traexSid) ?? null;
      }, { retryMiss: q.fresh });
      return path ? { path, kind: 'traex' } : null;
    }
    case 'grok': {
      const path = cachedTranscriptPathLookup(
        `grok:${sid}:${q.cwd ?? ''}`,
        null,
        () => findGrokUpdatesBySessionId(sid, q.cwd) ?? null,
        { retryMiss: q.fresh },
      );
      return path ? { path, kind: 'grok' } : null;
    }
    case 'pi': {
      const path = cachedTranscriptPathLookup(`pi:${sid}:${q.cwd ?? ''}`, null, () => findPiTranscriptBySessionId(sid, q.cwd) ?? null, { retryMiss: q.fresh });
      return path ? { path, kind: 'pi' } : null;
    }
    case 'antigravity': {
      // Validate the CLI session id before interpolating it into a path (every
      // other branch resolves by scanning a data dir; this one builds the path
      // directly). Conservative charset rules out traversal / separators, and
      // existsSync keeps the null-when-absent contract the other branches honor.
      if (!q.cliSessionId || !/^[A-Za-z0-9._-]+$/.test(q.cliSessionId)) return null;
      const p = join(homedir(), '.gemini', 'antigravity-cli', 'brain', q.cliSessionId, '.system_generated', 'logs', 'transcript.jsonl');
      return existsSync(p) ? { path: p, kind: 'antigravity' } : null;
    }
    default:
      return null;
  }
}
