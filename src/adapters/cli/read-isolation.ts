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

import { createHash } from 'node:crypto';
import type { SessionProbe } from '../backend/types.js';
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

/** Whether a worker can redirect CLI data into BOT_HOME for this session.
 * A forced per-bot home (currently Codex `codexAuthSync=isolated`) is separate
 * from the OS sandbox: it changes CLI state ownership without implying file
 * read/write confinement. */
export function shouldRedirectCliData(input: {
  sandboxRequested: boolean;
  forcePerBotHome?: boolean;
  supportsReadIsolation: boolean;
  wrapperCli?: string;
  sessionDataDir?: string;
}): boolean {
  return (input.sandboxRequested || input.forcePerBotHome === true)
    && input.supportsReadIsolation
    && !input.wrapperCli
    && !!input.sessionDataDir;
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
//
// BUMP THIS whenever the START-TIME sandbox contract of an isolated CLI changes
// in a way a still-running process cannot satisfy — warm reattach preserves the
// live process + its original bwrap mounts/env untouched, so a new mount/env the
// reattach path relies on but the old process lacks makes reattach unsafe.
//   · 7 → 8 (#709): isolated CLIs must carry host-injected BOTMUX_READ_ISOLATION
//     / BOTMUX_API_ONLY env (bots.json EPERM fix). Panes spawned by v3.8.0 have a
//     v7 marker but a process with NEITHER key, so `botmux` inside them dies on
//     the denied bots.json read; reattaching leaves the regression unfixed after
//     a plain `daemon:restart`.
//   · 8 → 9 (#714): traex/coco now bind ~/.trae migration done-markers read-only
//     (sandboxReadonlyPaths) so goal-mode stops wedging on the TRAE first-run
//     migration prompt. That is a new spawn-time mount; a pane predating it warm-
//     reattaches with the old mount set and still wedges, so it must cold-spawn.
//   · 9 → 10: credential-only Seatbelt/bwrap panes receive a private rotating
//     managed-origin channel for capability-gated daemon IPC. A warm pane with
//     the v9 marker lacks both the env and the private read carve-out.
//   · 10 → 11: provenance proofs gain a two-phase `state:'pending'|'committed'`
//     lifecycle (generational-race fix). A v10 marker was written UNCONDITIONALLY
//     BEFORE spawn (the vulnerable path) and has NO `state` field, so a late-winner
//     pane may already wear a "valid" v10 marker it never earned. Requiring v11 +
//     strict `state:'committed'` forces every pre-existing no-state marker to
//     cold-spawn ONCE under the new pending→commit contract — closing the INSTALLED
//     BASE risk, not just new spawns. (A legacy no-state marker is now version-
//     rejected, so validators no longer need to tolerate `state===undefined`.)
// #709 (→8) merged first; this PR (#714) rebased on top and takes 9. Numbers stay
// strictly monotonic — a pane at any intermediate version must be rejected so it
// cold-spawns under the current contract rather than bypassing a migration.
export const ISOLATION_PANE_MARKER_VERSION = 11;

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

export interface IsolationPanePolicyInput {
  readIsolation: boolean;
  writeSandbox: boolean;
  readDenyExtraPaths?: readonly string[];
  writeAllowExtraPaths?: readonly string[];
  readOnlyExtraPaths?: readonly string[];
  readWriteExtraPaths?: readonly string[];
  workingDir?: string;
  homeDir?: string;
  osUserHomeDir?: string;
  botmuxHome?: string;
  sessionDataDir?: string;
  currentAppId?: string;
  cliId?: string;
  resolvedBin?: string;
}

/** Deterministic fingerprint of effective Darwin Seatbelt inputs that can
 * change between worker forks while the pane survives. Arrays are normalized
 * as sets because rule order does not change their final deny semantics. */
export function isolationPanePolicyDigest(input: IsolationPanePolicyInput): string {
  const normalizedExtra = (input.readDenyExtraPaths ?? [])
    .map(normalizeIsolationPath)
    .filter((value): value is string => !!value)
    .sort();
  const normalizedWriteExtra = (input.writeAllowExtraPaths ?? [])
    .map(normalizeIsolationPath)
    .filter((value): value is string => !!value)
    .sort();
  const normalizedReadOnlyExtra = (input.readOnlyExtraPaths ?? [])
    .map(normalizeIsolationPath)
    .filter((value): value is string => !!value)
    .sort();
  const normalizedReadWriteExtra = (input.readWriteExtraPaths ?? [])
    .map(normalizeIsolationPath)
    .filter((value): value is string => !!value)
    .sort();
  return createHash('sha256').update(JSON.stringify({
    domain: 'botmux.darwin-seatbelt-policy.v7',
    readIsolation: input.readIsolation,
    writeSandbox: input.writeSandbox,
    readDenyExtraPaths: normalizedExtra,
    writeAllowExtraPaths: normalizedWriteExtra,
    readOnlyExtraPaths: normalizedReadOnlyExtra,
    readWriteExtraPaths: normalizedReadWriteExtra,
    workingDir: input.workingDir ?? '',
    homeDir: input.homeDir ?? '',
    osUserHomeDir: input.osUserHomeDir ?? '',
    botmuxHome: input.botmuxHome ?? '',
    sessionDataDir: input.sessionDataDir ?? '',
    currentAppId: input.currentAppId ?? '',
    cliId: input.cliId ?? '',
    resolvedBin: input.resolvedBin ?? '',
  })).digest('hex');
}

export function isolationPaneMarkerContent(
  bootId: string,
  capabilities: readonly IsolationCapability[],
  policy?: {
    originChannelId: string;
    readIsolation: boolean;
    writeSandbox: boolean;
    policyDigest: string;
  },
): string {
  if (policy
    && (!/^[a-f0-9]{64}$/.test(policy.originChannelId)
      || !/^[a-f0-9]{64}$/.test(policy.policyDigest))) {
    throw new Error('invalid isolation marker policy');
  }
  return JSON.stringify({
    version: ISOLATION_PANE_MARKER_VERSION,
    bootId,
    capabilities: normalizeIsolationCapabilities(capabilities),
    // Committed = an attributably-fresh generation was established (the proof is
    // written PENDING before the pane exists, then rewritten committed only after
    // spawn confirms a fresh, non-reattached generation). isolatedPaneReattachSafe
    // refuses anything whose state is present-but-not-'committed'.
    state: 'committed',
    ...(policy ?? {}),
  });
}

export function isolatedPaneOriginChannel(
  markerContent: string | null | undefined,
): string | undefined {
  try {
    const parsed = JSON.parse(markerContent ?? '') as { originChannelId?: unknown };
    return typeof parsed.originChannelId === 'string'
      && /^[a-f0-9]{64}$/.test(parsed.originChannelId)
      ? parsed.originChannelId
      : undefined;
  } catch {
    return undefined;
  }
}

/** Directory holding per-session persistent-pane provenance files. */
export function persistentPaneProvenanceDir(runtimeDataDir: string): string {
  return `${runtimeDataDir.replace(/\/+$/, '')}/read-isolation`;
}

/** ISOLATION marker path (`<sid>.boot`) — stamped for a policy-ON sandboxed pane. */
export function isolationPaneMarkerPath(runtimeDataDir: string, sessionId: string): string {
  return `${persistentPaneProvenanceDir(runtimeDataDir)}/${assertSafeAppId(sessionId)}.boot`;
}

/** TOMBSTONE path (`<sid>.policy-off`) — positively proves a live pane was
 *  cold-spawned by the current NO-SANDBOX policy (see
 *  {@link evaluatePersistentPaneMigration}). Distinct filename so it survives /
 *  is cleared independently of the isolation marker. */
export function policyOffTombstonePath(runtimeDataDir: string, sessionId: string): string {
  return `${persistentPaneProvenanceDir(runtimeDataDir)}/${assertSafeAppId(sessionId)}.policy-off`;
}

/** Tombstone body: a self-describing, version-stamped generation proof. Content
 *  is diagnostic-bearing but its PRESENCE-as-valid (not equality to any live boot
 *  id) is the reattach signal — a legitimate policy-off pane warm-reattaches
 *  across daemon restarts, so binding to the current boot id would cold-spawn it
 *  every restart. bootId is kept only for diagnostics.
 *
 *  `state:'committed'` is REQUIRED for authorization: a proof is written first as
 *  PENDING (see {@link provenancePendingContent}) before the pane is created, and
 *  only rewritten to committed once the fresh generation is attributably
 *  established (see the generational-race guard in worker.ts). A pending record
 *  never authorizes a reattach — {@link policyOffTombstoneValid} rejects it. */
export function policyOffTombstoneContent(bootId: string): string {
  return JSON.stringify({ version: ISOLATION_PANE_MARKER_VERSION, policyOff: true, bootId, state: 'committed' });
}

/**
 * PENDING provenance body: written to the FINAL proof path BEFORE `backend.spawn()`
 * for a predicted-fresh persistent launch, then rewritten to the committed body
 * only after the fresh generation is attributably established. It carries a random
 * `nonce` (compare-before-replace at commit time, so a superseded generation's
 * deferred callback can't overwrite a newer pending) and, deliberately, NEITHER a
 * committed `state` NOR the structural fields the validators require — so both
 * {@link policyOffTombstoneValid} and {@link isolatedPaneReattachSafe} reject it
 * outright. Its on-disk PRESENCE still drives the conservative guard: a pending
 * file means "this system KNOWS a generation's attribution is incomplete", which
 * is STRONGER than legacy provenance and dominates the migration scope (a live
 * pane with a pending proof is always killed + cold-spawned; see
 * {@link evaluatePersistentPaneMigration}).
 */
export function provenancePendingContent(nonce: string): string {
  return JSON.stringify({ version: ISOLATION_PANE_MARKER_VERSION, state: 'pending', nonce });
}

/** Extract the pending nonce for the compare-before-replace at commit time.
 *  Returns the nonce string only for a well-formed pending record read from a
 *  secure 0600 file; null otherwise (so a garbage/committed/absent file never
 *  matches a live launch's nonce). */
export function provenancePendingNonce(content: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(content ?? '') as { state?: unknown; nonce?: unknown };
    return parsed.state === 'pending' && typeof parsed.nonce === 'string' && parsed.nonce.length > 0
      ? parsed.nonce
      : null;
  } catch {
    return null;
  }
}

/**
 * Validate a policy-off tombstone body (already securely read from a real 0600
 * file by the caller — see readManagedOriginAuthorityFile). Returns true only for
 * a well-formed CURRENT-version `policyOff:true` record with a non-empty string
 * bootId. bootId is NOT compared to the live daemon boot id (a legit policy-off
 * pane must reattach across restarts); it only has to be present + a string, so a
 * blank/garbage/structurally-wrong tombstone cannot authorize a warm reattach.
 * Mirror of {@link isolatedPaneReattachSafe}'s fail-closed parse discipline, but
 * for the opposite polarity: here VALID authorizes reattach.
 *
 * A `state:'pending'` record is explicitly rejected (an incomplete generation
 * proof must never authorize). `state` is now REQUIRED to equal 'committed': the
 * v11 version bump means every legitimate proof carries it, so a missing/other
 * state is refused (this is what forces a pre-v11 no-state marker — possibly
 * washed onto a late-winner pane under the old pre-spawn-write path — to
 * cold-spawn once instead of being trusted).
 */
export function policyOffTombstoneValid(content: string | null | undefined): boolean {
  try {
    const parsed = JSON.parse(content ?? '') as {
      version?: unknown; policyOff?: unknown; bootId?: unknown; state?: unknown;
    };
    return parsed.version === ISOLATION_PANE_MARKER_VERSION
      && parsed.policyOff === true
      && typeof parsed.bootId === 'string'
      && parsed.bootId.trim().length > 0
      && parsed.state === 'committed';
  } catch {
    return false;
  }
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
  expected: readonly IsolationCapability[] | {
    requiredCapabilities: readonly IsolationCapability[];
    exactCapabilities?: boolean;
    readIsolation?: boolean;
    writeSandbox?: boolean;
    requireOriginChannel?: boolean;
    policyDigest?: string;
  } = [],
): boolean {
  try {
    const parsed = JSON.parse(markerContent ?? '') as {
      version?: unknown;
      bootId?: unknown;
      capabilities?: unknown;
      readIsolation?: unknown;
      writeSandbox?: unknown;
      originChannelId?: unknown;
      policyDigest?: unknown;
      state?: unknown;
    };
    if (parsed.version !== ISOLATION_PANE_MARKER_VERSION
      || typeof parsed.bootId !== 'string'
      || parsed.bootId.trim().length === 0
      // A committed generation proof is REQUIRED. A PENDING record (written before
      // the pane is attributably established) must never authorize; and with the
      // v11 bump every legitimate marker carries state:'committed', so a
      // missing/other state (e.g. a washed pre-v11 no-state marker) is refused →
      // cold-spawn once. (Version check above already rejects pre-v11; this keeps
      // the contract explicit and rejects a same-version pending.)
      || parsed.state !== 'committed'
      || !Array.isArray(parsed.capabilities)
      || parsed.capabilities.some(capability =>
        typeof capability !== 'string'
        || !ALL_ISOLATION_CAPABILITIES.includes(capability as IsolationCapability))) {
      return false;
    }
    const expectedPolicy = Array.isArray(expected)
      ? undefined
      : expected as {
          requiredCapabilities: readonly IsolationCapability[];
          exactCapabilities?: boolean;
          readIsolation?: boolean;
          writeSandbox?: boolean;
          requireOriginChannel?: boolean;
          policyDigest?: string;
        };
    const requiredCapabilities: readonly IsolationCapability[] = expectedPolicy
      ? expectedPolicy.requiredCapabilities
      : expected as readonly IsolationCapability[];
    const actual = new Set(parsed.capabilities as IsolationCapability[]);
    if (!requiredCapabilities.every(capability => actual.has(capability))) return false;
    if (expectedPolicy?.exactCapabilities
      && actual.size !== new Set(requiredCapabilities).size) return false;
    if (!expectedPolicy) return true;
    if (expectedPolicy.readIsolation !== undefined
      && parsed.readIsolation !== expectedPolicy.readIsolation) return false;
    if (expectedPolicy.writeSandbox !== undefined
      && parsed.writeSandbox !== expectedPolicy.writeSandbox) return false;
    if (expectedPolicy.policyDigest !== undefined
      && parsed.policyDigest !== expectedPolicy.policyDigest) return false;
    return !expectedPolicy.requireOriginChannel
      || (typeof parsed.originChannelId === 'string'
        && /^[a-f0-9]{64}$/.test(parsed.originChannelId));
  } catch {
    return false;
  }
}

/**
 * Persistent-pane (tmux/zellij/herdr/zmx) reattach migration decision — the pure
 * state machine behind the worker's stale-pane guard. Isolation is injected at
 * CLI *spawn* time and lives on the RUNNING process, so a pane that survives a
 * daemon restart keeps whatever confinement it was born with. This function
 * decides, from persisted evidence + the current policy, whether the live pane
 * may be warm-reattached or must be killed + cold-spawned under the new policy.
 *
 * Two provenance files live under `<runtimeDataDir>/read-isolation/`:
 *   · `<sid>.boot`      — ISOLATION marker: written (best-effort) when a policy-ON
 *                         (sandboxed) pane is spawned. Its capabilities/policy are
 *                         version-checked by {@link isolatedPaneReattachSafe}.
 *   · `<sid>.policy-off` — TOMBSTONE: written when a policy-OFF (no-sandbox) pane
 *                         is cold-spawned, positively proving "this generation was
 *                         created by the current no-sandbox policy".
 *
 * Why a tombstone and not just "no isolation marker": the isolation stamp is
 * BEST-EFFORT (its write is wrapped in try/catch and the spawn proceeds anyway),
 * so "no marker" does NOT prove the live process was never isolated — a sandboxed
 * pane whose stamp write lost a race/perm/disk error looks identical. Under
 * policy-OFF we therefore require POSITIVE, VALIDATED proof (a tombstone that
 * passes secure-read + schema check) to warm-reattach; any other shape (isolation
 * marker present, tombstone missing/invalid, or NEITHER file) is treated as
 * possibly-still-confined and killed. Absence is never trusted as safe.
 *
 * Scope is split by policy direction:
 *   · policy ON (file sandbox OR credential-only `credential` cap): the exact-
 *     capability/policy check runs on EVERY persistent backend — credential-only
 *     panes exist on zellij/herdr/zmx too, so this must NOT be tmux-scoped.
 *   · policy OFF migration arm: scoped to `noTransport && isolationCapableBackend`
 *     (only no-transport tmux was ever file-force-isolated by the removed rule).
 *     An ordinary transport chat / non-tmux backend is never subjected to the
 *     tombstone requirement — no false kills — though a DEAD pane's stale
 *     provenance is still cleared so it cannot mislead a later decision.
 *
 * Existence flags MUST come from no-follow existence probes (a planted/tampered
 * leaf that fails to parse still counts as present, so it can never be used to
 * force a silent reattach). `policyOffTombstoneValid` is the secure-read result.
 *
 * Pane liveness is TRI-STATE (`paneProbe`: exists | missing | unknown), NOT a
 * boolean. `unknown` (the backend could not answer) is never collapsed into
 * "dead": a still-alive, still-confined pane whose probe is momentarily `unknown`
 * would otherwise have its provenance cleared and be cold-spawned around, silently
 * downgrading confinement. On `unknown` the machine returns
 * `refuse-inconclusive-probe` (fail-closed) whenever anything is at stake — policy
 * ON, in the policy-off migration scope, or ANY provenance on disk — and only
 * `skip`s when a wholly unconcerned session (policy OFF, out of scope, no
 * provenance) sees probe flakiness, so an ordinary chat never fails to start.
 * Only an authoritative `missing` clears stale provenance / cold-spawns.
 */
export type PersistentPaneMigrationInput = {
  /** Current-spawn isolation capabilities (empty ⇒ policy OFF this spawn). May be
   *  non-empty on ANY persistent backend — `credential` is pushed for enrolled
   *  hosts independent of the file sandbox, and its wrapper applies to
   *  tmux/zellij/herdr/zmx alike. So the policy-ON capability check below is NOT
   *  scoped to tmux. */
  appliedIsolationCapabilities: readonly IsolationCapability[];
  /** Backend can carry a FILE sandbox (tmux). Scopes ONLY the policy-off
   *  no-transport migration arm (the removed force-isolation rule only ever
   *  file-sandboxed tmux); policy-ON capability checks run on every backend. */
  isolationCapableBackend: boolean;
  /** apiOnly bot OR HTTP-virtual chat — the sessions the old rule force-isolated. */
  noTransport: boolean;
  /** `<sid>.boot` exists on disk (no-follow existence — planted/garbage counts). */
  isolationMarkerPresent: boolean;
  /** `<sid>.policy-off` tombstone exists on disk (no-follow existence). Triggers
   *  CLEANUP / conservative decisions; does NOT by itself authorize a reattach. */
  policyOffTombstonePresent: boolean;
  /** The `<sid>.policy-off` tombstone passed secure-read + schema/version
   *  validation ({@link policyOffTombstoneValid}). ONLY this authorizes a
   *  policy-off warm reattach. */
  policyOffTombstoneValid: boolean;
  /** The persistent pane's liveness probe — TRI-STATE, NOT a boolean. `exists`
   *  and `missing` are authoritative; `unknown` means the probe could not answer
   *  (flaky/unavailable backend). Collapsing `unknown` into "dead" is the bug this
   *  field prevents: a still-alive, still-confined pane whose probe is momentarily
   *  `unknown` must never have its provenance cleared nor be cold-spawned around.
   *  Only an authoritative `missing` proves the pane is gone. */
  paneProbe: SessionProbe;
  /** A PENDING provenance file (marker OR tombstone whose secure-read body parses
   *  as `state:'pending'`) is present on disk. This is STRONGER than legacy
   *  provenance and DOMINATES everything below: it means the system explicitly
   *  knows a generation's fresh-attribution never completed (crash between
   *  pending-write and commit, or a late-flip/collision that was never committed).
   *  A pending file is evaluated FIRST, on ALL backends and BOTH policy directions,
   *  independent of the tmux migration scope — `exists`→kill, `unknown`→refuse,
   *  `missing`→clear. Its no-follow presence also keeps isolationMarkerPresent /
   *  policyOffTombstonePresent true (the file exists), but the pending branch runs
   *  before any of the committed-provenance logic. */
  pendingProvenancePresent: boolean;
  /**
   * Result of {@link isolatedPaneReattachSafe}(marker, current policy) — only
   * meaningful when policy is ON. The caller computes it (it needs the parsed
   * marker + policy digest); passed in to keep this function pure.
   */
  isolationMarkerReattachSafe: boolean;
};

export type PersistentPaneMigrationDecision =
  /** Guard does not apply (nothing to evaluate). */
  | { action: 'skip' }
  /** Live pane matches the current policy → keep the running process. */
  | { action: 'reattach' }
  /** Live pane's provenance is wrong/unknown → kill, then cold-spawn. Provenance
   *  files are cleared ONLY AFTER the kill is confirmed (clearAfterKill). */
  | { action: 'kill-then-cold-spawn'; clearAfterKill: boolean }
  /** No live pane, but stale provenance files linger → clear them (verified) then
   *  cold-spawn fresh, so a later restart doesn't misjudge the new pane. */
  | { action: 'clear-stale-then-cold-spawn' }
  /** The liveness probe is INCONCLUSIVE (`unknown`) in a context where acting would
   *  be unsafe — clearing provenance the pane might still own, or cold-spawning
   *  around a pane a later `exists` probe would warm-reattach unvalidated. The
   *  caller MUST refuse to start rather than guess (fail-closed). Only reached when
   *  the guard is security-concerned; an ordinary transport chat with no provenance
   *  skips on `unknown` instead (no gratuitous start-failures on probe flakiness). */
  | { action: 'refuse-inconclusive-probe' };

export function evaluatePersistentPaneMigration(
  input: PersistentPaneMigrationInput,
): PersistentPaneMigrationDecision {
  const {
    appliedIsolationCapabilities, isolationCapableBackend, noTransport,
    isolationMarkerPresent, policyOffTombstonePresent, policyOffTombstoneValid: tombstoneValid,
    paneProbe, pendingProvenancePresent, isolationMarkerReattachSafe,
  } = input;
  const policyOn = appliedIsolationCapabilities.length > 0;
  const anyProvenance = isolationMarkerPresent || policyOffTombstonePresent;
  const paneLive = paneProbe === 'exists';

  // ── PENDING dominates everything (all backends, both policy directions, ANY
  //    scope). A pending provenance file means the system EXPLICITLY knows a
  //    generation's fresh-attribution never completed — a crash between the
  //    pre-spawn pending-write and the post-spawn commit, or a late-flip/collision
  //    that was never committed. This is STRONGER than legacy provenance, so it is
  //    judged BEFORE the migration-scope logic (which would otherwise `skip` a
  //    live pane out of the tmux scope and warm-reattach an undetermined
  //    generation — e.g. an enrolled zellij pane whose credential policy later
  //    flipped OFF). Only an authoritative `missing` clears it; `unknown` refuses
  //    (never erase evidence of a possibly-live pane); `exists` kills + cold-spawns.
  if (pendingProvenancePresent) {
    if (paneProbe === 'exists') return { action: 'kill-then-cold-spawn', clearAfterKill: true };
    if (paneProbe === 'unknown') return { action: 'refuse-inconclusive-probe' };
    return { action: 'clear-stale-then-cold-spawn' }; // authoritative missing
  }

  // TRI-STATE liveness. `unknown` is NOT "dead": the backend (tmux/zellij/herdr/
  // zmx) could not answer, so the pane may still be alive AND still confined under
  // its original (possibly obsolete) policy. Acting on `unknown` — clearing
  // provenance the pane might still own, or cold-spawning around it so a later
  // `exists` probe warm-reattaches an unvalidated generation — is exactly the
  // silent-downgrade this guard exists to prevent. We fail closed on `unknown`
  // whenever there is anything at stake (policy ON, in the policy-off migration
  // scope, or ANY provenance on disk); only a truly unconcerned session (policy
  // OFF, out of scope, no provenance) skips on `unknown` so probe flakiness on an
  // ordinary chat never blocks startup. Only an authoritative `missing` is trusted
  // as "the pane is gone".
  const inMigrationScope = noTransport && isolationCapableBackend;
  const guardConcerned = policyOn || inMigrationScope || anyProvenance;

  if (policyOn) {
    // Policy ON (file sandbox OR credential-only): runs on EVERY persistent
    // backend — credential-only panes on zellij/herdr/zmx carry a marker too, so
    // this check must not be scoped to tmux (that would skip their capability
    // validation and warm-reattach a stale/mismatched credential pane).
    if (paneLive) {
      // Only a live pane stamped under the CURRENT policy may reattach; a
      // legacy/mismatched one is killed. (isolationMarkerReattachSafe already
      // fail-closes on a missing/garbage marker.)
      if (isolationMarkerReattachSafe) return { action: 'reattach' };
      return { action: 'kill-then-cold-spawn', clearAfterKill: true };
    }
    // Not authoritatively alive. An `unknown` probe under policy ON must not clear
    // a still-confined pane's marker nor cold-spawn around it — fail closed.
    if (paneProbe === 'unknown') return { action: 'refuse-inconclusive-probe' };
    // Authoritative `missing`: nothing to reattach. A fresh policy-on spawn
    // re-stamps its marker, but any stale tombstone from a prior policy-off
    // generation must be cleared first, or a later flip back to policy-off could
    // misread it.
    if (anyProvenance) return { action: 'clear-stale-then-cold-spawn' };
    return { action: 'skip' };
  }

  // Policy OFF. The file-sandbox migration only ever confined no-transport tmux
  // sessions, so the tombstone requirement is scoped to them; an ordinary chat
  // (or a non-file-sandboxable backend) was never force-isolated and is left
  // untouched — EXCEPT we still clear any stale provenance on a dead pane so a
  // lingering file can't mislead a future decision.
  if (paneLive) {
    if (!inMigrationScope) return { action: 'skip' };
    // Warm reattach requires POSITIVE, VALIDATED proof the live generation is a
    // known policy-off pane: a VALID tombstone AND no isolation marker. Any other
    // shape — isolation marker present (dominates), tombstone missing/invalid, or
    // NEITHER file (absence never proves "was never isolated", since the isolation
    // stamp is best-effort) — is treated as possibly-still-confined and killed.
    const provenPolicyOffGeneration = tombstoneValid && !isolationMarkerPresent;
    if (provenPolicyOffGeneration) return { action: 'reattach' };
    return { action: 'kill-then-cold-spawn', clearAfterKill: true };
  }

  // Not authoritatively alive under policy OFF.
  if (paneProbe === 'unknown') {
    // Inconclusive. Clearing provenance now could delete the marker/tombstone of a
    // pane that is actually still alive (and, if it predates the 放宽, still
    // confined) — and cold-spawning would let a later `exists` probe warm-reattach
    // that unvalidated pane. Fail closed whenever the guard is concerned; a wholly
    // unconcerned session (out of scope, no provenance) just skips.
    return guardConcerned ? { action: 'refuse-inconclusive-probe' } : { action: 'skip' };
  }

  // Authoritative `missing`. Clear any lingering provenance (verified) before the
  // fresh cold-spawn regardless of scope — a stale file must never survive to
  // mislead a later restart.
  if (anyProvenance) return { action: 'clear-stale-then-cold-spawn' };
  return { action: 'skip' };
}

/**
 * Injectable side-effect seam for {@link executePersistentPaneMigration}. The
 * worker supplies real implementations (backend kill, post-kill probe, verified
 * provenance removal, backend re-selection); tests supply mocks to observe the
 * ORDER of effects and the "not called" guarantees on each failure path — the
 * part a pure truth-table cannot cover.
 */
export type PersistentPaneMigrationEffects = {
  /** Kill the stale persistent pane. Throw on failure — caller must NOT proceed. */
  killStalePane: () => void;
  /** Probe AFTER the kill; throw (fail-closed) if termination cannot be confirmed. */
  confirmPaneGone: () => void;
  /** Remove BOTH provenance files, each verified-gone; throw if any cannot be
   *  removed (fail-closed — a surviving file would mis-drive the next restart). */
  clearProvenanceVerified: () => void;
  /** Re-select the backend so a stale isReattach=true does not target the pane we
   *  just destroyed. Only called after a confirmed kill + cleared provenance. */
  reselectBackend: () => void;
  /** Refuse to start the session because the liveness probe was inconclusive
   *  (`unknown`) where acting would be unsafe. MUST throw — there is no safe
   *  fall-through. */
  refuseInconclusiveProbe: () => never;
};

/**
 * Execute a {@link PersistentPaneMigrationDecision} with strict fail-closed
 * ordering. Extracted from the worker so the ordering + "stop on failure"
 * guarantees are unit-testable with injected effects:
 *
 *   kill-then-cold-spawn : killStalePane → confirmPaneGone → (clearAfterKill?
 *                          clearProvenanceVerified) → reselectBackend.
 *     Any throw from killStalePane or confirmPaneGone aborts BEFORE clearing
 *     provenance (evidence is preserved for the retry) and BEFORE reselect. A
 *     throw from clearProvenanceVerified aborts BEFORE reselect (never publish a
 *     new generation while a stale proof lingers).
 *   clear-stale-then-cold-spawn : clearProvenanceVerified only (no live pane to
 *                          kill; a throw aborts the spawn).
 *   refuse-inconclusive-probe : refuseInconclusiveProbe (always throws — the probe
 *                          was `unknown` where clearing/cold-spawning is unsafe).
 *                          NO provenance is touched and NO reselect happens.
 *   reattach / skip : no effects.
 *
 * Returns the action taken so the caller can branch (e.g. set warm-reattach).
 */
export function executePersistentPaneMigration(
  decision: PersistentPaneMigrationDecision,
  effects: PersistentPaneMigrationEffects,
): PersistentPaneMigrationDecision['action'] {
  switch (decision.action) {
    case 'reattach':
    case 'skip':
      return decision.action;
    case 'refuse-inconclusive-probe':
      effects.refuseInconclusiveProbe(); // always throws — no safe fall-through
      return decision.action;
    case 'clear-stale-then-cold-spawn':
      effects.clearProvenanceVerified();
      return decision.action;
    case 'kill-then-cold-spawn':
      effects.killStalePane();       // throws → stop (evidence preserved)
      effects.confirmPaneGone();     // throws → stop (evidence preserved)
      if (decision.clearAfterKill) {
        effects.clearProvenanceVerified(); // throws → stop before reselect
      }
      effects.reselectBackend();
      return decision.action;
  }
}

/**
 * Which kill/probe primitive a persistent-pane teardown must use, so it targets
 * the EXACT just-launched pane and never a shared host. Pure so the worker's
 * inline teardown and the migration effects share one behaviorally-tested policy:
 *
 *   · 'zmx'    — identity-verified kill against the frozen managed PID + owned probe.
 *   · 'target' — the recorded PersistentBackendTarget (REQUIRED when one exists):
 *                a herdr isolated/MCP agent lives as `{sessionName:'botmux',
 *                agentName:<topic>}` on the SHARED host, so a name-only kill of
 *                'botmux' would tear down every bot's agent. The target scopes the
 *                kill to this agent.
 *   · 'name'   — last-resort name-only kill, ONLY when no target was recorded
 *                (legacy tmux/zellij that own their whole session by name).
 */
export type PersistentTeardownKillKind = 'zmx' | 'target' | 'name';
export function persistentTeardownKillKind(input: {
  backendType: string;
  hasBackendTarget: boolean;
}): PersistentTeardownKillKind {
  if (input.backendType === 'zmx') return 'zmx';
  if (input.hasBackendTarget) return 'target';
  return 'name';
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/**
 * True when this process is a CLI the worker spawned for a bot under READ
 * ISOLATION (the sandbox), where `~/.botmux/bots.json` is denied ON PURPOSE (it
 * holds every sibling bot's app secret). Callers use it to tell that EXPECTED
 * denial apart from a genuine unreadable-config fault.
 *
 * The signal is `BOTMUX_READ_ISOLATION`, which the worker sets (and otherwise
 * explicitly DELETES) on the child env, gated on `sandboxRequested`. It has to
 * come from the host; two CLI-side guesses were tried and are both wrong:
 *
 *   · `SESSION_DATA_DIR` + `BOTMUX_LARK_APP_ID` — injected for EVERY
 *     worker-spawned CLI, sandboxed or not. Matches ordinary bots, so a real
 *     "bots.json is unreadable" fault would be silently downgraded to "there are
 *     no bots" on a normal host.
 *   · existence of `<BOT_HOME>/send-cred.json` — wrong in BOTH directions: a
 *     no-transport (apiOnly) bot has its own copy denied by fs-policy
 *     (`push([`${ctx.botHome}/send-cred.json`], 'deny', 'mandatory')` in the
 *     `!larkTransport` branch), so a genuinely sandboxed bot reads as
 *     not-isolated; and the file is never cleaned up, so flipping a bot from
 *     `sandbox: true` back to `false` leaves a stale one behind that makes an
 *     ordinary CLI look isolated.
 *
 * (Both caught in review, 2026-08-03. Do not "simplify" this back to either.)
 */
export function underReadIsolation(): boolean {
  return process.env.BOTMUX_READ_ISOLATION === '1';
}
