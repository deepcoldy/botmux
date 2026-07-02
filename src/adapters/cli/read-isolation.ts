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
  /** The CLI's transcript root to deny, e.g. Claude's `<home>/.claude/projects`.
   *  Optional: Codex sessions live in one shared `~/.codex/sessions` (not
   *  per-bot-separable), so a single-Codex-bot setup omits it to avoid denying
   *  the bot its own history. */
  claudeProjectsDir?: string;
  /** Transcript roots of OTHER CLI families this bot does NOT use — denied fully.
   *  A Codex bot must not read Claude bots' `~/.claude/projects`, and a Claude bot
   *  must not read Codex bots' `~/.codex/sessions`. (The bot's OWN transcript root
   *  is handled by {@link claudeProjectsDir} for Claude; Codex's own shared
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
    ...(ctx.claudeProjectsDir ? [ctx.claudeProjectsDir] : []),
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
  // Never deny the bot's own lark-cli dir, nor the running CLI's own auth/home
  // (the external wrapper sandboxes the CLI's main process — denying its own
  // auth would crash it). Match by prefix so `~/.codex/auth.json` also protects
  // anything the deny set nests under it.
  const ownNorm = normalizeIsolationPath(ownLarkCliDir);
  const preserve = new Set([ownNorm, ...(ctx.ownAuthPaths ?? []).map(normalizeIsolationPath)].filter(Boolean));
  const isPreserved = (p: string) =>
    preserve.has(p) || [...preserve].some((k) => k && (p === k || p.startsWith(k + '/') || k.startsWith(p + '/')));
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
 * (Codex and any CLI without a usable built-in read-deny). Blocklist: allow
 * everything, then deny reads of the sensitive paths — `subpath` covers a file
 * or a whole subtree. Verified: `sandbox-exec -f <profile> codex ... --dangerously-
 * bypass-approvals-and-sandbox` blocks the denied paths while codex runs normally.
 * The CLI must bypass its OWN sandbox (nested Seatbelt would hang) — the outer
 * profile is the enforcement.
 */
export function buildSeatbeltProfile(denyPaths: string[]): string {
  const lines = ['(version 1)', '(allow default)'];
  for (const p of denyPaths) {
    // Seatbelt string literals: backslash-escape backslashes and double quotes.
    const esc = p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`(deny file-read* (subpath "${esc}"))`);
  }
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
 * Decide whether a persistent pane (tmux/zellij/herdr) may be reattached for an
 * isolated bot. Isolation is injected only at CLI *spawn* time (Claude
 * `--settings` / the Seatbelt wrapper), so reattaching a pane whose provenance we
 * can't vouch for risks resuming an UNISOLATED CLI.
 *
 * We stamp a boot-id marker when we spawn an isolated CLI. A reattach is safe iff
 * the marker matches the CURRENT daemon lifetime's boot id:
 *  - suspend→resume within one daemon lifetime → same boot id → safe reattach
 *    (the still-running pane was spawned isolated by us, keeps its sandbox).
 *  - daemon restart → new boot id → stale marker (or none) → NOT safe; caller
 *    kills the pane and cold-spawns fresh isolated instead.
 * Blank marker/boot id never matches (defensive).
 */
export function isolatedPaneReattachSafe(
  markerBootId: string | null | undefined,
  currentBootId: string | null | undefined,
): boolean {
  const m = (markerBootId ?? '').trim();
  const c = (currentBootId ?? '').trim();
  return m.length > 0 && m === c;
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
