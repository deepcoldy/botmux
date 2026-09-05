import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter, isAbsolute } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type {
  SessionBackend,
  SessionDestroyResult,
  SessionShutdownDetachResult,
  SpawnOpts,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { escapeXmlTagLikeTokens } from '../../utils/xml.js';

/**
 * Fallback system prompt injected into every riff task when no explicit
 * `systemPrompt` is configured. Mirrors the `<botmux_routing>` block that
 * codex/gemini/etc. get via buildBotmuxShellHints — the riff agent must use
 * `botmux send` to reply (same as any other botmux-bridged CLI), not rely on
 * passive output capture. botmux is installed in the sandbox via setupCommands.
 */
const DEFAULT_RIFF_SYSTEM_PROMPT = [
  'You are running inside a botmux-bridged session: Feishu/Lark group ↔ riff agent sandbox.',
  'The user reads on Lark and cannot see your terminal output.',
  '',
  'STEP 0 — ensure botmux is installed (the riff API has no native setup hook, so do this FIRST, before anything else):',
  '  which botmux >/dev/null 2>&1 || npm install -g botmux',
  '',
  'IMPORTANT — identity: reply ONLY with the botmux session identity injected via the BOTMUX_* environment variables (BOTMUX_LARK_APP_ID / BOTMUX_LARK_APP_SECRET / BOTMUX_CHAT_ID / BOTMUX_SESSION_ID). NEVER reply through other Feishu apps / bots / credentials you may find on this machine (e.g. cjadk / aiden integrations) — they impersonate the wrong bot and fail in groups they are not in. `botmux send` picks up the BOTMUX_* env automatically.',
  '',
  'IMPORTANT: `botmux send` / `botmux history` / `botmux quoted` / `botmux bots` are SHELL commands (CLI programs installed in $PATH), NOT MCP tools. Run them via the Bash tool — do not look for them in the MCP tool list.',
  '',
  'To send a message to the user (the only way): run `botmux send "your message"` via Bash. Attach images with `--images /path`, files with `--files /path`.',
  'Multi-line messages MUST use a heredoc — never `botmux send "line1\\nline2"`, since `\\n` may appear literally in Lark.',
  "Correct multi-line example:\n  botmux send <<'EOF'\n  line 1\n  line 2\n  EOF",
  '',
  escapeXmlTagLikeTokens('Helpers: `botmux history` (read this session\'s history), `botmux quoted <message_id>` (fetch a quoted message), `botmux bots list` (list other bots in the group).'),
  '',
  escapeXmlTagLikeTokens('@ decision (mandatory): every `botmux send` MUST explicitly pick one or it errors — `--mention <open_id>` (use the open_id from the <sender> tag of the CURRENT message you are answering) / `--no-mention` (low-priority notes). NEVER use `--mention-back` in this sandbox: the session-recorded sender is frozen at task creation, so on follow-up turns it would @ the wrong person (it is disabled here and will error).'),
  '',
  'When to send: key conclusions, plans (wait for user approval before acting), final results, progress updates. A bare `print`/`echo` does NOT count as a reply.',
  'COMPLETION CONTRACT: a turn is complete ONLY after `botmux send` actually ran and printed ✓ success. Writing the answer solely in your final report/output does NOT reach the user — always run `botmux send` first, then summarize in the report.',
  'Keep final answers concise. For images/files: write them to disk then send via `botmux send --images/--files`.',
  '',
  'LAST-RESORT fallback (only if the npm install itself fails): call the Feishu Open API directly with the injected BOTMUX_LARK_APP_ID/SECRET — fetch a tenant_access_token, then POST im/v1/messages?receive_id_type=chat_id to BOTMUX_CHAT_ID. Still never use non-BOTMUX credentials.',
].join('\n');

/**
 * Mandatory setup commands run in the riff sandbox to ensure `botmux` is
 * available. These are ALWAYS sent to the riff API via `config.setupCommands`
 * (not via prompt injection) so the install is reliable and not dependent on
 * the agent parsing a prompt. The riff sandbox has Node.js (it runs codex),
 * so npm install works. Any user-configured setupCommands are appended AFTER
 * these mandatory commands.
 */
/** riff（codex bridge）接受的思考等级档位——与服务端 shared/reasoningEffort 对齐。 */
export const RIFF_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export const RIFF_SANDBOX_CLUSTERS = ['boe', 'cn'] as const;
export type RiffSandboxCluster = typeof RIFF_SANDBOX_CLUSTERS[number];

const MANDATORY_SETUP_COMMANDS = [
  // Unconditional install/upgrade: a `which botmux` guard would skip the
  // install when the sandbox image preinstalls an older botmux, freezing the
  // sandbox on a version without riff-aware `botmux send`. Falls back to any
  // preinstalled botmux only when the install itself fails (e.g. npm offline).
  // Tracks the npm `latest` dist-tag — riff-aware `botmux send` ships in
  // v2.109.0+; pinning a prerelease dist-tag here would let any future
  // unrelated canary publish break riff sandboxes.
  'npm install -g botmux >/dev/null 2>&1 || which botmux >/dev/null 2>&1',
];

export interface RiffBackendConfig {
  baseUrl: string;
  templateId?: string;
  /** @deprecated riff 服务端已收敛仅支持 codex（其它值 400）；本字段不再被读取，
   *  任务一律以 agent=codex 创建。保留仅为兼容存量 bots.json。 */
  agent?: string;
  model?: string;
  /** codex 思考等级（low/medium/high/xhigh），写入沙箱 config.toml 的
   *  model_reasoning_effort；留空走 riff 默认 medium。非法值静默丢弃。 */
  reasoningEffort?: string;
  /** Direct JWT token (takes precedence over jwtEnv). */
  jwt?: string;
  /** Name of env var containing the JWT token (default: RIFF_JWT). */
  jwtEnv?: string;
  /**
   * Command to refresh the ByteCloud JWT when the keychain holds no live token.
   * When neither `config.jwt` nor the env token is set and `readBytecloudKeychainJwt`
   * returns null (every candidate expired / within the safety window / absent),
   * riff task creation would fail with a 401 that aborts the whole turn. Before
   * giving up, we run this command ONCE (debounced) to let the owning CLI
   * (bytedcli / kaboo-cli) refresh credentials and rewrite the keychain, then
   * re-read. bytedcli is the ByteCloud JWT owner: `bytedcli auth
   * get-bytecloud-jwt-token --force-refresh` refreshes via its Auth SDK and
   * writes the token to `~/.local/share/bytedcli/data/bytecloud-auth/…`, which is
   * already a `bytecloudKeychainCandidates` path.
   *
   * Shape: [binary, ...args]. When unset, resolves in order:
   *   1. env `BOTMUX_RIFF_JWT_REFRESH_CMD` (space-split, e.g. `bytedcli auth get-bytecloud-jwt-token --force-refresh`)
   *   2. a `bytedcli` binary found on PATH → `bytedcli auth get-bytecloud-jwt-token --force-refresh`
   *   3. otherwise no auto-refresh (fail-closed to the old behaviour — a 401).
   * We intentionally do NOT default to `npx @bytedance-dev/bytedcli@latest`: an
   * uncached/`@latest` npx resolve can block ~30s per call, far too slow for a
   * synchronous pre-request refresh. Deployments wanting npx must set the env
   * explicitly (and ideally pin the version).
   *
   * WITH `jwtHome`: this becomes REQUIRED for auto-refresh. The resolved default
   * runs as the daemon UID with the daemon's HOME and would rewrite the DAEMON's
   * keychain, not the override's — so it cannot refresh a sub-user's login, and
   * the override skips auto-refresh unless this is set explicitly. Set it to
   * whatever refreshes as that user on this host (a per-user wrapper, `sudo -u
   * <user> bytedcli auth get-bytecloud-jwt-token --force-refresh`, …). Without
   * it, an expired sub-user token must be renewed by that user re-logging in.
   */
  jwtRefreshCmd?: string[];
  /**
   * Home directory whose ByteCloud keychain owns THIS bot's riff identity.
   *
   * The keychain lookup is home-derived, and by default the home is the
   * DAEMON's (`os.homedir()`). On a shared host that runs one bot per human —
   * each pointed at its own login via a per-user `cliPathOverride` wrapper —
   * every riff bot would then read the daemon account's keychain instead of the
   * bot owner's, and 401 when that account is not logged in (which is the
   * normal state: nobody logs the daemon account into ByteCloud). Setting this
   * to the owning user's home (`/home/<user>`) scopes the lookup to that
   * identity.
   *
   * Empty/unset keeps the daemon home (current behaviour). Must be an ABSOLUTE
   * path — a relative value would resolve against the daemon's cwd and silently
   * point somewhere meaningless, so it is rejected at the config gate rather
   * than half-applied.
   */
  jwtHome?: string;
  /** Sandbox resource pool selected for newly-created tasks. Riff defaults to
   *  BOE when omitted; follow-ups inherit the parent task's sandbox. */
  sandboxCluster?: RiffSandboxCluster;
  /**
   * Repos to clone into the riff sandbox, in the API's native shape
   * ({ repoName: 'group/repo', repoBranch? }). Takes precedence over
   * defaultRepo/defaultBranch. Typically derived by the worker from the
   * session's local workingDir (复用本地仓库+分支) — see
   * deriveRiffRepoFromWorkingDir.
   */
  repos?: RiffRepoRef[];
  /** Parent task id persisted by the daemon (see worker riff_task_id IPC) —
   *  restores the follow-up lineage after a daemon restart. */
  resumeParentTaskId?: string;
  /** Human-readable notes about the derived repo state (dirty tree, unpushed
   *  commits). Printed as status lines on task creation so the user knows the
   *  sandbox may not see their latest local changes. */
  repoWarnings?: string[];
  injectStatusLines?: boolean;
  logLevel?: string;
  /**
   * Environment variables injected into the riff sandbox execution environment.
   * Merged from: botmux session context vars (BOTMUX_SESSION_ID, …) → per-bot
   * env (bots.json `env`) → explicit config.env (which takes precedence).
   * The sandbox installs botmux via setupCommands, so BOTMUX_* vars are needed
   * for the agent to use `botmux send`. Sent as `config.env` to the riff API.
   */
  env?: Record<string, string>;
  /**
   * System prompt injected into the riff task. Prepended to the userPrompt
   * (riff API has no separate system-prompt field) so the agent knows it is
   * running inside a botmux-bridged session. When unset, the built-in
   * DEFAULT_RIFF_SYSTEM_PROMPT is used as a fallback.
   */
  systemPrompt?: string;
  /**
   * ADDITIONAL shell commands run in the riff sandbox before the agent starts
   * working. botmux is ALWAYS installed via MANDATORY_SETUP_COMMANDS (not
   * user-editable, sent to the riff API as config.setupCommands); these are
   * extra commands the user wants to run after that (e.g. installing other
   * dependencies). Sent to the riff API as `config.setupCommands` appended
   * after the mandatory botmux install commands.
   */
  setupCommands?: string[];
  /**
   * Extra HTTP headers added to EVERY riff outbound request (task-execute,
   * task-follow-up, task-stream, the reconcile tasks query, task-cancel,
   * task-detail). Intended for PPE/lane routing — e.g. { 'x-tt-env':
   * 'ppe_shenhan_sh', 'x-use-ppe': '1' } to hit a PPE deployment instead of
   * production. Empty/unset → no extra headers (production, current behavior).
   * MUST cover all requests uniformly: routing only task-execute to PPE while
   * task-stream hits production would split a session across environments.
   * Also mergeable from the BOTMUX_RIFF_EXTRA_HEADERS env var (JSON object);
   * config wins on key conflicts.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Override the follow-up fetch timeout budgets (ms). Both optional; when unset
   * the built-in defaults apply (hot 30s / cold 60s). Cold covers a follow-up
   * that must synchronously wake a reclaimed sandbox (idle gap / daemon-restart
   * resume); hot covers a follow-up right after the previous turn. Exposed so the
   * values can be tuned against riff's measured P50/P99 without a code change,
   * and so tests/live-repro can force a timeout by shrinking them. Non-positive
   * or non-finite values are ignored.
   */
  followUpHotTimeoutMs?: number;
  followUpColdTimeoutMs?: number;
}

/** Valid riff service base URL: non-empty http(s). Shared by the worker's
 *  spawn fail-fast and the dashboard PUT endpoint so every config entry point
 *  (dashboard / /config / setup / hand-edited bots.json) hits the same gate. */
export function isValidRiffBaseUrl(v: unknown): v is string {
  if (typeof v !== 'string' || !v.trim()) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isValidRiffSandboxCluster(v: unknown): v is RiffSandboxCluster {
  return RIFF_SANDBOX_CLUSTERS.includes(v as RiffSandboxCluster);
}

/** Valid `riff.jwtHome`: an absolute path. A relative one would resolve against
 *  the daemon's cwd and silently read a meaningless tree, so the spawn gate
 *  rejects it rather than letting the session 401 with no explanation. */
export function isValidRiffJwtHome(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && isAbsolute(v.trim());
}

export interface RiffRepoRef {
  /** Internal repo name, e.g. 'webinfra/agent-monorepo' (internal git host). */
  repoName: string;
  /** Branch to pin. Omitted → the repo's default branch. (The riff API
   *  ignores unknown fields like `branch`; `repoBranch` is the real one —
   *  verified empirically: it normalizes to gitRef/gitRefType/gitCommitId.) */
  repoBranch?: string;
}

/**
 * Normalize a git origin URL / repo spec to riff's internal repoName.
 * Accepts SSH (`git@<host>:group/repo.git`) and HTTPS
 * (`https://<host>/group/repo(.git)`) forms from any host, plus bare
 * `group/repo`. The host is not inspected here — the riff API validates
 * repoName against its internal registry and cannot clone external repos, so
 * an out-of-registry spec is rejected downstream rather than by hostname here.
 */
export function parseRiffRepoName(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  let m = /^git@[^:/\s]+:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(s);
  if (m) return m[1]!;
  m = /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(s);
  if (m) return m[1]!;
  // Bare group/repo (no scheme, no host) — pass through as-is.
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s;
  return null;
}

/**
 * Derive the riff repo ref from a local checkout so a riff task executes
 * against the same repo + branch the botmux session works in (复用本地仓库).
 * All git calls are local (no network). Returns null when the workingDir is
 * not a git repo or its origin cannot be parsed into a `group/repo` name.
 * `warnings` surface states the sandbox cannot see (dirty tree, unpushed
 * commits, never-pushed branch) — callers inject them as status lines.
 */
export function deriveRiffRepoFromWorkingDir(
  workingDir: string,
  runGit: (args: string[]) => string | null = defaultRunGit(workingDir),
): { repo: RiffRepoRef; warnings: string[] } | null {
  const origin = runGit(['remote', 'get-url', 'origin']);
  if (!origin) return null;
  const repoName = parseRiffRepoName(origin);
  if (!repoName) return null;

  const warnings: string[] = [];
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const repo: RiffRepoRef = { repoName };

  if (branch && branch !== 'HEAD') {
    const remoteRef = runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (remoteRef) {
      repo.repoBranch = branch;
      const ahead = runGit(['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]);
      if (ahead && ahead !== '0') {
        warnings.push(`本地分支 ${branch} 领先远端 ${ahead} 个未推送提交，沙箱只能看到已推送内容`);
      }
    } else {
      warnings.push(`本地分支 ${branch} 未推送到远端，沙箱将使用默认分支`);
    }
  }
  const dirty = runGit(['status', '--porcelain']);
  if (dirty) {
    warnings.push('本地工作区有未提交改动，沙箱只能看到已推送内容');
  }
  return { repo, warnings };
}

/**
 * Multi-repo derivation over an EXPLICIT, ordered dir list — the repo-select
 * card's 多仓库 flow stamps the user's chosen worktree dirs (in selection
 * order) onto the session, and ONLY that stamp triggers multi-repo here. The
 * first dir becomes riff's `primary` (sandbox cwd). Never scans children of an
 * arbitrary non-git workingDir: a home dir / repo-collection dir would attach
 * random unrelated repos to the task.
 */
export function deriveRiffReposFromDirs(
  dirs: string[],
  deriveOne: typeof deriveRiffRepoFromWorkingDir = deriveRiffRepoFromWorkingDir,
): { repos: RiffRepoRef[]; warnings: string[] } | null {
  const repos: RiffRepoRef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const derived = deriveOne(dir);
    if (!derived || seen.has(derived.repo.repoName)) continue;
    seen.add(derived.repo.repoName);
    repos.push(derived.repo);
    warnings.push(...derived.warnings.map(w => `[${derived.repo.repoName}] ${w}`));
  }
  return repos.length > 0 ? { repos, warnings } : null;
}

/**
 * Daemon-side orphan cancel: /close on a worker-less riff session must still
 * cancel the persisted remote task (the sandbox agent otherwise keeps running
 * with injected Lark credentials after the topic is closed). Bounded + one
 * retry; failures are logged, never thrown.
 */
export async function cancelRiffTaskById(
  cfg: { baseUrl: string; jwt?: string; jwtEnv?: string; jwtHome?: string; extraHeaders?: Record<string, string> },
  taskId: string,
): Promise<boolean> {
  const attempt = async (): Promise<void> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Reuse a throwaway instance for BOTH resolveJwt and applyExtraHeaders so the
    // orphan-cancel path routes to the same env/lane as the live session (else a
    // PPE session's orphan cancel would hit production). allowRefresh:false is
    // kept from the daemon-side contract — orphan-cancel must never trigger a
    // host-identity JWT refresh.
    const inst = new RiffBackend(cfg as RiffBackendConfig, 'orphan-cancel');
    const jwt = await inst['resolveJwt']({ allowRefresh: false });
    if (jwt) headers['x-jwt-token'] = jwt;
    inst['applyExtraHeaders'](headers);
    const resp = await fetch(`${cfg.baseUrl}/api/task-cancel`, {
      method: 'POST', headers, body: JSON.stringify({ id: taskId }), signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) throw new Error(`task-cancel HTTP ${resp.status}`);
  };
  try { await attempt(); return true; } catch {
    try { await attempt(); return true; } catch (err) {
      logger.warn(`[riff] orphan task-cancel failed (task ${taskId} may keep running remotely): ${err}`);
      return false;
    }
  }
}

/** Irreversible short hash of a sandbox URL for log correlation — the unique
 *  subdomain IS the write capability, so neither URL nor host may be logged. */
export function hashUrlForLog(u: string): string {
  return createHash('sha256').update(u).digest('hex').slice(0, 8);
}

/** The keychain leaf under a ByteCloud tool's storage root:
 *  `<root>/bytecloud-auth/keychain/auth/cn/default`, whose JSON holds the
 *  `bytecloud_jwt` field. `cn` is ByteCloud CN (riff is an internal CN
 *  service). NOTE the sibling `bytecloud-auth/auth/cn/credentials.json` (no
 *  `keychain/` segment) carries only metadata (app_id / expires_at / user) and
 *  NO `bytecloud_jwt` — we deliberately never read it. */
const BYTECLOUD_KEYCHAIN_LEAF = join('bytecloud-auth', 'keychain', 'auth', 'cn', 'default');

/**
 * Reproduce bytedcli's `sanitizeFilenamePart` + AIME base-dir assembly EXACTLY
 * (from `@bytedance-dev/bytedcli` dist/bytedcli-core.js, verified against
 * 0.124.0): a username path segment keeps only `[a-zA-Z0-9._-]` (every other
 * char → `_`), then a lone `.` → `_` and a lone `..` → `__`. Must match
 * byte-for-byte or the AIME keychain path we build won't line up with where
 * bytedcli actually wrote the token.
 */
function sanitizeAimeUser(user: string): string {
  return user.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.$/, '_').replace(/^\.\.$/, '__');
}

/**
 * bytedcli's data-home base when running inside an AIME workspace. bytedcli
 * uses it (in place of `os.homedir()`) ONLY when both `AIME_WORKSPACE_PATH` and
 * `AIME_CURRENT_USER` are set (trimmed non-empty); it then stores under
 * `<workspace>/<sanitizedUser>/.local/share/bytedcli/data/…`. We return the
 * `<workspace>/<sanitizedUser>/.local/share` prefix (parallel to the plain
 * `~/.local/share` data-home, so the shared `join(base,'bytedcli','data')`
 * below lands on the right leaf), or null when this is not an AIME runtime.
 */
function aimeDataHome(env: NodeJS.ProcessEnv): string | null {
  const workspace = env.AIME_WORKSPACE_PATH?.trim();
  const user = env.AIME_CURRENT_USER?.trim();
  if (!workspace || !user) return null;
  return join(workspace, sanitizeAimeUser(user), '.local', 'share');
}

/** True when BOTH AIME vars are set (trimmed non-empty), i.e. bytedcli swaps its
 *  storage root to the AIME workspace. In that runtime we must not trigger a
 *  host-identity JWT refresh — see resolveJwt's fail-closed skip. */
function isFullAimeRuntime(env: NodeJS.ProcessEnv): boolean {
  return aimeDataHome(env) !== null;
}

/**
 * Resolve the identity domain (home + env) whose ByteCloud keychain this riff
 * config reads, given the ambient daemon env.
 *
 * Why env and home move TOGETHER: three of the six candidate roots
 * (kaboo-cli / aiden-cli / cjadk) key off `$XDG_CONFIG_HOME` when it is set,
 * and on macOS/Windows the config root comes from the env too. Swapping only
 * the home while keeping the daemon's env therefore leaves those candidates
 * pointing at the DAEMON's account — measured: 3 of 6 candidates still resolved
 * under the daemon home. Since the selector picks the globally-freshest token
 * regardless of position, a live daemon-account token would then WIN over the
 * bot owner's and we would silently authenticate as the wrong user — the exact
 * cross-identity hazard `bytecloudKeychainCandidates` is built to prevent. So
 * an override drops the ambient home-derived env keys and lets each candidate
 * fall back to its documented `<home>/…` default.
 *
 * `AIME_*` is deliberately NOT carried over either: those vars describe the
 * daemon's own AIME runtime, and honouring them under a different home would
 * resolve to a third identity that is neither the daemon's nor the override's.
 * An explicit override is a statement about which human owns this bot, so it
 * wins over the ambient AIME runtime.
 *
 * Returns the ambient pair unchanged when no override is configured, so the
 * default path is byte-for-byte the current behaviour.
 */
export function resolveRiffJwtIdentity(
  jwtHome: string | undefined,
  ambientHome: string = homedir(),
  ambientEnv: NodeJS.ProcessEnv = process.env,
): { home: string; env: NodeJS.ProcessEnv; overridden: boolean } {
  const override = jwtHome?.trim();
  if (!override) return { home: ambientHome, env: ambientEnv, overridden: false };
  // A relative path would resolve against the daemon's cwd — meaningless and
  // silently wrong. Config gates reject it; ignore it here too so a hand-edited
  // bots.json degrades to current behaviour rather than reading a bogus tree.
  if (!isAbsolute(override)) {
    logger.warn(`[riff] ignoring non-absolute riff.jwtHome ${JSON.stringify(override)}; using the daemon home`);
    return { home: ambientHome, env: ambientEnv, overridden: false };
  }
  const env: NodeJS.ProcessEnv = { ...ambientEnv };
  // Home-derived roots that would otherwise pin the DAEMON's identity.
  delete env.XDG_CONFIG_HOME;
  delete env.APPDATA;
  delete env.AIME_WORKSPACE_PATH;
  delete env.AIME_CURRENT_USER;
  return { home: override, env, overridden: true };
}

/**
 * The keychain candidates for a ByteCloud tool's `bytecloud-auth/` store, across
 * the CLIs botmux users log into (kaboo-cli / aiden-cli / cjadk / bytedcli).
 *
 * ⚠️ This is NOT a "cast a wide net" list. The selector in
 * `readBytecloudKeychainJwt` picks the globally-freshest token by `exp`
 * REGARDLESS of order, so an extra candidate is not free: a stale/foreign token
 * at a location the tool never actually writes could WIN and shadow the real
 * one. Every entry must be a location the tool genuinely uses on THIS host:
 *   - Config-style CLIs (kaboo-cli / aiden-cli / cjadk) resolve their base via
 *     Go's os.UserConfigDir (verified against kaboo 1.3.77): macOS →
 *     `~/Library/Application Support`, Windows → `%AppData%` (Go errors, does
 *     NOT default to `~/AppData/Roaming`, when it is unset — so we emit no
 *     config candidate then), otherwise → `$XDG_CONFIG_HOME` (else `~/.config`).
 *     We list ONLY the current platform's root, never several — a
 *     foreign-platform root is never live here and would only invite shadowing.
 *   - cjadk also uses a home dot-dir `~/.cjadk`; aipaas uses `~/.aipaas`.
 *   - bytedcli stores under `~/.local/share/bytedcli/data` on Linux, macOS AND
 *     Windows: its `bytedcliBaseDir()` (bytedcli-core.js, 0.125.0) has no
 *     platform branch and ignores `$XDG_DATA_HOME`. Inside an AIME workspace it
 *     swaps the home base for `$AIME_WORKSPACE_PATH/<sanitized $AIME_CURRENT_USER>`
 *     — see the fail-closed early return below.
 * Order is otherwise NOT significant (selection is by `exp`, not position).
 * Non-existent candidates simply fail the read and are skipped.
 */
export function bytecloudKeychainCandidates(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dedupe = (xs: string[]): string[] => [...new Set(xs.filter(Boolean))];
  const isMac = platform === 'darwin';

  // --- Full AIME runtime: fail-closed to the AIME identity domain ---------
  // When BOTH AIME vars are set, bytedcli swaps its storage root to
  // `$AIME_WORKSPACE_PATH/<sanitized user>/.local/share/bytedcli/data` and,
  // crucially, does NOT fall back to the host HOME (bytedcliBaseDir returns the
  // AIME root and stops). `os.homedir()` here is still the HOST home — that is
  // precisely WHY bytedcli needs the override — so EVERY host-HOME-derived
  // keychain (the config-style CLIs under ~/.config or Application Support,
  // ~/.cjadk, ~/.aipaas) belongs to a DIFFERENT identity. Reading any of them
  // would cross AIME user identities, and the exp-aware selector below would
  // happily prefer a longer-lived host token. The safe boundary is the
  // identity domain, not the tool name: in a full AIME runtime the ONLY
  // in-domain source is the AIME-scoped bytedcli store. If it holds no live
  // token we return nothing here and the caller fails closed (the user logs in
  // inside AIME) rather than silently authenticating as someone else.
  const aimeHome = aimeDataHome(env);
  if (aimeHome) {
    return [join(aimeHome, 'bytedcli', 'data', BYTECLOUD_KEYCHAIN_LEAF)];
  }

  // --- Ordinary (non-AIME) runtime ---------------------------------------
  // Config-style CLIs (kaboo-cli / aiden-cli / cjadk) resolve their base via
  // Go's os.UserConfigDir (verified against kaboo 1.3.77's embedded ByteCloud
  // auth). That maps per-platform: macOS → `~/Library/Application Support`;
  // Windows → `%AppData%`; everything else → `$XDG_CONFIG_HOME` (falling back
  // to `~/.config`). A single process only ever uses ONE of these — the current
  // platform's. We must key off the actual platform, NOT list several: the
  // exp-aware selector picks the globally-freshest token regardless of order,
  // so a stale token under another platform's root could otherwise shadow the
  // authoritative one (a foreign-platform root is never a live location on this
  // host anyway). `platform` is injectable so every spelling stays testable.
  //
  // `configHome` is null when we cannot name the platform's real config root:
  // on Windows Go ERRORS if `%AppData%` is unset (it does NOT default to
  // `~/AppData/Roaming`), so with APPDATA absent we emit NO config-style
  // candidate rather than invent a phantom path a stale token could shadow
  // from. The other verified candidates (bytedcli, dot-dirs) are unaffected.
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  let configHome: string | null;
  if (isMac) {
    configHome = join(home, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    configHome = env.APPDATA?.trim() || null;
  } else {
    configHome = xdgConfig || join(home, '.config');
  }
  // bytedcli keeps `bytedcli/data/bytecloud-auth/...` under its data home.
  // `bytedcliBaseDir()` in `@bytedance-dev/bytedcli` (dist/bytedcli-core.js,
  // 0.125.0) has NO platform branch: in the ordinary case it unconditionally
  // uses `~/.local/share/bytedcli` on Linux, macOS AND Windows, and it ignores
  // $XDG_DATA_HOME. So the single `~/.local/share` data home is correct on
  // every platform — there is no Application Support / %AppData% spelling to
  // add. (The AIME workspace override is the only base swap, handled above.)
  const bytedcliHome = join(home, '.local', 'share');
  const roots: string[] = [];
  // Config-dir CLIs (single platform-correct base, when we can name one).
  if (configHome) {
    for (const cli of ['kaboo-cli', 'aiden-cli', 'cjadk']) roots.push(join(configHome, cli));
  }
  // Home dot-dir layouts (Linux-observed; harmless as extra candidates elsewhere).
  roots.push(join(home, '.cjadk'));
  roots.push(join(home, '.aipaas'));
  // Data-dir CLI (bytedcli) — the extra `data/` segment is part of its layout.
  roots.push(join(bytedcliHome, 'bytedcli', 'data'));
  return dedupe(roots).map((root) => join(root, BYTECLOUD_KEYCHAIN_LEAF));
}

/**
 * Decode a JWT's `exp` (seconds since epoch) from its payload without verifying
 * the signature — we only need the expiry to prefer a live token over a stale
 * one. Returns null for anything we cannot confidently parse as an expiry so it
 * ranks below any parseable-live token (opaque/non-JWT strings, malformed
 * base64, missing/non-number `exp`).
 *
 * A JWS compact JWT is EXACTLY three non-empty base64url segments
 * (`header.payload.signature`) whose header and payload are JSON. We require
 * that shape up front: a 2- or 4-segment string, a segment that isn't
 * base64url (incl. the signature), or a header/payload that isn't a JSON
 * object is NOT a JWT and must never be ranked as a live token where its
 * (accidentally decodable) `exp` could shadow a genuine JWT. We do NOT verify
 * the signature (that is riff's job) — only that the structure is a real JWT.
 */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
function decodeJoseJson(seg: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(Buffer.from(seg, 'base64url').toString('utf-8')) as unknown;
    // A JOSE header / JWT payload is a JSON object (not an array, not a scalar).
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}
export function decodeJwtExp(jwt: string): number | null {
  const parts = jwt.split('.');
  // Exactly three non-empty, strictly-base64url segments (header.payload.sig).
  if (parts.length !== 3) return null;
  if (!parts[0] || !parts[1] || !parts[2]) return null;
  if (parts.some((p) => !BASE64URL_RE.test(p))) return null;
  // Header must decode to a JSON object (confirms it's really JOSE, not just
  // base64url-shaped noise); we don't require a specific `typ`/`alg`.
  if (!decodeJoseJson(parts[0]!)) return null;
  const payload = decodeJoseJson(parts[1]!);
  if (!payload) return null;
  const exp = payload['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

/**
 * Read the ByteCloud JWT from the keychain candidates, preferring a live token.
 * Pure + injectable (home/env/now) so it is unit-testable without touching the
 * real HOME. Never throws — unreadable/malformed candidates are skipped.
 *
 * Selection (fixes the stale-token-shadows-valid-token hazard: an expired token
 * from an earlier-listed tool must not mask a valid token from a later one):
 *   1. Collect every candidate's non-empty `bytecloud_jwt`, in candidate order.
 *   2. Drop tokens whose decoded `exp` is already past `now`.
 *   3. Among the survivors, pick the one with the greatest `exp` (freshest);
 *      candidates whose `exp` we cannot parse (opaque values) rank BELOW any
 *      parseable live token and are used only as a last-resort fallback when no
 *      parseable-live token exists — so a broken/opaque old value can never
 *      shadow a clearly-valid newer token.
 * Returns null when nothing yields a usable token.
 */
/**
 * Treat a token that expires within this many seconds as already expired. riff
 * task creation reads the JWT once and does a single fetch; a 401 there throws
 * and fails the whole turn (SSE reconnect only covers an ALREADY-created task),
 * and a fresh sandbox cold-boot costs minutes — so a token about to expire
 * mid-request is worse than skipping to a longer-lived candidate. Also absorbs
 * small client/server clock skew.
 */
export const JWT_EXPIRY_SAFETY_WINDOW_SEC = 30;

export function readBytecloudKeychainJwt(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const cutoffSec = nowMs / 1000 + JWT_EXPIRY_SAFETY_WINDOW_SEC;
  let bestLive: { jwt: string; exp: number } | null = null; // parseable, unexpired, freshest
  let opaqueFallback: string | null = null;                 // first exp-less, non-expired-unknown token
  for (const path of bytecloudKeychainCandidates(home, env, platform)) {
    let jwt: string;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      const v = data['bytecloud_jwt'];
      if (typeof v !== 'string' || v.length === 0) continue;
      jwt = v;
    } catch { continue; }
    const exp = decodeJwtExp(jwt);
    if (exp === null) {
      // Cannot parse expiry — keep only the first as a last-resort fallback.
      if (opaqueFallback === null) opaqueFallback = jwt;
      continue;
    }
    if (exp <= cutoffSec) continue; // expired or about to expire — never select.
    if (!bestLive || exp > bestLive.exp) bestLive = { jwt, exp };
  }
  return bestLive?.jwt ?? opaqueFallback;
}

/**
 * Locate a `bytedcli` binary on PATH (used to build the default JWT-refresh
 * command). Returns the bare name `bytedcli` when found so execFileSync resolves
 * it via PATH, or null when absent. Injectable env/platform for testing.
 *
 * We look for a real installed binary rather than defaulting to
 * `npx @bytedance-dev/bytedcli@latest`: an uncached / `@latest` npx resolve can
 * block ~30s, which is unacceptable on the synchronous pre-request path. If
 * bytedcli is not installed we simply do not auto-refresh (fail-closed to the
 * prior behaviour — the request may 401, exactly as before this change).
 */
export function findBytedcliBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  if (!pathVar) return null;
  const names = platform === 'win32' ? ['bytedcli.cmd', 'bytedcli.exe', 'bytedcli'] : ['bytedcli'];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (existsSync(join(dir, name))) return 'bytedcli';
      } catch { /* ignore unreadable PATH entry */ }
    }
  }
  return null;
}

/**
 * Resolve the JWT-refresh command: explicit config → env
 * `BOTMUX_RIFF_JWT_REFRESH_CMD` (space-split) → a PATH-resident bytedcli →
 * null (no auto-refresh). See RiffBackendConfig.jwtRefreshCmd for the rationale.
 */
export function resolveJwtRefreshCmd(
  configured: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] | null {
  if (configured && configured.length > 0) return configured;
  const fromEnv = env.BOTMUX_RIFF_JWT_REFRESH_CMD?.trim();
  if (fromEnv) {
    const parts = fromEnv.split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
  }
  const bin = findBytedcliBinary(env, platform);
  if (bin) return [bin, 'auth', 'get-bytecloud-jwt-token', '--force-refresh'];
  return null;
}

/** Minimum gap between speculative JWT refresh attempts. When the keychain
 *  holds no live token, a reconnect/follow-up loop would otherwise trigger a
 *  refresh on EVERY getJwt() call; we cap proactive refreshes at one per window
 *  and let the shared keychain re-read serve the rest. Also caps the cost of a
 *  refresh command that keeps failing (e.g. bytedcli not logged in). A refresh
 *  driven by an actual server 401 bypasses this window (see `force`). */
export const JWT_REFRESH_DEBOUNCE_MS = 60_000;

/** How long a single refresh command may run before we give up. Once the
 *  refresh is asynchronous (below) this no longer blocks the event loop — it
 *  only bounds one awaited child process — so we keep it generous: a cold
 *  bytedcli token fetch can take a few seconds, and a session that cannot get a
 *  JWT has nothing useful to do anyway. */
export const JWT_REFRESH_TIMEOUT_MS = 30_000;

/** Process-wide last-attempt timestamp (ms), PER IDENTITY. Shared across
 *  RiffBackend instances because the orphan-cancel path builds a throwaway
 *  instance per call — a per-instance clock there would never debounce. Keyed by
 *  identity because a shared host runs one riff bot per human: a single global
 *  clock let the FIRST bot's refresh swallow every other bot's for the next 60s
 *  (measured: alice refreshed, bob got `false` without its command ever running),
 *  so a user whose token expired would sit unauthenticated behind a colleague's
 *  unrelated refresh. A missing key means "never attempted", so the first call
 *  for an identity always runs. Reset helper for tests. */
const lastJwtRefreshAtMsByIdentity = new Map<string, number>();
/** In-flight refresh PER IDENTITY, so concurrent callers for the SAME identity
 *  coalesce onto one child process while different identities still refresh
 *  independently — they rewrite different keychains, so one can never stand in
 *  for the other. */
const inFlightJwtRefreshByIdentity = new Map<string, Promise<boolean>>();
export function __resetJwtRefreshDebounceForTest(): void {
  lastJwtRefreshAtMsByIdentity.clear();
  inFlightJwtRefreshByIdentity.clear();
}

export interface RefreshBytecloudJwtOpts {
  /** Injectable async runner (defaults to a real execFile). */
  runner?: (bin: string, args: string[]) => Promise<void>;
  /** Injectable clock for the debounce window (defaults to Date.now()). */
  nowMs?: number;
  /** Bypass the debounce window. Set only when an actual server 401/403 proved
   *  the current token is bad — a rejection is authoritative evidence worth one
   *  more attempt even inside the window. Never set for speculative refreshes. */
  force?: boolean;
  /** Which identity's keychain this refresh rewrites. Debounce and coalescing are
   *  scoped to it, so one bot's refresh never stands in for (or suppresses)
   *  another user's. Defaults to the daemon's own identity. */
  identityKey?: string;
}

/**
 * Run the JWT-refresh command once, ASYNCHRONOUSLY. Never throws: a missing
 * command, a non-zero exit, or a timeout all resolve to `false` (the caller then
 * falls back to whatever the keychain holds — i.e. the pre-change behaviour).
 * Resolves true only when a command actually ran to completion.
 *
 * Async + injectable (runner / now / force) so it never blocks the event loop
 * (critical on the daemon-side orphan-cancel path) and the debounce / coalesce /
 * fail-closed paths are unit-testable without spawning a real process.
 *
 * COALESCE: if a refresh is already in flight, ride it instead of spawning a
 * second bytedcli — concurrent getJwt() callers share one refresh.
 */
export function refreshBytecloudJwt(
  cmd: string[] | null,
  opts: RefreshBytecloudJwtOpts = {},
): Promise<boolean> {
  const { runner = defaultJwtRefreshRunner, nowMs = Date.now(), force = false, identityKey = '' } = opts;
  if (!cmd || cmd.length === 0) return Promise.resolve(false);
  // Coalesce first, WITHIN one identity: a forced caller still rides an in-flight
  // refresh rather than racing a second child — the running one will rewrite that
  // keychain either way. Across identities there is nothing to ride: a refresh for
  // alice does not touch bob's store.
  const inFlight = inFlightJwtRefreshByIdentity.get(identityKey);
  if (inFlight) return inFlight;
  // Debounce: cap the cost of a refresh that keeps failing. A forced (401-driven)
  // refresh bypasses the window — the token was provably rejected.
  const lastAt = lastJwtRefreshAtMsByIdentity.get(identityKey) ?? Number.NEGATIVE_INFINITY;
  if (!force && nowMs - lastAt < JWT_REFRESH_DEBOUNCE_MS) return Promise.resolve(false);
  lastJwtRefreshAtMsByIdentity.set(identityKey, nowMs);
  const [bin, ...args] = cmd;
  const run = (async (): Promise<boolean> => {
    try {
      await runner(bin!, args);
      return true;
    } catch (err) {
      logger.warn(`[riff] JWT refresh command failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  })();
  inFlightJwtRefreshByIdentity.set(identityKey, run);
  return run.finally(() => {
    if (inFlightJwtRefreshByIdentity.get(identityKey) === run) inFlightJwtRefreshByIdentity.delete(identityKey);
  });
}

const execFileAsync = promisify(execFile);
/** Default refresh runner: async execFile with a bounded timeout. stdout/stderr
 *  are discarded — the command's SIDE EFFECT (rewriting the keychain) is what
 *  matters; we re-read the keychain afterwards rather than parse its output. */
async function defaultJwtRefreshRunner(bin: string, args: string[]): Promise<void> {
  await execFileAsync(bin, args, { timeout: JWT_REFRESH_TIMEOUT_MS });
}

function defaultRunGit(cwd: string): (args: string[]) => string | null {
  return (args: string[]) => {
    try {
      const out = execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  };
}

interface RiffAttachment {
  path: string;
  name: string;
  type: 'image' | 'file';
}

/**
 * riff route-B `display` projection carried on stdout `log` SSE events
 * (feat/riff-agent-log-display, TaskLogDisplay = DerivedExecuteLogEvent minus
 * commandId/payload). A per-line, stateless distillation of a codex app-server
 * event; `kind` drives our timeline prefix + colour, `title` is riff-localized.
 */
interface RiffLogDisplay {
  kind: string;
  actor?: string;
  title?: string;
  text?: string;
  summary?: string;
  command?: string;
  status?: 'running' | 'completed' | 'failed';
  stream?: 'stdout' | 'stderr';
  exitCode?: number;
}

// Defensive backstop only: riff already downgrades codex lifecycle "noise" lines
// (thread.started / item.started / usage-only turns) to channel:'raw' so a default
// subscription never receives them. If an un-projected bare codex event still slips
// through, this recognizes it so we suppress rather than render a wall of JSON.
// Deliberately narrow: only a single-line JSON object whose `type` is a known
// no-content lifecycle marker — never plain shell output.
// Kept in sync with riff's CODEX_NOISE_EVENT_TYPES (agentExecuteLogParser.ts) — the
// authoritative classifier. Mirror it exactly so our fallback matches riff's filter.
const CODEX_NOISE_TYPES = new Set([
  'thread.started',
  'turn.started',
  'item.started',
  'item.updated',
  'turn.completed',
  'response.completed',
  'response.done',
]);
function isBareCodexNoiseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return typeof parsed.type === 'string' && CODEX_NOISE_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

interface RiffTaskResponse {
  success: boolean;
  data: {
    id: string;
    status: string;
    accessUrl?: string;
    directAccessUrl?: string;
    queuePosition?: number | null;
  };
}

/** One node from `GET /api/tasks?threadId=&view=summary` (summary projection).
 *  NOTE the primary-key field is `id` (the DB `taskId` is serialized out as
 *  `id`) — never read `.taskId` here. `followUpParentTaskId` is absent on the
 *  root task. `interaction.status` is a retired V1 field (not written by new
 *  tasks) — status comes from the top-level `status` only.
 *  Fields verified against riff's TASK_THREAD_SUMMARY_PROJECTION: the summary
 *  view really does project `followUpParentTaskId`/`followUpRootTaskId`, so the
 *  reconcile below can match on them. */
interface RiffThreadNode {
  id: string;
  threadId?: string;
  status?: string;
  origin?: string;
  useRunner?: boolean;
  followUpParentTaskId?: string;
  followUpRootTaskId?: string;
  /** ISO timestamp of task creation. In riff's summary projection; used as the
   *  reconcile floor so a task stranded by an earlier turn is never adopted. */
  createdAt?: string;
}

/** Terminal riff task statuses (riff openApiDocs task contract). Once a task
 *  reaches one of these it will emit no further progress — an `init` replay or
 *  a `done` event carrying one of these IS the task's completion. Non-terminal:
 *  pending / creating_session / running. */
const TERMINAL_RIFF_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

/**
 * RiffBackend — bridges botmux's SessionBackend interface to riff's HTTP API.
 *
 * Lifecycle:
 *   spawn()       → initializes riff client (no actual task created yet)
 *   write(text)   → creates a task (first write) or follow-up (subsequent writes)
 *                   SSE output events flow through onData callback
 *   kill()        → cancels current task via task-cancel
 *   onExit        → fires on /close (kill) or unrecoverable error, NOT on task done
 *
 * SSE events use standard SSE format: event type in `event:` line, JSON in `data:` lines.
 * Events: output (text chunks), status (state changes), init (full state + accessUrl),
 * session_info (sandbox access info), done (task completion), log (verbose logs).
 */
export class RiffBackend implements SessionBackend {
  private config: RiffBackendConfig;
  private sessionId: string;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private accessUrlCb: ((url: string) => void) | null = null;
  private taskDoneCb: (() => void) | null = null;
  private taskIdCb: ((taskId: string | null) => void) | null = null;
  private outputBuffer = '';
  private currentTaskId: string | null = null;
  private currentAccessUrl: string | null = null;
  /** True when currentAccessUrl is the sandbox directAccessUrl (never downgrade it). */
  private accessUrlIsDirect = false;
  private abortController: AbortController | null = null;
  private killed = false;
  /** /close teardown in progress — new writes are rejected and an in-flight
   *  create/follow-up must cancel its late task instead of streaming it. */
  private closing = false;
  private taskDone = false;
  /** Tasks whose done event already fired the turn boundary — a duplicate
   *  done (observed live) or a stale stream must never re-fire it. Bounded:
   *  cleared past 64 entries (a session rarely exceeds a few dozen turns). */
  private completedTaskIds = new Set<string>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 6;
  /** Wall-clock ms when the CURRENT SSE connection was established, or `null`
   *  when none is open / the last fetch never connected. Typed `number | null`
   *  (not a 0 sentinel) on purpose: 0 is both "not connected" AND a valid number
   *  you could subtract, so a future edit dropping the guard would compute a
   *  bogus multi-decade lifetime from `Date.now() - 0` and refund forever. `null`
   *  makes "never connected" un-subtractable and forces the guard at the type
   *  level. The reconnect budget is refunded only when a broken connection had
   *  LIVED long enough to be a healthy long connection merely severed by the
   *  upstream proxy's fixed ~183s lifetime cap — NOT merely because a connection
   *  opened. Keying on "connection lived ≥ reconnectHealthyConnMs" (not on
   *  receiving init, and not on any data event — both were falsified/
   *  insufficient) is what separates the two cases that look identical from the
   *  client:
   *    • healthy cap:   connection lives ~183s, EOFs → refund → task streams on
   *    • dead/hot-loop: connection opens then EOFs within ~1s, repeatedly →
   *      NO refund → budget exhausts and bails. Covers BOTH a fetch that never
   *      connects (stays null) AND a "connect→init→instant-EOF" loop against a
   *      stale-running orphan (lives <threshold) — the latter is exactly the
   *      infinite-retry hole a naive "reset on connect/init" would reopen. */
  private connectionStartedAtMs: number | null = null;
  /** 预算层级（单调覆盖，见 destroySession 注释）；字段化以便测试注入边界。 */
  private cancelTimeoutMs = 4_000;
  /** task-execute（首建）的 fetch 预算。create 只是服务端入队，快，保持较小。 */
  private createTimeoutMs = 15_000;
  /** task-follow-up 的 fetch 预算，冷/热两档。follow-up 返回前的同步预检（JWT 刷新
   *  + 读沙箱状态 + lark/meego/agentBuddy 授权检查）本就比 create 重；沙箱变冷时
   *  （空闲被回收 / daemon 重启后 resume 血缘）还会叠加 archive+snapshot+IDE-proxy
   *  探测——正是当初顶穿共用 10s 预算的慢路径（实测 spawn→timeout 恰好 10.01s）。
   *  故 follow-up 给更大预算并按冷/热分档。30/60s 为暂定值，待 riff 侧 P50/P99
   *  回填；字段化以便测试注入。 */
  private followUpHotTimeoutMs = 30_000;
  private followUpColdTimeoutMs = 60_000;
  /** follow-up 距上次任务活动超过此阈值（或本进程尚无任何活动，见 followUpTimeoutMs）
   *  即判为冷沙箱，走 followUpColdTimeoutMs。 */
  private coldFollowUpThresholdMs = 90_000;
  /** follow-up 超时后对 thread 的对账查询预算 / 最多尝试次数 / 重试间隔。查询是只读的，
   *  刚在超时瞬间建好的子任务可能要一小会才可查到，故允许一次短重试。字段化以便测试注入。 */
  private reconcileTimeoutMs = 8_000;
  private reconcileMaxAttempts = 2;
  private reconcileRetryDelayMs = 1_500;
  /** 对账「发送时刻下限」的容差，分两档（见 pickReconciledChild）：
   *  - 已从 `Date` 头实测到服务端偏差 → 只需覆盖测量误差本身（`Date` 头整秒精度
   *    ~0.5s + 一个往返 + 期间的小漂移），取 5s。
   *  - 尚未观测到 `Date` 头（首次对账、代理剥掉了该头等） → 偏差完全未知，退回
   *    30s 盲兜底：宁可窗口宽一些，也不要因本机时钟快而永远认领不到子任务。
   *  容差直接就是误接窗口宽度（创建于本轮发送前该时长内的遗留任务会被误判为本轮
   *  的），所以能测到偏差时必须收窄。字段化以便测试注入。 */
  private reconcileClockSkewMs = 5_000;
  private reconcileBlindClockSkewMs = 30_000;
  /** riff 服务端时钟减本机时钟（ms），由 tasks 响应的 `Date` 头实测得出；`null`
   *  表示尚未观测到（此时按偏差未知处理，走盲兜底容差）。用于把「发送时刻」换算到
   *  服务端时间轴，再与服务端写入的 `createdAt` 比较。 */
  private serverClockOffsetMs: number | null = null;
  /** 最近一次「任务活动」的 wall-clock ms（成功建任务/续任务，或收到任意 SSE 事件），
   *  本进程尚无活动时为 null。驱动 follow-up 冷/热判据：长时间空闲或全新进程
   *  （daemon 重启 resume）意味着 riff 沙箱大概率已被回收，下一次 follow-up 需同步
   *  唤醒它——正是需要更大预算的慢路径。 */
  private lastTaskActivityMs: number | null = null;
  private destroyDeadlineMs = 20_000;
  /** SSE 重连退避基数（指数退避的第一档）；字段化以便测试把重连间隔压到 0。 */
  private reconnectBaseDelayMs = 1_000;
  private reconnectMaxDelayMs = 30_000;
  /** A broken SSE connection that lived at least this long is treated as a
   *  healthy long connection severed by the ~183s proxy cap → refund the
   *  reconnect budget. Shorter-lived breaks (dead endpoint / instant-EOF hot
   *  loop) do NOT refund. 30s: the cap is metronomic at ~181-183s (6× margin)
   *  while pathological EOFs are sub-second, so the two separate cleanly.
   *  Field-ized for test injection. */
  private reconnectHealthyConnMs = 30_000;
  /** Exact late/current task whose close cancellation failed. Retained across
   * the prepare-close handshake so the daemon can persist a retry handle. */
  private closeFailureTaskId: string | null = null;
  private closeFailureError: string | null = null;
  private closeLateTaskHandled = false;
  private closePrepared = false;
  private closeAttempt: symbol | null = null;
  private destroyInFlight: Promise<SessionDestroyResult> | null = null;
  private cancelInFlight: Promise<boolean> | null = null;
  private abortInFlight: Promise<void> | null = null;
  /** Graceful daemon shutdown is a non-cancelling two-phase detach. It fences
   * only writes arriving after prepare; writes already appended to writeChain
   * still drain so a late child id can be durably handed to the daemon. */
  private shutdownDetaching = false;
  private shutdownDetachPrepared = false;
  private shutdownDetachAttempt: symbol | null = null;
  private shutdownDetachInFlight: Promise<SessionShutdownDetachResult> | null = null;
  private shutdownDetachAbortInFlight: Promise<SessionShutdownDetachResult> | null = null;
  /** Serializes write() → createTask/followUp. Without this, a second message
   *  arriving before the first task-execute HTTP returns would see
   *  currentTaskId === null and create a duplicate task. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(config: RiffBackendConfig, sessionId: string) {
    this.config = config;
    this.sessionId = sessionId;
    // Daemon-restart resume: the persisted parent task id restores the
    // follow-up lineage — the first write after restart continues the riff
    // conversation instead of cold-booting a context-less fresh task.
    if (config.resumeParentTaskId) this.currentTaskId = config.resumeParentTaskId;
    // Optional follow-up timeout overrides (P50/P99 tuning without a code change,
    // or forcing a timeout in live repro). Only positive finite values apply.
    const pos = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (pos(config.followUpHotTimeoutMs)) this.followUpHotTimeoutMs = config.followUpHotTimeoutMs;
    if (pos(config.followUpColdTimeoutMs)) this.followUpColdTimeoutMs = config.followUpColdTimeoutMs;
  }

  /** Called when the riff sandbox accessUrl becomes available or changes. */
  onAccessUrl(cb: (url: string) => void): void {
    this.accessUrlCb = cb;
    if (this.currentAccessUrl) cb(this.currentAccessUrl);
  }

  /** Called when the current riff task completes or fails (turn boundary). */
  onTaskDone(cb: () => void): void {
    this.taskDoneCb = cb;
  }

  /** Called whenever a new task id becomes current (create/follow-up). The
   *  worker forwards it to the daemon so the follow-up lineage survives a
   *  daemon restart (currentTaskId otherwise lives only in this process). */
  onTaskId(cb: (taskId: string | null) => void): void {
    this.taskIdCb = cb;
    if (this.currentTaskId) cb(this.currentTaskId);
  }

  /** Resolve JWT dynamically — re-reads env/keychain each call so auto-refresh
   *  works. Async because a keychain miss may trigger a (non-blocking) CLI
   *  refresh. `opts.allowRefresh=false` skips the refresh entirely (daemon-side
   *  orphan-cancel: a best-effort teardown must never freeze the daemon on a
   *  host-identity refresh). `opts.forceRefresh=true` bypasses the debounce
   *  window (an actual server 401 proved the token bad). */
  private getJwt(opts: { allowRefresh?: boolean; forceRefresh?: boolean } = {}): Promise<string | null> {
    return this.resolveJwt(opts);
  }

  /** Merge the configured extra headers (PPE/lane routing, see config.extraHeaders)
   *  into an outbound request's header map, in place. Precedence: existing headers
   *  already set (JWT, Content-Type) are never overwritten; config.extraHeaders
   *  wins over the BOTMUX_RIFF_EXTRA_HEADERS env var on key conflicts. Applied to
   *  EVERY riff request so a session never splits across environments. No-op when
   *  nothing is configured (production, current behavior). */
  private applyExtraHeaders(headers: Record<string, string>): void {
    const merged = this.resolveExtraHeaders();
    for (const [k, v] of Object.entries(merged)) {
      if (!(k in headers)) headers[k] = v;
    }
  }

  /** Extra headers from the env var (JSON object) overlaid by config.extraHeaders.
   *  Malformed env JSON is ignored with a warning rather than throwing. */
  private resolveExtraHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = process.env.BOTMUX_RIFF_EXTRA_HEADERS?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          if (v != null && v !== '') out[k] = String(v);
        }
      } catch (err) {
        logger.warn(`[riff] ignoring malformed BOTMUX_RIFF_EXTRA_HEADERS: ${err}`);
      }
    }
    if (this.config.extraHeaders) {
      for (const [k, v] of Object.entries(this.config.extraHeaders)) {
        if (v != null && v !== '') out[k] = String(v);
      }
    }
    return out;
  }

  private async resolveJwt(
    opts: { allowRefresh?: boolean; forceRefresh?: boolean } = {},
  ): Promise<string | null> {
    const { allowRefresh = true, forceRefresh = false } = opts;
    if (this.config.jwt) return this.config.jwt;
    const envKey = this.config.jwtEnv ?? 'RIFF_JWT';
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;

    // Fallback: try ByteCloud Auth SDK keychain (kaboo-cli / aiden-cli / cjadk / bytedcli)
    const fromKeychain = this.readJwtFromBytecloudKeychain();
    // A forced refresh (post-401) intentionally ignores an existing keychain
    // token: the server just rejected whatever we had, so re-reading the same
    // store without refreshing first would hand back the same bad token.
    if (fromKeychain && !forceRefresh) {
      logger.info(`[riff] JWT loaded from ByteCloud keychain`);
      return fromKeychain;
    }

    // No live keychain token (or a forced post-401 refresh) — every candidate is
    // expired, within the safety window, or absent. This is exactly the "token
    // expired mid-task" / "expired at startup" case (the JWT is re-read per
    // request). Before giving up to a 401 that would abort the turn, ask the
    // owning CLI to refresh (non-blocking async, coalesced, non-fatal), then
    // re-read once. Skipped when allowRefresh=false (daemon-side orphan-cancel)
    // and inside a full AIME runtime (fail-closed identity boundary — we never
    // trigger a host-identity refresh there; the AIME store is refreshed inside
    // AIME).
    //
    // A `jwtHome` override needs a refresh command that can rewrite THAT user's
    // keychain. The default command (`bytedcli …`) runs as the daemon UID with
    // the daemon's HOME, so it would rewrite the daemon's store — it cannot fix
    // the token we are about to return, and pointing it at someone else's HOME
    // would be worse (a daemon-UID write into that user's home). So an override
    // auto-refreshes ONLY when the deployment supplied an explicit
    // `jwtRefreshCmd` — the operator's own hook (a per-user wrapper, `sudo -u`,
    // whatever the host uses to isolate logins) which is the only thing that
    // knows how to refresh as that user. Without one we skip rather than burn a
    // 30s subprocess that provably cannot help.
    const identity = this.jwtIdentity();
    const cmd = resolveJwtRefreshCmd(this.config.jwtRefreshCmd, identity.env);
    const refreshCanServeIdentity = !identity.overridden || Boolean(this.config.jwtRefreshCmd?.length);
    if (allowRefresh && refreshCanServeIdentity && !isFullAimeRuntime(identity.env)) {
      if (await refreshBytecloudJwt(cmd, { force: forceRefresh, identityKey: identity.home })) {
        const refreshed = this.readJwtFromBytecloudKeychain();
        if (refreshed) {
          logger.info(`[riff] JWT refreshed via ByteCloud CLI and reloaded from keychain`);
          return refreshed;
        }
      }
    } else if (allowRefresh && identity.overridden && !cmd) {
      logger.warn(
        `[riff] riff.jwtHome=${identity.home} has no live token and no riff.jwtRefreshCmd is configured — `
        + 'botmux cannot refresh another user\'s ByteCloud login by itself. Configure riff.jwtRefreshCmd '
        + '(a command that refreshes as that user), or have them re-login.',
      );
    }

    // Forced refresh found nothing new — fall back to the (rejected) keychain
    // token rather than null: a stale token is no worse than no token, and the
    // caller already knows it 401'd.
    if (fromKeychain) return fromKeychain;
    // Name the identity domain we searched. "JWT not found" alone sent users
    // hunting through `kaboo login` status on an account that was in fact
    // logged in — just not the account this lookup reads.
    const { home, overridden } = identity;
    logger.warn(
      `[riff] JWT not found in config, env ${envKey}, or the ByteCloud keychain under ${home}`
      + `${overridden ? ' (riff.jwtHome)' : ' (daemon home — set riff.jwtHome to the bot owner\'s home if this bot runs as another user)'}`
      + '; API calls will fail',
    );
    return null;
  }

  /** Identity domain (home + env) whose keychain this bot's riff JWT comes from
   *  — the daemon's own unless `riff.jwtHome` scopes it to the bot owner. */
  private jwtIdentity(): { home: string; env: NodeJS.ProcessEnv; overridden: boolean } {
    return resolveRiffJwtIdentity(this.config.jwtHome);
  }

  private readJwtFromBytecloudKeychain(): string | null {
    const { home, env } = this.jwtIdentity();
    return readBytecloudKeychainJwt(home, env);
  }

  spawn(_bin: string, _args: string[], _opts: SpawnOpts): void {
    logger.info(`[riff] spawn (ignoring bin/args, using config: ${this.config.baseUrl})`);
    // No actual process to spawn. Task creation happens on first write().
  }

  write(data: string): boolean {
    if (this.killed) return false;
    if (this.shutdownDetaching) {
      logger.warn('[riff] write rejected while graceful shutdown detach is preparing/prepared');
      return false;
    }
    if (this.closing) {
      logger.warn('[riff] write rejected while explicit close is preparing/prepared');
      return false;
    }

    const { text, attachments } = this.extractAttachments(data);

    this.writeChain = this.writeChain
      .then(async () => {
        // closing 也要在链内复查：write 可能在 close 之前就排进了队列。
        if (this.killed || this.closing) return;
        // Route by task lineage only: task-follow-up is exactly the "continue
        // the conversation after the parent finished" API, so a completed task
        // (taskDone) must still route to followUp — spinning up a fresh task
        // per turn would cold-boot a new sandbox (minutes) and drop context.
        this.taskDone = false;
        if (!this.currentTaskId) {
          await this.createTask(text, attachments);
        } else {
          await this.followUp(text, attachments);
        }
      })
      .catch((err) => {
        logger.warn(`[riff] queued write failed: ${err}`);
      });
    return true;
  }

  resize(_cols: number, _rows: number): void {
    // No terminal screen to resize.
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    // Stream detach ONLY — the remote task keeps running. kill() fires on
    // worker teardown / daemon restart, where the task should survive: its
    // agent still delivers via `botmux send`, and the persisted parent task id
    // resumes the follow-up lineage after restart. Cancelling belongs to the
    // explicit /close path (destroySession).
    logger.info('[riff] kill requested (stream detach — remote task keeps running)');
    this.abortController?.abort();
    this.exitCb?.(0, null);
  }

  async destroySession(): Promise<SessionDestroyResult> {
    // /close 必须把远端任务真正取消掉——fire-and-forget
    // 在 worker 紧接 process.exit 时大概率发不出去，已关闭话题的远端 agent 会
    // 继续拿着注入的凭证发消息。有界 await + 一次重试，失败也明确留痕。
    //
    // L-race：/close 可能落在 create/follow-up HTTP 未返回的窗口——此时
    // currentTaskId 还是 null/旧值，直接 cancel 会漏掉 late task。先立 closing
    // 门（拒新写 + 令 in-flight 完成后自取消），再有界等 writeChain 沉降，最后
    // cancel 沉降后的 current task。
    if (this.shutdownDetaching) {
      return {
        ok: false,
        ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
        error: 'shutdown_detach_in_progress',
      };
    }
    if (this.destroyInFlight) return this.destroyInFlight;
    if (this.closePrepared) {
      return {
        ok: true,
        ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
      };
    }
    const attempt = Symbol('riff-close-prepare');
    this.closeAttempt = attempt;
    this.closing = true;
    this.closeFailureTaskId = null;
    this.closeFailureError = null;
    this.closeLateTaskHandled = false;
    // 预算层级（单调覆盖，无内层 race——writeChain 本身有界）：
    //   create/follow-up fetch 10s + late cancel 4s×2 = chain 最坏 18s
    //   own cancel 4s×2 = 8s（与 late 情形互斥：closing 分支不登记 current）
    //   → destroySession 总 deadline 20s → worker close handshake 22s
    //   → daemon SIGTERM backstop 24s / SIGKILL 29s。
    // 对 writeChain 只整体 await：单独给它小窗口会在窗口边缘掐掉链内的
    // late cancel（create 于 t≈窗口末返回 → cancel 尚 pending → teardown 提前
    // resolve → process.exit 掐断取消）。
    const teardown = (async (): Promise<SessionDestroyResult> => {
      try {
        await this.writeChain;
      } catch { /* writeChain never rejects (caught internally) */ }
      if (this.closeAttempt !== attempt) {
        return {
          ok: false,
          ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
          error: 'close_aborted',
        };
      }
      if (this.closeFailureTaskId) {
        return {
          ok: false,
          taskId: this.closeFailureTaskId,
          error: this.closeFailureError ?? 'late_task_cancel_failed',
        };
      }
      // A task materialized while closing was already cancelled inside the
      // writeChain. Do not then cancel its stale parent lineage as if it were
      // still the active execution.
      if (!this.closeLateTaskHandled && this.currentTaskId && !this.taskDone) {
        const id = this.currentTaskId;
        const cancelled = await this.cancelTaskWithRetry(id, 'close');
        // abortDestroySession invalidates the exact attempt before waiting for
        // an already-issued cancellation. A late successful HTTP response must
        // not resurrect that aborted generation as a prepared close.
        if (this.closeAttempt !== attempt || !this.closing) {
          return {
            ok: false,
            ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
            error: 'close_aborted',
          };
        }
        if (cancelled) {
          logger.info(`[riff] task ${id} cancelled on close`);
        } else {
          return {
            ok: false,
            taskId: id,
            error: this.closeFailureError ?? 'task_cancel_failed',
          };
        }
      }
      if (this.closeAttempt !== attempt || !this.closing) {
        return {
          ok: false,
          ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
          error: 'close_aborted',
        };
      }
      return {
        ok: true,
        ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
      };
    })();
    this.destroyInFlight = Promise.race([
      teardown,
      new Promise<SessionDestroyResult>(resolve => setTimeout(() => resolve({
        ok: false,
        ...(this.closeFailureTaskId || this.currentTaskId
          ? { taskId: this.closeFailureTaskId ?? this.currentTaskId! }
          : {}),
        error: 'close_timeout',
      }), this.destroyDeadlineMs)),
    ]).then(async (result) => {
      // Promise.race and the teardown continuation each add a microtask
      // boundary. Revalidate the generation immediately before publishing the
      // prepared bit so a concurrent abort can never be overwritten.
      if (result.ok && (this.closeAttempt !== attempt || !this.closing)) {
        result = {
          ok: false,
          ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
          error: 'close_aborted',
        };
      }
      if (result.ok) {
        this.closePrepared = true;
      } else {
        // A failed prepare is not a terminal close. Restore admission so the
        // still-active durable owner can accept a follow-up or a close retry.
        await this.abortDestroySession();
      }
      return result;
    }).finally(() => {
      this.destroyInFlight = null;
    });
    return this.destroyInFlight;
  }

  async abortDestroySession(): Promise<void> {
    if (this.killed) return;
    if (this.abortInFlight) return this.abortInFlight;
    this.closeAttempt = null;
    this.closePrepared = false;
    const pendingCancel = this.cancelInFlight;
    this.abortInFlight = (async () => {
      // A close timeout can win Promise.race after task-cancel was already
      // issued. Reopening admission before that request settles lets a new
      // follow-up race a late successful cancellation of its parent. Keep the
      // backend fenced until the exact cancellation attempt reaches terminal.
      if (pendingCancel) {
        try { await pendingCancel; } catch { /* cancel helper returns boolean */ }
      }
      if (this.killed || this.closeAttempt !== null || this.closePrepared) return;
      this.closing = false;
      this.closeFailureTaskId = null;
      this.closeFailureError = null;
      this.closeLateTaskHandled = false;
      logger.info('[riff] explicit close aborted; write admission restored');
    })().finally(() => {
      this.abortInFlight = null;
    });
    return this.abortInFlight;
  }

  commitDestroySession(): void {
    // The daemon has durably published the closed row. Keep admission fenced
    // until the worker immediately detaches/exits.
    this.closePrepared = false;
    this.closeAttempt = null;
    this.closing = true;
  }

  async prepareShutdownDetach(): Promise<SessionShutdownDetachResult> {
    if (this.shutdownDetachInFlight) return this.shutdownDetachInFlight;
    if (this.shutdownDetachPrepared) {
      return { ok: true, taskId: this.currentTaskId };
    }
    if (this.killed) {
      return { ok: false, taskId: this.currentTaskId, error: 'backend_killed' };
    }
    if (this.closing || this.destroyInFlight || this.closePrepared) {
      return { ok: false, taskId: this.currentTaskId, error: 'explicit_close_in_progress' };
    }

    const attempt = Symbol('remote-shutdown-detach');
    this.shutdownDetachAttempt = attempt;
    this.shutdownDetaching = true;
    // Existing SSE delivery is presentation-only. Stop it now, but do not
    // cancel the remote task. Any create/follow-up already accepted before the
    // fence remains in writeChain and is allowed to materialize below.
    this.abortController?.abort();

    const drain = (async (): Promise<SessionShutdownDetachResult> => {
      try { await this.writeChain; }
      catch { /* writeChain catches its own failures */ }
      if (this.killed || this.shutdownDetachAttempt !== attempt || !this.shutdownDetaching) {
        return { ok: false, taskId: this.currentTaskId, error: 'shutdown_detach_aborted' };
      }
      if (this.closing || this.closePrepared) {
        return { ok: false, taskId: this.currentTaskId, error: 'explicit_close_in_progress' };
      }
      this.shutdownDetachPrepared = true;
      logger.info(
        `[riff] graceful shutdown detach prepared`
        + `${this.currentTaskId ? ` (task ${this.currentTaskId})` : ' (no task lineage)'}`,
      );
      return { ok: true, taskId: this.currentTaskId };
    })();
    this.shutdownDetachInFlight = drain.finally(() => {
      this.shutdownDetachInFlight = null;
    });
    return this.shutdownDetachInFlight;
  }

  async abortShutdownDetach(): Promise<SessionShutdownDetachResult> {
    if (this.killed) {
      return { ok: false, taskId: this.currentTaskId, error: 'backend_killed' };
    }
    if (this.shutdownDetachAbortInFlight) return this.shutdownDetachAbortInFlight;
    const pending = this.shutdownDetachInFlight;
    const pendingCancel = this.cancelInFlight;
    this.shutdownDetachAttempt = null;
    this.shutdownDetachPrepared = false;
    this.shutdownDetachAbortInFlight = (async (): Promise<SessionShutdownDetachResult> => {
      // Normally shutdown detach never cancels a remote task. Still wait for
      // any exact cancellation already issued by an overlapping explicit close
      // before reopening admission, otherwise its late result could invalidate
      // a newly accepted follow-up.
      await Promise.all([
        pending ? pending.catch(() => undefined) : Promise.resolve(),
        pendingCancel ? pendingCancel.catch(() => false) : Promise.resolve(),
      ]);
      if (this.killed) {
        return { ok: false, taskId: this.currentTaskId, error: 'backend_killed' };
      }
      if (this.closing || this.shutdownDetachAttempt !== null) {
        return {
          ok: false,
          taskId: this.currentTaskId,
          error: this.closing ? 'explicit_close_in_progress' : 'new_shutdown_detach_in_progress',
        };
      }
      this.shutdownDetaching = false;
      // prepare stopped SSE before the persistence ACK. If shutdown is
      // aborted, reconnect the exact current task so the still-live owner
      // resumes normal output and completion tracking.
      if (this.currentTaskId && !this.taskDone) {
        this.reconnectAttempts = 0;
        void this.streamTask(this.currentTaskId);
      }
      logger.info('[riff] graceful shutdown detach aborted; write admission restored');
      return { ok: true, taskId: this.currentTaskId };
    })().finally(() => {
      this.shutdownDetachAbortInFlight = null;
    });
    return this.shutdownDetachAbortInFlight;
  }

  commitShutdownDetach(): void {
    this.shutdownDetachPrepared = false;
    this.shutdownDetachAttempt = null;
    // Keep admission fenced until the worker exits immediately after commit.
    this.shutdownDetaching = true;
  }

  getChildPid(): number | null {
    return null;
  }

  captureCurrentScreen(): string {
    return this.outputBuffer;
  }

  captureViewport(): string {
    return this.outputBuffer;
  }

  getPaneSize(): { cols: number; rows: number } | null {
    return null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Emit a styled status line into the terminal stream. The worker renders
   * this through a headless xterm — bare `\n` (no carriage return) makes
   * lines stair-step to the right, which is the main reason the raw log view
   * was hard to read. Always emit `\r\n` and reset ANSI styling per line.
   */
  private emitLine(text: string, style: 'info' | 'warn' | 'ok' | 'err' | 'title' | 'dim' | 'plain' = 'info'): void {
    const codes: Record<string, string> = {
      info: '\x1b[36m',   // cyan — routine status
      warn: '\x1b[33m',   // yellow — degraded/attention
      ok: '\x1b[32m',     // green — completion
      err: '\x1b[31m',    // red — failure
      title: '\x1b[1m',   // bold — section separators
      dim: '\x1b[2m',     // faint — low-signal (reasoning / usage)
      plain: '',
    };
    const open = codes[style] ?? '';
    const close = open ? '\x1b[0m' : '';
    const line = `\r\n${open}${text}${close}\r\n`;
    this.outputBuffer += line;
    this.dataCb?.(line);
  }

  /** Normalize newlines for xterm rendering (bare \n → \r\n, keep existing \r\n). */
  private emitText(text: string): void {
    const normalized = text.replace(/\r?\n/g, '\r\n');
    this.outputBuffer += normalized;
    this.dataCb?.(normalized);
  }

  /**
   * Emit ONE timeline row for a route-B display projection. Unlike {@link emitLine}
   * (which brackets every call with a leading + trailing CRLF → blank lines between
   * consecutive rows, and leaves internal `\n` un-normalized → xterm stair-stepping),
   * this normalizes ALL internal newlines to CRLF and appends exactly ONE trailing
   * CRLF, with NO leading CRLF. Consecutive rows therefore sit on adjacent lines and
   * multi-line bodies render flush-left.
   */
  private emitTimelineRow(text: string, style: 'info' | 'warn' | 'ok' | 'err' | 'title' | 'dim' | 'plain' = 'info'): void {
    const codes: Record<string, string> = {
      info: '\x1b[36m', warn: '\x1b[33m', ok: '\x1b[32m',
      err: '\x1b[31m', title: '\x1b[1m', dim: '\x1b[2m', plain: '',
    };
    const open = codes[style] ?? '';
    const close = open ? '\x1b[0m' : '';
    // Color the whole (possibly multi-line) row, then normalize every newline —
    // including the internal ones — to CRLF, and terminate with exactly one CRLF.
    const body = `${open}${text}${close}`.replace(/\r?\n/g, '\r\n');
    const line = `${body}\r\n`;
    this.outputBuffer += line;
    this.dataCb?.(line);
  }

  /**
   * Render a riff route-B `display` projection (a codex app-server event distilled
   * to {kind,title,text,command,exitCode,status}) as one human-readable timeline
   * row: `[思路] …` / `[命令] <cmd> (exit N)` / `[回答] …`. The Chinese label comes
   * from riff's already-localized `title` when present (i18n follows riff); we only
   * fall back to a kind→label table when it is absent. Colour follows the kind
   * (failed command / error → red, completed command → green, reasoning/usage dim).
   */
  private emitDisplay(display: RiffLogDisplay): void {
    const kind = display.kind;
    // Kind → default label. `title` (localized by riff) wins when present.
    const LABEL: Record<string, string> = {
      message: '回答',
      reasoning: '思路',
      command: '命令',
      tool: '工具',
      system: '系统',
      usage: '用量',
      error: '错误',
      stage: '阶段',
      trace: '追踪',
      stdout: '',
      stderr: '',
    };
    const label = display.title || LABEL[kind] || kind;
    // For a codex `command` projection riff sets {command,status,exitCode,
    // summary:'命令执行完成'} PLUS `text` = the captured command output (stdout/
    // stderr, already truncated to 32KB by riff's collapseCommandOutputIntoPrimary).
    // `summary` is a status blurb we never render; `text` is the real output we DO
    // render beneath the header. For non-command kinds `text` is the content itself.
    const body = (display.text ?? '').trimEnd();

    if (kind === 'command') {
      const cmd = display.command || '已执行命令';
      const completed = display.status === 'completed' || display.exitCode === 0;
      const failed = display.status === 'failed' || (display.exitCode != null && display.exitCode !== 0);
      const exit = display.exitCode != null ? ` (exit ${display.exitCode})` : '';
      // Green ONLY for a confirmed-completed/exit-0 command; red for failure;
      // neutral (info) for a still-running command (no exit code yet).
      const style = failed ? 'err' : completed ? 'ok' : 'info';
      this.emitTimelineRow(`[${label}] ${cmd}${exit}`, style);
      // Render the captured command output (riff folds it into `text`) beneath the
      // header, verbatim/uncolored. `summary` ('命令执行完成') is NOT this — it never
      // reaches `body` (we read `text` only), so no fake output line.
      if (body) this.emitTimelineRow(body, 'plain');
      return;
    }
    switch (kind) {
      case 'reasoning':
      case 'usage':
        this.emitTimelineRow(`[${label}] ${body}`, 'dim');
        return;
      case 'error':
        this.emitTimelineRow(`[${label}] ${body}`, 'err');
        return;
      case 'stderr':
        this.emitTimelineRow(body, 'warn');
        return;
      case 'stdout':
        // Plain shell output projected as-is (no label prefix).
        if (body) this.emitTimelineRow(body, 'plain');
        return;
      case 'message':
        this.emitTimelineRow(`[${label}] ${body}`, 'title');
        return;
      case 'tool':
      case 'system':
      case 'stage':
      case 'trace':
      default:
        this.emitTimelineRow(`[${label}] ${body}`, 'info');
        return;
    }
  }


  private extractAttachments(content: string): { text: string; attachments: RiffAttachment[] } {
    const attachments: RiffAttachment[] = [];
    const attachRegex = /<attachments[^>]*>([\s\S]*?)<\/attachments>/g;
    let match: RegExpExecArray | null;
    let text = content;

    while ((match = attachRegex.exec(content)) !== null) {
      const block = match[1]!;
      const imgRegex = /<image\s+[^>]*path="([^"]+)"[^>]*\/>/g;
      const fileRegex = /<file\s+[^>]*path="([^"]+)"(?:\s+name="([^"]*)")?[^>]*\/>/g;
      let m: RegExpExecArray | null;
      while ((m = imgRegex.exec(block)) !== null) {
        attachments.push({ path: m[1]!, name: this.basename(m[1]!), type: 'image' });
      }
      while ((m = fileRegex.exec(block)) !== null) {
        attachments.push({ path: m[1]!, name: m[2] ?? this.basename(m[1]!), type: 'file' });
      }
      text = text.replace(match[0]!, '').trim();
    }

    return { text, attachments };
  }

  private basename(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] ?? p;
  }

  private async createTask(prompt: string, attachments: RiffAttachment[]): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-execute`;

    // riff task-execute body: origin at top level, prompt inside config.userPrompt
    // agent 写死 codex：riff 服务端已下线其它 runner（aiden 等一律 400
    // UNSUPPORTED_TASK_AGENT），配置项不再暴露。
    const config: Record<string, unknown> = {
      userPrompt: this.injectSystemPrompt(prompt),
      agent: 'codex',
    };
    if (this.config.model) config.model = this.config.model;
    if (RIFF_REASONING_EFFORTS.includes(this.config.reasoningEffort as typeof RIFF_REASONING_EFFORTS[number])) {
      config.reasoningEffort = this.config.reasoningEffort;
    }
    // Repos: explicit config.repos (e.g. derived from the session's local
    // workingDir by the worker) wins over defaultRepo/defaultBranch. The API's
    // native shape is { repoName, repoBranch } — it silently ignores unknown
    // fields, so anything else never pins the branch.
    const repos = this.buildRepos();
    if (repos.length > 0) {
      config.repos = repos;
      if (this.config.injectStatusLines !== false) {
        const desc = repos.map(r => r.repoBranch ? `${r.repoName}@${r.repoBranch}` : `${r.repoName}(默认分支)`).join(', ');
        this.emitLine(`[riff] 仓库: ${desc}`);
        for (const w of this.config.repoWarnings ?? []) this.emitLine(`[riff] ⚠️ ${w}`, 'warn');
      }
    }
    // Inject env into the riff sandbox so the agent can use `botmux send` etc.
    // Merged from: per-bot env (bots.json `env`) + botmux session context vars +
    // any explicit config.env (which takes precedence).
    const env = this.buildEnv();
    if (Object.keys(env).length > 0) config.env = env;
    // Always send setupCommands to the riff API: mandatory botmux install first
    // (MANDATORY_SETUP_COMMANDS, not user-editable), then any user-configured
    // additional commands. botmux is installed via the API's native
    // setupCommands support — NOT via prompt injection — so it is reliable.
    const setup = [...MANDATORY_SETUP_COMMANDS, ...(this.config.setupCommands ?? [])];
    config.setupCommands = setup;

    const payload: Record<string, unknown> = {
      origin: 'botmux',
      threadId: this.sessionId,
      config,
      // task-execute exposes sandboxCluster as a top-level request field. Keep
      // it separate from config so botmux follows the public Riff API shape.
      sandboxCluster: this.config.sandboxCluster ?? 'boe',
      useRunner: true,
    };
    if (this.config.templateId) payload.templateId = this.config.templateId;

    try {
      const taskId = await this.uploadAndCreate(url, payload, attachments, this.createTimeoutMs);
      if (!(await this.adoptLateTask(taskId))) return;
      this.markActivity();
      this.reconnectAttempts = 0; // per-task budget (see streamTask)
      this.streamTask(taskId);
    } catch (err) {
      this.emitError(`创建 riff 任务失败: ${err}`);
    }
  }

  /** Record a "task activity" tick — drives the follow-up cold/hot decision.
   *  Called on every SSE event and on each successful create/adopt so a long
   *  idle gap (sandbox likely reclaimed) or a fresh process is detectable. */
  private markActivity(): void {
    this.lastTaskActivityMs = Date.now();
  }

  /** Pick the follow-up fetch budget. Cold (larger budget) when the riff sandbox
   *  has likely gone cold and this follow-up must synchronously wake it:
   *    • this process has seen NO task activity yet — the daemon-restart resume
   *      case (currentTaskId came from resumeParentTaskId, sandbox long idle);
   *      this is exactly the logged 10.01s timeout.
   *    • the last activity was longer ago than coldFollowUpThresholdMs.
   *  Hot budget otherwise (a follow-up right after the previous turn). */
  private followUpTimeoutMs(): number {
    const last = this.lastTaskActivityMs;
    const cold = last === null || (Date.now() - last) >= this.coldFollowUpThresholdMs;
    return cold ? this.followUpColdTimeoutMs : this.followUpHotTimeoutMs;
  }

  private async followUp(prompt: string, attachments: RiffAttachment[]): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-follow-up`;

    // Capture the parent BEFORE the request: reconcile-on-timeout below needs the
    // exact parent this follow-up hung off, independent of any later mutation.
    const parentTaskId = this.currentTaskId;

    // riff task-follow-up body: parentTaskId + origin + prompt at top level
    const payload: Record<string, unknown> = {
      origin: 'botmux',
      parentTaskId,
      prompt: this.injectSystemPrompt(prompt),
    };

    // Send-time floor for reconcile-on-timeout: only a task created at/after this
    // instant can be THIS follow-up's child (see reconcileAfterFollowUpTimeout).
    // Read before the request so a slow pre-flight cannot push it past the child's
    // own createdAt.
    const sentAtMs = Date.now();

    try {
      const taskId = await this.uploadAndCreate(url, payload, attachments, this.followUpTimeoutMs());
      if (!(await this.adoptLateTask(taskId))) return;
      this.markActivity();
      this.reconnectAttempts = 0; // per-task budget (see streamTask)
      this.streamTask(taskId);
    } catch (err) {
      // A client-side fetch timeout does NOT mean the server did nothing. riff
      // task-follow-up is "accept → return taskId", but returns only AFTER a
      // synchronous pre-flight (auth refresh + sandbox-status read + lark/meego/
      // agentBuddy checks, plus archive/snapshot/IDE-proxy probes when the sandbox
      // is cold). That pre-flight can outlast our fetch budget while the child task
      // is ALREADY being created server-side. Clearing the lineage here (old
      // behavior) would cold-boot a fresh context-less task on the next message AND
      // strand that in-flight child. Instead: reconcile against the thread — if the
      // child already exists, adopt it (no lost context, no duplicate); only a true
      // broken lineage resets to a fresh task.
      if (this.isTimeoutError(err) && parentTaskId) {
        if (await this.reconcileAfterFollowUpTimeout(parentTaskId, sentAtMs)) return;
        // Reconcile found no child. Deliberately NO auto-resend: riff has no
        // request-dedup (no X-Idempotency-Key / clientRequestId server-side), and
        // its follow-up redirects the parent to the thread's latest node — so a
        // blind resend can genuinely build a SECOND task for one user message.
        // Keep the lineage instead: the parent is still valid, so the next message
        // continues the conversation rather than cold-booting a fresh sandbox.
        // THIS turn's prompt is dropped; say so plainly so the user can resend.
        this.emitError(`riff follow-up 超时，本次未送达（血缘保留，请重发本条消息）: ${err}`);
        return;
      }
      // Broken lineage (parent expired/GC'd etc.) — fall back to a fresh task
      // on the next message instead of failing every follow-up forever. Also
      // clear the DAEMON-side persisted lineage: without the null broadcast a
      // daemon restart would resurrect the parent we just declared broken.
      this.currentTaskId = null;
      this.taskIdCb?.(null);
      this.emitError(`riff follow-up 失败: ${err}（下一条消息将新建任务）`);
    }
  }

  /** Node's AbortSignal.timeout() rejects with a DOMException/Error named
   *  "TimeoutError" ("The operation was aborted due to timeout"). Match by name
   *  (message wording is locale/runtime-dependent). AbortError (manual abort) is
   *  deliberately NOT treated as a timeout — that is teardown, handled elsewhere. */
  private isTimeoutError(err: unknown): boolean {
    return err instanceof Error && err.name === 'TimeoutError';
  }

  /**
   * After a follow-up fetch times out, ask the thread whether the child task was
   * in fact created (the pre-flight simply outran our budget). botmux sends its
   * own sessionId as the riff threadId (task-execute threadId: this.sessionId),
   * and riff stores it verbatim (no rewrite/mapping) — so we query by sessionId
   * directly, no task-detail hop needed.
   *
   * IDENTITY INVARIANT (locked by design with the riff side): riff's
   * `GET /api/tasks` is owner-scoped. This reconcile MUST reuse the CURRENT
   * backend instance's getJwt() — the same identity that created the task — or it
   * would query as a different owner and get an empty list. Never introduce a
   * different credential here.
   *
   * Returns true iff this follow-up's child task was found and adopted (streaming
   * resumed / terminal result fetched). False means "no child yet" → caller keeps
   * the lineage without adopting.
   *
   * MATCHING ANCHOR — `followUpParentTaskId` PLUS a send-time floor:
   *   riff has no per-request id we could echo back (no clientRequestId in the
   *   task document, no X-Idempotency-Key handling), so the parent link is the
   *   only server-side signal tying a task to this follow-up.
   *   It is not unique on its own: riff redirects a follow-up's parent to the
   *   thread's LATEST node (api/lambda/task-follow-up.ts — "普通追问必须从 thread
   *   最新节点发起"), so several siblings can share one parent — including a task
   *   stranded by an EARLIER timed-out turn. Adopting that one would replay a
   *   previous turn's output and silently drop this turn's prompt.
   *   Hence `sentAtMs`: only a child created at/after the moment we issued THIS
   *   follow-up can be its child. `createdAt` is in riff's
   *   TASK_THREAD_SUMMARY_PROJECTION, so the summary view really carries it.
   *   A node with an absent/unparsable createdAt is NOT adopted — fail closed,
   *   because a wrong adopt is worse than a missed one (the caller keeps the
   *   lineage and the user just resends).
   *   Ties are broken by the OLDEST qualifying child: the first task created
   *   after we sent is the one our request produced.
   */
  private async reconcileAfterFollowUpTimeout(parentTaskId: string, sentAtMs: number): Promise<boolean> {
    for (let attempt = 1; attempt <= this.reconcileMaxAttempts; attempt++) {
      if (this.killed || this.closing || this.shutdownDetaching) return false;
      let nodes: RiffThreadNode[];
      try {
        nodes = await this.fetchThreadNodes(this.sessionId);
      } catch (err) {
        logger.warn(`[riff] reconcile thread query failed (attempt ${attempt}): ${err}`);
        nodes = [];
      }
      // Diagnostic: what did the thread query return, and what are we matching on?
      // ids/times only — surfaces missing (timing/scope) vs present-but-unmatched.
      // Print the EFFECTIVE floor (offset + tolerance applied), not the raw send
      // instant: a log that names a different threshold than the code applies
      // would send whoever debugs this down the wrong path.
      logger.info(`[riff] reconcile attempt ${attempt}: match by parent=${parentTaskId.slice(0, 8)} createdAt>=${new Date(this.reconcileFloorMs(sentAtMs)).toISOString()} (sent=${new Date(sentAtMs).toISOString()}, serverOffset=${this.serverClockOffsetMs ?? 'unmeasured'}), thread has ${nodes.length} node(s): ${nodes.map(n => `${n.id?.slice(0, 8)}(par=${n.followUpParentTaskId?.slice(0, 8) ?? 'none'},created=${n.createdAt ?? 'none'},${n.status})`).join(' ')}`);
      const child = this.pickReconciledChild(nodes, parentTaskId, sentAtMs);
      if (child) {
        const childId = child.id;
        // Re-check we can still adopt (a concurrent close/kill may have landed).
        if (!(await this.adoptLateTask(childId))) return true;
        this.markActivity();
        this.reconnectAttempts = 0;
        this.emitLine(`[riff] follow-up 超时，但服务端已建任务，自动续接（未丢上下文）`, 'warn');
        if (this.isTerminalStatus(child.status)) {
          // Already finished while we were blind — fire the turn boundary + fetch
          // its final report instead of streaming a stream that will never speak.
          this.completeTask(childId, child.status, undefined);
        } else {
          this.streamTask(childId);
        }
        return true;
      }
      if (attempt < this.reconcileMaxAttempts) {
        await new Promise((r) => setTimeout(r, this.reconcileRetryDelayMs));
      }
    }
    return false;
  }

  /** The effective reconcile floor in riff's time frame: our send instant,
   *  translated by the measured server clock offset, minus the tolerance.
   *  `createdAt` is stamped by riff's clock (TaskService: `new Date()`), while
   *  sentAtMs is ours — two different machines. The tolerance IS the mis-adopt
   *  window (a leftover task created within it, just before we sent, still
   *  passes), so it is kept tight once the offset is known and only stays wide
   *  while it is unknown.
   *  CAVEAT: an intermediary (proxy/gateway) may rewrite `Date`, in which case
   *  the measured offset is that hop's clock, not riff's — harmless while the two
   *  agree to within the tolerance. A server-side NTP jump between stamping
   *  `createdAt` and sending the response is absorbed the same way.
   *  Single-sourced so the diagnostic log can never name a different threshold
   *  than the filter actually applies. */
  private reconcileFloorMs(sentAtMs: number): number {
    const measured = this.serverClockOffsetMs;
    const tolerance = measured === null ? this.reconcileBlindClockSkewMs : this.reconcileClockSkewMs;
    return sentAtMs + (measured ?? 0) - tolerance;
  }

  /** The thread node this follow-up created, or undefined. Requires BOTH the
   *  parent link AND creation at/after the effective floor (see
   *  reconcileFloorMs + the anchor notes on reconcileAfterFollowUpTimeout — the
   *  parent alone can match a task stranded by an earlier timed-out turn).
   *  Unparsable/absent createdAt → not a candidate. Oldest qualifying node wins. */
  private pickReconciledChild(
    nodes: RiffThreadNode[],
    parentTaskId: string,
    sentAtMs: number,
  ): RiffThreadNode | undefined {
    const floorMs = this.reconcileFloorMs(sentAtMs);
    let best: RiffThreadNode | undefined;
    let bestMs = Number.POSITIVE_INFINITY;
    for (const n of nodes) {
      if (!n.id || n.followUpParentTaskId !== parentTaskId) continue;
      const createdMs = n.createdAt ? Date.parse(n.createdAt) : NaN;
      if (!Number.isFinite(createdMs) || createdMs < floorMs) continue;
      if (createdMs < bestMs) {
        best = n;
        bestMs = createdMs;
      }
    }
    return best;
  }

  /** riff terminal task statuses — whitelist so future intermediate states are
   *  never mis-classified as "done" (they default to "still running"). Mirrors
   *  TERMINAL_RIFF_STATUSES. */
  private isTerminalStatus(status: string | undefined): boolean {
    return status != null && TERMINAL_RIFF_STATUSES.has(status);
  }

  /** GET /api/tasks?threadId=&view=summary → { success, data: RiffThreadNode[] }.
   *  Owner-scoped (see reconcileAfterFollowUpTimeout). view=summary is the
   *  lightweight projection (no logs/results) suited to this hot-path probe. */
  private async fetchThreadNodes(threadId: string): Promise<RiffThreadNode[]> {
    const url = `${this.config.baseUrl}/api/tasks?threadId=${encodeURIComponent(threadId)}&view=summary`;
    const headers: Record<string, string> = {};
    const jwt = await this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;
    this.applyExtraHeaders(headers);
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(this.reconcileTimeoutMs) });
    if (!resp.ok) throw new Error(`tasks query HTTP ${resp.status}`);
    // Measure the server↔client clock offset off this very response, so the
    // reconcile floor compares like with like (see observeServerClock).
    this.observeServerClock(resp.headers.get('date'));
    const result = (await resp.json()) as { success?: boolean; data?: RiffThreadNode[] };
    // Envelope is { success, data: [...] } — data is the array directly (NOT
    // data.tasks). Empty/no-permission → [].
    return Array.isArray(result.data) ? result.data : [];
  }

  /** Record how far riff's clock sits from ours, read from an HTTP `Date`
   *  response header (RFC 9110 requires it, and it is generated by the same
   *  machine that stamps `createdAt`). Lets the reconcile floor correct for a
   *  real measured offset instead of assuming the two clocks agree.
   *  Whole-second resolution, and the value is one round-trip old, so callers
   *  still add a small tolerance on top. Unparsable/missing header → leave the
   *  previous observation (or none) in place. */
  private observeServerClock(dateHeader: string | null): void {
    if (!dateHeader) return;
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) return;
    this.serverClockOffsetMs = serverMs - Date.now();
  }

  /**
   * Prepend the configured system prompt to the user prompt.
   * The riff API has no separate system-prompt field (only userPrompt), so we
   * fold the system prompt into the prompt text. config.systemPrompt takes
   * precedence over the built-in DEFAULT_RIFF_SYSTEM_PROMPT. The result is
   * wrapped in a <system> block so the agent can distinguish it from the user
   * message. NOTE: setup commands (botmux install) are NOT injected here —
   * they are sent to the riff API via config.setupCommands for reliability.
   */
  private injectSystemPrompt(prompt: string): string {
    // 自定义 systemPrompt 是「追加」而非「替换」：mandatory 路由规则（身份锁定 /
    // STEP 0 安装 / @ 硬门禁 mention-back / 完成契约）无论如何都在——否则用户
    // 一填自定义提示词就悄悄丢掉回投能力。
    const custom = this.config.systemPrompt?.trim();
    const sys = custom
      ? `${DEFAULT_RIFF_SYSTEM_PROMPT}\n\n<additional_instructions>\n${custom}\n</additional_instructions>`
      : DEFAULT_RIFF_SYSTEM_PROMPT;
    return `<system>\n${sys}\n</system>\n\n${prompt}`;
  }

  /**
   * Build the env object for the riff sandbox. Precedence (highest wins):
   *   1. config.env (explicit per-bot riff config)
   *   2. per-bot env from bots.json `env` (merged by the worker into config.env)
   * Returns a clean Record with empty values dropped.
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (v != null && v !== '') env[k] = String(v);
      }
    }
    return env;
  }

  private async uploadAndCreate(
    url: string,
    payload: Record<string, unknown>,
    attachments: RiffAttachment[],
    timeoutMs: number,
  ): Promise<string> {
    // Assemble the request body FIRST (attachment reads can be slow on large
    // files / slow disks), THEN resolve the JWT immediately before fetch. The
    // keychain selector skips tokens expiring within a safety window, but that
    // guarantee only holds if we read the token close to the request — reading
    // it before a multi-second upload prep could hand off a token that expires
    // mid-flight. createTimeout only bounds the fetch, not the prep before it.
    const headers: Record<string, string> = {};
    let body: BodyInit;
    if (attachments.length > 0) {
      const form = new FormData();
      form.append('payload', JSON.stringify(payload));
      for (const att of attachments) {
        try {
          const fileData = await this.readFileAsBlob(att.path);
          form.append('attachments', fileData, att.name);
        } catch (err) {
          logger.warn(`[riff] failed to read attachment ${att.path}: ${err}`);
        }
      }
      body = form;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }

    // Resolve JWT last — right before the request — so the safety-window
    // freshness check reflects the token that actually goes on the wire. `body`
    // (string or FormData) is re-extractable per fetch, so the retry below can
    // reuse it.
    this.applyExtraHeaders(headers);
    // Observability: record the outbound target + which routing headers were
    // attached (names only — never the JWT value). Makes "did this request carry
    // the PPE/lane headers?" answerable from logs instead of guesswork.
    const routingHeaderKeys = Object.keys(headers).filter(k => k.toLowerCase() !== 'x-jwt-token' && k.toLowerCase() !== 'content-type');
    logger.info(`[riff] → POST ${url} headers=[${routingHeaderKeys.join(',') || 'none'}]`);
    // The routing headers live in `headers`, which `post` spreads — so the
    // 401/403 retry below carries them too (a retry that dropped them would land
    // in the wrong environment). The timeout is the caller's per-endpoint budget
    // (create vs follow-up cold/hot), not a fixed constant.
    const post = (jwt: string | null): Promise<Response> => {
      const h = { ...headers };
      if (jwt) h['x-jwt-token'] = jwt;
      return fetch(url, { method: 'POST', headers: h, body, signal: AbortSignal.timeout(timeoutMs) });
    };

    const firstJwt = await this.getJwt();
    let resp = await post(firstJwt);

    // One retry on an auth rejection. A 401/403 is authoritative proof the token
    // was bad (expired mid-flight / stale at startup), so it justifies forcing a
    // JWT refresh that bypasses the debounce window. We retry ONLY when the
    // refresh produced a genuinely different token — otherwise the second POST
    // would just replay the same rejected credential (this also naturally
    // no-ops inside a full AIME runtime, where the host refresh is skipped).
    // Other statuses (400/5xx) are not auth problems and are not retried.
    if (resp.status === 401 || resp.status === 403) {
      const freshJwt = await this.getJwt({ forceRefresh: true });
      if (freshJwt && freshJwt !== firstJwt) {
        logger.warn(`[riff] task create/follow-up got HTTP ${resp.status}; retrying once with a refreshed JWT`);
        resp = await post(freshJwt);
      }
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const result = (await resp.json()) as RiffTaskResponse;
    if (!result.success || !result.data?.id) {
      throw new Error(`riff API returned error: ${JSON.stringify(result)}`);
    }

    // New task → new sandbox URLs may flow in; allow them to replace the old ones.
    this.accessUrlIsDirect = false;
    this.updateAccessUrl(result.data);

    // If queued, inject a status line
    if (result.data.status === 'queued' && result.data.queuePosition != null) {
      this.emitLine(`[riff] 任务排队中，位置: ${result.data.queuePosition}`, 'warn');
    }

    return result.data.id;
  }

  private async readFileAsBlob(path: string): Promise<Blob> {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    return new Blob([buf]);
  }

  /**
   * Post-await adoption gate for a freshly created/followed-up task id.
   * - closing（/close 竞态窗口）：这个 late task 已经没有会话可服务——立即取消
   *   （有界+一次重试），绝不 stream/登记，防远端 orphan；
   * - killed / shutdownDetaching（detach）：登记 id 让 daemon 持久化血缘，
   *   但不 stream（任务合法续跑，重启后 follow-up 接上）；
   * - 正常：登记 + 由调用方启动 stream。
   */
  private async adoptLateTask(taskId: string): Promise<boolean> {
    if (this.closing) {
      // 在 writeChain 内 await——destroySession 等 writeChain 沉降时就能把这次
      // 取消一起等到（void 触发会在 worker exit 时被掐断）。
      logger.info(`[riff] task ${taskId} created during close — cancelling late task`);
      this.closeLateTaskHandled = true;
      // Preserve the exact newest lineage even when cancellation succeeds.
      // If the daemon cannot durably commit the close and sends abort, the
      // next follow-up must continue from this child rather than its stale
      // parent. Publishing before the cancel also makes a failed cancel
      // retryable by the daemon.
      this.currentTaskId = taskId;
      this.taskIdCb?.(taskId);
      const cancelled = await this.cancelTaskWithRetry(taskId, 'late-task close');
      if (!cancelled) this.taskDone = false;
      return false;
    }
    this.currentTaskId = taskId;
    this.taskIdCb?.(taskId);
    if (this.killed || this.shutdownDetaching) return false;
    return true;
  }

  /** Repos come exclusively from config.repos (worker-derived from the session
   *  workingDir). The old defaultRepo/defaultBranch bot config was removed —
   *  a stale bots.json value would silently shadow the workingDir derivation
   *  with no UI left to clear it. */
  private buildRepos(): RiffRepoRef[] {
    return this.config.repos && this.config.repos.length > 0 ? this.config.repos : [];
  }

  private async cancelTask(taskId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-cancel`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const jwt = await this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;
    this.applyExtraHeaders(headers);
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      // The API expects { id } — { taskId } is silently rejected ("id Required").
      body: JSON.stringify({ id: taskId }),
      signal: AbortSignal.timeout(this.cancelTimeoutMs),
    });
    if (!resp.ok) throw new Error(`task-cancel HTTP ${resp.status}`);
  }

  private async cancelTaskWithRetry(taskId: string, context: string): Promise<boolean> {
    const operation = (async (): Promise<boolean> => {
      try {
        await this.cancelTask(taskId);
        return true;
      } catch {
        try {
          await this.cancelTask(taskId);
          logger.info(`[riff] task ${taskId} cancelled on ${context} (retry)`);
          return true;
        } catch (err) {
          this.closeFailureTaskId = taskId;
          this.closeFailureError = err instanceof Error ? err.message : String(err);
          logger.warn(`[riff] ${context} cancel failed (task ${taskId} may keep running remotely): ${err}`);
          return false;
        }
      }
    })();
    this.cancelInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.cancelInFlight === operation) this.cancelInFlight = null;
    }
  }

  private async streamTask(taskId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api2/task-stream?id=${encodeURIComponent(taskId)}`;
    const headers: Record<string, string> = {};
    const jwt = await this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;
    this.applyExtraHeaders(headers);

    this.abortController = new AbortController();
    // Per-connection lifetime clock (see field doc): null until this connection
    // is confirmed established below. Reset PER streamTask invocation so a fetch
    // that never connects can't inherit the previous connection's start time.
    this.connectionStartedAtMs = null;

    try {
      const resp = await fetch(url, { headers, signal: this.abortController.signal });
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE HTTP ${resp.status}`);
      }
      // Connection established — start its lifetime clock. On break, catch
      // compares elapsed against reconnectHealthyConnMs to decide whether this
      // was a healthy ~183s-capped connection (refund budget) or a short-lived
      // dead/hot-loop break (do not refund).
      this.connectionStartedAtMs = Date.now();

      // NOTE: reconnectAttempts is reset per TASK (createTask/followUp) AND
      // whenever a broken connection had LIVED ≥ reconnectHealthyConnMs (see the
      // catch) — NOT unconditionally on every 200, which would let a "connect OK
      // → instant EOF" loop retry forever (the hole the per-task-only reset
      // originally guarded, which a naive "reset on connect/init" reopens).
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 允许 CRLF 行结束（常见于代理）——先归一化，否则 \r\n\r\n 永远
        // 切不出事件块，整条流会在 EOF 后被误判成「无 done」。跨 chunk 撕裂的
        // \r\n 也安全：残留的尾部 \r 会留在 buffer 里等下一个 chunk 拼上。
        buffer = buffer.replace(/\r\n/g, '\n');

        // Standard SSE: events separated by blank line (\n\n)
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          this.handleSseEvent(eventBlock, taskId);
        }
      }
      // EOF 尾部：最后一个事件块后面可能没有空行分隔（decoder 也可能还压着
      // 末尾字节）——冲洗并把完整的残块按事件处理，否则收尾的 done 会被丢掉。
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.trim()) this.handleSseEvent(buffer, taskId);

      // Clean EOF without a done event: a proxy/link can close the stream
      // gracefully while the task is still running. Silently returning here
      // would leave the session busy FOREVER (nothing else fires onTaskDone),
      // so route it through the same reconnect/exhausted path as a hard break.
      if (!this.killed && taskId === this.currentTaskId && !this.completedTaskIds.has(taskId)) {
        throw new Error('SSE stream ended without done event');
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // Stale stream: a follow-up already replaced this task (or its done was
      // processed) — its stream dying is expected; never reconnect or surface
      // an error for it, that belongs to the current task's stream only.
      if (taskId !== this.currentTaskId || this.completedTaskIds.has(taskId)) return;
      logger.warn(`[riff] SSE stream error: ${err}`);

      // Core fix: an upstream proxy caps each task-stream connection at a fixed
      // ~183s lifetime and closes it with a clean EOF (no done event) — verified
      // against live data: tasks that "重连失败" had actually COMPLETED server-
      // side; botmux gave up ~22s early on one, 16min early on another. A healthy
      // long runner task thus breaks every ~183s. If this just-broken connection
      // had LIVED long enough (≥ reconnectHealthyConnMs), it was such a healthy
      // capped connection — refund the reconnect budget so those periodic caps
      // never accumulate into a false failure, letting the task stream until it
      // truly finishes. A short-lived break (dead endpoint that never connected,
      // or a connect→instant-EOF hot loop against a stale-running orphan) does
      // NOT refund, so it still exhausts the budget and bails (no infinite
      // retry). Keyed on connection LIFETIME — not on connect/init receipt,
      // which would refund every attempt and reopen the infinite-retry hole.
      const connLivedMs = this.connectionStartedAtMs !== null ? Date.now() - this.connectionStartedAtMs : 0;
      if (connLivedMs >= this.reconnectHealthyConnMs) this.reconnectAttempts = 0;

      // Attempt reconnect if task is still running
      if (!this.killed && !this.taskDone && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        // Exponential backoff with a cap: 1s,2s,4s,8s,16s,30s(cap). Linear 1s/2s/3s
        // was negligible against a ~180s connection lifetime anyway; the cap keeps
        // a truly-unreachable gateway from stalling teardown for minutes.
        const delay = Math.min(this.reconnectMaxDelayMs, this.reconnectBaseDelayMs * 2 ** (this.reconnectAttempts - 1));
        logger.info(`[riff] SSE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        this.emitLine(`[riff] 连接中断，正在重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'warn');
        await new Promise((r) => setTimeout(r, delay));
        // Re-check after the delay: a follow-up may have replaced the task
        // while we slept — reconnecting the stale stream would resurrect it.
        if (this.killed || taskId !== this.currentTaskId || this.completedTaskIds.has(taskId)) return;
        this.streamTask(taskId);
      } else if (!this.killed && !this.taskDone) {
        this.emitError(`SSE 连接中断，重连失败`);
      }
    }
  }

  /**
   * Fire a task's completion exactly once — the turn boundary + final-output
   * fetch. Called from BOTH the `done` SSE event AND an `init` replay carrying a
   * terminal status (the task finished while a prior connection was dead and its
   * `done` was lost with the closed stream). Idempotency & staleness — per TASK,
   * not per backend: streams can deliver done more than once (observed ~500ms
   * apart live), and by the time a duplicate (or a reconnect's init replay)
   * arrives, a queued follow-up may already be running as the NEXT task (write()
   * reset the global taskDone). A plain boolean guard would re-fire the boundary
   * mid-way through that next task and falsely mark it done, so gate on:
   *   1) the completion must belong to the CURRENT task (stale streams no-op)
   *   2) each task fires the boundary at most once (completedTaskIds)
   */
  private completeTask(taskId: string, status: string | undefined, exitCode: number | undefined): void {
    if (taskId !== this.currentTaskId) return;
    if (this.completedTaskIds.has(taskId)) return;
    this.completedTaskIds.add(taskId);
    // Bounded FIFO eviction — never a blanket clear(), which would drop the id
    // just added and let its ~500ms duplicate done re-fire.
    while (this.completedTaskIds.size > 64) {
      const oldest = this.completedTaskIds.values().next().value!;
      if (oldest === taskId) break;
      this.completedTaskIds.delete(oldest);
    }
    this.taskDone = true;
    if (this.config.injectStatusLines !== false) {
      this.emitLine(`[riff] 任务完成${status ? ` (${status}${exitCode != null ? `, exit=${exitCode}` : ''})` : ''}`, status === 'failed' ? 'warn' : 'ok');
    }
    // Fetch final output from task-detail API (SSE has no output events for
    // runner tasks) BEFORE firing the turn boundary: the boundary flushes queued
    // follow-ups → currentTaskId flips to the next task → the stale guard would
    // (correctly) drop THIS task's only report.
    if (status === 'completed' || status === 'failed') {
      void this.fetchAndEmitOutput(taskId)
        .catch(() => { /* logged inside */ })
        .finally(() => { this.taskDoneCb?.(); });
    } else {
      this.taskDoneCb?.();
    }
  }

  private handleSseEvent(block: string, taskId: string): void {
    // Task isolation: once a newer task is current, EVERY event from an older
    // task's stream (output/log/init/session_info/done alike) is inert — a
    // stale stream must never write into the new task's log or replace its
    // sandbox URL.
    if (taskId !== this.currentTaskId) return;
    // Any event from the current task's live stream is proof the sandbox is warm
    // and talking — refresh the cold/hot clock so a follow-up right after gets the
    // hot budget.
    this.markActivity();
    // Standard SSE parsing: event type from `event:` line, data from `data:` lines
    // Also handle SSE comments (lines starting with `:`) — ignore them (heartbeats)
    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // SSE comment / heartbeat
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) return;

    try {
      const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;

      switch (eventType) {
        case 'output': {
          const chunk = data['chunk'] as string | undefined;
          if (chunk) this.emitText(chunk);
          break;
        }
        case 'status': {
          if (this.config.injectStatusLines !== false) {
            const status = data['status'] as string | undefined;
            if (status) this.emitLine(`[riff] 状态: ${status}`);
          }
          break;
        }
        case 'init':
        case 'session_info': {
          // accessUrl lives in init / session_info events, not in done
          const changed = this.updateAccessUrl({
            accessUrl: data['accessUrl'] as string | undefined,
            directAccessUrl: data['directAccessUrl'] as string | undefined,
          });
          if (changed && this.currentAccessUrl && this.config.injectStatusLines !== false) {
            // 群成员可经「显示输出/导出文字」看到状态行，而 AIO 链接的可写能力
            // 编码在唯一子域里（port-8080-<sandbox-id>.…）——host 也不能露，
            // 状态行只报就绪，链接一律走 canOperate 门控的「获取操作链接」私发。
            this.emitLine('[riff] Sandbox 已就绪（链接经「获取操作链接」按钮获取）');
          }
          // SSE events usually carry only accessUrl (riff frontend page — its
          // domain may not match the configured baseUrl environment). The
          // directly-openable AIO sandbox terminal lives in task-detail's
          // directAccessUrl — try to upgrade once the first URL arrives.
          if (changed && !this.accessUrlIsDirect) {
            void this.fetchDirectAccessUrl(taskId);
          }
          // init REPLAYS the full accumulated task state, including a terminal
          // `status` when the task finished while our previous connection was
          // dead (the ~183s cap closes mid-flight and the `done` event is lost
          // with it). Consume that replay: a terminal status here IS the missed
          // completion — route it through the same completion path so the turn
          // ends cleanly instead of the budget eventually exhausting into a
          // false "重连失败". Non-terminal (running/pending/…) just means the
          // reconnect resumed a still-live task — no completion, keep streaming.
          if (eventType === 'init') {
            const initStatus = data['status'] as string | undefined;
            if (initStatus && TERMINAL_RIFF_STATUSES.has(initStatus)) {
              const exitCode = data['exitCode'] as number | undefined;
              this.completeTask(taskId, initStatus, exitCode);
            }
          }
          break;
        }
        case 'done': {
          const status = data['status'] as string | undefined;
          const exitCode = data['exitCode'] as number | undefined;
          this.completeTask(taskId, status, exitCode);
          // NOTE: task done does NOT trigger onExit — session stays alive
          // for follow-up messages. Only /close or unrecoverable errors exit.
          break;
        }
        case 'log': {
          const text = data['text'] as string | undefined;
          const kind = data['kind'] as string | undefined;
          const group = (data['group'] as string | undefined)
            ?? (data['payload'] as Record<string, unknown> | undefined)?.['group'] as string | undefined;
          // riff's route-B projection (feat/riff-agent-log-display): stdout log
          // events may carry a `display: TaskLogDisplay` — a per-line, human-readable
          // projection of a codex app-server event (回答 / 思路 / 命令 … ). When present,
          // render the timeline row from it instead of the raw JSON line.
          const display = data['display'] as RiffLogDisplay | undefined;
          if (group === 'stdout' && display && typeof display.kind === 'string') {
            this.emitDisplay(display);
            break;
          }
          // stdout logs are the real output stream — emit as data regardless of logLevel.
          // riff stores each stdout log line BARE (no trailing newline): the runner's
          // logger persists `message` verbatim (Logger.createRootLog) and the SSE `log`
          // event carries it as `text` unchanged (taskLog.ts runnerLog*→text: log.message).
          // For codex_app_server that message is one `JSON.stringify(event)` per line. Since
          // emitText only NORMALIZES existing newlines and never adds a separator, emitting
          // the bare text would butt consecutive events together into one unreadable wall.
          // Re-add the per-line separator here (safe & non-duplicating precisely because the
          // stored line has no trailing newline). NOTE: the `output`/chunk path stays raw —
          // those chunks may be partial lines, so they must NOT get a synthetic newline.
          if (group === 'stdout' && text) {
            // Defensive backstop: riff downgrades codex lifecycle "noise" lines
            // (thread.started / item.started / usage-only turns) to channel:'raw',
            // so a default subscription never receives them. But if an un-projected
            // bare codex event ever slips through, suppress it rather than re-wall.
            if (isBareCodexNoiseLine(text)) {
              break;
            }
            this.emitText(`${text}\n`);
          } else if (this.config.logLevel === 'verbose' && text) {
            this.emitLine(`[riff:${kind ?? 'log'}] ${text}`);
          }
          break;
        }
      }
    } catch (err) {
      logger.warn(`[riff] failed to parse SSE event: ${err}`);
    }
  }

  /**
   * Track the best sandbox URL for the "Web 终端" button.
   * Preference: directAccessUrl (the AIO sandbox terminal, directly openable)
   * over accessUrl (riff frontend page — hardcoded to the production domain
   * even on BOE deployments, so its origin is rewritten to the configured
   * baseUrl). A direct URL is never downgraded back to a frontend URL within
   * the same task. Returns true when the current URL changed.
   */
  private updateAccessUrl(src: { accessUrl?: string; directAccessUrl?: string }): boolean {
    let next: string | null = null;
    let isDirect = false;
    if (src.directAccessUrl) {
      next = src.directAccessUrl;
      isDirect = true;
    } else if (src.accessUrl && !this.accessUrlIsDirect) {
      next = this.rewriteToBaseOrigin(src.accessUrl);
    }
    if (!next || next === this.currentAccessUrl) return false;
    this.currentAccessUrl = next;
    this.accessUrlIsDirect = isDirect;
    this.accessUrlCb?.(next);
    return true;
  }

  /** Rewrite a riff frontend URL onto the configured baseUrl origin (BOE vs prod). */
  private rewriteToBaseOrigin(url: string): string {
    try {
      const u = new URL(url);
      const base = new URL(this.config.baseUrl);
      if (u.origin === base.origin) return url;
      return `${base.origin}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return url;
    }
  }

  /** One-shot task-detail fetch to pick up directAccessUrl (not present in SSE events). */
  private async fetchDirectAccessUrl(taskId: string): Promise<void> {
    try {
      const url = `${this.config.baseUrl}/api/task-detail?id=${encodeURIComponent(taskId)}`;
      const headers: Record<string, string> = {};
      const jwt = await this.getJwt();
      if (jwt) headers['x-jwt-token'] = jwt;
      this.applyExtraHeaders(headers);
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return;
      const result = (await resp.json()) as {
        success: boolean;
        data?: { task?: { accessUrl?: string; directAccessUrl?: string } };
      };
      // A slow detail response may land after a follow-up replaced the task —
      // never let the OLD task's URL overwrite the new task's.
      if (taskId !== this.currentTaskId) return;
      const task = result.data?.task;
      if (task) this.updateAccessUrl(task);
    } catch (err) {
      logger.warn(`[riff] fetchDirectAccessUrl failed: ${err}`);
    }
  }

  private emitError(message: string): void {
    this.emitLine(`[riff] 错误: ${message}`, 'err');
    logger.error(`[riff] ${message}`);
    // A failed task is also a turn boundary — without this, a task-execute /
    // follow-up / SSE failure would leave the worker "busy" forever and queued
    // messages would never flush.
    this.taskDone = true;
    this.taskDoneCb?.();
  }

  private async fetchAndEmitOutput(taskId: string): Promise<void> {
    try {
      const url = `${this.config.baseUrl}/api/task-detail?id=${encodeURIComponent(taskId)}`;
      const headers: Record<string, string> = {};
      const jwt = await this.getJwt();
      if (jwt) headers['x-jwt-token'] = jwt;
      this.applyExtraHeaders(headers);

      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!resp.ok) {
        logger.warn(`[riff] task-detail fetch failed: HTTP ${resp.status}`);
        return;
      }
      const result = (await resp.json()) as {
        success: boolean;
        data?: {
          task?: {
            output?: string;
            accessUrl?: string;
            directAccessUrl?: string;
            resultOutput?: {
              displayReport?: {
                content?: string;
                kind?: string;
              };
            };
          };
        };
      };

      // Stale guard: if a follow-up already replaced this task while the
      // detail request was in flight, drop both the URL and the report —
      // appending the OLD task's report into the NEW task's log (or replacing
      // its sandbox URL) is worse than losing a tail report.
      if (taskId !== this.currentTaskId) {
        logger.info(`[riff] task ${taskId} detail arrived after a newer task started — report dropped`);
        return;
      }
      if (result.data?.task) this.updateAccessUrl(result.data.task);

      // Prefer displayReport content (cleaner), fall back to raw output
      const displayContent = result.data?.task?.resultOutput?.displayReport?.content;
      const rawOutput = result.data?.task?.output ?? '';
      const output = displayContent && displayContent.length > 0
        ? displayContent
        : rawOutput;

      if (output && output.length > 0) {
        // Clean up: strip leading "startedcompleted" noise from aiden runner
        const cleaned = output.replace(/^(started|completed)+/, '').trim();
        if (cleaned.length > 0) {
          this.emitLine('────────── 任务报告 ──────────', 'title');
          this.emitText(cleaned + '\n');
        }
      }
    } catch (err) {
      logger.warn(`[riff] fetchAndEmitOutput failed: ${err}`);
    }
  }
}
