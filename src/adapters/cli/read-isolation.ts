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

import {
  DEVICE_AUTHORITY_DIRECTORY,
  DEVICE_CREDENTIAL_FILE,
  DEVICE_ENROLLMENT_JOURNAL_FILE,
} from '../../platform/device-paths.js';

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

/** Host device-authority files must never be visible to a chat-driven CLI.
 * New credentials live below DEVICE_AUTHORITY_DIRECTORY; the exact legacy
 * files remain covered for upgrades from older layouts. */
export const HOST_DEVICE_CREDENTIAL_FILES = [
  'platform.json',
  DEVICE_CREDENTIAL_FILE,
  DEVICE_ENROLLMENT_JOURNAL_FILE,
] as const;
export const DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME = '.device-credential-isolation';

function hostDeviceAuthorityPaths(root: string): string[] {
  return [
    `${root}/${DEVICE_AUTHORITY_DIRECTORY}`,
    ...HOST_DEVICE_CREDENTIAL_FILES.map(file => `${root}/${file}`),
  ];
}

/** Fixed host marker; deliberately independent of SESSION_DATA_DIR and child env. */
export function deviceCredentialIsolationMarkerPath(homeDir: string): string {
  return `${homeDir.replace(/\/+$/, '')}/.botmux/${DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME}`;
}

/** Match current atomic-write sidecars and legacy backups as well as the
 * dedicated authority directory. */
export function isCredentialIsolationReservedBasename(name: string): boolean {
  return name === DEVICE_AUTHORITY_DIRECTORY
    || name === DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME
    || name.startsWith(`${DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME}.`)
    || HOST_DEVICE_CREDENTIAL_FILES.some(file => name === file || name.startsWith(`${file}.`));
}

export function credentialIsolationRequired(input: {
  markerExists: boolean;
  deviceCredentialExists: boolean;
}): boolean {
  return input.markerExists || input.deviceCredentialExists;
}

export type CredentialOnlyIsolationGate =
  | { required: false; mode: 'off' }
  | { required: true; mode: 'remote-bypass' }
  | { required: true; mode: 'covered' }
  | { required: true; mode: 'seatbelt' | 'bwrap' }
  | { required: true; mode: 'blocked'; failClosedReason: string };

/** Mandatory device-credential isolation is independent of the optional bot
 * sandbox toggle: once enrolled, every local child must be confined. */
export function evaluateCredentialOnlyIsolationGate(input: {
  markerExists: boolean;
  deviceCredentialExists: boolean;
  remoteBackend: boolean;
  platform: string;
  mechanismAvailable: boolean;
  fullIsolationCoversCredentials: boolean;
}): CredentialOnlyIsolationGate {
  const required = credentialIsolationRequired(input);
  if (!required) return { required: false, mode: 'off' };
  if (input.remoteBackend) return { required: true, mode: 'remote-bypass' };
  if (input.fullIsolationCoversCredentials) return { required: true, mode: 'covered' };
  if (input.platform !== 'darwin' && input.platform !== 'linux') {
    return {
      required: true,
      mode: 'blocked',
      failClosedReason: `credential isolation unsupported on ${input.platform}`,
    };
  }
  if (!input.mechanismAvailable) {
    return {
      required: true,
      mode: 'blocked',
      failClosedReason: input.platform === 'darwin'
        ? 'sandbox-exec is unavailable'
        : 'bubblewrap is unavailable',
    };
  }
  return { required: true, mode: input.platform === 'darwin' ? 'seatbelt' : 'bwrap' };
}

export interface CredentialIsolationContext {
  homeDir: string;
  botmuxHome: string;
  defaultBotmuxHome?: string;
}

function escapeForRegex(p: string): string {
  return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Legacy credential-only Seatbelt/bwrap rule shape. Full fs-policy sessions
 * consume the same authority paths through buildFsPolicy instead. */
export function buildCredentialIsolationRules(ctx: CredentialIsolationContext): {
  roots: string[];
  denyPaths: string[];
  denyRegexes: string[];
  denyWritePaths: string[];
  denyWriteRegexes: string[];
  denyWriteLiterals: string[];
} {
  const h = ctx.homeDir.replace(/\/+$/, '');
  const bh = ctx.botmuxHome.replace(/\/+$/, '');
  const defaultBh = (ctx.defaultBotmuxHome ?? `${h}/.botmux`).replace(/\/+$/, '');
  const roots = dedupe([defaultBh, bh]);
  const credentialPaths = roots.flatMap(hostDeviceAuthorityPaths);
  const markerPath = `${defaultBh}/${DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME}`;
  const denyRegexes = roots.flatMap(root =>
    HOST_DEVICE_CREDENTIAL_FILES.map(file =>
      `^${escapeForRegex(root)}/${escapeForRegex(file)}(?:\\.|$)`));
  denyRegexes.push(
    `^${escapeForRegex(defaultBh)}/${escapeForRegex(DEVICE_CREDENTIAL_ISOLATION_MARKER_BASENAME)}(?:\\.|$)`,
  );
  return {
    roots,
    denyPaths: dedupe([...credentialPaths, markerPath]),
    denyRegexes: dedupe(denyRegexes),
    denyWritePaths: dedupe([...credentialPaths, markerPath]),
    denyWriteRegexes: dedupe(denyRegexes),
    denyWriteLiterals: roots,
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

/** Legacy allow-default profile retained only for mandatory credential-only
 * confinement when the full fs-policy sandbox is disabled. */
export function buildSeatbeltProfile(
  denyPaths: string[],
  allowPaths: string[] = [],
  finalDenyPaths: string[] = [],
  traverseDirs: string[] = [],
  denyRegexes: string[] = [],
  writeSandbox?: {
    allowWritePaths: string[];
    allowWriteRegexes?: string[];
    denyWritePaths: string[];
    denyWriteRegexes?: string[];
  },
  protectedWrites?: {
    denyWritePaths: string[];
    denyWriteRegexes?: string[];
    denyWriteLiterals?: string[];
  },
): string {
  const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escRe = (r: string) => r.replace(/"/g, '.');
  const lines = ['(version 1)', '(allow default)'];
  for (const p of denyPaths) lines.push(`(deny file-read* (subpath "${esc(p)}"))`);
  for (const r of denyRegexes) lines.push(`(deny file-read* (regex #"${escRe(r)}"))`);
  for (const p of traverseDirs) lines.push(`(allow file-read-metadata (literal "${esc(p)}"))`);
  for (const p of allowPaths) lines.push(`(allow file-read* (subpath "${esc(p)}"))`);
  for (const p of finalDenyPaths) lines.push(`(deny file-read* (subpath "${esc(p)}"))`);
  if (writeSandbox) {
    lines.push('(deny file-write* (subpath "/"))');
    for (const p of writeSandbox.allowWritePaths) lines.push(`(allow file-write* (subpath "${esc(p)}"))`);
    for (const r of writeSandbox.allowWriteRegexes ?? []) lines.push(`(allow file-write* (regex #"${escRe(r)}"))`);
    for (const p of writeSandbox.denyWritePaths) lines.push(`(deny file-write* (subpath "${esc(p)}"))`);
    for (const r of writeSandbox.denyWriteRegexes ?? []) lines.push(`(deny file-write* (regex #"${escRe(r)}"))`);
  }
  for (const p of protectedWrites?.denyWritePaths ?? []) {
    lines.push(`(deny file-write* (subpath "${esc(p)}"))`);
  }
  for (const r of protectedWrites?.denyWriteRegexes ?? []) {
    lines.push(`(deny file-write* (regex #"${escRe(r)}"))`);
  }
  for (const p of protectedWrites?.denyWriteLiterals ?? []) {
    lines.push(`(deny file-write* (literal "${esc(p)}"))`);
  }
  return lines.join('\n') + '\n';
}

// A marker records which confinement capabilities are attached to the live
// process. Credential-only panes must cold-spawn when a full sandbox is enabled.
export const ISOLATION_PANE_MARKER_VERSION = 7;

export type IsolationCapability = 'credential' | 'read' | 'write';

const ALL_ISOLATION_CAPABILITIES: readonly IsolationCapability[] = [
  'credential',
  'read',
  'write',
] as const;

function normalizeIsolationCapabilities(
  capabilities: readonly IsolationCapability[],
): IsolationCapability[] {
  const requested = new Set(capabilities);
  return ALL_ISOLATION_CAPABILITIES.filter(capability => requested.has(capability));
}

export function isolationPaneMarkerContent(
  bootId: string,
  capabilities: readonly IsolationCapability[],
): string {
  return JSON.stringify({
    version: ISOLATION_PANE_MARKER_VERSION,
    bootId,
    capabilities: normalizeIsolationCapabilities(capabilities),
  });
}

/**
 * Decide whether a live persistent pane (tmux/zellij/herdr) may be reattached for
 * an isolated bot. Isolation is injected at CLI *spawn* time (the Seatbelt
 * wrapper) and lives on the RUNNING process, so a pane that was spawned isolated
 * STAYS isolated for its whole lifetime — including across daemon restarts (the
 * sandbox is on the CLI process, independent of the daemon).
 *
 * We stamp a versioned marker file when we spawn an isolated CLI. A reattach is
 * safe only when the live process was launched with the current policy version.
 * This matters during security upgrades: a legacy Seatbelt process keeps its old
 * permissions across daemon restarts and must be cold-spawned under the new
 * profile. The boot id remains diagnostic and is not compared across restarts.
 */
export function isolatedPaneReattachSafe(
  markerContent: string | null | undefined,
  requiredCapabilities: readonly IsolationCapability[] = [],
): boolean {
  try {
    const parsed = JSON.parse(markerContent ?? '') as {
      version?: unknown;
      bootId?: unknown;
      capabilities?: unknown;
    };
    if (!Array.isArray(parsed.capabilities)
      || parsed.capabilities.some(capability =>
        typeof capability !== 'string'
        || !ALL_ISOLATION_CAPABILITIES.includes(capability as IsolationCapability))) {
      return false;
    }
    const actual = new Set(parsed.capabilities as IsolationCapability[]);
    return parsed.version === ISOLATION_PANE_MARKER_VERSION
      && typeof parsed.bootId === 'string'
      && parsed.bootId.trim().length > 0
      && requiredCapabilities.every(capability => actual.has(capability));
  } catch {
    return false;
  }
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
