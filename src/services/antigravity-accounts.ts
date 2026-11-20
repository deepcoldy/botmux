/**
 * Hosted Antigravity (`agy`) account vault, token reconciliation, and
 * cross-process quota-limit rotation.
 *
 * `agy` stores file-fallback OAuth credentials at
 * `~/.gemini/antigravity-cli/antigravity-oauth-token` (0600 JSON) whenever no
 * OS keyring daemon is active (headless Linux servers / containers). It exposes
 * no env var to relocate only the token file; changing `$HOME` relocates the
 * whole shell environment and splits conversation history across accounts.
 *
 * This service keeps named snapshots of `antigravity-oauth-token` in
 * `~/.botmux/antigravity-accounts/` under a cross-process file lock so multiple
 * Botmux daemons and the `botmux agy-accounts` CLI share one consistent active
 * account, safely sync back refreshed tokens by `id_token_email`, and rotate to
 * the next healthy account on quota exhaustion.
 *
 * Secret hygiene: `access_token` and `refresh_token` never leave memory except
 * when atomically written to mode-0600 regular files; they are never included
 * in `state.json`, return values, logs, or error messages.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { resolveBotmuxConfigDir } from '../core/config-dir.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';

export const ANTIGRAVITY_ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const DEFAULT_ANTIGRAVITY_COOLDOWN_MS = 30 * 60 * 1000;
export const MAX_ANTIGRAVITY_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const RECENT_ROTATION_GRACE_MS = 60 * 1000;

export interface AntigravityAccountStoreOptions {
  /** Override `~/.botmux` root (test seam). */
  botmuxConfigDir?: string;
  /** Override OS home directory (test seam for `~/.gemini/antigravity-cli/...`). */
  homeDir?: string;
  /** Override live token path directly (test seam). */
  liveTokenPath?: string;
  /** Injectable wall clock (ms). */
  now?: () => number;
  /** Injectable platform (test seam for keyring check). */
  platform?: NodeJS.Platform;
  /** Injectable environment (test seam for keyring check). */
  env?: NodeJS.ProcessEnv;
}

export interface AntigravityAccountEntry {
  id: string;
  email?: string;
  authMethod?: string;
  enabled: boolean;
  addedAt: string;
  lastUsedAt?: string;
  cooldownUntilMs?: number;
  cooldownReason?: string;
  tokenExpiryMs?: number;
}

export interface AntigravityAccountStateV1 {
  version: 1;
  autoRotate: boolean;
  activeId: string | null;
  lastRotatedAtMs?: number;
  accounts: AntigravityAccountEntry[];
}

export interface AntigravityAccountSnapshot {
  id: string;
  email?: string;
  maskedEmail?: string;
  authMethod?: string;
  enabled: boolean;
  active: boolean;
  hasValidToken: boolean;
  inCooldown: boolean;
  cooldownUntilMs?: number;
  cooldownRemainingMs?: number;
  cooldownReason?: string;
  addedAt: string;
  lastUsedAt?: string;
  tokenExpiryMs?: number;
}

export interface AntigravityKeyringRisk {
  status: 'file-storage-active' | 'macos-keychain' | 'linux-dbus-possible' | 'no-live-token';
  warning?: string;
}

export interface AntigravityAccountsInspection {
  managed: boolean;
  autoRotate: boolean;
  activeId: string | null;
  liveTokenPresent: boolean;
  liveEmail?: string;
  liveMaskedEmail?: string;
  liveTokenMatchesActive: boolean;
  keyringRisk: AntigravityKeyringRisk;
  accounts: AntigravityAccountSnapshot[];
  availableCount: number;
  enabledCount: number;
  earliestRecoveryMs?: number;
  /** Present when state.json exists but cannot be parsed or validated. */
  stateError?: string;
}

export interface ReconcileAntigravityTokenResult {
  managed: boolean;
  activeId?: string;
  email?: string;
  /** Live token had drifted (e.g. stale process refresh) and was restored to activeId. */
  restored?: boolean;
  /** Active account was unavailable/cooled-down so auto-rotate advanced to a healthy account. */
  advancedFrom?: string;
  /** A fresher live token was synced back into its matching vault slot. */
  syncedBackId?: string;
  allInCooldown?: boolean;
  earliestRecoveryMs?: number;
  error?: string;
}

export interface QuotaRotateAntigravityParams {
  /** Account ID the limited session was actually running on. */
  failedAccountId?: string;
  /** Reset timestamp (epoch ms) parsed from `usageLimit.retryAtMs`. */
  cooldownUntilMs?: number;
  reason?: string;
  /** Accounts already tried in this logical turn (never re-selected). */
  excludeAccountIds?: readonly string[];
}

export type QuotaRotateAntigravityResult =
  | { outcome: 'disabled' }
  | {
      outcome: 'rotated' | 'already_rotated';
      fromId?: string;
      fromEmail?: string;
      toId: string;
      toEmail?: string;
      cooldownUntilMs?: number;
    }
  | {
      outcome: 'exhausted';
      fromId?: string;
      fromEmail?: string;
      earliestRecoveryMs?: number;
      enabledCount: number;
    }
  | { outcome: 'identity_unknown' }
  | {
      outcome: 'write_failed';
      fromId?: string;
      error: string;
    };

interface ParsedTokenFile {
  rawJson: string;
  email?: string;
  normalizedEmail?: string;
  authMethod?: string;
  expiryMs?: number;
  /** Field was present but was not a valid date (distinct from absent). */
  expiryInvalid?: boolean;
  refreshToken: string;
  accessToken: string;
}

interface ResolvedPaths {
  vaultDir: string;
  tokensDir: string;
  statePath: string;
  unmanagedBackupPath: string;
  liveTokenPath: string;
}

function resolvePaths(opts: AntigravityAccountStoreOptions = {}): ResolvedPaths {
  const home = opts.homeDir ?? homedir();
  const botmuxDir = opts.botmuxConfigDir ?? resolveBotmuxConfigDir({ homeDir: home });
  const vaultDir = join(botmuxDir, 'antigravity-accounts');
  return {
    vaultDir,
    tokensDir: join(vaultDir, 'tokens'),
    statePath: join(vaultDir, 'state.json'),
    unmanagedBackupPath: join(vaultDir, 'last-unmanaged-token.json'),
    liveTokenPath: opts.liveTokenPath ?? join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
  };
}

/** Resolve the live credential HOME from the exact spawn environment while
 * keeping the vault in the worker's configured Botmux home. Per-bot HOME
 * overrides relocate agy's credentials, not the host-owned account database. */
export function resolveAntigravitySpawnStoreOptions(input: {
  effectiveHome?: string;
  botmuxConfigDir: string;
  env?: NodeJS.ProcessEnv;
}): AntigravityAccountStoreOptions {
  return {
    homeDir: input.effectiveHome ?? homedir(),
    botmuxConfigDir: input.botmuxConfigDir,
    ...(input.env ? { env: input.env } : {}),
  };
}

function tokenPathFor(paths: ResolvedPaths, id: string): string {
  return join(paths.tokensDir, `${id}.json`);
}

export function isValidAntigravityAccountId(id: string): boolean {
  return id !== 'all' && typeof id === 'string' && ANTIGRAVITY_ACCOUNT_ID_RE.test(id);
}

function assertValidAccountId(id: string): void {
  if (!isValidAntigravityAccountId(id)) {
    throw new Error('账号别名只能包含字母、数字、-、_，必须以字母或数字开头（最长 64 字符），且不能使用保留字 all');
  }
}

export function normalizeAntigravityEmail(email: string | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function maskAntigravityEmail(email: string | undefined): string | undefined {
  if (typeof email !== 'string') return undefined;
  const trimmed = email.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed || undefined;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length <= 2) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 2)}***${local.slice(-1)}@${domain}`;
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

/**
 * Parse and structurally validate an Antigravity OAuth token file.
 * Refuses symlinks and non-regular files. Never exposes raw token strings in errors.
 */
function readValidatedTokenFile(path: string): { ok: true; token: ParsedTokenFile } | { ok: false; reason: string } {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, reason: 'not_regular_file' };
  }
  let rawJson: string;
  try {
    rawJson = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_structure' };
  }
  const obj = parsed as Record<string, unknown>;
  const tok = obj.token;
  if (!tok || typeof tok !== 'object' || Array.isArray(tok)) {
    return { ok: false, reason: 'missing_token_object' };
  }
  const tokRec = tok as Record<string, unknown>;
  const accessToken = typeof tokRec.access_token === 'string' ? tokRec.access_token.trim() : '';
  const refreshToken = typeof tokRec.refresh_token === 'string' ? tokRec.refresh_token.trim() : '';
  if (!refreshToken && !accessToken) {
    return { ok: false, reason: 'empty_credentials' };
  }
  const email = typeof obj.id_token_email === 'string' && obj.id_token_email.trim()
    ? obj.id_token_email.trim()
    : undefined;
  const authMethod = typeof obj.auth_method === 'string' && obj.auth_method.trim()
    ? obj.auth_method.trim()
    : undefined;
  let expiryMs: number | undefined;
  let expiryInvalid = false;
  if (tokRec.expiry !== undefined) {
    if (typeof tokRec.expiry === 'string') {
      const ms = Date.parse(tokRec.expiry);
      // Epoch zero is a valid (and necessarily expired) timestamp, not a
      // missing field. Any other unparseable value stays explicitly invalid.
      if (Number.isFinite(ms) && ms >= 0) expiryMs = ms;
      else expiryInvalid = true;
    } else {
      expiryInvalid = true;
    }
  }
  return {
    ok: true,
    token: {
      rawJson,
      email,
      normalizedEmail: normalizeAntigravityEmail(email),
      authMethod,
      expiryMs,
      ...(expiryInvalid ? { expiryInvalid: true } : {}),
      refreshToken,
      accessToken,
    },
  };
}

function isTokenFresher(candidate: ParsedTokenFile, existing: ParsedTokenFile | undefined): boolean {
  if (!existing) return true;
  // Never overwrite a durable refresh_token with a refresh-less token snapshot.
  if (existing.refreshToken && !candidate.refreshToken) return false;
  if (!existing.refreshToken && candidate.refreshToken) return true;
  if (candidate.refreshToken && candidate.refreshToken !== existing.refreshToken) {
    // Only prefer a rotated refresh token when its expiry is not strictly older.
    if (candidate.expiryMs !== undefined && existing.expiryMs !== undefined) {
      return candidate.expiryMs >= existing.expiryMs;
    }
    return true;
  }
  if (candidate.expiryMs !== undefined && existing.expiryMs !== undefined) {
    return candidate.expiryMs > existing.expiryMs;
  }
  return candidate.expiryMs !== undefined && existing.expiryMs === undefined;
}

/** Structural JSON validity is not enough for rotation: an access-only snapshot
 * whose expiry is already in the past cannot authenticate a fresh process.
 * Unknown expiry remains allowed because older agy token files may omit it. */
function tokenCanAuthenticateAt(token: ParsedTokenFile, nowMs: number): boolean {
  return Boolean(
    token.refreshToken
    || (token.accessToken && !token.expiryInvalid && (token.expiryMs === undefined || token.expiryMs > nowMs)),
  );
}

function defaultState(): AntigravityAccountStateV1 {
  return { version: 1, autoRotate: true, activeId: null, accounts: [] };
}

function readStateUnlocked(statePath: string): AntigravityAccountStateV1 | undefined {
  if (!existsSync(statePath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    throw new Error('Antigravity 账号托管状态文件已损坏（state.json 无法解析）');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Antigravity 账号托管状态文件格式无效');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.accounts)) {
    throw new Error('不支持的 Antigravity 账号状态版本');
  }
  const accounts: AntigravityAccountEntry[] = [];
  const seen = new Set<string>();
  for (const item of obj.accounts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !isValidAntigravityAccountId(rec.id) || seen.has(rec.id)) continue;
    seen.add(rec.id);
    accounts.push({
      id: rec.id,
      ...(typeof rec.email === 'string' && rec.email.trim() ? { email: rec.email.trim() } : {}),
      ...(typeof rec.authMethod === 'string' && rec.authMethod.trim() ? { authMethod: rec.authMethod.trim() } : {}),
      enabled: rec.enabled !== false,
      addedAt: typeof rec.addedAt === 'string' ? rec.addedAt : new Date(0).toISOString(),
      ...(typeof rec.lastUsedAt === 'string' ? { lastUsedAt: rec.lastUsedAt } : {}),
      ...(typeof rec.cooldownUntilMs === 'number' && Number.isFinite(rec.cooldownUntilMs) && rec.cooldownUntilMs > 0
        ? { cooldownUntilMs: Math.round(rec.cooldownUntilMs) }
        : {}),
      ...(typeof rec.cooldownReason === 'string' && rec.cooldownReason.trim() ? { cooldownReason: rec.cooldownReason.trim() } : {}),
      ...(typeof rec.tokenExpiryMs === 'number' && Number.isFinite(rec.tokenExpiryMs) && rec.tokenExpiryMs > 0
        ? { tokenExpiryMs: Math.round(rec.tokenExpiryMs) }
        : {}),
    });
  }
  const activeId = typeof obj.activeId === 'string' && seen.has(obj.activeId) ? obj.activeId : null;
  const lastRotatedAtMs = typeof obj.lastRotatedAtMs === 'number'
    && Number.isFinite(obj.lastRotatedAtMs) && obj.lastRotatedAtMs > 0
    ? Math.round(obj.lastRotatedAtMs)
    : undefined;
  return {
    version: 1,
    autoRotate: obj.autoRotate !== false,
    activeId,
    ...(lastRotatedAtMs !== undefined ? { lastRotatedAtMs } : {}),
    accounts,
  };
}

function writeStateLocked(paths: ResolvedPaths, state: AntigravityAccountStateV1): void {
  ensurePrivateDir(paths.vaultDir);
  try {
    atomicWriteFileSync(paths.statePath, JSON.stringify(state, null, 2) + '\n', {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  } catch (err) {
    // rename(2) precedes the directory fsync. If the latter reports EIO, the
    // desired state may already be visible; never let callers roll back a
    // committed write as though it had never happened. Read-your-writes turns
    // that ambiguous acknowledgement into a consistent success. A genuinely
    // uncommitted write still throws and can be rolled back by the caller.
    try {
      const persisted = readStateUnlocked(paths.statePath);
      if (persisted && isDeepStrictEqual(persisted, state)) return;
    } catch { /* preserve the original write failure */ }
    throw err;
  }
}

function writeLiveTokenLocked(paths: ResolvedPaths, rawJson: string): void {
  ensurePrivateDir(dirname(paths.liveTokenPath));
  // Never follow a leaf symlink at the live token path.
  try {
    const st = lstatSync(paths.liveTokenPath);
    if (st.isSymbolicLink()) {
      throw new Error('live antigravity-oauth-token is a symlink; refusing to overwrite through symlink');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  try {
    atomicWriteFileSync(paths.liveTokenPath, rawJson, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  } catch (err) {
    // The live rename may already have committed before directory fsync failed.
    // Continue only when read-your-writes proves the exact intended content;
    // otherwise keep the failure and never overwrite a racing credential.
    try {
      if (readLiveTokenRawForRollback(paths) === rawJson) return;
    } catch { /* preserve the original write failure */ }
    throw err;
  }
}

function writeVaultTokenLocked(paths: ResolvedPaths, id: string, rawJson: string): void {
  ensurePrivateDir(paths.tokensDir);
  try {
    atomicWriteFileSync(tokenPathFor(paths, id), rawJson, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  } catch (err) {
    try {
      if (readVaultTokenRawForRollback(paths, id) === rawJson) return;
    } catch { /* preserve the original write failure */ }
    throw err;
  }
}

function readVaultTokenRawForRollback(paths: ResolvedPaths, id: string): string | undefined {
  const path = tokenPathFor(paths, id);
  let st;
  try { st = lstatSync(path); } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`vault token for account "${id}" is not a regular file`);
  }
  return readFileSync(path, 'utf8');
}

function readLiveTokenRawForRollback(paths: ResolvedPaths): string | undefined {
  let st;
  try { st = lstatSync(paths.liveTokenPath); } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new Error('live antigravity-oauth-token is a symlink; refusing to overwrite through symlink');
  }
  if (!st.isFile()) {
    throw new Error('live antigravity-oauth-token is not a regular file');
  }
  return readFileSync(paths.liveTokenPath, 'utf8');
}

function rollbackLiveTokenIfUnchanged(
  paths: ResolvedPaths,
  previousRaw: string | undefined,
  writtenRaw: string,
): void {
  const currentRaw = readLiveTokenRawForRollback(paths);
  if (currentRaw !== writtenRaw) return;
  if (previousRaw === undefined) unlinkSync(paths.liveTokenPath);
  else writeLiveTokenLocked(paths, previousRaw);
}

/** Commit the live credential and state as one recoverable transaction. If the
 * state rename really did not commit, put back the previous live value, but
 * only while it still equals this transaction's write (never clobber a racing
 * agy refresh). Committed-but-unconfirmed state writes are handled by
 * writeStateLocked and never reach this rollback. */
function writeLiveThenStateLocked(
  paths: ResolvedPaths,
  state: AntigravityAccountStateV1,
  rawJson: string,
): void {
  const previousRaw = readLiveTokenRawForRollback(paths);
  writeLiveTokenLocked(paths, rawJson);
  try {
    writeStateLocked(paths, state);
  } catch (err) {
    try {
      rollbackLiveTokenIfUnchanged(paths, previousRaw, rawJson);
    } catch (rollbackErr) {
      throw new AggregateError([err, rollbackErr], 'Antigravity state write and live-token rollback both failed');
    }
    throw err;
  }
}

function withVaultLock<T>(paths: ResolvedPaths, fn: () => T): T {
  ensurePrivateDir(paths.vaultDir);
  return withFileLockSync(paths.statePath, fn);
}

function accountIdentityConflicts(
  entry: AntigravityAccountEntry,
  token: ParsedTokenFile,
): boolean {
  const stateEmail = normalizeAntigravityEmail(entry.email);
  return Boolean(stateEmail && token.normalizedEmail && stateEmail !== token.normalizedEmail);
}

function sameTokenIdentity(live: ParsedTokenFile, target: ParsedTokenFile): boolean {
  // A known account email is never replaced by an email-less live file. The
  // reverse is safe when the secret identity matches: agy may add the email on
  // a later refresh of a snapshot that originally had none.
  if (target.normalizedEmail) return live.normalizedEmail === target.normalizedEmail;
  return Boolean(
    (target.refreshToken && live.refreshToken === target.refreshToken)
    || (!target.refreshToken && target.accessToken && live.accessToken === target.accessToken),
  );
}

/**
 * True only when the live token belongs to the same account identity AND carries
 * credentials at least as fresh as the vault target (catching re-logins of the
 * same email or stale overwrites with an older same-email token).
 */
function liveMatchesTargetToken(live: ParsedTokenFile | undefined, target: ParsedTokenFile): boolean {
  if (!live) return false;
  if (!sameTokenIdentity(live, target)) return false;
  if (isTokenFresher(target, live)) return false;
  if (target.refreshToken && live.refreshToken !== target.refreshToken) return false;
  if (target.accessToken && live.accessToken !== target.accessToken && !isTokenFresher(live, target)) return false;
  return true;
}

/**
 * If the live token belongs to a known vault account (matched by email, or
 * uniquely by refresh token when email is absent) and is fresher than the vault
 * snapshot (e.g. refreshed in-place by a running `agy`), copy it back into
 * `tokens/<id>.json` so rotations never lose fresh tokens.
 * Never writes a token into an account with a different email.
 */
function syncLiveTokenBackLocked(
  paths: ResolvedPaths,
  state: AntigravityAccountStateV1,
): { matchedId?: string; syncedBackId?: string; liveToken?: ParsedTokenFile } {
  const live = readValidatedTokenFile(paths.liveTokenPath);
  if (!live.ok) return {};
  const liveEmail = live.token.normalizedEmail;

  let match: AntigravityAccountEntry | undefined;
  if (liveEmail) {
    match = state.accounts.find(a => normalizeAntigravityEmail(a.email) === liveEmail);
    if (!match && live.token.refreshToken) {
      // A snapshot imported without an email may gain one on its next refresh.
      // Only a unique refresh-token match among accounts that are email-less in
      // BOTH state and vault is eligible; never cross two known identities.
      const matches = state.accounts.filter(a => {
        if (normalizeAntigravityEmail(a.email)) return false;
        const tok = readValidatedTokenFile(tokenPathFor(paths, a.id));
        return tok.ok && !tok.token.normalizedEmail && tok.token.refreshToken === live.token.refreshToken;
      });
      if (matches.length === 1) match = matches[0];
    }
  } else if (live.token.refreshToken) {
    const matches = state.accounts.filter(a => {
      const tok = readValidatedTokenFile(tokenPathFor(paths, a.id));
      return tok.ok && tok.token.refreshToken === live.token.refreshToken;
    });
    if (matches.length === 1) match = matches[0];
  }
  if (!match) return { liveToken: live.token };

  const stored = readValidatedTokenFile(tokenPathFor(paths, match.id));
  if (stored.ok && accountIdentityConflicts(match, stored.token)) {
    // A half-completed save may leave old state metadata beside a new vault
    // identity. Never let a stale agy refresh overwrite that conflicting vault.
    return { liveToken: live.token };
  }
  const shouldSync = !stored.ok || isTokenFresher(live.token, stored.token);
  if (shouldSync) {
    writeVaultTokenLocked(paths, match.id, live.token.rawJson);
    if (live.token.email) match.email = live.token.email;
    if (live.token.authMethod) match.authMethod = live.token.authMethod;
    if (live.token.expiryMs !== undefined) match.tokenExpiryMs = live.token.expiryMs;
    return { matchedId: match.id, syncedBackId: match.id, liveToken: live.token };
  }
  return { matchedId: match.id, liveToken: live.token };
}

function backupUnmanagedLiveTokenLocked(
  paths: ResolvedPaths,
  state: AntigravityAccountStateV1,
  liveToken: ParsedTokenFile | undefined,
  matchedId?: string,
): void {
  if (!liveToken || matchedId !== undefined) return;
  const liveEmail = liveToken.normalizedEmail;
  const known = liveEmail && state.accounts.some(a => normalizeAntigravityEmail(a.email) === liveEmail);
  if (known) return;
  ensurePrivateDir(paths.vaultDir);
  // This backup is a safety prerequisite, not a best-effort side effect: if it
  // cannot be written, every caller must abort BEFORE replacing the live token.
  atomicWriteFileSync(paths.unmanagedBackupPath, liveToken.rawJson, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function clearExpiredCooldown(entry: AntigravityAccountEntry, nowMs: number): boolean {
  if (entry.cooldownUntilMs !== undefined && entry.cooldownUntilMs <= nowMs) {
    delete entry.cooldownUntilMs;
    delete entry.cooldownReason;
    return true;
  }
  return false;
}

function isAccountInCooldown(entry: AntigravityAccountEntry, nowMs: number): boolean {
  return entry.cooldownUntilMs !== undefined && entry.cooldownUntilMs > nowMs;
}

function isAccountHealthy(
  paths: ResolvedPaths,
  entry: AntigravityAccountEntry,
  nowMs: number,
  opts: { includeCooldown?: boolean; excludeIds?: ReadonlySet<string> } = {},
): boolean {
  if (!entry.enabled) return false;
  if (opts.excludeIds?.has(entry.id)) return false;
  if (!opts.includeCooldown && isAccountInCooldown(entry, nowMs)) return false;
  const token = readValidatedTokenFile(tokenPathFor(paths, entry.id));
  return token.ok && tokenCanAuthenticateAt(token.token, nowMs) && !accountIdentityConflicts(entry, token.token);
}

/** Pick the next candidate in round-robin order starting strictly after `afterId`. */
function pickNextHealthyAccount(
  paths: ResolvedPaths,
  state: AntigravityAccountStateV1,
  afterId: string | null | undefined,
  nowMs: number,
  opts: { includeCooldown?: boolean; excludeIds?: ReadonlySet<string> } = {},
): AntigravityAccountEntry | undefined {
  const n = state.accounts.length;
  if (n === 0) return undefined;
  const startIdx = afterId ? state.accounts.findIndex(a => a.id === afterId) : -1;
  for (let offset = 1; offset <= n; offset++) {
    const candidate = state.accounts[(startIdx + offset + n) % n]!;
    if (isAccountHealthy(paths, candidate, nowMs, opts)) return candidate;
  }
  return undefined;
}

function earliestRecoveryAcrossEnabled(
  paths: ResolvedPaths,
  state: AntigravityAccountStateV1,
  nowMs: number,
): number | undefined {
  let earliest: number | undefined;
  for (const acc of state.accounts) {
    if (!acc.enabled) continue;
    const token = readValidatedTokenFile(tokenPathFor(paths, acc.id));
    if (!token.ok || !tokenCanAuthenticateAt(token.token, nowMs)) continue;
    if (acc.cooldownUntilMs !== undefined && acc.cooldownUntilMs > nowMs) {
      earliest = earliest === undefined ? acc.cooldownUntilMs : Math.min(earliest, acc.cooldownUntilMs);
    }
  }
  return earliest;
}

export function detectAntigravityKeyringRisk(opts: AntigravityAccountStoreOptions = {}): AntigravityKeyringRisk {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const paths = resolvePaths(opts);
  const liveExists = existsSync(paths.liveTokenPath);

  if (platform === 'darwin') {
    return {
      status: 'macos-keychain',
      warning: 'macOS 上 agy 默认优先使用系统 Keychain；基于文件切换仅在 agy 降级到文件凭据时生效。',
    };
  }
  if (platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS && !liveExists) {
    return {
      status: 'linux-dbus-possible',
      warning: '检测到 DBUS_SESSION_BUS_ADDRESS 且本地尚无 antigravity-oauth-token 文件，若桌面开启了 Secret Service (gnome-keyring)，agy 可能优先读取 Keyring。',
    };
  }
  if (!liveExists) {
    return { status: 'no-live-token' };
  }
  return { status: 'file-storage-active' };
}

/** Read-only inspection for CLI `list` and Feishu `/status`. */
export function inspectAntigravityAccounts(
  opts: AntigravityAccountStoreOptions = {},
): AntigravityAccountsInspection {
  const paths = resolvePaths(opts);
  const nowMs = (opts.now ?? Date.now)();
  const live = readValidatedTokenFile(paths.liveTokenPath);
  const keyringRisk = detectAntigravityKeyringRisk(opts);

  let state: AntigravityAccountStateV1 | undefined;
  let stateError: string | undefined;
  try {
    state = readStateUnlocked(paths.statePath);
  } catch (err) {
    state = undefined;
    stateError = err instanceof Error ? err.message : String(err);
  }

  const accounts = (state?.accounts ?? []).map((entry): AntigravityAccountSnapshot => {
    const tokenRes = readValidatedTokenFile(tokenPathFor(paths, entry.id));
    const inCooldown = isAccountInCooldown(entry, nowMs);
    const email = entry.email ?? (tokenRes.ok ? tokenRes.token.email : undefined);
    return {
      id: entry.id,
      ...(email ? { email, maskedEmail: maskAntigravityEmail(email) } : {}),
      ...(entry.authMethod ? { authMethod: entry.authMethod } : {}),
      enabled: entry.enabled,
      active: state?.activeId === entry.id,
      hasValidToken: tokenRes.ok && tokenCanAuthenticateAt(tokenRes.token, nowMs) && !accountIdentityConflicts(entry, tokenRes.token),
      inCooldown,
      ...(inCooldown && entry.cooldownUntilMs ? {
        cooldownUntilMs: entry.cooldownUntilMs,
        cooldownRemainingMs: Math.max(0, entry.cooldownUntilMs - nowMs),
      } : {}),
      ...(inCooldown && entry.cooldownReason ? { cooldownReason: entry.cooldownReason } : {}),
      addedAt: entry.addedAt,
      ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {}),
      ...(entry.tokenExpiryMs ? { tokenExpiryMs: entry.tokenExpiryMs } : {}),
    };
  });

  const activeEntry = accounts.find(a => a.active);
  const activeTokenRes = activeEntry ? readValidatedTokenFile(tokenPathFor(paths, activeEntry.id)) : undefined;
  const liveEmail = live.ok ? live.token.email : undefined;
  const liveTokenMatchesActive = Boolean(
    activeTokenRes?.ok
    && live.ok
    && liveMatchesTargetToken(live.token, activeTokenRes.token),
  );
  const enabledCount = accounts.filter(a => a.enabled && a.hasValidToken).length;
  const availableCount = accounts.filter(a => a.enabled && a.hasValidToken && !a.inCooldown).length;
  const earliestRecoveryMs = state ? earliestRecoveryAcrossEnabled(paths, state, nowMs) : undefined;

  return {
    managed: accounts.length > 0,
    autoRotate: state?.autoRotate ?? !stateError,
    activeId: state?.activeId ?? null,
    liveTokenPresent: live.ok,
    ...(liveEmail ? { liveEmail, liveMaskedEmail: maskAntigravityEmail(liveEmail) } : {}),
    liveTokenMatchesActive,
    keyringRisk,
    accounts,
    availableCount,
    enabledCount,
    ...(earliestRecoveryMs !== undefined ? { earliestRecoveryMs } : {}),
    ...(stateError ? { stateError } : {}),
  };
}

/**
 * Save a token file (defaults to live `~/.gemini/antigravity-cli/antigravity-oauth-token`)
 * into the vault under alias `id`.
 */
export function saveAntigravityAccount(
  id: string,
  opts: AntigravityAccountStoreOptions & {
    sourceTokenPath?: string;
    /** Allow overwriting a different email on the same alias or moving an existing email. */
    force?: boolean;
    /** Activate immediately after saving (default: true only when vault has no activeId yet). */
    activate?: boolean;
  } = {},
): {
  id: string;
  email?: string;
  updated: boolean;
  activated: boolean;
} {
  assertValidAccountId(id);
  const paths = resolvePaths(opts);
  const nowMs = (opts.now ?? Date.now)();
  const sourcePath = opts.sourceTokenPath ?? paths.liveTokenPath;

  return withVaultLock(paths, () => {
    const parsed = readValidatedTokenFile(sourcePath);
    if (!parsed.ok) {
      throw new Error(
        parsed.reason === 'missing'
          ? `未找到有效的 Antigravity 登录凭据（${sourcePath} 不存在），请先登录 agy`
          : `Antigravity 凭据文件无效（原因: ${parsed.reason}）`,
      );
    }

    if (sourcePath !== paths.liveTokenPath) {
      preserveIndependentSourceSnapshotLocked(paths, id, parsed.token.rawJson);
    }
    const state = readStateUnlocked(paths.statePath) ?? defaultState();
    const existingById = state.accounts.find(a => a.id === id);

    // Always enforce email uniqueness across distinct aliases: two aliases for
    // the same Google account would break rotation and email-based sync-back.
    if (parsed.token.normalizedEmail) {
      const duplicate = state.accounts.find(a => {
        if (a.id === id) return false;
        if (normalizeAntigravityEmail(a.email) === parsed.token.normalizedEmail) return true;
        // state metadata may lag a successful vault sync-back after a failed
        // state rename. Email uniqueness must cover BOTH durable representations.
        const vault = readValidatedTokenFile(tokenPathFor(paths, a.id));
        return vault.ok && vault.token.normalizedEmail === parsed.token.normalizedEmail;
      });
      if (duplicate) {
        throw new Error(
          `该邮箱（${parsed.token.email}）已托管在账号 "${duplicate.id}" 下。`
          + `若要更新它请运行 save ${duplicate.id}；若要登录新账号请运行 login ${id}。`,
        );
      }
      if (!opts.force && existingById && existingById.email && normalizeAntigravityEmail(existingById.email) !== parsed.token.normalizedEmail) {
        throw new Error(
          `账号 "${id}" 当前绑定的是 ${existingById.email}，与新凭据邮箱（${parsed.token.email}）不同；`
          + '若确认覆盖请加 --force，或换用新别名。',
        );
      }
    } else if (!opts.force && existingById && existingById.email) {
      throw new Error(
        `账号 "${id}" 当前绑定的是 ${existingById.email}，新凭据缺少邮箱字段；若确认覆盖请加 --force。`,
      );
    }

    // Activate if requested, if vault has no activeId yet, OR when refreshing
    // the currently active alias from an isolated source (e.g. `login <activeId>`).
    const shouldActivate = opts.activate === true
      || state.activeId === null
      || (state.activeId === id && sourcePath !== paths.liveTokenPath);

    let previousLiveRaw: string | undefined;
    let previousVaultRaw: string | undefined;
    let writtenLiveRaw: string | undefined;
    let writtenVaultRaw: string | undefined;
    try {
      // Preserve the pre-transaction live value. sync-back itself is a valid
      // independent refresh and is not rolled back; only THIS save's writes are.
      if (shouldActivate && sourcePath !== paths.liveTokenPath) {
        previousLiveRaw = readLiveTokenRawForRollback(paths);
        const synced = syncLiveTokenBackLocked(paths, state);
        backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
        writeLiveTokenLocked(paths, parsed.token.rawJson);
        writtenLiveRaw = parsed.token.rawJson;
      }

      previousVaultRaw = readVaultTokenRawForRollback(paths, id);
      writeVaultTokenLocked(paths, id, parsed.token.rawJson);
      writtenVaultRaw = parsed.token.rawJson;

      const nowIso = new Date(nowMs).toISOString();
      let updated = false;
      if (existingById) {
        updated = true;
        const identityChanged = normalizeAntigravityEmail(existingById.email) !== parsed.token.normalizedEmail;
        if (identityChanged) {
          delete existingById.cooldownUntilMs;
          delete existingById.cooldownReason;
        }
        if (parsed.token.email) existingById.email = parsed.token.email;
        else delete existingById.email;
        if (parsed.token.authMethod) existingById.authMethod = parsed.token.authMethod;
        else delete existingById.authMethod;
        if (parsed.token.expiryMs !== undefined) existingById.tokenExpiryMs = parsed.token.expiryMs;
        else delete existingById.tokenExpiryMs;
        existingById.enabled = true;
      } else {
        state.accounts.push({
          id,
          ...(parsed.token.email ? { email: parsed.token.email } : {}),
          ...(parsed.token.authMethod ? { authMethod: parsed.token.authMethod } : {}),
          enabled: true,
          addedAt: nowIso,
          ...(parsed.token.expiryMs !== undefined ? { tokenExpiryMs: parsed.token.expiryMs } : {}),
        });
      }

      if (shouldActivate) {
        state.activeId = id;
        const entry = state.accounts.find(a => a.id === id)!;
        entry.lastUsedAt = nowIso;
      }
      writeStateLocked(paths, state);
      clearIndependentSourceRecoveryBestEffort(paths, id);
      return { id, email: parsed.token.email, updated, activated: shouldActivate };
    } catch (err) {
      rollbackFailedSaveLocked(paths, id, {
        previousVaultRaw,
        writtenVaultRaw,
        previousLiveRaw,
        writtenLiveRaw,
      }, err);
    }
  });
}

function recoveryPathFor(paths: ResolvedPaths, id: string): string {
  return join(paths.vaultDir, 'recovery', `${id}.json`);
}

/** Durable pre-write for an independent-source save/login. This runs BEFORE
 * state parsing or any live/vault mutation, so a failure can never strand the
 * only copy of a newly logged-in credential in a temporary directory. */
function preserveIndependentSourceSnapshotLocked(paths: ResolvedPaths, id: string, rawJson: string): void {
  ensurePrivateDir(join(paths.vaultDir, 'recovery'));
  const path = recoveryPathFor(paths, id);
  try {
    atomicWriteFileSync(path, rawJson, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
  } catch (err) {
    try {
      const st = lstatSync(path);
      if (st.isFile() && !st.isSymbolicLink() && readFileSync(path, 'utf8') === rawJson) return;
    } catch { /* preserve the original recovery write failure */ }
    throw err;
  }
}

function clearIndependentSourceRecoveryBestEffort(paths: ResolvedPaths, id: string): void {
  try { unlinkSync(recoveryPathFor(paths, id)); } catch { /* a committed save needs no recovery copy */ }
}

/** Preserve an independent-source login before rolling back any part of a
 * failed save. The recovery copy is deliberately outside tokens/ and therefore
 * never participates in rotation or email uniqueness until explicitly rescued. */
function rollbackFailedSaveLocked(
  paths: ResolvedPaths,
  id: string,
  input: {
    previousVaultRaw: string | undefined;
    writtenVaultRaw?: string;
    previousLiveRaw: string | undefined;
    writtenLiveRaw?: string;
  },
  cause: unknown,
): never {
  const errors: unknown[] = [cause];
  if (input.writtenLiveRaw !== undefined) {
    try { rollbackLiveTokenIfUnchanged(paths, input.previousLiveRaw, input.writtenLiveRaw); }
    catch (err) { errors.push(err); }
  }
  if (input.writtenVaultRaw !== undefined) {
    try {
      if (readVaultTokenRawForRollback(paths, id) === input.writtenVaultRaw) {
        if (input.previousVaultRaw === undefined) unlinkSync(tokenPathFor(paths, id));
        else writeVaultTokenLocked(paths, id, input.previousVaultRaw);
      }
    } catch (err) { errors.push(err); }
  }
  if (errors.length > 1) throw new AggregateError(errors, `Failed to roll back Antigravity account save for "${id}"`);
  throw cause;
}

/** Explicitly switch active account to `id`. */
export function useAntigravityAccount(
  id: string,
  opts: AntigravityAccountStoreOptions & { allowDisabled?: boolean } = {},
): {
  fromId: string | null;
  toId: string;
  email?: string;
  syncedBackId?: string;
  inCooldown: boolean;
  cooldownUntilMs?: number;
} {
  assertValidAccountId(id);
  const paths = resolvePaths(opts);
  const nowMs = (opts.now ?? Date.now)();

  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath);
    if (!state || state.accounts.length === 0) {
      throw new Error('尚未托管任何 Antigravity 账号，请先执行 botmux agy-accounts save <别名> 或 login <别名>');
    }
    const target = state.accounts.find(a => a.id === id);
    if (!target) throw new Error(`账号不存在: ${id}`);
    if (!target.enabled && !opts.allowDisabled) {
      throw new Error(`账号 "${id}" 已禁用，请先执行 botmux agy-accounts enable ${id}`);
    }
    const synced = syncLiveTokenBackLocked(paths, state);
    // sync-back may have refreshed THIS target's vault snapshot. Read it only
    // after that write; using the pre-sync value would immediately regress live.
    const targetToken = readValidatedTokenFile(tokenPathFor(paths, target.id));
    if (!targetToken.ok) {
      throw new Error(`账号 "${id}" 的凭据文件缺失或损坏（${targetToken.reason}），请重新登录`);
    }
    if (accountIdentityConflicts(target, targetToken.token)) {
      throw new Error(`账号 "${id}" 的 state 邮箱与凭据邮箱不一致，请先执行 save --force 修复身份后再切换`);
    }
    backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);

    const fromId = state.activeId;
    state.activeId = target.id;
    target.lastUsedAt = new Date(nowMs).toISOString();
    clearExpiredCooldown(target, nowMs);
    writeLiveThenStateLocked(paths, state, targetToken.token.rawJson);

    return {
      fromId,
      toId: target.id,
      email: target.email ?? targetToken.token.email,
      ...(synced.syncedBackId ? { syncedBackId: synced.syncedBackId } : {}),
      inCooldown: isAccountInCooldown(target, nowMs),
      ...(isAccountInCooldown(target, nowMs) ? { cooldownUntilMs: target.cooldownUntilMs } : {}),
    };
  });
}

/** Manually rotate to the next healthy account in round-robin order. */
export function rotateNextAntigravityAccount(
  opts: AntigravityAccountStoreOptions & { includeCooldown?: boolean } = {},
): {
  fromId: string | null;
  toId: string;
  email?: string;
  syncedBackId?: string;
} {
  const paths = resolvePaths(opts);
  const nowMs = (opts.now ?? Date.now)();

  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath);
    if (!state || state.accounts.length === 0) {
      throw new Error('尚未托管任何 Antigravity 账号');
    }
    for (const acc of state.accounts) clearExpiredCooldown(acc, nowMs);
    const synced = syncLiveTokenBackLocked(paths, state);
    const exclude = state.activeId ? new Set([state.activeId]) : undefined;
    const next = pickNextHealthyAccount(paths, state, state.activeId, nowMs, {
      includeCooldown: opts.includeCooldown,
      excludeIds: exclude,
    });
    if (!next) {
      throw new Error(
        opts.includeCooldown
          ? '没有其他可切换的启用账号'
          : '没有其他处于可用状态的账号（其余账号可能处于限额冷却或已禁用；如需强制切换可加 --include-cooldown）',
      );
    }
    const nextToken = readValidatedTokenFile(tokenPathFor(paths, next.id));
    if (!nextToken.ok) {
      throw new Error(`目标账号 "${next.id}" 的凭据不可用（${nextToken.reason}）`);
    }
    backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
    const fromId = state.activeId;
    state.activeId = next.id;
    next.lastUsedAt = new Date(nowMs).toISOString();
    writeLiveThenStateLocked(paths, state, nextToken.token.rawJson);
    return {
      fromId,
      toId: next.id,
      email: next.email ?? nextToken.token.email,
      ...(synced.syncedBackId ? { syncedBackId: synced.syncedBackId } : {}),
    };
  });
}

export function setAntigravityAccountEnabled(
  id: string,
  enabled: boolean,
  opts: AntigravityAccountStoreOptions = {},
): { id: string; enabled: boolean; activeId: string | null } {
  assertValidAccountId(id);
  const paths = resolvePaths(opts);
  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath);
    if (!state) throw new Error('尚未托管任何 Antigravity 账号');
    const target = state.accounts.find(a => a.id === id);
    if (!target) throw new Error(`账号不存在: ${id}`);
    target.enabled = enabled;
    writeStateLocked(paths, state);
    return { id: target.id, enabled: target.enabled, activeId: state.activeId };
  });
}

function deleteAntigravityTokenSnapshotOrThrow(paths: ResolvedPaths, id: string): void {
  try {
    unlinkSync(tokenPathFor(paths, id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new Error(`账号 "${id}" 已从 state 移除，但凭据快照删除失败；请检查 ${tokenPathFor(paths, id)}`, { cause: err });
    }
  }
}

function antigravityTokenSnapshotExists(paths: ResolvedPaths, id: string): boolean {
  try { lstatSync(tokenPathFor(paths, id)); return true; } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw err;
  }
}

export function removeAntigravityAccount(
  id: string,
  opts: AntigravityAccountStoreOptions = {},
): { removedId: string; newActiveId: string | null } {
  assertValidAccountId(id);
  const paths = resolvePaths(opts);
  const nowMs = (opts.now ?? Date.now)();

  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath);
    const idx = state?.accounts.findIndex(a => a.id === id) ?? -1;
    if (!state || idx < 0) {
      // A previous remove may have committed state and crashed/failed before
      // unlink. Make the same command an idempotent cleanup retry.
      if (antigravityTokenSnapshotExists(paths, id)) {
        deleteAntigravityTokenSnapshotOrThrow(paths, id);
        return { removedId: id, newActiveId: state?.activeId ?? null };
      }
      if (!state) throw new Error('尚未托管任何 Antigravity 账号');
      throw new Error(`账号不存在: ${id}`);
    }

    const wasActive = state.activeId === id;
    // Preserve any fresher live token belonging to another hosted account (or
    // back up an unmanaged live token) BEFORE overwriting liveTokenPath.
    const synced = syncLiveTokenBackLocked(paths, state);
    state.accounts.splice(idx, 1);

    let newActiveId: string | null = state.activeId;
    if (wasActive) {
      const replacement =
        pickNextHealthyAccount(paths, state, null, nowMs)
        ?? pickNextHealthyAccount(paths, state, null, nowMs, { includeCooldown: true });
      if (replacement) {
        const repTok = readValidatedTokenFile(tokenPathFor(paths, replacement.id));
        if (!repTok.ok) throw new Error(`替代账号 "${replacement.id}" 的凭据不可用（${repTok.reason}）`);
        backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
        replacement.lastUsedAt = new Date(nowMs).toISOString();
        state.activeId = replacement.id;
        writeLiveThenStateLocked(paths, state, repTok.token.rawJson);
        newActiveId = replacement.id;
      } else {
        newActiveId = null;
      }
      state.activeId = newActiveId;
    }

    if (!wasActive || !newActiveId) writeStateLocked(paths, state);
    deleteAntigravityTokenSnapshotOrThrow(paths, id);
    return { removedId: id, newActiveId };
  });
}

export function clearAntigravityAccountCooldown(
  target: string | 'all',
  opts: AntigravityAccountStoreOptions = {},
): { clearedIds: string[] } {
  if (target !== 'all') assertValidAccountId(target);
  const paths = resolvePaths(opts);

  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath);
    if (!state) throw new Error('尚未托管任何 Antigravity 账号');
    const clearedIds: string[] = [];
    if (target === 'all') {
      for (const acc of state.accounts) {
        if (acc.cooldownUntilMs !== undefined || acc.cooldownReason !== undefined) {
          delete acc.cooldownUntilMs;
          delete acc.cooldownReason;
          clearedIds.push(acc.id);
        }
      }
    } else {
      const acc = state.accounts.find(a => a.id === target);
      if (!acc) throw new Error(`账号不存在: ${target}`);
      if (acc.cooldownUntilMs !== undefined || acc.cooldownReason !== undefined) {
        delete acc.cooldownUntilMs;
        delete acc.cooldownReason;
        clearedIds.push(acc.id);
      }
    }
    if (clearedIds.length > 0) writeStateLocked(paths, state);
    return { clearedIds };
  });
}

export function setAntigravityAutoRotate(
  enabled: boolean,
  opts: AntigravityAccountStoreOptions = {},
): { autoRotate: boolean } {
  const paths = resolvePaths(opts);
  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath) ?? defaultState();
    state.autoRotate = enabled;
    writeStateLocked(paths, state);
    return { autoRotate: state.autoRotate };
  });
}

/**
 * Reconcile the host live token file right before spawning/restarting `agy`.
 *
 * Fast path: returns `{ managed: false }` with zero locking when no vault
 * `state.json` exists, so unmanaged hosts pay zero overhead.
 *
 * Managed path:
 *  1. Syncs back a fresher live token to its matching account by `id_token_email`
 *     (protecting against a stale long-lived `agy` refreshing and overwriting
 *     the live file).
 *  2. If `activeId` is in cooldown / disabled / corrupt and `autoRotate` is on,
 *     advances `activeId` to the next healthy account.
 *  3. If the live token is missing or does not match `activeId`, restores
 *     `tokens/<activeId>.json` atomically.
 */
export function reconcileActiveAntigravityToken(
  opts: AntigravityAccountStoreOptions = {},
): ReconcileAntigravityTokenResult {
  const paths = resolvePaths(opts);
  if (!existsSync(paths.statePath)) return { managed: false };
  const nowMs = (opts.now ?? Date.now)();

  return withVaultLock(paths, () => {
    const state = readStateUnlocked(paths.statePath);
    if (!state || state.accounts.length === 0) return { managed: false };

    let stateDirty = false;
    for (const acc of state.accounts) {
      if (clearExpiredCooldown(acc, nowMs)) stateDirty = true;
    }

    const synced = syncLiveTokenBackLocked(paths, state);
    if (synced.syncedBackId) stateDirty = true;

    let active = state.activeId ? state.accounts.find(a => a.id === state.activeId) : undefined;
    let advancedFrom: string | undefined;

    // A disabled active account must NEVER be silently restored or booted,
    // regardless of autoRotate. Move to an enabled healthy account first, then
    // any enabled valid account (even in cooldown); fail cleanly if none exist.
    if (active && !active.enabled) {
      const disabledId = active.id;
      const replacement =
        pickNextHealthyAccount(paths, state, disabledId, nowMs)
        ?? pickNextHealthyAccount(paths, state, disabledId, nowMs, { includeCooldown: true });
      if (!replacement) {
        state.activeId = null;
        writeStateLocked(paths, state);
        return { managed: true, error: 'no_enabled_account' };
      }
      advancedFrom = disabledId;
      active = replacement;
      state.activeId = replacement.id;
      replacement.lastUsedAt = new Date(nowMs).toISOString();
      stateDirty = true;
    }

    const activeUsable = active ? isAccountHealthy(paths, active, nowMs) : false;
    if (!activeUsable && state.autoRotate) {
      const healthy = pickNextHealthyAccount(paths, state, active?.id, nowMs);
      if (healthy) {
        if (active && healthy.id !== active.id) advancedFrom ??= active.id;
        active = healthy;
        state.activeId = healthy.id;
        healthy.lastUsedAt = new Date(nowMs).toISOString();
        stateDirty = true;
      }
    }

    if (!active) {
      // Fall back to any enabled valid account even if all are in cooldown.
      const fallback = pickNextHealthyAccount(paths, state, null, nowMs, { includeCooldown: true });
      if (!fallback) {
        if (stateDirty) writeStateLocked(paths, state);
        return { managed: true, error: 'no_enabled_account' };
      }
      active = fallback;
      state.activeId = fallback.id;
      stateDirty = true;
    }

    const activeToken = readValidatedTokenFile(tokenPathFor(paths, active.id));
    if (activeToken.ok && accountIdentityConflicts(active, activeToken.token)) {
      return {
        managed: true,
        activeId: active.id,
        email: active.email,
        error: 'active_account_identity_conflict',
      };
    }
    if (!activeToken.ok || !tokenCanAuthenticateAt(activeToken.token, nowMs)) {
      if (stateDirty) writeStateLocked(paths, state);
      return {
        managed: true,
        activeId: active.id,
        email: active.email,
        error: activeToken.ok ? 'active_token_expired' : `active_token_${activeToken.reason}`,
      };
    }

    const liveMatches = liveMatchesTargetToken(synced.liveToken, activeToken.token);
    let restored = false;
    if (!liveMatches) {
      try {
        backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
        writeLiveThenStateLocked(paths, state, activeToken.token.rawJson);
        restored = true;
      } catch (err) {
        return {
          managed: true,
          activeId: active.id,
          email: active.email ?? activeToken.token.email,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (stateDirty) {
      writeStateLocked(paths, state);
    }

    const allInCooldown = !state.accounts.some(a => isAccountHealthy(paths, a, nowMs));
    const earliestRecoveryMs = allInCooldown ? earliestRecoveryAcrossEnabled(paths, state, nowMs) : undefined;
    return {
      managed: true,
      activeId: active.id,
      email: active.email ?? activeToken.token.email,
      ...(restored ? { restored: true } : {}),
      ...(advancedFrom ? { advancedFrom } : {}),
      ...(synced.syncedBackId ? { syncedBackId: synced.syncedBackId } : {}),
      ...(allInCooldown ? { allInCooldown: true } : {}),
      ...(earliestRecoveryMs !== undefined ? { earliestRecoveryMs } : {}),
    };
  });
}

function sanitizeCooldownUntilMs(raw: number | undefined, nowMs: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > nowMs) {
    return Math.min(Math.round(raw), nowMs + MAX_ANTIGRAVITY_COOLDOWN_MS);
  }
  return nowMs + DEFAULT_ANTIGRAVITY_COOLDOWN_MS;
}

/**
 * Multi-daemon-safe quota-limit rotation.
 *
 * Key concurrency invariant: if Session A and Session B both started on `acc1`
 * and Session A already rotated the host to `acc2`, Session B's subsequent
 * quota error passes `failedAccountId: 'acc1'`. Because `state.activeId` is
 * already `'acc2'` (healthy and not excluded), this returns `already_rotated`
 * pointing at `'acc2'` without falsely penalizing or burning `'acc2'`.
 */
export function rotateAntigravityAccountOnQuotaLimit(
  params: QuotaRotateAntigravityParams,
  opts: AntigravityAccountStoreOptions = {},
): QuotaRotateAntigravityResult {
  const paths = resolvePaths(opts);
  if (!existsSync(paths.statePath)) return { outcome: 'disabled' };
  const nowMs = (opts.now ?? Date.now)();

  try {
    return withVaultLock(paths, () => {
      const state = readStateUnlocked(paths.statePath);
      if (!state || state.accounts.length === 0 || !state.autoRotate) {
        return { outcome: 'disabled' };
      }

      let metadataDirty = false;
      for (const acc of state.accounts) {
        if (clearExpiredCooldown(acc, nowMs)) metadataDirty = true;
      }

      const synced = syncLiveTokenBackLocked(paths, state);
      // Persist sync-back/expiry metadata before ANY early return (including
      // identity_unknown). Otherwise vault and state disagree about email
      // uniqueness on the next save.
      if (metadataDirty || synced.syncedBackId) writeStateLocked(paths, state);

      const excludeIds = new Set<string>(params.excludeAccountIds ?? []);

      // Concurrent legacy/unknown-account sessions: if failedAccountId is unknown
      // AND another session just rotated activeId within the recent grace window
      // onto a healthy non-excluded account, adopt that fresh activeId without
      // falsely placing it into cooldown.
      if (
        !params.failedAccountId
        && state.activeId
        && state.lastRotatedAtMs !== undefined
        && nowMs - state.lastRotatedAtMs >= 0
        && nowMs - state.lastRotatedAtMs < RECENT_ROTATION_GRACE_MS
      ) {
        const freshActive = state.accounts.find(a => a.id === state.activeId);
        if (freshActive && isAccountHealthy(paths, freshActive, nowMs, { excludeIds })) {
          const activeTok = readValidatedTokenFile(tokenPathFor(paths, freshActive.id));
          if (activeTok.ok) {
            if (!liveMatchesTargetToken(synced.liveToken, activeTok.token)) {
              try {
                backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
                writeLiveThenStateLocked(paths, state, activeTok.token.rawJson);
              } catch (err) {
                return {
                  outcome: 'write_failed',
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            }
            return {
              outcome: 'already_rotated',
              toId: freshActive.id,
              toEmail: freshActive.email ?? activeTok.token.email,
            };
          }
        }
      }

      // Outside the narrow concurrent-rotation grace window, an unbound legacy
      // pane provides no trustworthy evidence about its account. The live file
      // may have been overwritten by another process, so do not guess from
      // activeId (or even live contents) and cool a healthy account.
      if (!params.failedAccountId) return { outcome: 'identity_unknown' };

      // Identify the victim account. If failedAccountId was explicitly provided
      // but has since been removed from the vault, do NOT blame state.activeId.
      let victim: AntigravityAccountEntry | undefined;
      if (params.failedAccountId) {
        victim = state.accounts.find(a => a.id === params.failedAccountId);
      }

      const cooldownUntilMs = sanitizeCooldownUntilMs(params.cooldownUntilMs, nowMs);
      if (victim) {
        victim.cooldownUntilMs = Math.max(victim.cooldownUntilMs ?? 0, cooldownUntilMs);
        victim.cooldownReason = params.reason ?? 'usage_limit';
      }

      if (victim) excludeIds.add(victim.id);
      if (params.failedAccountId) excludeIds.add(params.failedAccountId);

      // Check if another session/daemon already rotated global activeId onto a healthy account.
      if (state.activeId && state.activeId !== victim?.id) {
        const currentActive = state.accounts.find(a => a.id === state.activeId);
        if (currentActive && isAccountHealthy(paths, currentActive, nowMs, { excludeIds })) {
          const activeTok = readValidatedTokenFile(tokenPathFor(paths, currentActive.id));
          if (activeTok.ok) {
            const liveMatches = liveMatchesTargetToken(synced.liveToken, activeTok.token);
            if (!liveMatches) {
              try {
                backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
                writeLiveThenStateLocked(paths, state, activeTok.token.rawJson);
              } catch (err) {
                return {
                  outcome: 'write_failed',
                  fromId: victim?.id ?? params.failedAccountId,
                  error: err instanceof Error ? err.message : String(err),
                };
              }
            } else {
              writeStateLocked(paths, state);
            }
            return {
              outcome: 'already_rotated',
              fromId: victim?.id ?? params.failedAccountId,
              fromEmail: victim?.email,
              toId: currentActive.id,
              toEmail: currentActive.email ?? activeTok.token.email,
              cooldownUntilMs: victim?.cooldownUntilMs,
            };
          }
        }
      }

      const next = pickNextHealthyAccount(paths, state, victim?.id ?? state.activeId, nowMs, { excludeIds });
      if (!next) {
        writeStateLocked(paths, state);
        const enabledCount = state.accounts.filter(a => isAccountHealthy(paths, a, nowMs, { includeCooldown: true })).length;
        return {
          outcome: 'exhausted',
          fromId: victim?.id ?? params.failedAccountId,
          fromEmail: victim?.email,
          earliestRecoveryMs: earliestRecoveryAcrossEnabled(paths, state, nowMs),
          enabledCount,
        };
      }

      const nextTok = readValidatedTokenFile(tokenPathFor(paths, next.id));
      if (!nextTok.ok) {
        writeStateLocked(paths, state);
        return {
          outcome: 'write_failed',
          fromId: victim?.id ?? params.failedAccountId,
          error: `target_token_${nextTok.reason}`,
        };
      }

      const previousActiveId = state.activeId;
      const previousLastRotatedAtMs = state.lastRotatedAtMs;
      const previousNextLastUsedAt = next.lastUsedAt;
      try {
        backupUnmanagedLiveTokenLocked(paths, state, synced.liveToken, synced.matchedId);
        state.activeId = next.id;
        state.lastRotatedAtMs = nowMs;
        next.lastUsedAt = new Date(nowMs).toISOString();
        writeLiveThenStateLocked(paths, state, nextTok.token.rawJson);
      } catch (err) {
        // Roll the in-memory transaction back before making a best-effort
        // durability record of the victim's cooldown. Never persist the new
        // activeId when its live write/state commit did not complete.
        state.activeId = previousActiveId;
        if (previousLastRotatedAtMs === undefined) delete state.lastRotatedAtMs;
        else state.lastRotatedAtMs = previousLastRotatedAtMs;
        if (previousNextLastUsedAt === undefined) delete next.lastUsedAt;
        else next.lastUsedAt = previousNextLastUsedAt;
        try { writeStateLocked(paths, state); } catch { /* preserve the original failure */ }
        return {
          outcome: 'write_failed',
          fromId: victim?.id ?? params.failedAccountId,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        outcome: 'rotated',
        fromId: victim?.id ?? params.failedAccountId,
        fromEmail: victim?.email,
        toId: next.id,
        toEmail: next.email ?? nextTok.token.email,
        cooldownUntilMs: victim?.cooldownUntilMs,
      };
    });
  } catch (err) {
    return {
      outcome: 'write_failed',
      fromId: params.failedAccountId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
