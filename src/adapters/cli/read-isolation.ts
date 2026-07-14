/**
 * Per-bot local read isolation (v2) — the CLI-agnostic core.
 *
 * Model (HYBRID): each isolated bot's CLI data is relocated into its own
 * BOT_HOME (`<botmuxHome>/bots/<appId>`, via CLAUDE_CONFIG_DIR / CODEX_HOME),
 * then the whole CLI process is wrapped in an OS sandbox (macOS Seatbelt via
 * `sandbox-exec -f <profile>`) that denies reads of: the GLOBAL CLI data dirs,
 * system credential stores, and every cross-bot-sensitive part of ~/.botmux —
 * with the bot's OWN slice re-allowed by carve-outs. The wrapped CLI bypasses
 * its own built-in sandbox, so the outer Seatbelt profile is the sole enforcer
 * (covers the main process + every Bash subprocess — no escape).
 *
 * This module is pure (no fs / no spawn) so it is fully unit-testable and
 * shared across adapters; the worker resolves the impure inputs (realpath,
 * platform, adapter capability) and emits the profile.
 *
 * Threat model: a semi-trusted Feishu user driving bot A's agent must not be
 * able to read bot B's session data or credentials (bots.json is the full
 * multi-bot cred file; each bot's lark-cli config holds its app secret in
 * plaintext). See the design doc for the two-layer rationale.
 */

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

/** Path of the per-bot `botmux send` credential file the worker writes under read
 *  isolation. Lives INSIDE the bot's BOT_HOME ({@link botHomePath}) — the same
 *  per-bot private storage as its redirected CLI data — so the bot reads its OWN
 *  while every OTHER bot's is already covered by the whole-BOT_HOME deny (no
 *  separate per-file deny needed). This makes BOT_HOME the single private-storage
 *  primitive for any per-bot secret (send cred, future github token, …). The
 *  secret reaches `botmux send` only through this file — never env/argv — so it is
 *  not exposed to sibling bots via `ps aux` / `tmux show-environment`.
 *
 *  Takes SESSION_DATA_DIR (what every caller has) and derives BOTMUX_HOME as its
 *  parent — the SAME definition the worker uses for BOT_HOME
 *  (`botHomePath(dirname(SESSION_DATA_DIR))`). Centralizing the derivation here
 *  keeps worker-write / CLI-read / deny in lock-step even for a customized
 *  SESSION_DATA_DIR. */
export function sendCredFilePath(sessionDataDir: string, appId: string): string {
  const botmuxHome = sessionDataDir.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
  return `${botHomePath(botmuxHome, appId)}/send-cred.json`;
}

/** A Feishu app id is safe to use as a path segment. Enforced because appId is
 *  concatenated into BOT_HOME (and its send-cred.json) / sessions-<appId>.json paths and
 *  into Seatbelt allow rules — a `/` or `..` (from a hand-edited bots.json) would
 *  traverse out of BOTMUX_HOME or mis-scope a carve-out. Real Feishu app ids match. */
const SAFE_APP_ID = /^[A-Za-z0-9._-]+$/;
export function assertSafeAppId(appId: string): string {
  // Reject the char-class violators AND any all-dots id (`.`/`..`/`...`): the latter pass
  // the class but are path-traversal segments — as a carve-out subpath `bots/..` resolves
  // to the PARENT and re-opens sensitive roots.
  if (!SAFE_APP_ID.test(appId) || /^\.+$/.test(appId)) {
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

/**
 * Minimal read carve-outs needed to launch a CLI whose executable itself lives
 * under a globally denied data root. The standalone Codex installer exposes
 * `~/.local/bin/codex` as a symlink through
 * `~/.codex/packages/standalone/current`; allowing only the final canonical
 * binary is insufficient because Seatbelt must read the intermediate `current`
 * symlink while resolving execvp(). Re-open the executable package tree only —
 * auth.json, config.toml, sessions and the rest of ~/.codex remain denied.
 *
 * Inputs must already be canonicalized by the worker (this module stays pure).
 */
export function buildCliExecutableReadCarveOuts(input: {
  homeDir: string;
  cliId: string;
  resolvedBin: string;
}): string[] {
  if (input.cliId !== 'codex') return [];
  const h = input.homeDir.replace(/\/+$/, '');
  const bin = normalizeIsolationPath(input.resolvedBin);
  const standaloneRoot = `${h}/.codex/packages/standalone`;
  if (!bin || (bin !== standaloneRoot && !bin.startsWith(`${standaloneRoot}/`))) return [];
  return [standaloneRoot];
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
  /** This bot's Feishu app id. All carve-outs are keyed on it (immutable, never the
   *  user-controllable cwd) — sibling data needs NO enumeration: per-bot dirs are
   *  denied WHOLESALE and per-bot session files by a filename-pattern regex. */
  currentAppId: string;
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
 *  dirs (frozen-cards, queues, attachments, whiteboards, …). Own BOT_HOME + own
 *  session/cred + own attachments bucket + config/registry stay readable by default.
 *  Plus the system-credential stores. Everything else (code/repos/runtime) stays open.
 *
 *  NOTE: per-bot session stores (`sessions-<appId>.json`) are denied by PATTERN — see
 *  {@link buildV2DenyRegexes} — so no sibling-appId enumeration is needed anywhere. */
export function buildV2DenyPaths(ctx: V2IsolationContext): string[] {
  const h = ctx.homeDir.replace(/\/+$/, '');
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
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
      // WHOLESALE-deny the per-bot lark config dir (same rationale as bots/ below): a
      // newly-added bot is covered without cold-restart, and `ls .lark-cli-bots/` can't
      // enumerate siblings. Own is re-allowed via buildV2CarveOuts (+ traverse shim).
      `${h}/.lark-cli-bots`,
      // WHOLESALE-deny the bots/ dir (every sibling BOT_HOME + their send-cred). Own is
      // re-allowed via buildV2CarveOuts (allow subpath own + file-read-metadata traverse
      // shim so the CLI can realpath its redirected config). Denying the DIR (not each
      // sibling appId) means a NEWLY-ADDED bot is covered WITHOUT cold-restarting this
      // one, and `ls bots/` can't enumerate siblings.
      `${bh}/bots`,
      `${sd}/sessions.json`,           // legacy shared store
      `${sd}/frozen-cards`,            // conversation content (all bots')
      `${sd}/turn-sends`,              // CLI only APPENDS markers here — read-deny is safe
      `${sd}/crash-diagnostics`,
      // All bots' Feishu-uploaded files. Own per-appId bucket (attachments/<self>/) is
      // re-allowed via buildV2CarveOuts; siblings' buckets + the legacy flat
      // per-messageId layout stay denied.
      `${sd}/attachments`,
      // whiteboards/ is deliberately NOT denied (owner decision): whiteboards are
      // shared content, meant to be visible across the bots that collaborate on
      // them. NOTE the store is currently GLOBAL (no per-chat scoping), so a
      // sandboxed bot can `whiteboard list`/`read` boards from other chats too —
      // an accepted tradeoff until whiteboards are bucketed by chat/appId. Also
      // un-denying the read avoids the read-modify-write clobber a deny would cause.
      // Queued inbound messages (queues/<rootMessageId>.jsonl = full LarkMessage
      // content for EVERY bot). Daemon-side only — the CLI never reads it.
      `${sd}/queues`,
      // Seatbelt profiles + reattach markers: filenames/rules enumerate sibling
      // session ids and appIds. sandbox-exec parses the profile BEFORE applying it,
      // and the markers are read by the daemon — the sandboxed CLI never reads these.
      `${sd}/read-isolation`,
      // NOTE: schedules.json is deliberately NOT denied. It's a read-modify-write
      // store: denying the read makes a sandboxed `botmux schedule` load an empty
      // map and then overwrite the shared file, silently wiping EVERY bot's tasks
      // (read-modify-write degraded to write-only). We accept the minor leak
      // (isolated bots can read others' scheduled prompts) until schedule-store
      // fail-closes on read errors (ENOENT vs EPERM). See PR #387 review.
      `${bh}/feishu-session.json`,     // Feishu web login session (setup automation) — can mint bots
      // The dashboard admin credentials. `.dashboard-secret` signs the loopback-HMAC
      // that gates `/__cli/rotate` AND the daemon-IPC write-link routes — the ipc-server
      // comment (dashboard-ipc-server.ts) explicitly relies on the sandbox hiding it to
      // "keep a sandboxed worker from minting write tokens" for sessions it doesn't own
      // (a cross-bot escalation reachable by a semi-trusted conversant driving the agent).
      // Only owner-facing admin verbs (`botmux dashboard`/`term-link`) sign with it — the
      // agent's send/list/status never do, so denying it costs the agent nothing. Its
      // sibling `.dashboard-token` (dashboard bearer) is denied for the same reason;
      // `.dashboard-port` is just a port number (no credential value) → left readable.
      `${bh}/.dashboard-secret`,
      `${bh}/.dashboard-token`,
      // NOTE: extraDenyPaths (readDenyExtraPaths) are NOT here — they go to
      // buildV2CarveOuts().finalDenyPaths so they win over the own-BOT_HOME allow.
    ]
      .map(normalizeIsolationPath)
      .filter((p): p is string => !!p),
  );
}

/** Escape a literal path for embedding in a Seatbelt regex filter. */
function escapeForRegex(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** v2 PATTERN denies — Seatbelt `regex` filters that deny a whole FILENAME CLASS
 *  instead of enumerating sibling app ids. Covers:
 *   - per-bot session stores (`<sd>/sessions-<appId>.json`, routing metadata): a
 *     newly-added bot's store is denied WITHOUT cold-restarting the ones already
 *     running, and no caller needs to know the sibling app ids. The bot's OWN store
 *     is re-allowed by carve-out (Seatbelt last-match).
 *   - EVERY `bots.json.*` sidecar (`.bak` written by setup/migration, `.tmp`, ad-hoc
 *     `.bak.<suffix>` copies): the exact `bots.json` is subpath-denied in
 *     {@link buildV2DenyPaths}, but its backups carry the SAME plaintext
 *     larkAppSecret for every bot under a DIFFERENT basename, which `subpath` does
 *     not match — so without this an isolated bot could `cat bots.json.bak` and
 *     recover all siblings' credentials, defeating the whole isolation. */
export function buildV2DenyRegexes(ctx: V2IsolationContext): string[] {
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  return [
    `^${escapeForRegex(sd)}/sessions-[^/]+\\.json$`,
    // Any `bots.json.` sidecar (backups/temp) — trailing dot so it matches
    // bots.json.bak / .tmp / .bak.<suffix> but NOT the exact bots.json (that is
    // the subpath deny's job) and NOT an unrelated `bots.jsonx`.
    `^${escapeForRegex(bh)}/bots\\.json\\.`,
    // LEGACY pre-BOT_HOME send-cred files (`<sd>/.send-cred-<appId>`): current
    // builds write send-cred.json inside BOT_HOME, but leftovers from older
    // builds still carry live per-bot send credentials at the data root.
    `^${escapeForRegex(sd)}/\\.send-cred-`,
    // Per-bot user display-name caches (`identities-<appId>.json`): open_id→name
    // PII of every bot's interlocutors. The CLI never reads them (daemon-side
    // prompt injection only), so the OWN file gets NO carve-out — the whole
    // filename class is denied.
    `^${escapeForRegex(sd)}/identities-[^/]+\\.json$`,
  ];
}

/** The v2 Seatbelt carve-outs that accompany {@link buildV2DenyPaths} +
 *  {@link buildV2DenyRegexes}. They re-open the bot's OWN slice of each denied class:
 *   - allowPaths: the own BOT_HOME subpath (redirected CLI data + creds + send-cred),
 *     the own lark-cli config dir, and the own session store file.
 *   - traverseDirs: `bots/` etc., as file-read-metadata ONLY — lets the CLI realpath()
 *     its config dir THROUGH the denied parent WITHOUT allowing `ls bots/` (enumeration).
 *   - finalDenyPaths: admin `readDenyExtraPaths`, emitted AFTER the allows so an admin
 *     deny UNDER the own BOT_HOME still wins (Seatbelt last-match). */
export function buildV2CarveOuts(ctx: V2IsolationContext): {
  allowPaths: string[];
  traverseDirs: string[];
  finalDenyPaths: string[];
} {
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
  const h = ctx.homeDir.replace(/\/+$/, '');
  const self = assertSafeAppId(ctx.currentAppId);
  return {
    // Re-open the bot's OWN slice of each wholesale/pattern-denied per-bot class.
    allowPaths: [
      botHomePath(bh, self),
      `${h}/.lark-cli-bots/${self}`,
      // Own routing metadata (`botmux send` reads it to route replies); siblings'
      // stay denied by the buildV2DenyRegexes filename pattern.
      `${sd}/sessions-${self}.json`,
      // Own Feishu-upload bucket (attachments/<appId>/<messageId>/…) — the agent must
      // read files the user uploads in chat. getAttachmentsDir keys the bucket on the
      // appId precisely so this spawn-time-static carve-out can exist.
      `${sd}/attachments/${self}`,
    ],
    // file-read-metadata on the wholesale-denied parents so the CLI/skill can realpath()
    // through them WITHOUT `ls` (enumeration) leaking.
    traverseDirs: [`${bh}/bots`, `${h}/.lark-cli-bots`, `${sd}/attachments`],
    finalDenyPaths: (ctx.extraDenyPaths ?? [])
      .map(normalizeIsolationPath)
      .filter((p): p is string => !!p),
  };
}

// ─── Mac file-sandbox: WRITE isolation (the Seatbelt twin of Linux bwrap) ─────

export interface WriteSandboxContext {
  /** The bot user's home directory. */
  homeDir: string;
  /** BOTMUX_HOME root (e.g. `~/.botmux`). */
  botmuxHome: string;
  /** botmux session data root (SESSION_DATA_DIR, e.g. `~/.botmux/data`). */
  sessionDataDir: string;
  /** The session's project working dir — writes here PERSIST (the point of the sandbox). */
  workingDir: string;
  /** This bot's Feishu app id (keys its own BOT_HOME carve-out). */
  currentAppId: string;
  /** Extra writable roots the worker resolves at spawn time (realpath'd TMPDIR,
   *  extra worktrees, admin-configured writable paths). */
  extraWritePaths?: string[];
}

/**
 * Write-isolation rules for the macOS file sandbox — the FUNCTIONAL twin of the
 * Linux bwrap overlay (which lets the agent read the whole real FS but confines
 * WRITES). Seatbelt has no copy-on-write overlay, so we approximate the same
 * guarantee with a deny-all-writes + allow-list: the agent can write its project
 * and the ephemeral scratch/cache the CLI needs, but CANNOT tamper the rest of
 * your real disk (home dotfiles, other projects, other bots' data, system dirs).
 * Reads stay wide open (like Linux) — this is orthogonal to read isolation, which
 * layers its own read-deny set into the SAME profile when also enabled.
 *
 * `allowWritePaths` re-open the writable zones AFTER the profile's `(deny
 * file-write* (subpath "/"))`; `denyWritePaths` are crown jewels re-denied AFTER
 * the allows (Seatbelt last-match), so they stay protected even if the project or
 * an allowed zone nests them. The allow-list is intentionally generous toward
 * CLI scratch/cache — the exact set is empirically tuned on real macOS (a missing
 * cache path makes the CLI fail, an over-broad one weakens the sandbox). Pure: the
 * worker realpath's every path (symlink-safe) before emitting.
 */
export function buildWriteSandboxRules(ctx: WriteSandboxContext): {
  allowWritePaths: string[];
  allowWriteRegexes: string[];
  denyWritePaths: string[];
} {
  const h = ctx.homeDir.replace(/\/+$/, '');
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  const wd = ctx.workingDir.replace(/\/+$/, '');
  const keep = (arr: string[]) =>
    dedupe(arr.map(normalizeIsolationPath).filter((p): p is string => !!p));
  return {
    allowWritePaths: keep([
      // The project — writes here PERSIST (no overlay/landing step; direct like a
      // non-sandboxed run would, only nothing OUTSIDE the allow-list can be touched).
      wd,
      // Own BOT_HOME — where read isolation redirects the CLI's data when co-enabled;
      // harmless to allow when write-sandbox is standalone (dir just won't exist).
      botHomePath(bh, ctx.currentAppId),
      // CLI data dirs (write-sandbox standalone leaves them at the real path).
      `${h}/.claude`, `${h}/.claude.json`, `${h}/.codex`,
      // Claude Code's updater/OAuth refresh uses sibling lock directories rather
      // than placing every state file under ~/.claude. Without these, a valid
      // login can fail to refresh because lock acquisition returns EPERM.
      `${h}/.claude.lock`, `${h}/.claude.json.lock`,
      `${h}/.local/state/claude`,
      // Ephemeral scratch / caches every CLI + spawned tool (git, npm, node) needs.
      `${h}/Library/Caches`,
      `${h}/Library/Application Support`,
      `${h}/.cache`,
      `${h}/.npm`,
      '/private/var/folders',   // macOS per-user TMPDIR / DARWIN_USER_TEMP_DIR root
      '/private/tmp', '/tmp', '/var/tmp',
      '/dev',                   // ptys, /dev/null, /dev/tty — required to run at all
      ...(ctx.extraWritePaths ?? []),
    ]),
    allowWriteRegexes: [
      // Claude Code saves ~/.claude.json atomically through a PID/random-suffixed
      // sibling (e.g. .claude.json.tmp.1234.abcd). A subpath rule for the exact
      // state file cannot match those siblings, so allow only that basename class
      // at the home root — not arbitrary home dotfiles.
      `^${escapeForRegex(h)}/\\.claude\\.json\\.tmp\\.[^/]+$`,
    ],
    denyWritePaths: keep([
      // Crown jewels — re-denied AFTER the allows so a semi-trusted operator can't
      // plant an ssh key or tamper another bot's creds even if the project/home
      // nests these. (Most already fall under deny-by-default; this is the guard for
      // a broad workingDir and defence-in-depth.)
      `${h}/.ssh`, `${h}/.aws`, `${h}/.gnupg`,
      `${bh}/bots.json`,
      `${bh}/feishu-session.json`,
      `${bh}/.dashboard-secret`, `${bh}/.dashboard-token`,
    ]),
  };
}

// ─── Linux read isolation: bwrap mask set (the Seatbelt read-deny twin) ──────

export interface LinuxReadIsolationInput {
  ctx: V2IsolationContext;
  /** Every OTHER bot's appId — the worker enumerates these from the registry.
   *  bwrap has NO regex (unlike the macOS Seatbelt profile), so each sibling's
   *  per-bot paths are masked INDIVIDUALLY. Consequence: the mask set is
   *  spawn-time-static — a bot added AFTER this session spawned isn't covered
   *  until a cold restart (the macOS regex covers new bots without one). */
  siblingAppIds: string[];
  /** Existing `bots.json.*` sidecars (backups/tmp) globbed by the worker at spawn
   *  — each carries every bot's plaintext secret under a dynamic name that no
   *  wholesale rule matches, so they're masked individually. */
  botsJsonSidecars?: string[];
}

/**
 * The bwrap MASK set for Linux read isolation — the functional twin of the macOS
 * Seatbelt read-deny profile ({@link buildV2DenyPaths} + regexes + carve-outs),
 * expressed for bwrap (which blanks paths with tmpfs/empty-binds and has no regex).
 *
 * SAME cross-bot-sensitive set as macOS, but the per-bot classes (other bots'
 * BOT_HOMEs / lark configs / session stores / identities / send-creds / attachment
 * buckets) are enumerated PER SIBLING instead of wholesale-denied + regex-matched.
 * The bot's OWN slice is simply never masked (so it stays readable through the
 * overlay), and its BOT_HOME is additionally bound real+writable via
 * `ownReadWritePaths` so its redirected CLI data persists — matching macOS.
 *
 * Pure: the worker resolves the impure inputs (sibling list, sidecar glob, realpath).
 * NOTE: keep the `shared` set in lock-step with {@link buildV2DenyPaths} — the
 * `read-isolation.test.ts` parity test fails if a sensitive path is added to one
 * platform but not the other.
 */
export function buildLinuxReadIsolationMasks(input: LinuxReadIsolationInput): {
  /** Paths to blank inside bwrap (prepareSandbox stat-classifies: dir→tmpfs,
   *  file→empty ro-bind, missing→skipped). Feed as prepareSandbox.hidePaths. */
  hidePaths: string[];
  /** The bot's OWN BOT_HOME — bound REAL + writable (feed as authPaths) so the
   *  redirected CLI data (CLAUDE_CONFIG_DIR/CODEX_HOME) persists and escapes the
   *  write overlay. Its parent `bots/` is enumerated per-sibling (NOT wholesale-
   *  masked) so this real bind survives. */
  ownReadWritePaths: string[];
  /** The bot's OWN slices that sit UNDER a wholesale-masked parent and must be
   *  re-exposed read-only AFTER the masks (feed as readonlyRoots — bound after the
   *  tmpfs masks). Currently the own attachments bucket, under the wholesale
   *  `data/attachments` mask. Read-only is enough (the agent only READS uploads). */
  ownReadOnlyPaths: string[];
} {
  const { ctx } = input;
  const h = ctx.homeDir.replace(/\/+$/, '');
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
  const self = assertSafeAppId(ctx.currentAppId);
  const keep = (arr: string[]) => dedupe(arr.map(normalizeIsolationPath).filter((p): p is string => !!p));

  // Cross-bot-sensitive paths handled WHOLESALE (not per-bot, OR a per-bot dir with
  // a non-enumerable layout) — MUST mirror the same entries in buildV2DenyPaths.
  const shared = [
    `${h}/.claude`, `${h}/.claude.json`, `${h}/.codex`,
    `${h}/.ssh`, `${h}/.aws`, `${h}/.azure`, `${h}/.gnupg`, `${h}/.netrc`,
    `${h}/.config/gh`, `${h}/.config/glab-cli`, `${h}/.config/gcloud`, `${h}/.config/op`,
    `${h}/.config/1Password`, `${h}/.1password`, `${h}/.password-store`,
    `${h}/.git-credentials`, `${h}/.npmrc`, `${h}/.pypirc`, `${h}/.docker/config.json`, `${h}/.kube`,
    `${h}/Library/Keychains`,
    `${bh}/bots.json`, `${bh}/logs`, `${h}/.lark-cli`,
    `${bh}/feishu-session.json`, `${bh}/.dashboard-secret`, `${bh}/.dashboard-token`,
    `${sd}/sessions.json`, `${sd}/frozen-cards`, `${sd}/turn-sends`,
    `${sd}/crash-diagnostics`, `${sd}/queues`, `${sd}/read-isolation`,
    // attachments/ is masked WHOLESALE (like macOS) — covers every sibling bucket
    // AND the legacy flat per-messageId layout (which per-sibling enumeration can't
    // reach); the OWN bucket is re-exposed read-only via ownReadOnlyPaths below.
    `${sd}/attachments`,
    // schedules.json + whiteboards deliberately NOT masked (same owner decision as
    // macOS: RMW-clobber / shared content).
  ];

  // Per-sibling enumeration for the classes macOS covers by REGEX (bwrap has none):
  // other bots' BOT_HOMEs, lark configs, session stores, identities, send-creds. Own
  // BOT_HOME + lark + session stay UNMASKED (readable via the overlay lower; BOT_HOME
  // also bound real+writable below). identities/send-cred get NO own carve-out — the
  // CLI never reads them (daemon-side) — so the own ones are masked too.
  const perBot: string[] = [];
  for (const raw of input.siblingAppIds) {
    let sib: string;
    try { sib = assertSafeAppId(raw); } catch { continue; }
    if (sib === self) continue;
    perBot.push(
      `${bh}/bots/${sib}`,
      `${h}/.lark-cli-bots/${sib}`,
      `${sd}/sessions-${sib}.json`,
      `${sd}/identities-${sib}.json`,
      `${sd}/.send-cred-${sib}`,
    );
  }
  perBot.push(`${sd}/identities-${self}.json`, `${sd}/.send-cred-${self}`);

  return {
    hidePaths: keep([...shared, ...perBot, ...(input.botsJsonSidecars ?? [])]),
    ownReadWritePaths: keep([botHomePath(bh, self)]),
    ownReadOnlyPaths: keep([`${sd}/attachments/${self}`]),
  };
}

/**
 * Decide whether read isolation is enabled for a session, or fail-closed.
 * Pure: the caller resolves the impure inputs. This is the SINGLE decision
 * point — the worker computes it once and uses it for BOT_HOME redirection,
 * provisioning, and the Seatbelt wrapper alike.
 *  - not configured → `{ enabled: false }` (no error).
 *  - configured but unenforceable → `{ enabled: false, failClosedReason }` — the
 *    caller MUST refuse to start the session rather than run unisolated.
 *  - all satisfied → `{ enabled: true }`.
 */
export function evaluateReadIsolationGate(opts: {
  configured: boolean;
  adapterSupports: boolean;
  wrapperCliSet: boolean;
  /** process.platform — read isolation is enforced by macOS Seatbelt (sandbox-exec)
   *  OR Linux bwrap masks; unsupported elsewhere (fail-closed rather than run
   *  unisolated). NOTE: on Linux the masks ride the bwrap file sandbox, so the caller
   *  must ensure the sandbox is on (see readIsoConfigured in worker.ts). */
  platform: string;
  /** SESSION_DATA_DIR present (BOT_HOME + profile paths derive from it). */
  sessionDataDirSet: boolean;
}): { enabled: boolean; failClosedReason?: string } {
  if (!opts.configured) return { enabled: false };
  if (!opts.adapterSupports)
    return { enabled: false, failClosedReason: 'the CLI adapter does not support read isolation' };
  if (opts.wrapperCliSet)
    return { enabled: false, failClosedReason: 'wrapperCli strips the CLI spawn args, read isolation cannot be enforced' };
  if (opts.platform !== 'darwin' && opts.platform !== 'linux')
    return { enabled: false, failClosedReason: `read isolation unsupported on ${opts.platform}` };
  if (!opts.sessionDataDirSet)
    return { enabled: false, failClosedReason: 'missing SESSION_DATA_DIR' };
  return { enabled: true };
}

/**
 * macOS Seatbelt (sandbox-exec) profile for the whole-process isolation wrapper.
 * Blocklist: allow everything, deny reads of the sensitive paths/patterns, THEN
 * re-allow the carve-outs — `subpath` covers a file or a whole subtree. Rule ORDER
 * matters: Seatbelt applies the LAST matching rule, so an allow listed AFTER a
 * broader deny re-opens that subpath, and the final denies win over the allows.
 * Verified: reads of denied paths fail EPERM; carved-out subpaths read normally; the
 * wrapped CLI (which bypasses its OWN sandbox — nested Seatbelt would hang) runs fine.
 */
export function buildSeatbeltProfile(
  denyPaths: string[],
  allowPaths: string[] = [],
  finalDenyPaths: string[] = [],
  traverseDirs: string[] = [],
  denyRegexes: string[] = [],
  /** When set, layer the macOS file-sandbox WRITE isolation (Linux-bwrap twin) into
   *  the SAME profile: deny all writes, re-allow the writable zones, then final-deny
   *  the crown jewels. Reads are unaffected. Omit for read-isolation-only sessions. */
  writeSandbox?: { allowWritePaths: string[]; allowWriteRegexes?: string[]; denyWritePaths: string[] },
): string {
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Regex literals (#"…") pass backslashes RAW to the regex engine — do NOT
  // double-escape them. A `"` would terminate the literal; swap it for `.`
  // (single-char wildcard that still matches the quote) instead of breaking syntax.
  const escRe = (r: string) => r.replace(/"/g, '.');
  const lines = ['(version 1)', '(allow default)'];
  for (const p of denyPaths) lines.push(`(deny file-read* (subpath "${esc(p)}"))`);
  // Filename-pattern denies (e.g. every bot's sessions-<appId>.json) — no sibling
  // enumeration; the own file is re-opened by an allow below (last-match).
  for (const r of denyRegexes) lines.push(`(deny file-read* (regex #"${escRe(r)}"))`);
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
  // ── Write isolation (macOS file sandbox): deny ALL writes, re-allow the writable
  // zones, then re-deny the crown jewels. Ordered AFTER the read rules but they are
  // an independent operation class (file-write* vs file-read*), so they never
  // interact with the read allow/deny above. Emitted only when write-sandbox is on.
  if (writeSandbox) {
    lines.push('(deny file-write* (subpath "/"))');
    for (const p of writeSandbox.allowWritePaths) lines.push(`(allow file-write* (subpath "${esc(p)}"))`);
    for (const r of writeSandbox.allowWriteRegexes ?? []) lines.push(`(allow file-write* (regex #"${escRe(r)}"))`);
    for (const p of writeSandbox.denyWritePaths) lines.push(`(deny file-write* (subpath "${esc(p)}"))`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Decide whether a live persistent pane (tmux/zellij/herdr) may be reattached for
 * an isolated bot. Isolation is injected at CLI *spawn* time (the Seatbelt
 * wrapper) and lives on the RUNNING process, so a pane that was spawned isolated
 * STAYS isolated for its whole lifetime — including across daemon restarts (the
 * sandbox is on the CLI process, independent of the daemon).
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

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
