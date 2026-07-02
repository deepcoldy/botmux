/**
 * Per-bot local read isolation — the CLI-agnostic core.
 *
 * Common layer expresses the ISOLATION INTENT + CONTEXT (which paths a bot may
 * or may not read); each CLI adapter translates it into that CLI's native
 * permission mechanism. This module is pure (no fs / no spawn) so it is fully
 * unit-testable and shared across adapters. The Claude adapter consumes
 * {@link buildClaudeReadIsolationSettings}; a Codex adapter would consume the
 * same {@link ReadIsolationContext} to emit a permission profile instead.
 *
 * Threat model: a semi-trusted Feishu user driving bot A's agent must not be
 * able to read bot B's session data or credentials (bots.json is the full
 * multi-bot cred file; each bot's lark-cli config holds its app secret in
 * plaintext). See the design doc for the two-layer rationale.
 */

/** Minimum Claude Code version whose built-in sandbox supports
 *  `sandbox.filesystem.denyRead` + credential-scoped blocking. */
export const MIN_CLAUDE_SANDBOX_VERSION = '2.1.187';

export interface ReadIsolationContext {
  /** The current bot's Feishu app id (its own lark-cli config dir stays readable). */
  currentAppId: string;
  /** Every OTHER bot's app id — their lark-cli config dirs are denied. */
  otherAppIds: string[];
  /** botmux session data root (SESSION_DATA_DIR): sessions-*.json, frozen-cards, ... */
  sessionDataDir: string;
  /** The bot user's home directory. */
  homeDir: string;
  /** The running CLI's OWN transcript root to deny, e.g. Claude's
   *  `<home>/.claude/projects`. Optional: Codex sessions live in one shared
   *  `~/.codex/sessions` (not per-bot-separable), so Codex omits it to avoid denying
   *  the bot its own history. (Adapter-supplied via readIsolationTranscriptRoots.) */
  ownTranscriptRoot?: string;
  /** Transcript roots of OTHER CLI families this bot does NOT use — denied fully.
   *  A Codex bot must not read Claude bots' `~/.claude/projects`, and a Claude bot
   *  must not read Codex bots' `~/.codex/sessions`. (The bot's OWN transcript root
   *  is handled by {@link ownTranscriptRoot} for Claude; Codex's own shared
   *  `~/.codex/sessions` stays readable so it can resume — a known limitation.) */
  foreignTranscriptDirs?: string[];
  /** Per-bot extra deny paths (BotConfig.readDenyExtraPaths). */
  extraDenyPaths?: string[];
  /** Strict allowlist mode: deny the whole home, allow only {@link allowPaths}. */
  strict?: boolean;
  /** Strict-mode allow set (workspace + anything the bot legitimately needs). */
  allowPaths?: string[];
  /** The running CLI's OWN auth/home paths that must stay readable (resolved
   *  absolute). Critical for the external-wrapper path, which sandboxes the CLI's
   *  MAIN process too: denying e.g. Codex's `~/.codex/auth.json` makes codex fail
   *  to authenticate and crash-loop. Excluded from the deny set. */
  ownAuthPaths?: string[];
}

/** Normalize a path for the deny/allow lists: require ABSOLUTE, strip trailing
 *  slashes, reject `..` traversal. Returns null for anything unusable so the
 *  caller drops it (a silently-ignored relative path is a fail-open trap).
 *  NOTE: symlink resolution (realpath) is the caller's job — this is pure. */
export function normalizeIsolationPath(p: string): string | null {
  if (!p) return null;
  const t = p.replace(/\/+$/, '');
  if (!t.startsWith('/')) return null;
  if (t.split('/').includes('..')) return null;
  return t;
}

/** Common credential locations denied by default (opt-in feature, but once on
 *  these are covered without the user enumerating them). */
export function defaultCredentialDenyPaths(homeDir: string): string[] {
  const h = homeDir.replace(/\/+$/, '');
  return [
    `${h}/.ssh`,
    `${h}/.aws`,
    `${h}/.config/gh`,
    `${h}/.config/glab-cli`,
    `${h}/.npmrc`,
    `${h}/.docker/config.json`,
    `${h}/.kube`,
    `${h}/.git-credentials`,
    // Other coding CLIs' auth (a Claude bot has no need to read these)
    `${h}/.codex/auth.json`,
    `${h}/.claude/.credentials.json`,
    `${h}/.claude.json`,
  ];
}

/** Path of the per-bot `botmux send` credential file the worker writes under read
 *  isolation. Lives directly in SESSION_DATA_DIR (not a denied subdir) so the bot
 *  can read its OWN; {@link buildReadDenyPaths} denies every OTHER bot's. The
 *  secret reaches `botmux send` only through this file — never env/argv — so it is
 *  not exposed to sibling bots via `ps aux` / `tmux show-environment`. */
export function sendCredFilePath(sessionDataDir: string, appId: string): string {
  return `${sessionDataDir.replace(/\/+$/, '')}/.send-cred-${appId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 read isolation: BOTMUX_HOME per-bot model (default-deny allowlist).
//
// Instead of enumerating every sensitive path to DENY (blocklist — fail-open if
// one is missed), v2 relocates each bot's private CLI data into a per-bot home
// under BOTMUX_HOME (via CLAUDE_CONFIG_DIR / CODEX_HOME), then denies the whole
// BOTMUX_HOME + the GLOBAL CLI dirs + system creds, and re-allows ONLY this bot's
// own home + its own per-appId botmux files. Code/repos outside BOTMUX_HOME stay
// open (the bot can still roam & work). Carve-outs are keyed on the IMMUTABLE
// appId (never the user-controllable cwd), so a semi-trusted user cannot /cd them
// onto another bot's data (the v1 F1 class of bug).
// ─────────────────────────────────────────────────────────────────────────────

/** A Feishu app id is safe to use as a path segment. Enforced because appId is
 *  concatenated into BOT_HOME / sessions-<appId>.json / .send-cred-<appId> paths and
 *  into Seatbelt allow rules — a `/` or `..` (from a hand-edited bots.json) would
 *  traverse out of BOTMUX_HOME or mis-scope a carve-out. Real Feishu app ids match. */
const SAFE_APP_ID = /^[A-Za-z0-9._-]+$/;
export function assertSafeAppId(appId: string): string {
  if (!SAFE_APP_ID.test(appId)) {
    throw new Error(`[read-isolation] unsafe app id used as path segment: ${JSON.stringify(appId)}`);
  }
  return appId;
}

/** A bot's private home under BOTMUX_HOME: `<botmuxHome>/bots/<appId>`. Holds the
 *  bot's redirected CLI config/transcripts/memory (CLAUDE_CONFIG_DIR=<here>/claude,
 *  CODEX_HOME=<here>/codex). The ONLY thing under BOTMUX_HOME v2 re-allows. */
export function botHomePath(botmuxHome: string, appId: string): string {
  return `${botmuxHome.replace(/\/+$/, '')}/bots/${assertSafeAppId(appId)}`;
}

export interface V2IsolationContext {
  /** The bot user's home directory. */
  homeDir: string;
  /** BOTMUX_HOME root (e.g. `~/.botmux`). NOT denied wholesale — the botmux CLI the
   *  agent runs (`botmux send`/`list`/`status`) needs broad read access to it (config,
   *  daemon registry, pm2, session store). Only its cross-bot-SENSITIVE parts are denied. */
  botmuxHome: string;
  /** botmux session data root (SESSION_DATA_DIR, e.g. `~/.botmux/data`). */
  sessionDataDir: string;
  /** This bot's Feishu app id. */
  currentAppId: string;
  /** Every OTHER bot's app id — their per-bot data (lark config, session file, send-cred,
   *  BOT_HOME) is denied. */
  otherAppIds: string[];
  /** Per-bot extra deny paths (BotConfig.readDenyExtraPaths). */
  extraDenyPaths?: string[];
}

/** v2 DENY set (HYBRID). The F1 fix is a WHOLE-deny of the CLI data dirs `~/.claude`
 *  (+ `~/.claude.json`) and `~/.codex`: this bot's OWN CLI data is redirected into its
 *  BOT_HOME (readable) via CLAUDE_CONFIG_DIR/CODEX_HOME, so whole-denying the globals
 *  blocks the admin/other/pre-migration data + kills the per-cwd carve-out + /cd hole,
 *  while own resume/memory keep working from BOT_HOME. `~/.botmux` is NOT whole-denied
 *  (the agent's botmux CLI needs its config/registry/pm2/data structure) — instead its
 *  cross-bot-SENSITIVE parts are denied surgically: bots.json, logs, other bots' lark
 *  configs / session files / send-creds / BOT_HOMEs, and the shared conversation-content
 *  dirs. Own BOT_HOME + own session/cred + config/registry stay readable by default.
 *  Plus the system-credential stores. Everything else (code/repos/runtime) stays open. */
export function buildV2DenyPaths(ctx: V2IsolationContext): string[] {
  const h = ctx.homeDir.replace(/\/+$/, '');
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
  const others = ctx.otherAppIds ?? [];
  return dedupe(
    [
      // ── F1: whole-deny the CLI data dirs (own is redirected to BOT_HOME) ──
      `${h}/.claude`,
      `${h}/.claude.json`,
      `${h}/.codex`,
      // ── System credential / secret stores (broad, since outside is open by default) ──
      `${h}/.ssh`,
      `${h}/.aws`,
      `${h}/.azure`,
      `${h}/.gnupg`,
      `${h}/.netrc`,
      `${h}/.config/gh`,
      `${h}/.config/glab-cli`,
      `${h}/.config/gcloud`,
      `${h}/.config/op`,
      `${h}/.config/1Password`,
      `${h}/.1password`,
      `${h}/.password-store`,
      `${h}/.git-credentials`,
      `${h}/.npmrc`,
      `${h}/.pypirc`,
      `${h}/.docker/config.json`,
      `${h}/.kube`,
      `${h}/Library/Keychains`,
      // ── botmux SENSITIVE (surgical — leave config/registry/pm2/data structure readable) ──
      `${bh}/bots.json`,               // ALL bots' secrets
      `${bh}/logs`,                    // daemon logs (cross-bot content)
      `${h}/.lark-cli`,                // default lark config (may hold creds)
      ...others.map((id) => `${h}/.lark-cli-bots/${id}`),   // other bots' lark configs
      ...others.map((id) => `${sd}/sessions-${id}.json`),   // other bots' session stores
      ...others.map((id) => sendCredFilePath(sd, id)),      // other bots' send-creds
      ...others.map((id) => botHomePath(bh, id)),           // other bots' BOT_HOMEs
      `${sd}/sessions.json`,           // legacy shared store
      `${sd}/frozen-cards`,            // conversation content (all bots')
      `${sd}/turn-sends`,
      `${sd}/crash-diagnostics`,
      `${sd}/attachments`,
      `${sd}/whiteboards`,
      ...(ctx.extraDenyPaths ?? []),
    ]
      .map(normalizeIsolationPath)
      .filter((p): p is string => !!p),
  );
}

/** The de-duplicated list of absolute paths this bot must NOT be able to read.
 *
 *  Surgical, NOT a blanket deny of SESSION_DATA_DIR: `botmux send` (run by the
 *  agent) must still read its OWN `sessions-<ownAppId>.json` to route replies.
 *  So we deny the conversation-CONTENT subdirs (transcripts, frozen cards, turn
 *  sends, crash diagnostics) + OTHER bots' session metadata files + all creds,
 *  while leaving this bot's own routing file + the daemon's own bookkeeping
 *  readable. Excludes the bot's OWN lark-cli config dir (its skills need it). */
export function buildReadDenyPaths(ctx: ReadIsolationContext): string[] {
  const h = ctx.homeDir.replace(/\/+$/, '');
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
  const ownLarkCliDir = `${h}/.lark-cli-bots/${ctx.currentAppId}`;
  const paths: (string | null)[] = [
    // Credentials
    `${h}/.botmux/bots.json`,
    `${h}/.lark-cli`,
    ...ctx.otherAppIds.map((id) => `${h}/.lark-cli-bots/${id}`),
    ...defaultCredentialDenyPaths(h),
    // Conversation content + other-bot local state (all bots')
    ...(ctx.ownTranscriptRoot ? [ctx.ownTranscriptRoot] : []),
    // Cross-CLI transcript roots this bot doesn't own (Codex denies Claude's
    // ~/.claude/projects; Claude denies Codex's ~/.codex/sessions).
    ...(ctx.foreignTranscriptDirs ?? []),
    `${sd}/frozen-cards`,
    `${sd}/turn-sends`,
    `${sd}/crash-diagnostics`,
    `${sd}/attachments`,
    `${sd}/whiteboards`,
    // Legacy single-file session store (pre per-app split) can hold cross-bot
    // metadata; own routing uses sessions-<self>.json so this stays safe to deny.
    `${sd}/sessions.json`,
    // Other bots' session metadata (own sessions-<self>.json stays readable)
    ...ctx.otherAppIds.map((id) => `${sd}/sessions-${id}.json`),
    // Other bots' `botmux send` credential files (mirror sessions-<other>): the
    // worker writes each isolated bot's OWN secret here so `botmux send` can auth
    // WITHOUT reading bots.json and WITHOUT the secret ever touching env/argv
    // (which `ps aux` would leak cross-bot). Own file stays readable; deny others'.
    ...ctx.otherAppIds.map((id) => sendCredFilePath(sd, id)),
    // Per-bot extras (normalized; relative/`..` dropped, not silently kept)
    ...(ctx.extraDenyPaths ?? []).map(normalizeIsolationPath),
  ];
  // Drop from the DENY set anything that is a preserved path or lives UNDER one
  // (the bot's own lark-cli dir + the running CLI's own auth/state — denying its own
  // auth would crash the wrapped main process). Deliberately does NOT drop a deny that
  // is a PARENT of a preserved path: dropping the parent would reopen the parent's
  // OTHER children too (e.g. dropping `~/.lark-cli-bots` to preserve one bot's dir
  // would expose every sibling bot's). Instead the caller re-allows each preserved
  // path as a Seatbelt allow carve-out, so a parent deny stays and only the specific
  // preserved file/dir is re-opened.
  const ownNorm = normalizeIsolationPath(ownLarkCliDir);
  const preserve = new Set([ownNorm, ...(ctx.ownAuthPaths ?? []).map(normalizeIsolationPath)].filter(Boolean));
  const isPreserved = (p: string) =>
    preserve.has(p) || [...preserve].some((k) => k !== null && (p === k || p.startsWith(k + '/')));
  return dedupe(
    paths
      .map((p) => (p ? normalizeIsolationPath(p) : null))
      .filter((p): p is string => !!p && !isPreserved(p)),
  );
}

/** Claude permission-rule path: absolute paths need a `//` double-slash prefix
 *  (single-slash silently fails to match — verified empirically). */
function claudePermPath(abs: string): string {
  return '//' + abs.replace(/^\/+/, '');
}

interface ClaudeSandboxFilesystem {
  denyRead: string[];
  allowRead?: string[];
}
export interface ClaudeReadIsolationSettings {
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    filesystem: ClaudeSandboxFilesystem;
  };
}

/**
 * Translate the intent into Claude Code `--settings`:
 *  - `sandbox.filesystem.denyRead` (kernel: Seatbelt/bwrap) covers Bash & every
 *    subprocess it spawns.
 *  - `permissions.deny` Read/Grep/Glob (CLI-enforced, survives bypassPermissions)
 *    covers the built-in file tools.
 * Both are needed — the sandbox does not govern the built-in Read tool.
 */
export function buildClaudeReadIsolationSettings(ctx: ReadIsolationContext): ClaudeReadIsolationSettings {
  const denyPaths = buildReadDenyPaths(ctx);
  const permDeny: string[] = [];
  for (const p of denyPaths) {
    const pp = claudePermPath(p);
    // Exact (for files) + subtree glob (for dirs); Grep/Glob for search tools.
    permDeny.push(`Read(${pp})`, `Read(${pp}/**)`, `Grep(${pp}/**)`, `Glob(${pp}/**)`);
  }

  if (ctx.strict) {
    const h = ctx.homeDir.replace(/\/+$/, '');
    const ownLarkCliDir = `${h}/.lark-cli-bots/${ctx.currentAppId}`;
    const allowRead = dedupe(
      [...(ctx.allowPaths ?? []).map(normalizeIsolationPath), ownLarkCliDir].filter(
        (p): p is string => !!p,
      ),
    );
    return {
      permissions: { deny: permDeny },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        filesystem: { denyRead: [h], allowRead },
      },
    };
  }

  return {
    permissions: { deny: permDeny },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: { denyRead: denyPaths },
    },
  };
}

/**
 * Decide whether read isolation should be enabled for a session, or fail-closed.
 * Pure: the caller resolves the impure inputs (adapter capability, wrapperCli,
 * whether the CLI version meets {@link MIN_CLAUDE_SANDBOX_VERSION}).
 *  - not configured → `{ enabled: false }` (no error).
 *  - configured but unenforceable → `{ enabled: false, failClosedReason }` — the
 *    caller MUST refuse to start the session rather than run unisolated.
 *  - all satisfied → `{ enabled: true }`.
 */
export function evaluateReadIsolationGate(opts: {
  configured: boolean;
  adapterSupports: boolean;
  wrapperCliSet: boolean;
  versionOk: boolean;
}): { enabled: boolean; failClosedReason?: string } {
  if (!opts.configured) return { enabled: false };
  if (!opts.adapterSupports)
    return { enabled: false, failClosedReason: 'the CLI adapter does not support read isolation' };
  if (opts.wrapperCliSet)
    return { enabled: false, failClosedReason: 'wrapperCli strips --settings, read isolation cannot be enforced' };
  if (!opts.versionOk)
    return { enabled: false, failClosedReason: `Claude Code >= ${MIN_CLAUDE_SANDBOX_VERSION} required for read isolation` };
  return { enabled: true };
}

/**
 * macOS Seatbelt (sandbox-exec) profile for the EXTERNAL-wrapper isolation path
 * (Codex + Claude + any CLI without a usable built-in read-deny). Blocklist: allow
 * everything, deny reads of the sensitive paths, THEN re-allow the {@link allowPaths}
 * carve-outs — `subpath` covers a file or a whole subtree. Rule ORDER matters:
 * Seatbelt applies the LAST matching rule, so an allow listed AFTER a broader deny
 * re-opens that subpath. Used e.g. to deny the whole `~/.claude/projects` tree but
 * re-allow the bot's OWN `projects/<own-cwd-hash>` (so its main process can read its
 * transcripts for resume + its memory, while every other bot's stays denied).
 * Verified: reads of denied paths fail EPERM; carved-out subpaths read normally; the
 * wrapped CLI (which bypasses its OWN sandbox — nested Seatbelt would hang) runs fine.
 */
export function buildSeatbeltProfile(
  denyPaths: string[],
  allowPaths: string[] = [],
  finalDenyPaths: string[] = [],
  traverseDirs: string[] = [],
): string {
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = ['(version 1)', '(allow default)'];
  for (const p of denyPaths) lines.push(`(deny file-read* (subpath "${esc(p)}"))`);
  // Traversal metadata-allows: a carve-out under a DENIED parent (e.g. BOT_HOME under
  // ~/.botmux) is reachable for a plain open (Seatbelt matches the final path), but a
  // realpath()/stat of an INTERMEDIATE dir is denied — which crashes CLIs that
  // canonicalize their config dir (Codex: "failed to canonicalize CODEX_HOME"). Allow
  // read-METADATA (stat/traverse) on those specific ancestor DIRS only (literal, not
  // subpath) — dir LISTING (read-data) stays denied, so no enumeration leak.
  for (const p of traverseDirs) lines.push(`(allow file-read-metadata (literal "${esc(p)}"))`);
  // Carve-outs override the broad denies above (Seatbelt applies the LAST match).
  for (const p of allowPaths) lines.push(`(allow file-read* (subpath "${esc(p)}"))`);
  // FINAL denies win over the carve-outs — admin `readDenyExtraPaths` must hold even
  // for a path that falls under the bot's own re-allowed BOT_HOME.
  for (const p of finalDenyPaths) lines.push(`(deny file-read* (subpath "${esc(p)}"))`);
  return lines.join('\n') + '\n';
}

/**
 * PLACEHOLDER — Linux equivalent of {@link buildSeatbeltProfile}. Seatbelt is
 * macOS-only; on Linux the external-wrapper path should use bubblewrap: wrap the
 * CLI in `bwrap --ro-bind / /` (read-all base) then mask each deny path with an
 * empty `--tmpfs`/`--bind` (dir) or empty-file bind (file), or an equivalent
 * landlock policy. Returns the `bwrap` argv prefix to prepend before the CLI.
 *
 * NOT YET IMPLEMENTED — the worker fail-closes on Linux until this is filled in
 * and e2e-verified (bwrap availability, userns/AppArmor caveats, no double-bwrap
 * with botmux's existing `sandbox` field). Kept as a typed seam so wiring the
 * platform dispatch doesn't need to change.
 */
export function buildLinuxReadIsolationWrap(_denyPaths: string[]): never {
  throw new Error('read-isolation: Linux bwrap wrapper not implemented yet');
}

/**
 * Decide whether a live persistent pane (tmux/zellij/herdr) may be reattached for
 * an isolated bot. Isolation is injected at CLI *spawn* time (Claude `--settings`
 * / the Seatbelt wrapper) and lives on the RUNNING process, so a pane that was
 * spawned isolated STAYS isolated for its whole lifetime — including across daemon
 * restarts (the sandbox is on the CLI process, independent of the daemon).
 *
 * We stamp a marker file when we spawn an isolated CLI. A reattach is safe iff that
 * marker EXISTS: its presence means "this pane was spawned isolated", so warm
 * reattach (preserving resume/context + tmux idle-suspend) is safe regardless of
 * which daemon lifetime spawned it. A pane with NO marker was spawned WITHOUT
 * isolation (before the feature was enabled, or by an old build) → NOT safe; the
 * caller kills it and cold-spawns fresh isolated instead. (The marker's content is
 * a daemon boot id, kept only for debugging — it is deliberately NOT compared, as
 * comparing it would wrongly kill isolated panes on every restart and drop resume.)
 */
export function isolatedPaneReattachSafe(markerContent: string | null | undefined): boolean {
  return (markerContent ?? '').trim().length > 0;
}

/** Extract the semver from `claude --version` output (e.g. "2.1.197 (Claude Code)"). */
export function parseClaudeVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric (not lexical) semver comparison: is `v` >= `min`? */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
