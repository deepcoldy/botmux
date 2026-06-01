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
import { basename } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import {
  cliIdForComm, readComm, readCwd, getChildPids, readClaudeSessionMeta,
} from './session-discovery.js';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { findServerPid } from '../adapters/backend/zellij-backend.js';
import {
  listLiveSessions, discoverSessionClis, type DiscoveredCli,
} from './zellij-session-discovery.js';
import { zellijEnv } from '../setup/ensure-zellij.js';
import { execFileSync } from 'node:child_process';

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

/** BFS the process tree under rootPid collecting every known CLI process with
 *  its cwd, for matching against dump-layout panes. */
function findAllClisUnder(
  rootPid: number,
  maxDepth: number,
  filterCliId?: CliId,
): Array<{ pid: number; cliId: CliId; cwd?: string }> {
  const found: Array<{ pid: number; cliId: CliId; cwd?: string }> = [];
  let current = [rootPid];
  for (let depth = 0; depth <= maxDepth && current.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of current) {
      const comm = readComm(pid);
      const cliId = comm ? cliIdForComm(comm, filterCliId) : undefined;
      if (cliId) found.push({ pid, cliId, cwd: canonPath(readCwd(pid)) });
      next.push(...getChildPids(pid));
    }
    current = next;
  }
  return found;
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

    const panes: DiscoveredCli[] = discoverSessionClis(session); // {paneId, command, cwd, ...}
    if (panes.length === 0) continue;

    const serverPid = findServerPid(session);
    if (!serverPid) continue;
    const clis = findAllClisUnder(serverPid, 4, filterCliId);

    for (const pane of panes) {
      const expectedCliId = cliIdForComm(basename(pane.command), filterCliId);
      if (!expectedCliId) continue;
      if (filterCliId && expectedCliId !== filterCliId) continue;

      const paneCwd = canonPath(pane.cwd);
      const matches = clis.filter(c => c.cliId === expectedCliId && c.cwd && c.cwd === paneCwd);
      // Refuse ambiguous (>1) or unresolved (0) — never adopt the wrong pane.
      if (matches.length !== 1) continue;
      const cli = matches[0]!;

      const dims = paneDimensions(session, pane.paneId);
      if (!dims) continue;

      const { sessionId, startedAt } = resolveSessionId(expectedCliId, cli.pid);
      results.push({
        zellijSession: session,
        zellijPaneId: pane.paneId,
        cliPid: cli.pid,
        cliId: expectedCliId,
        sessionId,
        cwd: cli.cwd ?? pane.cwd ?? '',
        startedAt,
        paneCols: dims.cols,
        paneRows: dims.rows,
      });
    }
  }

  return results;
}

/** Re-confirm a zellij pane still runs the expected CLI pid (pre-adopt guard). */
export function validateZellijAdoptTarget(session: string, paneId: string, expectedPid: number): boolean {
  const serverPid = findServerPid(session);
  if (!serverPid) return false;
  const clis = findAllClisUnder(serverPid, 4);
  if (!clis.some(c => c.pid === expectedPid)) return false;
  // And the pane must still exist.
  return paneDimensions(session, paneId) !== undefined;
}
