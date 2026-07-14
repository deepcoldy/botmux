/**
 * Session Discovery — scans tmux panes for running CLI processes that can be adopted.
 *
 * Discovers non-botmux tmux sessions running known CLI binaries (Claude Code,
 * Codex, Aiden, CoCo, Cursor, Gemini, OpenCode, MTR, Hermes, TRAE, Pi) and collects metadata needed to adopt them.
 */
import { execFileSync, execSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import type { CliId } from '../adapters/cli/types.js';
import { findCodexRolloutByPid } from '../services/codex-transcript.js';
import { findCocoSessionByPid } from '../services/coco-transcript.js';
import { findTraexRolloutByPid } from '../services/traex-transcript.js';
import { tmuxEnv } from '../setup/ensure-tmux.js';

// macOS 没有 /proc，所以走 ps/lsof/pgrep 兜底。Linux 仍优先走 /proc 快路径。
const IS_LINUX = platform() === 'linux';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AdoptableSession {
  source: 'tmux' | 'herdr';
  tmuxTarget?: string;       // e.g. "0:2.0"
  panePid?: number;          // tmux pane's shell PID
  cliPid?: number;           // CLI process PID, when the source exposes one
  herdrSessionName?: string;
  herdrTarget?: string;
  herdrPaneId?: string;
  herdrAgentName?: string;
  herdrTerminalId?: string;
  cliId: CliId;              // recognized CLI type
  sessionId?: string;        // CLI session ID
  cwd: string;               // CLI working directory
  startedAt?: number;        // epoch ms
  paneCols: number;          // current pane width
  paneRows: number;          // current pane height
}

// ─── CLI process name → CliId mapping ────────────────────────────────────────

const CLI_COMM_MAP: Record<string, CliId> = {
  claude: 'claude-code',
  // Seed / Relay are Claude Code forks (Relay is Seed's new release
  // name). Both rebrand process.title to their product name, so a running
  // session's `/proc/<pid>/comm` is literally `seed` / `relay` (verified on a
  // live host) — map them so `/adopt` can discover live panes by comm, the same
  // way `claude` resolves to claude-code. filterCliId keeps a seed/relay bot
  // from adopting the other's (or claude's) sessions.
  seed: 'seed',
  relay: 'relay',
  codex: 'codex',
  aiden: 'aiden',
  coco: 'coco',
  'cursor-agent': 'cursor',
  // CoCo 的别名 traecli：某些发行版（如 trae）安装的可执行实际叫
  // `traecli`，tmux pane_current_command 仍显示 "coco" 是因为进程标题被
  // 改写过；macOS 下 `ps -o comm=` 拿到的是真实 argv[0]，因此这里需要
  // 把别名 traecli 也识别成 coco，否则 /adopt 扫不到这种会话。
  traecli: 'coco',
  // TRAE（traex）是另一套 Codex 系 CLI，可执行就叫 `traex`，与上面 CoCo 的
  // traecli 别名是两个不同的二进制（traecli 是 coco 的软链）。
  traex: 'traex',
  gemini: 'gemini',
  opencode: 'opencode',
  mtr: 'mtr',
  hermes: 'hermes',
  pi: 'pi',
  omp: 'oh-my-pi',
  // Grok Build 的可执行就叫 `grok`（原生二进制，comm = basename），映射后
  // live `/adopt` 才能按 comm 发现正在运行的 Grok pane 并进 worker 的
  // grok adopt 分支（transcript bridge / by-pid 绑定都依赖这个入口）。
  grok: 'grok',
  'kiro-cli': 'kiro-cli',
};

/** Interpreters and native launchers that may hide the CLI identity in argv.
 *  Cursor Agent is one example on Linux: /proc/<pid>/comm can be `MainThread`
 *  while argv[0] is `/.../cursor-agent` or `/.../agent`. */
const COMM_ARGV_LAUNCHERS = new Set([
  'node', 'nodejs', 'bun', 'deno', 'python', 'python2', 'python3', 'ruby', 'npx', 'tsx',
  'MainThread',
]);

/** Interactive-shell comms. When a pane's leaf process is one of these AFTER
 *  botmux is ready to type the first prompt, the CLI never actually launched —
 *  e.g. the shell wrapper's `exec <cli>` was pre-empted by a user rcfile that
 *  `exec`-trampolines into another shell. None of the supported CLIs runs AS a
 *  bare shell (they're rust/go binaries or node), so this set never collides
 *  with a healthy CLI leaf. Used by the worker's launch-failure detector. */
const BARE_SHELL_COMMS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh',
]);

/** True when `comm` names an interactive shell rather than an agent CLI. */
export function isBareShellComm(comm: string | undefined): boolean {
  if (!comm) return false;
  return BARE_SHELL_COMMS.has(comm.startsWith('.') ? comm.slice(1) : comm);
}

/** Classify a confirmed bare-shell launch for diagnostics: 'trampoline' when the
 *  observed leaf shell differs from the shell botmux launched with — the
 *  signature of an rcfile that `exec`-trampolines into another shell (e.g.
 *  `$SHELL`=bash but the pane leaf is zsh). Otherwise 'stuck' (slow/erroring rc,
 *  or the CLI binary not on PATH). `expectedShell` may be '' when the launch
 *  shell is unknown, which yields 'stuck' (no confident trampoline claim). */
export function bareShellLaunchKind(leafComm: string, expectedShell: string): 'trampoline' | 'stuck' {
  return expectedShell && leafComm !== expectedShell ? 'trampoline' : 'stuck';
}

export function cliIdForComm(comm: string, filterCliId?: CliId): CliId | undefined {
  const normalizedComm = comm.startsWith('.') ? comm.slice(1) : comm;
  const direct = CLI_COMM_MAP[comm] ?? CLI_COMM_MAP[normalizedComm];
  // Cursor's agent binary may be installed as the generic name `agent`. Only
  // accept that alias when a Cursor bot is explicitly asking, otherwise a broad
  // /adopt scan could mistake unrelated agent processes for Cursor sessions.
  if (filterCliId === 'cursor' && normalizedComm === 'agent') return 'cursor';
  // MTR is an OpenCode fork and some installs still expose the underlying
  // native process as "opencode". When an MTR bot asks to adopt, treat that
  // process as MTR so the bot's filter does not hide its own sessions.
  if (filterCliId === 'mtr' && direct === 'opencode') return 'mtr';
  return direct;
}

/** /proc/<pid>/cmdline → argv (Linux fast path; ps fallback for macOS). */
export function readCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean);
  } catch {
    try {
      const out = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim().split(/\s+/).filter(Boolean);
    } catch { return []; }
  }
}

/**
 * Resolve a CliId from a process's comm + argv. Checks comm first; if the comm
 * belongs to a generic launcher, scan argv for the CLI executable basename.
 */
export function cliIdFromCommArgv(comm: string | undefined, argv: string[], filterCliId?: CliId): CliId | undefined {
  if (!comm) return undefined;
  let detected = cliIdForComm(comm, filterCliId);
  if (!detected && COMM_ARGV_LAUNCHERS.has(comm)) {
    for (const arg of argv) {
      if (arg.startsWith('-')) continue;
      const id = cliIdForComm(basename(arg), filterCliId);
      if (id) { detected = id; break; }
    }
  }
  if (!detected) return undefined;
  if (filterCliId && detected !== filterCliId) return undefined;
  return detected;
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
export function readComm(pid: number): string | undefined {
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
export function readCwd(pid: number): string | undefined {
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

// /proc/stat btime 与 CLK_TCK 在一次 daemon 生命周期内不变，缓存避免每个候选都
// 重复 fork-exec / 读盘。
let cachedBtimeSeconds: number | undefined;
let cachedBtimeRead = false;
function readBootTimeSeconds(): number | undefined {
  if (cachedBtimeRead) return cachedBtimeSeconds;
  cachedBtimeRead = true;
  try {
    const m = readFileSync('/proc/stat', 'utf-8').match(/^btime\s+(\d+)/m);
    cachedBtimeSeconds = m ? Number(m[1]) : undefined;
  } catch {
    cachedBtimeSeconds = undefined;
  }
  return cachedBtimeSeconds;
}

let cachedClkTck: number | undefined;
function clockTicksPerSecond(): number {
  if (cachedClkTck !== undefined) return cachedClkTck;
  try {
    const n = Number(execFileSync('getconf', ['CLK_TCK'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    cachedClkTck = Number.isFinite(n) && n > 0 ? n : 100;
  } catch {
    // 100 是 Linux 上几乎通用的默认值，拿不到 getconf 时用它兜底。
    cachedClkTck = 100;
  }
  return cachedClkTck;
}

/**
 * 进程启动时间（epoch ms），best-effort。让 /adopt 选择卡片能为**任意** CLI 显示
 * 真实运行时长，而不是只有 Claude（Claude 另有 ~/.claude/sessions/<pid>.json 带
 * startedAt）。其它 CLI（cursor/codex/coco/gemini…）之前一律落 "未知" 就是因为
 * 这里没有兜底。
 *
 * Linux 走 /proc/<pid>/stat（字段 22 = starttime，单位时钟滴答，自开机起算）+
 * /proc/stat 的 btime；其它 Unix 走 `ps -o lstart=` 解析。读不到返回 undefined。
 */
export function readProcessStartTime(pid: number): number | undefined {
  if (IS_LINUX) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // comm（字段 2）用括号包裹且可能含空格/括号，slice 到最后一个 ')' 之后，
      // 让后续字段偏移稳定。')' 之后第一个字段是 state（字段 3），所以 starttime
      // （字段 22）对应这里的下标 19。
      const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const starttimeTicks = Number(afterComm[19]);
      const btime = readBootTimeSeconds();
      if (Number.isFinite(starttimeTicks) && btime !== undefined) {
        return Math.round((btime + starttimeTicks / clockTicksPerSecond()) * 1000);
      }
    } catch {
      // 落到下面的 ps 兜底
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const ms = Date.parse(out);
      if (Number.isFinite(ms)) return ms;
    }
  } catch {
    // 进程不存在 / ps 不可用
  }
  return undefined;
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
export function getChildPids(pid: number): number[] {
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
        const cliId = cliIdFromCommArgv(comm, readCmdline(pid), filterCliId);
        if (cliId) return { pid, cliId };
      }
      next.push(...getChildPids(pid));
    }

    current = next;
  }

  return undefined;
}

/**
 * Resolve the REAL CLI pid spawned underneath a wrapperCli launcher
 * (e.g. `aiden x claude`, where the launcher forks real Claude Code as a child).
 *
 * The worker's `backend.getChildPid()` returns the LAUNCHER's pid, but it's the
 * forked child — not the launcher — that writes `~/.claude/sessions/<pid>.json`
 * and owns the transcript jsonl. Tracking the launcher pid therefore breaks
 * session-id discovery and leaves the JSONL bridge watching a path the real CLI
 * never writes. This walks the launcher's DESCENDANTS to find the actual CLI.
 *
 * Matching is by process `comm` ONLY — deliberately NOT argv. The launcher's own
 * argv carries the target name as a literal token (`aiden x claude` → "claude"
 * is in argv), so argv-scanning (cliIdFromCommArgv) would misidentify the
 * launcher itself as the CLI. The real CLI process has the binary as its comm
 * (`claude`, `codex`, …); the launcher's comm is its own (`node`/`aiden`).
 *
 * BFS starts at the launcher's children (never the launcher node) and returns
 * the shallowest descendant recognized as `targetCliId`, or null if none exists
 * yet — the launcher may not have forked the CLI at call time, so callers retry.
 */
export function findLaunchedCliPid(
  launcherPid: number,
  targetCliId: CliId,
  maxDepth = 6,
  // Injectable process probes (defaults hit the real OS); tests pass fakes.
  probes: { childrenOf?: (pid: number) => number[]; commOf?: (pid: number) => string | undefined } = {},
): number | null {
  const childrenOf = probes.childrenOf ?? getChildPids;
  const commOf = probes.commOf ?? readComm;
  let frontier = childrenOf(launcherPid);
  const seen = new Set<number>([launcherPid]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const comm = commOf(pid);
      if (comm && cliIdForComm(comm, targetCliId) === targetCliId) return pid;
      next.push(...childrenOf(pid));
    }
    frontier = next;
  }
  return null;
}

/**
 * Guard for the async wrapperCli pid-resolver retry. The retry closure starts
 * for ONE spawn and captures that spawn's `backendAtSpawn` instance + the
 * launcher pid it observed. A worker restart (CLI crash → in-worker respawn)
 * during the ~6s retry window tears down the backend and forks a NEW launcher,
 * so a stale tick must NOT apply its result — doing so would overwrite the NEW
 * session's `backend.cliPid` / global `bridgeCliPid` with a pid resolved from
 * the OLD launcher tree, mis-pointing the new session's bridge + discovery.
 *
 * A tick may apply only when (a) the backend instance is still the very one the
 * retry was scheduled for (respawn replaces it: `backend = null` then a fresh
 * object), and (b) that backend's current child pid is still the captured
 * launcher pid (defends against a same-instance pane-child change / pid reuse).
 */
export function launcherRetryStillValid(
  currentBackend: unknown,
  backendAtSpawn: unknown,
  currentChildPid: number | null | undefined,
  launcherPid: number,
): boolean {
  if (!currentBackend) return false;
  if (currentBackend !== backendAtSpawn) return false;
  return currentChildPid === launcherPid;
}

export interface WrapperRealPidResolveDeps {
  /** Find the real CLI descendant pid under the launcher (null until forked). */
  findRealPid: (launcherPid: number) => number | null;
  /** Current backend instance (identity-compared against the spawn snapshot). */
  getBackend: () => unknown;
  /** Backend's current child pid (the launcher while unchanged). */
  getChildPid: () => number | null | undefined;
  /** Apply the resolved real pid: rewire backend.cliPid + bridgeCliPid. */
  applyRealPid: (realPid: number) => void;
  /** Timer scheduler (injectable for tests). */
  schedule: (fn: () => void, ms: number) => void;
  intervalMs?: number;
  maxAttempts?: number;
}

/**
 * Drive the wrapperCli real-CLI-pid resolution as a bounded retry loop. Shared
 * by BOTH worker spawn paths — the synchronous one (tmux/pty, where
 * getChildPid() is the launcher immediately) and the late-pid fallback (zellij,
 * where getChildPid() is null at spawn and only resolves to the launcher
 * asynchronously). Either way the launcher forks the real CLI a beat later, so
 * we poll until findRealPid returns a descendant, then rewire.
 *
 * Every tick is gated by launcherRetryStillValid: a worker restart that swapped
 * the backend (or changed its child pid) aborts the loop so a stale resolution
 * can't clobber the new session's bridge/discovery.
 */
export function scheduleWrapperRealCliPid(launcherPid: number, deps: WrapperRealPidResolveDeps): void {
  const backendAtSpawn = deps.getBackend();
  const intervalMs = deps.intervalMs ?? 200;
  const maxAttempts = deps.maxAttempts ?? 30;
  let attempts = 0;
  const tick = () => {
    if (!launcherRetryStillValid(deps.getBackend(), backendAtSpawn, deps.getChildPid(), launcherPid)) return;
    const realPid = deps.findRealPid(launcherPid);
    if (realPid && realPid !== launcherPid) {
      deps.applyRealPid(realPid);
      return;
    }
    if (++attempts < maxAttempts) deps.schedule(tick, intervalMs);
  };
  deps.schedule(tick, intervalMs);
}

/**
 * Try to read Claude Code session metadata from ~/.claude/sessions/<PID>.json.
 * Returns { sessionId, cwd, startedAt } or undefined.
 */
export function readClaudeSessionMeta(pid: number): { sessionId?: string; cwd?: string; startedAt?: number } | undefined {
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


function realpathMaybe(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

export function findUniqueClaudeSessionByCwd(cwd: string): { sessionId?: string; startedAt?: number } | undefined {
  let names: string[];
  try {
    names = readdirSync(join(homedir(), '.claude', 'sessions'));
  } catch {
    return undefined;
  }
  const wanted = realpathMaybe(cwd);
  const matches: Array<{ sessionId?: string; startedAt?: number; updatedAt?: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(homedir(), '.claude', 'sessions', name), 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (typeof data.cwd !== 'string') continue;
      if (realpathMaybe(data.cwd) !== wanted) continue;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      if (!sessionId) continue;
      matches.push({
        sessionId,
        startedAt: typeof data.startedAt === 'number' ? data.startedAt : undefined,
        updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : undefined,
      });
    } catch {
      // Ignore malformed or concurrently rewritten metadata files.
    }
  }
  if (matches.length !== 1) return undefined;
  return matches[0];
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

type HerdrJsonResult = { ok: true; value: any | undefined } | { ok: false };

function tryHerdrJson(args: string[], opts?: { timeout?: number }): HerdrJsonResult {
  try {
    const out = execFileSync('herdr', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts?.timeout ?? 5000,
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
    return { ok: true, value: out ? JSON.parse(out) : undefined };
  } catch {
    return { ok: false };
  }
}

function herdrJson(args: string[], opts?: { timeout?: number }): any | undefined {
  const result = tryHerdrJson(args, opts);
  return result.ok ? result.value : undefined;
}

function extractHerdrSessions(raw: any): any[] {
  const sessions = raw?.sessions ?? raw?.result?.sessions;
  return Array.isArray(sessions) ? sessions : [];
}

function extractHerdrAgents(raw: any): any[] {
  const agents = raw?.result?.agents;
  return Array.isArray(agents) ? agents : [];
}

function herdrAgentCliId(agent: any, filterCliId?: CliId): CliId | undefined {
  const name = typeof agent?.agent === 'string' ? basename(agent.agent) : '';
  return name ? cliIdForComm(name, filterCliId) : undefined;
}

function discoverHerdrAdoptableSessions(filterCliId?: CliId): AdoptableSession[] {
  const rawSessions = herdrJson(['session', 'list', '--json']);
  const sessions = extractHerdrSessions(rawSessions).filter((s: any) => {
    const name = typeof s?.name === 'string' ? s.name : '';
    return name && s?.running === true && !name.startsWith('bmx-');
  });
  const results: AdoptableSession[] = [];
  for (const session of sessions) {
    const sessionName = session.name as string;
    const rawAgents = herdrJson(['--session', sessionName, 'agent', 'list']);
    for (const agent of extractHerdrAgents(rawAgents)) {
      const cliId = herdrAgentCliId(agent, filterCliId);
      if (!cliId) continue;
      if (filterCliId && cliId !== filterCliId) continue;
      const cwd = typeof agent?.cwd === 'string' ? agent.cwd : undefined;
      const paneId = typeof agent?.pane_id === 'string' ? agent.pane_id : undefined;
      const terminalId = typeof agent?.terminal_id === 'string' ? agent.terminal_id : undefined;
      const agentName = typeof agent?.agent === 'string' ? agent.agent : undefined;
      if (!cwd || !paneId) continue;
      const claudeMeta = cliId === 'claude-code' ? findUniqueClaudeSessionByCwd(cwd) : undefined;
      results.push({
        source: 'herdr',
        herdrSessionName: sessionName,
        herdrTarget: paneId,
        herdrPaneId: paneId,
        herdrAgentName: agentName,
        herdrTerminalId: terminalId,
        cliId,
        sessionId: claudeMeta?.sessionId,
        cwd,
        startedAt: claudeMeta?.startedAt,
        paneCols: 200,
        paneRows: 50,
      });
    }
  }
  return results;
}

export function adoptTargetLabel(target: AdoptableSession | NonNullable<import('./types.js').DaemonSession['adoptedFrom']>): string {
  if (target.source === 'herdr') {
    const sessionName = target.herdrSessionName ?? 'herdr';
    const pane = target.herdrPaneId ?? target.herdrTarget ?? target.herdrAgentName ?? 'agent';
    return `${sessionName}:${pane}`;
  }
  if ('zellijPaneId' in target && target.zellijPaneId) {
    return `${target.zellijSession ?? 'zellij'}/${target.zellijPaneId}`;
  }
  return target.tmuxTarget ?? 'tmux';
}

export function adoptTargetKey(target: AdoptableSession): string {
  if (target.source === 'herdr') return `herdr:${target.herdrSessionName}:${target.herdrPaneId ?? target.herdrTarget}`;
  return `tmux:${target.tmuxTarget}:${target.cliPid}`;
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
  const results: AdoptableSession[] = [];

  // 1. List all tmux panes
  let panesRaw: string | undefined;
  try {
    panesRaw = execSync(
      "tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_pid}'",
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env: tmuxEnv() },
    );
  } catch {
    panesRaw = undefined;
  }

  if (panesRaw) {

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
      } else if (match.cliId === 'traex') {
        // TRAE: same open-rollout-fd probe as Codex, with a TRAE-specific
        // path matcher (~/.trae/cli/sessions/...). Worker-side re-probes by
        // pid as a fallback, so undefined here is acceptable.
        const rollout = findTraexRolloutByPid(match.pid);
        if (rollout) sessionId = rollout.cliSessionId;
      }

      // 5b. Fall back to the CLI process's own start time for uptime. Without
      // this only Claude (which has a session JSON with startedAt) shows a real
      // uptime; every other CLI — cursor/codex/coco/gemini… — rendered "未知".
      if (startedAt === undefined) {
        startedAt = readProcessStartTime(match.pid);
      }

      // 6. Get pane dimensions
      const dims = getPaneDimensions(tmuxTarget);
      if (!dims) continue;

      results.push({
        source: 'tmux',
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
  }

  results.push(...discoverHerdrAdoptableSessions(filterCliId));
  return results;
}

/**
 * Re-check that a specific pane still has the expected CLI process running.
 * Used to validate an adopt target right before the actual adoption.
 *
 * `filterCliId` MUST mirror the filter discovery used. A Cursor agent installed
 * under the generic name `agent` is only recognized as a CLI when filtered to
 * 'cursor' (see cliIdForComm); without the same filter here, discovery surfaces
 * the session but validation re-identifies nothing and wrongly reports it exited.
 */
export function validateTmuxAdoptTarget(tmuxTarget: string, expectedPid: number, filterCliId?: CliId): boolean {
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
  const match = findCliProcess(panePid, 3, filterCliId);
  return match !== undefined && match.pid === expectedPid;
}


export type AdoptValidationResult = 'alive' | 'missing' | 'unknown';

export function validateHerdrAdoptTarget(sessionName: string | undefined, paneId: string | undefined): AdoptValidationResult {
  if (!sessionName || !paneId) return 'missing';
  const rawAgents = tryHerdrJson(['--session', sessionName, 'agent', 'list']);
  if (!rawAgents.ok) return 'unknown';
  return extractHerdrAgents(rawAgents.value).some((agent: any) => agent?.pane_id === paneId) ? 'alive' : 'missing';
}

export function validateAdoptTarget(target: AdoptableSession | NonNullable<import('./types.js').DaemonSession['adoptedFrom']>): boolean {
  return validateAdoptTargetState(target) === 'alive';
}

export function validateAdoptTargetState(target: AdoptableSession | NonNullable<import('./types.js').DaemonSession['adoptedFrom']>): AdoptValidationResult {
  if (target.source === 'herdr') return validateHerdrAdoptTarget(target.herdrSessionName, target.herdrPaneId ?? target.herdrTarget);
  const pid = 'originalCliPid' in target
    ? target.originalCliPid
    : ('cliPid' in target ? target.cliPid : undefined);
  if (!target.tmuxTarget || !pid) return 'missing';
  return validateTmuxAdoptTarget(target.tmuxTarget, pid, target.cliId) ? 'alive' : 'missing';
}

// 仅供单测使用 —— 暴露内部 helper，方便覆盖跨平台 (Linux /proc vs macOS ps/lsof/pgrep)
// 的回归路径。生产代码不要直接消费这些导出。
export const __testOnly_readComm = readComm;
export const __testOnly_readCwd = readCwd;
export const __testOnly_getChildPids = getChildPids;
