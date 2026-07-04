import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { resolveCommand } from './registry.js';
import { sessionReadyHookCommand } from '../hook-command.js';
import type { CliAdapter, CliId, PtyHandle } from './types.js';
import { findJsonlContainingFingerprint, jsonlContainsFingerprint, normaliseForFingerprint } from '../../services/claude-transcript.js';
import { GOAL_ENV } from '../../workflows/v3/contract.js';
import { buildBotmuxSystemPromptText } from './shared-hints.js';
import { delay, scaleMs } from '../../utils/timing.js';
import { discoverClaudeFamilySessions } from '../../services/resumable-session-discovery.js';

/** Resolve cwd to its canonical (symlink-free) absolute path for project-hash
 *  computation. Claude Code itself runs `process.cwd()` which the kernel returns
 *  already realpath'd via getcwd(3) — so its on-disk project hash always reflects
 *  the realpath, not the symlink we may have spawned it under. We must mirror
 *  that here, otherwise a deployment whose `workingDir` is a symlink (e.g.
 *  `/home/user` → `/data00/home/user`) computes the wrong project dir, the
 *  bridge watcher tails a non-existent file, submit-confirm never sees the
 *  user line, and the no-`botmux send` fallback never emits. realpathSync
 *  throws on non-existent paths — fall back to the raw cwd in that case so a
 *  pre-existence check upstream can still report a useful error. */
function realpathCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

/** The default Claude Code data root (`CLAUDE_CONFIG_DIR` equivalent): where
 *  `projects/`, `sessions/`, `tasks/`, `keybindings.json` and `settings.json`
 *  live. Claude-family forks (e.g. Seed CLI) relocate this — every helper below
 *  takes an optional `dataDir` so the same machinery drives both. Defaulting to
 *  `~/.claude` keeps all existing call sites byte-for-byte unchanged. */
export const DEFAULT_CLAUDE_DATA_DIR = join(homedir(), '.claude');

/** Resolve the JSONL transcript path Claude Code writes user/assistant turns to.
 *  Claude Code's project-hash scheme replaces every non-[A-Za-z0-9-] char with `-`
 *  (observed: `/foo/life_workspace` → `-foo-life-workspace`; `/`, `.`, `_` all become `-`).
 *  Always operates on realpath(cwd) — see realpathCwd above. */
export function claudeJsonlPathForSession(sessionId: string, cwd: string, dataDir: string = DEFAULT_CLAUDE_DATA_DIR): string {
  const projectHash = realpathCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(dataDir, 'projects', projectHash, `${sessionId}.jsonl`);
}

/** botmux ships its built-in skills as a Claude Code plugin here and injects it
 *  per-session via `--plugin-dir` (see buildArgs). Kept out of the global
 *  `~/.claude/skills` so a standalone `claude` never surfaces (and mis-fires)
 *  them. Single source of truth for both the adapter's `pluginDir` field and
 *  the spawn-time flag. */
const CLAUDE_PLUGIN_DIR = join(homedir(), '.botmux', 'claude-plugin');

/** Substrings that indicate Claude Code received our submit. We accept either:
 *  - `"role":"user","content":"` — direct submission while idle (the canonical
 *    user-message line; tool-result lines have array content `"content":[{...`
 *    so they never match).
 *  - `"operation":"enqueue"` — type-ahead submission while Claude is busy.
 *    Claude Code logs a `{"type":"queue-operation","operation":"enqueue",...}`
 *    line at the moment of submit and only later (after the current turn ends)
 *    promotes it to a `queued_command` attachment — never to a `role:user`
 *    string-content line. Without this marker, every type-ahead submit would
 *    falsely report failure. */
const SUBMIT_MARKERS = ['"role":"user","content":"', '"operation":"enqueue"'];

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function deltaHasSubmit(path: string, fromByte: number): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  return SUBMIT_MARKERS.some(m => text.includes(m));
}

async function waitForSubmit(path: string, baseByte: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + scaleMs(timeoutMs);
  while (Date.now() < deadline) {
    if (deltaHasSubmit(path, baseByte)) return true;
    await delay(100);
  }
  return false;
}

function makeSubmitFingerprint(content: string, len = 30): string | undefined {
  const collapsed = normaliseForFingerprint(content);
  return collapsed.length > 0 ? collapsed.substring(0, len) : undefined;
}

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the absolute path to Claude Code's per-process session state file.
 *  Claude writes `{pid, sessionId, cwd, procStart, status, updatedAt, ...}`
 *  here. Empirical scope (Claude Code 2.1.123): `status` and `updatedAt`
 *  refresh on every state change, but `sessionId` is written ONCE at
 *  process start. `--resume` is a fresh spawn → fresh pid file with the
 *  resumed id; in-pane `/clear` does NOT rewrite the pid file's
 *  `sessionId` even though it rotates the on-disk jsonl. Callers that
 *  rely on this for rotation tracking must therefore treat a "matching
 *  sessionId" answer as "no spawn-time rotation observed", not "no
 *  rotation at all" — the latter requires fingerprint corroboration. */
export function claudePidStatePath(pid: number, dataDir: string = DEFAULT_CLAUDE_DATA_DIR): string {
  return join(dataDir, 'sessions', `${pid}.json`);
}

/** Linux-only: read /proc/<pid>/stat field 22 (starttime). Returns null when
 *  /proc isn't available or the stat line is unreadable/malformed; callers
 *  decide whether to fail closed or skip validation for their platform. */
function readProcStarttime(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid pgrp ... — comm may contain spaces/parens, so
    // anchor on the LAST ')' before splitting the remaining fields.
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    // Post-')' field 1 is state; starttime is field 22 → index 19 here.
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Resolve Claude Code's authoritative current session id via
 *  ~/.claude/sessions/<pid>.json. Validates pid + sessionId UUID + cwd so a
 *  stale or unrelated pid file can't redirect us to the wrong jsonl. On Linux
 *  also matches procStart against /proc/<pid>/stat to reject PID reuse. If
 *  procStart is present but cannot be verified on Linux, fail closed; callers
 *  fall back to fingerprint detection. */
export function resolveJsonlFromPid(pid: number, expectedCwd: string, dataDir: string = DEFAULT_CLAUDE_DATA_DIR): { path: string; cliSessionId: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(claudePidStatePath(pid, dataDir), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.pid !== pid) return null;
  if (typeof parsed.sessionId !== 'string' || !SESSION_UUID_RE.test(parsed.sessionId)) return null;
  if (typeof parsed.cwd !== 'string') return null;
  // Identity check: procStart matching against /proc/<pid>/stat field 22 is
  // the strong signal that this pid file belongs to the live process (rules
  // out pid reuse). When that holds, Claude's recorded cwd is authoritative
  // even if it disagrees with `expectedCwd` — the worker's cliCwd can drift
  // (e.g. a schedule resumes a session with a different workingDir than the
  // original spawn, but Claude itself loads the session with its own cwd).
  // When procStart is unavailable/unverifiable, fall back to cwd equality as
  // the only remaining sanity check. Realpath both sides so a symlinked
  // workingDir (/home/x → /data00/home/x) still matches Claude's canonical
  // cwd from getcwd(3).
  let procStartVerified = false;
  if (typeof parsed.procStart === 'string') {
    const live = readProcStarttime(pid);
    if (live === null && process.platform === 'linux') return null;
    if (live !== null) {
      if (live !== parsed.procStart) return null;
      procStartVerified = true;
    }
  }
  if (!procStartVerified && realpathCwd(parsed.cwd) !== realpathCwd(expectedCwd)) return null;
  return {
    path: claudeJsonlPathForSession(parsed.sessionId, parsed.cwd, dataDir),
    cliSessionId: parsed.sessionId,
  };
}

/** Linux-only: probe `/proc/<pid>/fd` for any signal that reveals Claude's
 *  CURRENT sessionId — not the spawn-time one the pid file records. Two
 *  signals are checked:
 *    1. Direct `.jsonl` symlinks under `~/.claude/projects/...` — Claude
 *       opens-writes-closes per event, so this only hits if the probe
 *       lands during a write window.
 *    2. `~/.claude/tasks/<sessionId>(/...)` symlinks — Claude holds the
 *       tasks directory and its `.lock` file open continuously for the
 *       duration of the active session, so this signal is reliable even
 *       between writes. This is the path that catches in-pane `/clear`
 *       rotations the pid file can't see (pid file's `sessionId` is set
 *       once at process start; tasks dir tracks every rotation).
 *  Returns deduplicated sessionIds in arbitrary order; caller picks one
 *  (typically by mtime of the corresponding jsonl). Returns [] on
 *  non-Linux platforms or if /proc lookup fails. */
export function findOpenClaudeSessionIds(pid: number, dataDir: string = DEFAULT_CLAUDE_DATA_DIR): string[] {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const tasksPrefix = join(dataDir, 'tasks') + '/';
  // Substring (not absolute prefix) so a symlinked dataDir parent — e.g. a
  // symlinked home — still matches the kernel-realpath'd fd target. Derived
  // from dataDir's basename: `~/.claude` → `/.claude/projects/` (unchanged);
  // Seed's `.../.claude-runtime` → `/.claude-runtime/projects/`.
  const projectsInfix = `/${basename(dataDir)}/projects/`;
  const out = new Set<string>();
  for (const name of entries) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${name}`);
    } catch {
      continue;
    }
    if (target.startsWith(tasksPrefix)) {
      const sid = target.slice(tasksPrefix.length).split('/')[0];
      if (sid && SESSION_UUID_RE.test(sid)) out.add(sid);
      continue;
    }
    if (target.endsWith('.jsonl') && target.includes(projectsInfix)) {
      const base = target.split('/').pop() ?? '';
      const sid = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : '';
      if (sid && SESSION_UUID_RE.test(sid)) out.add(sid);
    }
  }
  return [...out];
}

/** Fingerprint search that fans out from the pinned project dir to every
 *  sibling under `~/.claude/projects/`. Used as the writeInput fallback
 *  when the pinned `claudeJsonlPath` doesn't contain the submit marker —
 *  Claude may have written to a different project hash than the worker
 *  expected (e.g. a schedule resumed the session with a workingDir that
 *  differs from Claude's internal cwd, so the worker computes the wrong
 *  -project-hash- but Claude appends to the original session's hash dir).
 *  Tries the primary dir first (fast path, unchanged behavior); only fans
 *  out when no match is found there. Per-dir, `findJsonlContainingFingerprint`
 *  still applies its newest-first ordering and the minMtimeMs guard, so a
 *  stale historical match in some unrelated project can't false-positive. */
function findJsonlAcrossProjectsRoot(
  searchPath: string,
  fingerprint: string,
  options: { minMtimeMs?: number; includeQueueOperations?: boolean },
): string | null {
  const primaryDir = dirname(searchPath);
  const primary = findJsonlContainingFingerprint(primaryDir, fingerprint, {
    excludePath: searchPath,
    ...options,
  });
  if (primary) return primary;
  const projectsRoot = dirname(primaryDir);
  if (!existsSync(projectsRoot)) return null;
  let siblings: string[];
  try { siblings = readdirSync(projectsRoot); } catch { return null; }
  for (const name of siblings) {
    const sib = join(projectsRoot, name);
    if (sib === primaryDir) continue;
    const matched = findJsonlContainingFingerprint(sib, fingerprint, {
      excludePath: searchPath,
      ...options,
    });
    if (matched) return matched;
  }
  return null;
}

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed|Baked|Brewed) for \d+[smh]/;
/** Escape hatch: force a specific chat:submit key regardless of
 *  keybindings.json. Accepts the same spellings as the config (e.g.
 *  `meta+enter`, `alt+enter`, `enter`). A value that can't be sent through the
 *  terminal makes writeInput fail fast with a clear reason. */
const CLAUDE_SUBMIT_KEY_ENV = 'CLAUDE_CODE_SUBMIT_KEY';
const CHAT_CONTEXT = 'Chat';
const CHAT_SUBMIT_ACTION = 'chat:submit';
const CHAT_NEWLINE_ACTION = 'chat:newline';
const DEFAULT_SUBMIT_KEY = 'Enter';
const UNSUPPORTED_SUBMIT_KEY_FAILURE =
  'Claude Code Chat keybindings have no terminal-sendable chat:submit key. ' +
  'Only Enter, Meta+Enter (Alt+Enter) can be delivered through tmux/PTY; ' +
  'keys such as Cmd+Enter, Ctrl+Enter or Shift+Enter cannot.';

interface ClaudeChatKeybindings {
  submitKeys: string[] | null;
  rawSubmitSequence: string | null;
  enterIsNewline: boolean;
  failureReason?: string;
}

function readClaudeChatBindings(keybindingsPath: string): Record<string, string> | null {
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(keybindingsPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.bindings)) return null;
  const chat = parsed.bindings.find((entry: any) => (
    entry?.context === CHAT_CONTEXT &&
    entry?.bindings &&
    typeof entry.bindings === 'object' &&
    !Array.isArray(entry.bindings)
  ));
  return chat?.bindings ?? null;
}

// Only keys that a terminal can actually deliver to Claude Code's Ink input
// are listed here. Plain Enter is `\r`; Meta/Alt+Enter is the widely-supported
// ESC-prefix (`\x1b\r`). Ctrl+Enter and Shift+Enter are deliberately omitted:
// terminals can't distinguish them from a bare Enter unless the Kitty keyboard
// protocol / modifyOtherKeys is negotiated, so sending `C-Enter`/`S-Enter`
// would silently fail to submit. Anything not listed falls through to a
// fail-fast with a clear reason rather than a phantom submit.
function toTmuxSubmitKey(key: string): string | null {
  const normalized = key.trim().toLowerCase();
  switch (normalized) {
    case 'enter':
      return 'Enter';
    case 'meta+enter':
    case 'alt+enter':
    case 'm-enter':
      return 'M-Enter';
    default:
      return null;
  }
}

function toRawSubmitSequence(key: string): string | null {
  const normalized = key.trim().toLowerCase();
  switch (normalized) {
    case 'enter':
      return '\r';
    case 'meta+enter':
    case 'alt+enter':
    case 'm-enter':
      return '\x1b\r';
    default:
      return null;
  }
}

function selectSubmitKey(bindings: Record<string, string> | null): string | null {
  const override = process.env[CLAUDE_SUBMIT_KEY_ENV]?.trim();
  if (override) return toTmuxSubmitKey(override) ? override : null;
  if (!bindings) return DEFAULT_SUBMIT_KEY;

  const submitKeys = Object.entries(bindings)
    .filter(([, action]) => action === CHAT_SUBMIT_ACTION)
    .map(([key]) => key);

  const terminalFriendlyOrder = ['meta+enter', 'alt+enter', 'enter'];
  for (const candidate of terminalFriendlyOrder) {
    if (submitKeys.some(key => key.toLowerCase() === candidate)) return candidate;
  }
  const supportedSubmitKey = submitKeys.find(key => toTmuxSubmitKey(key));
  if (supportedSubmitKey) return supportedSubmitKey;
  // No terminal-sendable submit binding (none configured, or only unsendable
  // ones like cmd+enter). Fall back to plain Enter only when Enter is still
  // unbound — i.e. Claude Code's built-in Enter=submit is intact. If Enter was
  // remapped (e.g. to chat:newline), sending Enter would never submit, so we
  // must fail fast instead.
  return bindingActionForKey(bindings, DEFAULT_SUBMIT_KEY) === undefined ? DEFAULT_SUBMIT_KEY : null;
}

function bindingActionForKey(bindings: Record<string, string> | null, targetKey: string): string | undefined {
  const normalizedTarget = targetKey.toLowerCase();
  return Object.entries(bindings ?? {})
    .find(([key]) => key.toLowerCase() === normalizedTarget)?.[1];
}

function resolveClaudeChatKeybindings(keybindingsPath: string): ClaudeChatKeybindings {
  const bindings = readClaudeChatBindings(keybindingsPath);
  const submitKey = selectSubmitKey(bindings);
  const tmuxSubmitKey = submitKey ? toTmuxSubmitKey(submitKey) : null;
  const rawSubmitSequence = submitKey ? toRawSubmitSequence(submitKey) : null;
  return {
    submitKeys: tmuxSubmitKey ? [tmuxSubmitKey] : null,
    rawSubmitSequence,
    enterIsNewline: bindingActionForKey(bindings, DEFAULT_SUBMIT_KEY) === CHAT_NEWLINE_ACTION,
    failureReason: submitKey === null ? UNSUPPORTED_SUBMIT_KEY_FAILURE : undefined,
  };
}

/** PTYs that have already received at least one writeInput. The first write
 *  lands while Ink is still doing its startup render pass (banner, model
 *  line, ❯ arrow) — keystrokes batched into that frame trip Claude Code's
 *  paste-burst detector and `\` + Enter soft-newlines stick as literal
 *  characters in the input box. Tracked by identity so the same pty handle
 *  across multiple adapter instances shares the warmup state. */
const claudeFirstWriteSeen = new WeakSet<PtyHandle>();

/** A member of the Claude-family CLIs: Claude Code itself and forks that share
 *  its on-disk session layout (per-project JSONL transcripts, `sessions/<pid>.json`
 *  pid-state, `tasks/` fd locks, keybindings.json, settings.json hooks) but
 *  relocate the data root and/or rename the binary. Seed CLI
 *  (`@bytedance-seed/claude-code`, binary `seed`) is one such fork — it reuses
 *  this entire adapter, only swapping `dataDir`/`stateJsonPath`/binary. */
export interface ClaudeFamilyVariant {
  /** CliId for this variant (`claude-code`, `seed`, …). */
  readonly id: CliId;
  /** Binary name printed in the user-facing `buildResumeCommand` handoff. */
  readonly resumeBin: string;
  /** Data root: `projects/`, `sessions/`, `tasks/`, `keybindings.json`,
   *  `settings.json`. `~/.claude` for Claude Code; Seed's `.claude-runtime`. */
  readonly dataDir: string;
  /** Path to the `.claude.json` state / folder-trust file. Lives at
   *  `~/.claude.json` (home) for Claude Code, but *inside* the data root for
   *  forks that set CLAUDE_CONFIG_DIR — so it can't be derived from dataDir. */
  readonly stateJsonPath: string;
  /** Env injected at spawn so the forked CLI actually writes to `dataDir`.
   *  undefined for Claude Code, which already
   *  defaults to ~/.claude. */
  readonly spawnEnv?: Readonly<Record<string, string>>;
  /** Curated `botmux setup` model candidates. Claude Code lists Anthropic
   *  aliases; forks whose model set is gateway-defined
   *  pass undefined so setup skips the prompt. */
  readonly modelChoices?: readonly string[];
  /** Auth/login paths kept real+writable in the file sandbox (see CliAdapter.authPaths). */
  readonly authPaths?: readonly string[];
}

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  return createClaudeFamilyAdapter({
    id: 'claude-code',
    authPaths: ['~/.claude/.credentials.json'],
    resumeBin: 'claude',
    dataDir: DEFAULT_CLAUDE_DATA_DIR,
    stateJsonPath: join(homedir(), '.claude.json'),
    // alias（opus/sonnet/haiku）会被 Claude Code 解析成当前推荐的具体版本；具体 ID 锁版本。
    modelChoices: ['opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  }, pathOverride ?? 'claude');
}

export function createClaudeFamilyAdapter(variant: ClaudeFamilyVariant, rawBin: string): CliAdapter {
  // resolvedBin is resolved lazily on first read (memoised) so merely
  // constructing the adapter — e.g. `botmux setup` reading modelChoices — never
  // shells out via resolveCommand. The binary path is a spawn-time concern.
  // (Seed passes an already-absolute bin here, so this getter is a no-op for it.)
  let cachedBin: string | undefined;
  return {
    id: variant.id,
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    supportsTypeAhead: true,
    claudeDataDir: variant.dataDir,
    claudeStateJsonPath: variant.stateJsonPath,
    spawnEnv: variant.spawnEnv,
    authPaths: variant.authPaths,
    skillDelivery: { nativeKind: 'claude-plugin', supportsScopedSession: true, supportsExclusive: false },

    /** Prove the resume JSONL exists (or at least the project dir does, so the
     *  sessionId lookup will find it). Conservative: only returns true when we
     *  can stat the exact file; false when the file is provably absent;
     *  undefined on any weirdness (caller will still try the spawn and rely on
     *  the secondary guard).
     *
     *  The `dataDir` parameter carries the EFFECTIVE data root, i.e. after any
     *  sandbox overlay redirection — the worker mirrors the same calculation
     *  into `(backend).claudeJsonlPath = claudeJsonlPathForSession(...)` so
     *  this probe sees the same filesystem the spawned CLI will write to. */
    checkResumeTargetExists({ sessionId, cliSessionId, workingDir, dataDir }) {
      if (!workingDir) return undefined;
      const effectiveDataDir = dataDir ?? variant.dataDir;
      const sid = cliSessionId ?? sessionId;
      if (!sid) return undefined;
      try {
        const p = claudeJsonlPathForSession(sid, workingDir, effectiveDataDir);
        if (existsSync(p)) return true;
        // Also try the project directory (allows partial matches): absent
        // projectDir means no resume target could possibly exist — Claude
        // writes `<sid>.jsonl` there on first submit and never moves it.
        if (!existsSync(dirname(p))) return false;
        // Project dir exists but this specific sid doesn't. Could be a
        // mid-session rotation the adapter's pid resolver would catch — don't
        // block, let spawn try; the secondary guard still covers it.
        return undefined;
      } catch {
        return undefined;
      }
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      // Claude resumes by reading <id>.jsonl, so we need the most recently
      // observed CLI-native id (rotation can happen mid-run); fall back to the
      // botmux sessionId for the first-turn case where they coincide.
      return `${variant.resumeBin} --resume ${cliSessionId ?? sessionId}`;
    },

    /** Import path: scan this variant's data root (`<dataDir>/projects/<hash>/<id>.jsonl`)
     *  for resumable sessions. The session id is the jsonl basename; cwd + first
     *  prompt come from the transcript. */
    listResumableSessions({ limit, exclude }) {
      return discoverClaudeFamilySessions(variant.dataDir, limit, exclude);
    },

    buildArgs({ sessionId, resume, resumeSessionId, botName, botOpenId, locale, model, disableCliBypass, skillPluginDir }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', resumeSessionId ?? sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (!disableCliBypass) {
        args.push('--dangerously-skip-permissions');
      }
      // 进程级 --settings JSON：作用域仅限本次 spawn，与用户自有 settings.json 合并
      // （Claude 把多个 settings 源按事件 **合并** hooks 数组，不互相覆盖）。这里只承载
      // bypass 权限相关键（仅 !disableCliBypass）。
      //
      // SessionStart 就绪 hook（→ `botmux session-ready`）**不**再注入这里，改走全局
      // settings.json（见下方 hookInstall.sessionStartCommand）。原因有二：
      //   1. wrapperCli=`aiden x claude` 会剥掉本 --settings（aiden 硬拒），进程级那份它拿
      //      不到；全局是它唯一能读到就绪 hook 的渠道。
      //   2. 若进程级和全局**同时**注入 SessionStart，Claude 会等两条 hook 都退出才渲染输入框，
      //      但 worker 在第一条 hook 发来的信号就放行首条 prompt → 首条 prompt 抢在输入框渲染前
      //      落地 → 触发 Claude 的 paste-burst 启发式 → 多行里的软换行 `\` 被当字面量保留。
      //      单一来源（全局）消除这个竞态，恢复原先单 hook 的时序。
      // 全局即足够：Claude（含 cjadk / aiden 等启动器跑的真 claude）默认读 ~/.claude/settings.json，
      // 与 askUserQuestion hook 同源同渠道，比进程级更稳（还覆盖 adopt / 剥 --settings 的场景）。
      const inlineSettings: Record<string, unknown> = {};
      if (!disableCliBypass) {
        inlineSettings.skipDangerousModePermissionPrompt = true;
        inlineSettings.permissions = { defaultMode: 'bypassPermissions' };
      }
      // 仅在有内容（bypass 键）时才传 --settings；disableCliBypass 下没东西可传就不传。
      if (Object.keys(inlineSettings).length > 0) {
        args.push('--settings', JSON.stringify(inlineSettings));
      }
      const disallowedTools = ['EnterPlanMode', 'ExitPlanMode'];
      if (process.env[GOAL_ENV.V3_MARKER] === '1') {
        disallowedTools.push('AskUserQuestion');
      }
      args.push('--disallowed-tools', disallowedTools.join(','));
      // Inject botmux's built-in skills as a plugin scoped to THIS session only.
      // Keeps them out of the user's global ~/.claude/skills so a standalone
      // `claude` never surfaces/mis-fires `botmux send` etc.
      args.push('--plugin-dir', CLAUDE_PLUGIN_DIR);
      if (skillPluginDir) args.push('--plugin-dir', skillPluginDir);
      args.push('--append-system-prompt', buildBotmuxSystemPromptText({ locale, botName, botOpenId }));
      return args;
    },

    injectsSessionContext: true,

    async writeInput(pty, content) {
      // Type content like a human: literal text via send-keys -l, and each
      // newline replaced by `\` + Enter (Claude Code's documented soft-newline
      // idiom — keeps content in the input box without submitting). The final
      // Enter at the bottom is the unambiguous submit. This sidesteps tmux
      // bracketed-paste mode entirely, which was unreliable: Claude Code can
      // toggle bracketed-paste off mid-session (after slash commands etc.),
      // making tmux's paste-buffer drop the markers and turning embedded \r
      // into Enters that fragment the message into multiple submits.
      //
      // Each tmux send-keys is throttled so the cumulative input rate stays
      // below Claude Code's paste-burst threshold — otherwise on long messages
      // (~1300+ chars / ~25+ lines) Ink flips into paste mode mid-stream and
      // subsequent `\` + Enter pairs are kept as literal `\\\r` in the
      // submitted content instead of being consumed as soft-newline markers.
      //
      // The first writeInput after spawn lands before Ink's startup render
      // pass has fully drained, so even short messages trip paste-burst —
      // wait briefly to let the queue settle and use a larger throttle for
      // that call only. Subsequent writes hit a quiescent TUI and can stay
      // on the lighter throttle.
      //
      // Trailing Enter is still subject to Claude Code's paste-burst heuristic
      // (rapid input followed by Enter can be coalesced as paste), so we keep
      // the JSONL retry loop below as the source of truth for "did it submit".
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;
      const isFirstWrite = !claudeFirstWriteSeen.has(pty);
      if (isFirstWrite) {
        claudeFirstWriteSeen.add(pty);
        await delay(200);
      }
      const TYPING_THROTTLE_MS = isFirstWrite ? 80 : 30;

      const tick = () => delay(TYPING_THROTTLE_MS);
      const keybindings = resolveClaudeChatKeybindings(join(variant.dataDir, 'keybindings.json'));

      const sendSubmit = (): boolean => {
        if (pty.sendSpecialKeys && keybindings.submitKeys) {
          pty.sendSpecialKeys(...keybindings.submitKeys);
          return true;
        }
        if (!pty.sendSpecialKeys && keybindings.rawSubmitSequence) {
          pty.write(keybindings.rawSubmitSequence);
          return true;
        }
        return false;
      };

      // Pid-state path resolver: ~/.claude/sessions/<pid>.json carries
      // the spawn-time sessionId (written once at process start; see
      // claudePidStatePath). Read it first so byte accounting locks onto
      // the resume target right away when Claude was started with
      // `--resume`. In-pane `/clear` won't appear here — that's covered
      // by the fingerprint-based mid-flight rotation check below.
      let observedCliSessionId: string | undefined;
      const applyResolved = (resolved: { path: string; cliSessionId: string }): boolean => {
        if (resolved.cliSessionId !== observedCliSessionId) observedCliSessionId = resolved.cliSessionId;
        if (resolved.path !== pty.claudeJsonlPath) {
          pty.claudeJsonlPath = resolved.path;
          return true;
        }
        return false;
      };
      if (pty.cliPid && pty.cliCwd) {
        const resolved = resolveJsonlFromPid(pty.cliPid, pty.cliCwd, variant.dataDir);
        if (resolved) applyResolved(resolved);
      }
      // baseByte is recomputed at this point (after any entry-time path swap)
      // so future writes are measured against the right transcript. Inside
      // confirmSubmit a mid-flight rotation does NOT advance baseByte — the
      // submit may already be in the rotated jsonl from before our re-resolve.
      let baseByte = pty.claudeJsonlPath ? currentFileSize(pty.claudeJsonlPath) : 0;
      const submitFingerprint = makeSubmitFingerprint(content);
      const submitSearchMinMtime = Date.now() - 60_000;
      const buildResult = (submitted: boolean, failureReason?: string): { submitted: boolean; cliSessionId?: string; failureReason?: string } => {
        const result = observedCliSessionId
          ? { submitted, cliSessionId: observedCliSessionId }
          : { submitted };
        return failureReason ? { ...result, failureReason } : result;
      };
      const submitKeySupportedByBackend = pty.sendSpecialKeys
        ? !!keybindings.submitKeys
        : !!keybindings.rawSubmitSequence;
      if (!submitKeySupportedByBackend) {
        return buildResult(false, keybindings.failureReason ?? UNSUPPORTED_SUBMIT_KEY_FAILURE);
      }

      if (pty.sendText && pty.sendSpecialKeys) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 0) {
            pty.sendText(lines[i]);
            await tick();
          }
          if (i < lines.length - 1) {
            if (!keybindings.enterIsNewline) {
              // Soft-newline: backslash + Enter inserts a newline in Claude
              // Code's input box without submitting.
              pty.sendText('\\');
              await tick();
            }
            pty.sendSpecialKeys('Enter');
            await tick();
          }
        }
      } else {
        // Non-tmux fallback (raw PTY): bracketed paste is reliable here since
        // we control the markers directly.
        pty.write('\x1b[200~' + content + '\x1b[201~');
      }
      await delay(submitDelay);
      if (!sendSubmit()) {
        return buildResult(false, keybindings.failureReason ?? UNSUPPORTED_SUBMIT_KEY_FAILURE);
      }

      // Without a JSONL path we can't verify — trust the fixed delay and return.
      // Still surface any sessionId we observed via the pid resolver so the
      // worker can persist it even on this unverified path.
      if (!pty.claudeJsonlPath) {
        return observedCliSessionId ? { submitted: true, cliSessionId: observedCliSessionId } : undefined;
      }

      const confirmSubmit = async (timeoutMs: number): Promise<boolean> => {
        const startPath = pty.claudeJsonlPath;
        if (!startPath) return false;

        // First check: did our submit land past baseByte on the currently
        // pinned path? Fast path for the common case (no rotation).
        if (await waitForSubmit(startPath, baseByte, timeoutMs)) return true;

        // Second: did Claude rotate sessionId mid-flight? The pid file
        // is rewritten by `--resume` (fresh spawn) but NOT by in-pane
        // `/clear` — so this catches the resume case. We re-read and
        // check both:
        //   a) the rotated jsonl already contains our submit (the rotation
        //      happened between our type+Enter and this resolve — the
        //      content lives in the new file from before we knew about it),
        //   b) the rotated jsonl is empty / pre-existing but a fresh
        //      append is on its way (briefly poll).
        // We do NOT overwrite the original baseByte before the fingerprint
        // check because (a) requires matching content that may already be in
        // the rotated file. For (b), poll from the rotated file's own current
        // size so an older, larger startPath cannot hide a delayed append.
        if (pty.cliPid && pty.cliCwd) {
          const resolved = resolveJsonlFromPid(pty.cliPid, pty.cliCwd, variant.dataDir);
          if (resolved) {
            const switched = applyResolved(resolved);
            const newPath = pty.claudeJsonlPath;
            const rotatedBaseByte = switched && newPath ? currentFileSize(newPath) : baseByte;
            if (switched && newPath && submitFingerprint) {
              if (jsonlContainsFingerprint(newPath, submitFingerprint, { includeQueueOperations: true })) {
                // Sync baseByte to end-of-file so subsequent confirms in
                // this writeInput pass don't re-trigger on the same line.
                baseByte = currentFileSize(newPath);
                return true;
              }
            }
            if (newPath) {
              if (await waitForSubmit(newPath, rotatedBaseByte, switched ? 200 : 0)) {
                if (switched) baseByte = currentFileSize(newPath);
                return true;
              }
            }
          }
        }

        // Final fallback when the pid file is unavailable / fails validation:
        // scan the pinned project dir for a recently-written jsonl whose
        // tail contains our content fingerprint. Stricter than mtime-based
        // detection so a sibling pane in the same dir can't hijack us.
        // Per-attempt scope is intentionally narrow (dirname only) — the
        // cross-project fan-out only runs once at end-of-writeInput and in
        // the recheck closure, not per retry, to keep the worst case bounded.
        if (submitFingerprint) {
          const searchPath = pty.claudeJsonlPath ?? startPath;
          const matched = findJsonlContainingFingerprint(dirname(searchPath), submitFingerprint, {
            excludePath: searchPath,
            minMtimeMs: submitSearchMinMtime,
            includeQueueOperations: true,
          });
          if (matched) {
            pty.claudeJsonlPath = matched;
            return true;
          }
        }
        return false;
      };

      // Retry budget: up to 2 extra Enters (3 sends total), each followed by
      // an 800ms wait for the JSONL to record either a direct user-submit line
      // or a type-ahead enqueue line. If the user is concurrently typing in the
      // web terminal, a stray Enter may submit their half-typed text — but we
      // only retry when the JSONL is provably unchanged, so the race window is
      // bounded to cases where submit really did fail.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await confirmSubmit(800)) {
          return observedCliSessionId ? buildResult(true) : undefined;
        }
        if (!sendSubmit()) break;
      }
      // Final grace check.
      if (await confirmSubmit(800)) {
        return observedCliSessionId ? buildResult(true) : undefined;
      }
      // Last-resort cross-project fan-out, run ONCE before declaring failure:
      // catches the case where workingDir/cwd drift made every per-attempt
      // scan look in the wrong project dir AND the pid resolver also failed
      // (e.g. pid file missing, /proc unavailable). minMtimeMs filtering and
      // newest-first ordering keep the cost bounded — only jsonls touched in
      // the last 60s are actually read, which is typically a handful even
      // across all sibling project dirs. Per-attempt scans stay narrow
      // (dirname only) so this work doesn't repeat 4×.
      if (submitFingerprint && pty.claudeJsonlPath) {
        const matched = findJsonlAcrossProjectsRoot(pty.claudeJsonlPath, submitFingerprint, {
          minMtimeMs: submitSearchMinMtime,
          includeQueueOperations: true,
        });
        if (matched) {
          pty.claudeJsonlPath = matched;
          return observedCliSessionId ? buildResult(true) : undefined;
        }
      }
      // All retries exhausted and still no submit marker in JSONL. Signal failure
      // so the worker can notify the user in Lark instead of silently dropping.
      // We still surface observedCliSessionId so the worker can persist Claude's
      // current id even when this particular submit didn't land.
      //
      // Attach a recheck closure: the in-band budget (4 × 800ms) is too short
      // for cold-start sessions and for environments where a slow third-party
      // UserPromptSubmit / SessionStart hook (e.g. superpowers) defers Claude's
      // jsonl append by 5–15s. The worker calls recheck() after a delay, and
      // suppresses the user-facing warning when the line shows up by then.
      const recheck = (): boolean => {
        if (!submitFingerprint) return false;
        // Latest pid → path; covers post-failure rotations (/clear, /resume).
        if (pty.cliPid && pty.cliCwd) {
          const resolved = resolveJsonlFromPid(pty.cliPid, pty.cliCwd, variant.dataDir);
          if (resolved) applyResolved(resolved);
        }
        const currentPath = pty.claudeJsonlPath;
        if (currentPath && jsonlContainsFingerprint(currentPath, submitFingerprint, { includeQueueOperations: true })) {
          return true;
        }
        // Fan out to sibling jsonls in the project dir, then across every
        // sibling project dir under `~/.claude/projects/` (catches workingDir
        // drift like worker thinking `-foo-bar/` while Claude actually appends
        // to `-foo-bar-baz/`). Same minMtime guard as the in-band fingerprint
        // fallback so a stale historical match can't suppress the warning.
        const searchPath = currentPath ?? pty.claudeJsonlPath;
        if (!searchPath) return false;
        const matched = findJsonlAcrossProjectsRoot(searchPath, submitFingerprint, {
          minMtimeMs: submitSearchMinMtime,
          includeQueueOperations: true,
        });
        return !!matched;
      };
      return { ...buildResult(false), recheck };
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
    // Claude 家族在 spawn 时注入 SessionStart hook（见 buildArgs），回调
    // `botmux session-ready` 给出「真就绪」信号。worker 据此武装 ready-gate：
    // 收到信号前不投首条 prompt，绕开 cjadk 启动选择器吞首条消息的 bug。
    injectsReadyHook: true,
    defaultPassthroughCommands: variant.id === 'claude-code' ? ['/goal'] : undefined,
    systemHints: [],
    altScreen: false,
    // Skills are injected per-session via --plugin-dir (see buildArgs), NOT
    // installed into the global ~/.claude/skills — so they never leak into the
    // user's standalone `claude`. pluginDir is consumed by ensurePluginSkills.
    pluginDir: CLAUDE_PLUGIN_DIR,
    // 候选 model 由 variant 决定（Claude 给 Anthropic alias；Seed 走网关交给 setup 跳过）。
    // setup 选 Other 可自由填，比如要回退或试 canary 模型。
    modelChoices: variant.modelChoices,
    // askUserQuestion hook 写各 variant 的 settings.json（matcher='AskUserQuestion' 的
    // PreToolUse），把事件转发到 `botmux hook <id>`。Claude 用全局 ~/.claude/settings.json
    // 是为了 adopt 模式（接管的 claude 会话拿不到进程级 --settings，只读全局那条）；hook
    // 客户端缺 BOTMUX_* env 时直接 passthrough 放行，不破坏非 botmux 的会话。Seed 写自己
    // 的 .claude-runtime/settings.json，只作用于走该 CLAUDE_CONFIG_DIR 的 seed 会话。
    hookInstall: {
      configPath: join(variant.dataDir, 'settings.json'),
      format: 'claude-settings',
      // SessionStart 就绪 hook 也写全局：进程级 --settings 那份会被 wrapperCli=`aiden x
      // claude` 剥掉（aiden 硬拒 --settings），全局这条是它唯一能拿到就绪信号的渠道，
      // 避免首条 prompt 空等 45s。原生 claude 会同时收到进程级+全局两份，幂等无害。
      sessionStartCommand: sessionReadyHookCommand(),
    },
    asksViaHook: true,
  };
}

export const create = createClaudeCodeAdapter;
