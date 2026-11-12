import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncNow } from './sqlite-compat.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_MATCH_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

/**
 * Scan /proc/<pid>/fd (and its child processes) for open SQLite handles
 * matching ~/.gemini/antigravity-cli/conversations/<uuid>.db.
 *
 * Fails closed (`null`) when zero or multiple distinct conversation UUIDs are
 * open across the process tree (for example during startup `ListConversations`
 * summary indexing or after `/fork` retains the parent DB alongside the child).
 * Multiple SQLite sidecar descriptors (`.db`, `.db-wal`, `.db-shm`) for the
 * same conversation collapse to one UUID.
 */
export function findAntigravityConversationIdByPid(
  pid: number,
  conversationsDir?: string,
  procRoot = '/proc',
): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const pidsToScan: number[] = [pid, ...getProcessChildPids(pid, procRoot)];
  const marker = conversationsDir ?? join('.gemini', 'antigravity-cli', 'conversations');
  const found = new Map<string, string>();

  for (const p of pidsToScan) {
    const links = getProcessFds(p, procRoot);
    for (const link of links) {
      if (!link.includes(marker)) continue;
      const m = link.match(UUID_MATCH_RE);
      if (m && UUID_RE.test(m[0])) {
        const key = m[0].toLowerCase();
        if (!found.has(key)) {
          found.set(key, m[0]);
          if (found.size > 1) return null;
        }
      }
    }
  }
  return found.size === 1 ? (found.values().next().value ?? null) : null;
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
