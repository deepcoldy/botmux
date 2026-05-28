/**
 * Session Discovery — scans tmux panes for running CLI processes that can be adopted.
 *
 * Discovers non-botmux tmux sessions running known CLI binaries (Claude Code,
 * Codex, Aiden, CoCo, Gemini, OpenCode, MTR, Hermes) and collects metadata needed to adopt them.
 */
import { execSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { tmuxEnv } from '../setup/ensure-tmux.js';

// macOS 没有 /proc，所以走 ps/lsof/pgrep 兜底。Linux 仍优先走 /proc 快路径。
const IS_LINUX = platform() === 'linux';

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
  mtr: 'mtr',
  hermes: 'hermes',
};

function cliIdForComm(comm: string, filterCliId?: CliId): CliId | undefined {
  const normalizedComm = comm.startsWith('.') ? comm.slice(1) : comm;
  const direct = CLI_COMM_MAP[comm] ?? CLI_COMM_MAP[normalizedComm];
  // MTR is an OpenCode fork and some installs still expose the underlying
  // native process as "opencode". When an MTR bot asks to adopt, treat that
  // process as MTR so the bot's filter does not hide its own sessions.
  if (filterCliId === 'mtr' && direct === 'opencode') return 'mtr';
  return direct;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal shell-escape for tmux targets. */
function shellescape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 读取进程的 comm 名（不含路径）。Linux 走 /proc/<pid>/comm 快路径；
 * macOS / 其它 Unix 走 `ps -o comm=` 兜底。
 *
 * 注意 macOS 的 `ps -o comm=` 返回完整可执行路径（如 `/usr/local/bin/claude`），
 * 所以这里统一做一次 basename，让上层匹配 CLI_COMM_MAP 的逻辑保持不变。
 *
 * 返回 undefined 表示进程不存在或读不到。
 */
function readComm(pid: number): string | undefined {
  if (IS_LINUX) {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    } catch {
      // 落到下面的 ps 兜底
    }
  }
  try {
    const out = execSync(`ps -o comm= -p ${pid}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!out) return undefined;
    return out.includes('/') ? basename(out) : out;
  } catch {
    return undefined;
  }
}

/**
 * 读取进程的工作目录。Linux 走 /proc/<pid>/cwd 软链；
 * macOS / 其它 Unix 走 `lsof -a -d cwd -p <pid> -Fn` 兜底。
 *
 * lsof -Fn 的输出格式：
 *   p<pid>
 *   fcwd
 *   n<path>
 * 这里只解析以 n 开头的那一行。
 *
 * 返回 undefined 表示读不到。
 */
function readCwd(pid: number): string | undefined {
  if (IS_LINUX) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // 落到下面的 lsof 兜底
    }
  }
  try {
    const out = execSync(`lsof -a -d cwd -p ${pid} -Fn`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('n')) return line.slice(1);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 获取一个进程的直接子进程 PID。
 *
 * 既不能用 GNU `ps --ppid`（BSD ps 不支持长选项），也不能用 `pgrep -P`
 * （macOS BSD pgrep 把 `-P` 当过滤器，要求**必须**搭配一个 pattern 位置参数，
 * 不传 pattern 返回空）。
 *
 * 改成一次 `ps -A -o pid= -o ppid=` 把全表拿回来 JS 端过滤 —— 两个平台
 * 的 ps 都接受这个写法。fork-exec 一次代价可接受，因为 discovery 本身是
 * 低频操作（只在用户 /adopt 时跑一遍）。
 */
function getChildPids(pid: number): number[] {
  try {
    const out = execSync('ps -A -o pid= -o ppid=', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const children: number[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const childPid = Number(parts[0]);
      const parentPid = Number(parts[1]);
      if (!isNaN(childPid) && !isNaN(parentPid) && parentPid === pid) {
        children.push(childPid);
      }
    }
    return children;
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
  filterCliId?: CliId,
): { pid: number; cliId: CliId } | undefined {
  // BFS through the process tree
  let current = [rootPid];

  for (let depth = 0; depth <= maxDepth && current.length > 0; depth++) {
    const next: number[] = [];

    for (const pid of current) {
      const comm = readComm(pid);
      if (comm) {
        const cliId = cliIdForComm(comm, filterCliId);
        if (cliId) return { pid, cliId };
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
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: tmuxEnv() },
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
 *
 * @param filterCliId - If provided, only return sessions matching this CLI type.
 */
export function discoverAdoptableSessions(filterCliId?: CliId): AdoptableSession[] {
  // 1. List all tmux panes
  let panesRaw: string;
  try {
    panesRaw = execSync(
      "tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_pid}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: tmuxEnv() },
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
    const match = findCliProcess(panePid, 3, filterCliId);
    if (!match) continue;

    // 3b. Filter by CLI type if requested
    if (filterCliId && match.cliId !== filterCliId) continue;

    // 4. Read CLI working directory (Linux: /proc; macOS: lsof)
    const cwd = readCwd(match.pid);
    if (!cwd) continue;

    // 5. Try to read CLI session metadata
    let sessionId: string | undefined;
    let startedAt: number | undefined;
    if (match.cliId === 'claude-code') {
      const meta = readClaudeSessionMeta(match.pid);
      if (meta) {
        sessionId = meta.sessionId;
        startedAt = meta.startedAt;
      }
    } else if (match.cliId === 'codex') {
      // Codex has no per-pid state file — bind via the open rollout fd in
      // /proc. Worker-side has the same probe as a fallback so this is
      // best-effort: we resolve here so the daemon-side adopt UI shows
      // an accurate "currently in session X" hint.
      const rollout = findCodexRolloutByPid(match.pid);
      if (rollout) sessionId = rollout.cliSessionId;
    } else if (match.cliId === 'coco') {
      // CoCo: probe /proc/<pid>/fd for an open file under the session dir
      // (session.log / traces.jsonl). events.jsonl itself is opened-written-
      // closed per event so it's not reliable on its own. Worker-side
      // re-probes too, so undefined here is acceptable.
      const cocoSession = findCocoSessionByPid(match.pid);
      if (cocoSession) sessionId = cocoSession.sessionId;
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
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: tmuxEnv() },
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

// 仅供单测使用 —— 暴露内部 helper，方便覆盖跨平台 (Linux /proc vs macOS ps/lsof/pgrep)
// 的回归路径。生产代码不要直接消费这些导出。
export const __testOnly_readComm = readComm;
export const __testOnly_readCwd = readCwd;
export const __testOnly_getChildPids = getChildPids;
