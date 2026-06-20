/**
 * Zellij adopt discovery — find CLIs running in a user's zellij sessions and
 * resolve the (paneId, pid, cwd, cliSessionId) needed to adopt them.
 *
 * The per-pid resolution (CLI detection, cwd, CLI-native session id) is shared
 * with the tmux path (session-discovery.ts) — multiplexer-agnostic. What's
 * zellij-specific is pane enumeration (`dump-layout` for command/cwd +
 * `list-panes` for the drive id) and the pane→pid join.
 *
 * pane→pid join: zellij exposes no pid in list-panes, so we enumerate the
 * session server's descendant CLI processes and match each dump-layout pane by
 * (cliId, cwd). cwd is a strong discriminator (each CLI usually in its own
 * project dir). If a pane matches zero or >1 process, we REFUSE it (skip) —
 * better no-adopt than adopting the wrong pane (Codex's guidance).
 */
import { realpathSync } from 'node:fs';
import type { CliId } from '../adapters/cli/types.js';
import {
  readComm, readCwd, getChildPids, readClaudeSessionMeta, cliIdFromCommArgv, readCmdline,
  readProcessStartTime,
} from './session-discovery.js';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { findTraexRolloutByPid } from '../services/traex-transcript.js';
import { findServerPid } from '../adapters/backend/zellij-backend.js';
import {
  listLiveSessions, parseListPanesJson,
} from './zellij-session-discovery.js';
import { zellijEnv } from '../setup/ensure-zellij.js';
import { logger } from '../utils/logger.js';
import { execFileSync } from 'node:child_process';

export { cliIdFromCommArgv } from './session-discovery.js';

export interface ZellijAdoptableSession {
  zellijSession: string;   // e.g. "mywork"
  zellijPaneId: string;    // e.g. "terminal_1" — the action/dump-screen target
  cliPid: number;          // resolved CLI process pid
  cliId: CliId;
  sessionId?: string;      // CLI-native session id (claude/codex/coco)
  cwd: string;             // CLI working directory
  startedAt?: number;      // epoch ms (claude only)
  paneCols: number;
  paneRows: number;
}

/** Normalise a path for comparison (resolve symlinks + strip trailing slash). */
function canonPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  let out = p;
  try { out = realpathSync(p); } catch { /* keep raw */ }
  return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

function cliIdForProc(pid: number, filterCliId?: CliId): CliId | undefined {
  return cliIdFromCommArgv(readComm(pid), readCmdline(pid), filterCliId);
}

/** BFS the process tree under rootPid collecting every known CLI process with
 *  its cwd, for matching against dump-layout panes. Interpreter-wrapper chains
 *  (e.g. an fnm shim `node …/bin/codex` whose child is the native `codex`
 *  binary) are collapsed to ONE entry — the deepest match — so a single CLI
 *  doesn't look like two same-cwd candidates (which would trip the ambiguity
 *  guard). The deepest process is also the one holding the transcript fds,
 *  matching tmux's findCliProcess. */
function findAllClisUnder(
  rootPid: number,
  maxDepth: number,
  filterCliId?: CliId,
): Array<{ pid: number; cliId: CliId; cwd?: string }> {
  const found: Array<{ pid: number; cliId: CliId; cwd?: string }> = [];
  const parentOf = new Map<number, number>();
  let current = [rootPid];
  for (let depth = 0; depth <= maxDepth && current.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of current) {
      const cliId = cliIdForProc(pid, filterCliId);
      if (cliId) found.push({ pid, cliId, cwd: canonPath(readCwd(pid)) });
      for (const ch of getChildPids(pid)) { parentOf.set(ch, pid); next.push(ch); }
    }
    current = next;
  }
  // Drop a match that is an ancestor of another same-cliId match (the wrapper);
  // keep the deepest (native) process.
  const isAncestor = (anc: number, desc: number): boolean => {
    let p: number | undefined = desc;
    while (p !== undefined && parentOf.has(p)) { p = parentOf.get(p); if (p === anc) return true; }
    return false;
  };
  return found.filter(m => !found.some(n => n.pid !== m.pid && n.cliId === m.cliId && isAncestor(m.pid, n.pid)));
}

/** comm values that are never a pane process — transient scan/client tooling
 *  that `ps`-based discovery and `zellij action` calls spawn under the server. */
const TRANSIENT_COMMS = new Set(['zellij', 'ps', 'pgrep', 'sh-from-ps', '']);

/**
 * Persistent pane-shell children of a zellij server, robust against the
 * transient processes that briefly parent to the server during discovery.
 *
 * Two failure modes are filtered: (1) `getChildPids` snapshots the whole `ps`
 * table, so any `ps`/`zellij`-client process alive at that instant with
 * ppid==server leaks in (comm denylist removes these); (2) anything else
 * transient — caught by taking TWO snapshots and intersecting, since a
 * short-lived process is gone by the second read while real pane shells persist.
 * Without this the children count flaps vs the terminal count → the count guard
 * intermittently refuses → discovery returns nothing on the unlucky call → the
 * card shows panes but the click's re-discovery finds none → "目标 CLI 会话已退出".
 */
function paneShellChildren(serverPid: number): number[] {
  const snap = (): Set<number> => new Set(
    getChildPids(serverPid).filter(pid => {
      const c = readComm(pid) ?? '';
      return c.length > 0 && !TRANSIENT_COMMS.has(c);
    }),
  );
  const first = snap();
  const second = snap();
  return [...first].filter(pid => second.has(pid)).sort((a, b) => a - b);
}

/** Run a read-only `zellij --session S action …`, returning stdout or null. */
function zellijRead(session: string, args: string[]): string | null {
  try {
    return execFileSync('zellij', ['--session', session, 'action', ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, env: zellijEnv(),
    });
  } catch {
    return null;
  }
}

/** Trailing integer of a "terminal_<n>" id, for stable sorting. */
function paneNum(paneId: string): number {
  const m = paneId.match(/(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/** Live pane dimensions (content area) for a paneId in a session. */
function paneDimensions(session: string, paneId: string): { cols: number; rows: number } | undefined {
  try {
    const out = execFileSync('zellij', ['--session', session, 'action', 'list-panes', '--json'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, env: zellijEnv(),
    });
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return undefined;
    const pane = arr.find((p: any) => !p.is_plugin && `terminal_${p.id}` === paneId);
    if (!pane) return undefined;
    const cols = Number(pane.pane_content_columns ?? pane.pane_columns);
    const rows = Number(pane.pane_content_rows ?? pane.pane_rows);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return undefined;
    return { cols, rows };
  } catch {
    return undefined;
  }
}

function resolveSessionId(cliId: CliId, pid: number): { sessionId?: string; startedAt?: number } {
  if (cliId === 'claude-code') {
    const meta = readClaudeSessionMeta(pid);
    return { sessionId: meta?.sessionId, startedAt: meta?.startedAt };
  }
  if (cliId === 'codex') {
    const rollout = findCodexRolloutByPid(pid);
    return { sessionId: rollout?.cliSessionId };
  }
  if (cliId === 'coco') {
    const coco = findCocoSessionByPid(pid);
    return { sessionId: coco?.sessionId };
  }
  if (cliId === 'traex') {
    const rollout = findTraexRolloutByPid(pid);
    return { sessionId: rollout?.cliSessionId };
  }
  return {};
}

/**
 * Scan all live zellij sessions for adoptable CLIs. Skips bmx-* (botmux's own).
 * @param filterCliId only return sessions matching this CLI type.
 */
export function discoverAdoptableZellijSessions(filterCliId?: CliId): ZellijAdoptableSession[] {
  const results: ZellijAdoptableSession[] = [];

  for (const session of listLiveSessions()) {
    if (session.startsWith('bmx-')) continue;

    const panesOut = zellijRead(session, ['list-panes', '--json']);
    if (!panesOut) continue;
    const terminals = parseListPanesJson(panesOut)
      .filter(p => !p.isPlugin && !p.isFloating)
      .sort((a, b) => paneNum(a.paneId) - paneNum(b.paneId));
    if (terminals.length === 0) continue;

    const serverPid = findServerPid(session);
    if (!serverPid) continue;

    // Bind each pane to its OWN process subtree. The zellij server forks one
    // shell per terminal pane, so its direct children sorted by pid (= process
    // creation order) align positionally with the terminals sorted by id (=
    // pane creation order) — both strictly monotonic. This gives each pane its
    // specific CLI pid WITHOUT a cwd match, which is essential when several
    // panes/tabs run the SAME cli from the SAME dir (e.g. multiple `codex` in
    // ~): a cwd match is then ambiguous and silently drops them all (the bug
    // 申晗 hit). Counts must match or the alignment is unreliable → refuse.
    // paneShellChildren filters the transient ps/zellij-client processes that
    // briefly parent to the server during discovery (see its doc) — only
    // persistent pane shells/commands remain, so the count guard is stable.
    const children = paneShellChildren(serverPid);
    if (children.length !== terminals.length) {
      logger.debug(`[zellij-adopt] ${session}: pane processes(${children.length}) != terminals(${terminals.length}) — can't align, refusing`);
      continue;
    }

    for (let i = 0; i < terminals.length; i++) {
      // findAllClisUnder collapses the node-wrapper chain to the native CLI;
      // a bare shell pane yields none and is skipped.
      const clis = findAllClisUnder(children[i]!, 4, filterCliId);
      if (clis.length === 0) continue;
      const cli = clis[0]!;

      const dims = paneDimensions(session, terminals[i]!.paneId);
      if (!dims) continue;

      const { sessionId, startedAt } = resolveSessionId(cli.cliId, cli.pid);
      results.push({
        zellijSession: session,
        zellijPaneId: terminals[i]!.paneId,
        cliPid: cli.pid,
        cliId: cli.cliId,
        sessionId,
        cwd: cli.cwd ?? '',
        // Same uptime fallback as the tmux path: only Claude carries startedAt
        // from its session JSON, so derive it from the process for everyone else.
        startedAt: startedAt ?? readProcessStartTime(cli.pid),
        paneCols: dims.cols,
        paneRows: dims.rows,
      });
    }
  }

  return results;
}

/** Re-confirm a zellij pane still runs the expected CLI pid (pre-adopt guard).
 *  `filterCliId` MUST mirror discovery's filter: a generic-named `agent` (Cursor)
 *  is only recognized as a CLI under the 'cursor' filter, so without it the
 *  expected pid is never re-identified and a live session looks exited. */
export function validateZellijAdoptTarget(session: string, paneId: string, expectedPid: number, filterCliId?: CliId): boolean {
  const serverPid = findServerPid(session);
  if (!serverPid) return false;
  const clis = findAllClisUnder(serverPid, 4, filterCliId);
  if (!clis.some(c => c.pid === expectedPid)) return false;
  // And the pane must still exist.
  return paneDimensions(session, paneId) !== undefined;
}
