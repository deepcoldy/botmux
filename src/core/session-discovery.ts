/**
 * Session Discovery — scans tmux panes for running CLI processes that can be adopted.
 *
 * Discovers non-botmux tmux sessions running known CLI binaries (Claude Code,
 * Codex, Aiden, CoCo, Gemini, OpenCode) and collects metadata needed to adopt them.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AdoptableSession {
  tmuxTarget: string;       // e.g. "0:2.0"
  panePid: number;          // tmux pane's shell PID
  cliPid: number;           // CLI process PID
  cliId: CliId;             // recognized CLI type
  sessionId?: string;       // Claude Code session ID
  cwd: string;              // CLI working directory
  startedAt?: number;       // epoch ms
  paneCols: number;         // current pane width
  paneRows: number;         // current pane height
}

// ─── CLI process name → CliId mapping ────────────────────────────────────────

const CLI_COMM_MAP: Record<string, CliId> = {
  claude: 'claude-code',
  codex: 'codex',
  aiden: 'aiden',
  coco: 'coco',
  gemini: 'gemini',
  opencode: 'opencode',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal shell-escape for tmux targets. */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Read the comm name for a PID from /proc.
 * Returns undefined if the process no longer exists.
 */
function readComm(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return undefined;
  }
}

/**
 * Read the cwd for a PID via /proc/<pid>/cwd symlink.
 * Returns undefined if unavailable.
 */
function readCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/** Get direct child PIDs of a process via `ps --ppid`. */
function getChildPids(pid: number): number[] {
  try {
    const out = execSync(`ps --ppid ${pid} -o pid=`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return out
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter(n => !isNaN(n));
  } catch {
    return [];
  }
}

/**
 * Recursively search the process tree (up to `maxDepth` levels) for a known CLI binary.
 * Returns { pid, cliId } of the first match, or undefined.
 */
function findCliProcess(
  rootPid: number,
  maxDepth: number,
): { pid: number; cliId: CliId } | undefined {
  // BFS through the process tree
  let current = [rootPid];

  for (let depth = 0; depth <= maxDepth && current.length > 0; depth++) {
    const next: number[] = [];

    for (const pid of current) {
      const comm = readComm(pid);
      if (comm && comm in CLI_COMM_MAP) {
        return { pid, cliId: CLI_COMM_MAP[comm]! };
      }
      next.push(...getChildPids(pid));
    }

    current = next;
  }

  return undefined;
}

/**
 * Try to read Claude Code session metadata from ~/.claude/sessions/<PID>.json.
 * Returns { sessionId, cwd, startedAt } or undefined.
 */
function readClaudeSessionMeta(pid: number): { sessionId?: string; cwd?: string; startedAt?: number } | undefined {
  try {
    const metaPath = join(homedir(), '.claude', 'sessions', `${pid}.json`);
    const raw = readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      sessionId: typeof data.sessionId === 'string' ? data.sessionId : undefined,
      cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
      startedAt: typeof data.startedAt === 'number' ? data.startedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Get pane dimensions via tmux display command.
 * Returns { cols, rows } or undefined on failure.
 */
function getPaneDimensions(tmuxTarget: string): { cols: number; rows: number } | undefined {
  try {
    const out = execSync(
      `tmux display -t ${shellescape(tmuxTarget)} -p '#{pane_width} #{pane_height}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const [colsStr, rowsStr] = out.split(' ');
    const cols = Number(colsStr);
    const rows = Number(rowsStr);
    if (isNaN(cols) || isNaN(rows)) return undefined;
    return { cols, rows };
  } catch {
    return undefined;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan all tmux panes for running CLI processes that can be adopted by Botmux.
 *
 * Skips `bmx-*` prefixed sessions (already managed by Botmux).
 * For each remaining pane, recursively searches the process tree (up to 3 levels)
 * for known CLI binaries.
 */
export function discoverAdoptableSessions(): AdoptableSession[] {
  // 1. List all tmux panes
  let panesRaw: string;
  try {
    panesRaw = execSync(
      "tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_pid}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    // tmux not available or no server running
    return [];
  }

  const results: AdoptableSession[] = [];

  const lines = panesRaw.split('\n').filter(Boolean);

  for (const line of lines) {
    // Parse: "session_name:window_index.pane_index pane_pid"
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue;

    const tmuxTarget = line.slice(0, spaceIdx);
    const panePid = Number(line.slice(spaceIdx + 1));
    if (isNaN(panePid)) continue;

    // 2. Filter out bmx-* sessions
    const sessionName = tmuxTarget.split(':')[0];
    if (sessionName?.startsWith('bmx-')) continue;

    // 3. Recursively search process tree for known CLI binaries (up to 3 levels)
    const match = findCliProcess(panePid, 3);
    if (!match) continue;

    // 4. Read CLI working directory from /proc
    const cwd = readCwd(match.pid);
    if (!cwd) continue;

    // 5. Try to read Claude Code session metadata
    let sessionId: string | undefined;
    let startedAt: number | undefined;
    if (match.cliId === 'claude-code') {
      const meta = readClaudeSessionMeta(match.pid);
      if (meta) {
        sessionId = meta.sessionId;
        startedAt = meta.startedAt;
      }
    }

    // 6. Get pane dimensions
    const dims = getPaneDimensions(tmuxTarget);
    if (!dims) continue;

    results.push({
      tmuxTarget,
      panePid,
      cliPid: match.pid,
      cliId: match.cliId,
      sessionId,
      cwd,
      startedAt,
      paneCols: dims.cols,
      paneRows: dims.rows,
    });
  }

  return results;
}

/**
 * Re-check that a specific pane still has the expected CLI process running.
 * Used to validate an adopt target right before the actual adoption.
 */
export function validateAdoptTarget(tmuxTarget: string, expectedPid: number): boolean {
  // Verify the tmux pane still exists and get its shell PID
  let panePid: number;
  try {
    const out = execSync(
      `tmux display -t ${shellescape(tmuxTarget)} -p '#{pane_pid}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    panePid = Number(out);
    if (isNaN(panePid)) return false;
  } catch {
    return false;
  }

  // Search the process tree for the expected CLI PID
  const match = findCliProcess(panePid, 3);
  return match !== undefined && match.pid === expectedPid;
}
