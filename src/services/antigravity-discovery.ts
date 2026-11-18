import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { listProcessOpenFiles } from '../utils/process-open-files.js';
import { openDatabaseSyncNow } from './sqlite-compat.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_DB_RE = /^([0-9a-f-]{36})\.db(?:-wal|-shm)?(?: \(deleted\))?$/i;

export interface AntigravityDiscoveryOptions {
  pid?: number;
  cwd?: string;
  summariesDbPath?: string;
  conversationsDir?: string;
  allowWorkspaceFallbackWithPid?: boolean;
}

function getProcessFds(pid: number, procRoot = '/proc'): string[] {
  const fdDir = join(procRoot, String(pid), 'fd');
  if (!existsSync(fdDir)) return [];
  try {
    const entries = readdirSync(fdDir);
    const links: string[] = [];
    for (const entry of entries) {
      try {
        const link = readlinkSync(join(fdDir, entry));
        if (link) links.push(link);
      } catch {
        // fd might have closed mid-iteration
      }
    }
    return links;
  } catch {
    return [];
  }
}

function getProcessChildPids(pid: number, procRoot = '/proc'): number[] {
  const taskDir = join(procRoot, String(pid), 'task');
  if (!existsSync(taskDir)) return [];
  const children: number[] = [];
  try {
    const tasks = readdirSync(taskDir);
    for (const task of tasks) {
      const childFile = join(taskDir, task, 'children');
      if (!existsSync(childFile)) continue;
      try {
        const text = readFileSync(childFile, 'utf8');
        for (const token of text.trim().split(/\s+/)) {
          if (!token) continue;
          const cpid = parseInt(token, 10);
          if (Number.isFinite(cpid) && cpid > 0 && !children.includes(cpid)) {
            children.push(cpid);
          }
        }
      } catch {
        // task or child exited
      }
    }
  } catch {
    // process exited
  }
  return children;
}

/** Logical and canonical trailing-slash prefixes for a directory. A directory
 *  that does not exist yet (the conversation or its presence lock is created
 *  lazily on the first submit) simply keeps its logical prefix. */
function directoryPrefixVariants(directory: string): string[] {
  const logical = `${directory}/`;
  try {
    const canonical = `${realpathSync(directory)}/`;
    return canonical === logical ? [logical] : [logical, canonical];
  } catch {
    return [logical];
  }
}

function matchingPrefix(link: string, prefixes: readonly string[]): string | undefined {
  return prefixes.find(prefix => link.startsWith(prefix));
}

/**
 * Agy holds a presence lock on the active conversation in the TUI process.
 * Prefer that descriptor because old brain directories and databases can
 * remain open after a conversation switch. Older builds without presence
 * descriptors fall back to a unique brain or database identity across the
 * process tree (procfs on Linux, lsof on macOS).
 *
 * `/proc/<pid>/fd` and lsof report the kernel-resolved path, so an fd opened
 * under a symlinked `$HOME` (or a symlinked parent) carries the canonical
 * prefix while callers resolve the logical one from `homedir()`; every prefix
 * is matched in both variants.
 */
export function findAntigravityConversationIdByPid(
  pid: number,
  conversationsDir?: string,
  procRoot = '/proc',
): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const useProcfs = process.platform === 'linux' || procRoot !== '/proc';
  const links = useProcfs
    ? getProcessFds(pid, procRoot)
    : listProcessOpenFiles(pid) ?? [];
  const databases = conversationsDir ?? join(homedir(), '.gemini', 'antigravity-cli', 'conversations');
  const presencePrefixes = directoryPrefixVariants(join(dirname(databases), 'presence'));
  const active = new Set<string>();
  for (const link of links) {
    const presencePrefix = matchingPrefix(link, presencePrefixes);
    if (!presencePrefix || !link.endsWith('.lock')) continue;
    const id = link.slice(presencePrefix.length, -'.lock'.length);
    if (UUID_RE.test(id)) active.add(id.toLowerCase());
  }
  if (active.size > 0) return active.size === 1 ? [...active][0] : null;

  if (useProcfs) {
    for (const child of getProcessChildPids(pid, procRoot)) links.push(...getProcessFds(child, procRoot));
  }
  const databasePrefixes = directoryPrefixVariants(databases);
  const brainPrefixes = directoryPrefixVariants(join(dirname(databases), 'brain'));
  let found: string | null = null;
  for (const link of links) {
    let id: string | undefined;
    const brainPrefix = matchingPrefix(link, brainPrefixes);
    if (brainPrefix) {
      id = link.slice(brainPrefix.length).split('/')[0];
    } else {
      const databasePrefix = matchingPrefix(link, databasePrefixes);
      if (databasePrefix) {
        id = CONVERSATION_DB_RE.exec(link.slice(databasePrefix.length))?.[1];
      }
    }
    if (!id || !UUID_RE.test(id)) continue;
    if (found && found.toLowerCase() !== id.toLowerCase()) return null;
    found ??= id;
  }
  return found;
}

function uriToPath(uri: string): string {
  let path = uri.startsWith('file://') ? uri.slice(7) : uri;
  try {
    path = decodeURIComponent(path);
  } catch {
    // ignore
  }
  return path.replace(/\/+$/, '');
}

function matchesWorkspaceUri(rawUris: unknown, cleanCwd: string): boolean {
  if (typeof rawUris !== 'string' || !rawUris) return false;
  try {
    const parsed = JSON.parse(rawUris);
    if (Array.isArray(parsed)) {
      return parsed.some(
        (u) => typeof u === 'string' && uriToPath(u) === cleanCwd,
      );
    }
    if (typeof parsed === 'string') {
      return uriToPath(parsed) === cleanCwd;
    }
  } catch {
    // not valid JSON
  }
  return uriToPath(rawUris) === cleanCwd;
}

/**
 * Look up the most recently modified conversation in conversation_summaries.db
 * whose workspace_uris array matches the specified cwd.
 * Compares exact decoded file URI paths to prevent prefix/substring collisions.
 */
export function findAntigravityConversationIdByWorkspace(
  cwd: string,
  summariesDbPath?: string,
): string | null {
  if (!cwd) return null;
  const dbPath = summariesDbPath ?? join(homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  if (!existsSync(dbPath)) return null;

  const db = openDatabaseSyncNow(dbPath, { readOnly: true });
  if (!db) return null;

  try {
    const rows = db.prepare(
      'SELECT conversation_id, workspace_uris FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 50',
    ).all() as Array<{ conversation_id: unknown; workspace_uris: unknown }>;

    const cleanCwd = cwd.replace(/\/+$/, '');
    for (const row of rows) {
      const cid = typeof row.conversation_id === 'string' ? row.conversation_id : '';
      if (!UUID_RE.test(cid)) continue;
      if (matchesWorkspaceUri(row.workspace_uris, cleanCwd)) {
        return cid;
      }
    }
  } catch {
    // Database busy or unreadable
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }

  return null;
}

/**
 * Discover the Antigravity conversation ID for a session.
 * Prioritizes PID open fds (authoritative).
 * When PID is present, does not fall back to workspace summaries to prevent
 * claiming old historical sessions before the new process opens its DB.
 */
export function findAntigravityConversationId(opts: AntigravityDiscoveryOptions): string | null {
  if (opts.pid) {
    const fromPid = findAntigravityConversationIdByPid(opts.pid, opts.conversationsDir);
    if (fromPid) return fromPid;
    if (!opts.allowWorkspaceFallbackWithPid) {
      return null;
    }
  }
  if (opts.cwd) {
    const fromWs = findAntigravityConversationIdByWorkspace(opts.cwd, opts.summariesDbPath);
    if (fromWs) return fromWs;
  }
  return null;
}
