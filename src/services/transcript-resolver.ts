import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliId } from '../adapters/cli/types.js';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { expandHome } from '../core/working-dir.js';
import { findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId } from './codex-transcript.js';
import { cocoEventsPathForSession } from './coco-transcript.js';
import { findCursorTranscriptByChatId } from './cursor-transcript.js';
import { findTraexRolloutBySessionId } from './traex-transcript.js';

export type TranscriptKind = 'claude' | 'codex' | 'coco' | 'cursor' | 'traex' | 'antigravity';

export interface TranscriptPathQuery {
  cliId?: CliId | 'unknown';
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
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

export function getClaudeSessionJsonlPath(sessionId: string, cwd: string, dataDir: string): string | null {
  // Claude stores sessions at ~/.claude/projects/<project-key>/<sessionId>.jsonl
  // where project-key = the REALPATH of cwd with non [A-Za-z0-9-] chars → '-'.
  // Resolve symlinks (realCwd), NOT just resolve(): under a symlinked cwd a
  // lexical key points at a dir Claude never wrote, so the transcript is never
  // found and the usage ledger silently writes no delta (claude-code.ts's
  // realpathCwd already does this for the idle bridge — this path was the laggard).
  const projectKey = realCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  const jsonlPath = join(dataDir, 'projects', projectKey, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
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

export function resolveSessionTranscriptPath(q: TranscriptPathQuery): ResolvedTranscriptPath | null {
  const sid = q.cliSessionId || q.sessionId;
  switch (q.cliId) {
    case 'claude-code': {
      const path = q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, join(homedir(), '.claude')) : null;
      return path ? { path, kind: 'claude' } : null;
    }
    case 'aiden': {
      const path = q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, join(homedir(), '.claude')) : null;
      return path ? { path, kind: 'claude' } : null;
    }
    case 'seed':
    case 'relay': {
      const path = q.cwd ? getClaudeSessionJsonlPath(sid, q.cwd, claudeForkDataDir(q.cliId)) : null;
      return path ? { path, kind: 'claude' } : null;
    }
    case 'codex': {
      const path = cachedTranscriptPathLookup(`codex:${q.sessionId}:${q.cliSessionId ?? ''}`, null, () => {
        const codexSid = q.cliSessionId || findCodexSessionIdByBotmuxSessionId(q.sessionId) || q.sessionId;
        return findCodexRolloutBySessionId(codexSid) ?? null;
      }, { retryMiss: q.fresh });
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
      const path = cachedTranscriptPathLookup(`traex:${sid}`, null, () => findTraexRolloutBySessionId(sid) ?? null, { retryMiss: q.fresh });
      return path ? { path, kind: 'traex' } : null;
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
