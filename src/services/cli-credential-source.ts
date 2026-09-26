/**
 * Per-bot CLI credential source (`bots.json` → `credentialsSourceDir`).
 *
 * By default every read-isolated/sandboxed bot seeds its per-bot CLI data root
 * from the machine's shared login (`~/.claude/.credentials.json` / keychain),
 * so all bots on a host run as ONE account. `credentialsSourceDir` lets a bot
 * point at its own account directory instead, e.g. `~/accounts/acct-b`, laid
 * out per CLI:
 *
 *   <credentialsSourceDir>/claude/.credentials.json
 *
 * On every cold spawn the worker copies the file(s) listed for the bot's CLI
 * family into the bot's per-bot data root. The field is CLI-agnostic; a CLI
 * opts in only with BOTH a family layout in {@link CREDENTIAL_SOURCE_LAYOUTS}
 * and its exact cliId in {@link CREDENTIAL_SOURCE_SUPPORTED_CLIS} (after it is
 * verified on a real host to log in from the copied files).
 *
 * Contract (fail closed — a bot configured for account B must never silently
 * run as the shared account):
 *  - not configured                  → historical behaviour, untouched (for
 *    every sandbox setting).
 *  - configured, bot not sandboxed   → no per-bot data root exists to copy
 *    into, the CLI keeps using the global login; warn so the operator sees the
 *    field had no effect.
 *  - configured, sandbox requested but the CLI data dir is not redirected
 *    (wrapperCli / adapter without redirection / no SESSION_DATA_DIR) →
 *    refuse to start, naming which of the three applies.
 *  - configured, redirected, CLI not in {@link CREDENTIAL_SOURCE_SUPPORTED_CLIS}
 *    → refuse to start.
 *  - configured, redirected, source missing/unreadable/invalid → refuse to
 *    start; never fall back to the global login or keychain.
 *
 * Refreshing the tokens held in the source directory (and suspending the bots
 * that use it) is deliberately OUT of scope: botmux only copies on cold spawn.
 * An external refresher owns the source and must refresh before the CLI's own
 * refresh margin, otherwise the CLI rotates the refresh token inside its copy
 * and invalidates the source.
 */
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  writeFileSync,
} from 'node:fs';

export type CredentialSourceFamily = 'claude';

/** Per CLI family: sub-directory under the source dir and the files copied
 *  into the per-bot data root (same relative names on both sides). */
export const CREDENTIAL_SOURCE_LAYOUTS: Readonly<Record<CredentialSourceFamily, {
  subdir: string;
  files: readonly string[];
}>> = {
  claude: { subdir: 'claude', files: ['.credentials.json'] },
};

/**
 * Normalize a raw `credentialsSourceDir` value from bots.json / config set.
 * Missing / blank → undefined. `~` and `~/…` expand to the home directory.
 * Anything else that is not an absolute path is rejected (throws), so a
 * relative path can never resolve against whatever cwd the daemon started in.
 */
export function normalizeCredentialsSourceDir(raw: unknown, home: string = homedir()): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new Error('credentialsSourceDir must be a string path');
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let expanded = trimmed;
  if (trimmed === '~') expanded = home;
  else if (trimmed.startsWith('~/')) expanded = join(home, trimmed.slice(2));
  if (!isAbsolute(expanded)) {
    throw new Error(`credentialsSourceDir must be an absolute path (or start with ~/), got: ${trimmed}`);
  }
  return resolve(expanded);
}

/**
 * Env / settings keys that make Claude authenticate with something OTHER than
 * the OAuth file copied from the source. In source mode they are not
 * inherited from the shared settings, and their presence anywhere the CLI can
 * see them refuses the spawn (the bot would be ambiguous between accounts).
 */
export const CLAUDE_AUTH_OVERRIDE_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/** Auth-override keys set (non-empty) in `env`. */
export function claudeAuthOverrideKeys(env: Record<string, unknown> | undefined | null): string[] {
  if (!env) return [];
  return CLAUDE_AUTH_OVERRIDE_ENV_KEYS.filter((k) => {
    const v = env[k];
    return v !== undefined && v !== null && String(v) !== '';
  });
}

/** Keys in a Claude settings file (top-level `apiKeyHelper` or `env`) that
 *  would override the copied OAuth login. Absent file → none; a present file
 *  that cannot be read/parsed as a JSON object → `<unreadable>` (fail closed:
 *  we cannot prove it grants no auth). */
export function claudeSettingsAuthOverrides(settingsPath: string): string[] {
  let raw: string;
  try { raw = readFileSync(settingsPath, 'utf-8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['<unreadable>'];
  }
  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ['<unreadable>'];
    settings = parsed as Record<string, unknown>;
  } catch { return ['<unreadable>']; }
  const out: string[] = [];
  if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper) out.push('apiKeyHelper');
  const env = settings.env;
  if (env && typeof env === 'object' && !Array.isArray(env)) out.push(...claudeAuthOverrideKeys(env as Record<string, unknown>));
  return out;
}

/** Managed (enterprise) settings Claude applies above every other layer. */
export const CLAUDE_MANAGED_SETTINGS_PATHS: readonly string[] = [
  '/etc/claude-code/managed-settings.json',
  '/Library/Application Support/ClaudeCode/managed-settings.json',
];

/** Every settings layer the spawned Claude reads, with any auth override it
 *  carries (`<path>:<key>`): per-bot user settings, the project's shared and
 *  local settings under the bot's working dir, and managed settings. */
export function claudeAuthOverridesInSettingsLayers(input: {
  userSettingsPath: string;
  workingDir?: string;
  managedPaths?: readonly string[];
}): string[] {
  const paths = [
    input.userSettingsPath,
    ...(input.workingDir
      ? [join(input.workingDir, '.claude', 'settings.json'), join(input.workingDir, '.claude', 'settings.local.json')]
      : []),
    ...(input.managedPaths ?? CLAUDE_MANAGED_SETTINGS_PATHS),
  ];
  return paths.flatMap((p) => claudeSettingsAuthOverrides(p).map((k) => `${p}:${k}`));
}

export type CredentialSourcePlan =
  | { kind: 'default' }
  | { kind: 'ineffective'; warning: string }
  | { kind: 'refuse'; reason: string }
  | { kind: 'copy'; family: CredentialSourceFamily; sourceDir: string };

/**
 * CLIs proven to take their login from the copied file(s). Allow-list on
 * purpose: other Claude-family forks (seed / relay authenticate via ByteCloud
 * SSO, not `.credentials.json`) would otherwise slide into the copy branch
 * just because they expose a CLAUDE_CONFIG_DIR, and silently keep running on
 * the shared login. Add a CLI here only after verifying it on a real host.
 */
export const CREDENTIAL_SOURCE_SUPPORTED_CLIS: Readonly<Record<string, CredentialSourceFamily>> = {
  'claude-code': 'claude',
};

/** Why a sandbox-requested spawn is NOT redirecting its CLI data root. */
function redirectBlocker(input: {
  cliId: string;
  wrapperCli?: string;
  supportsReadIsolation: boolean;
  sessionDataDirPresent: boolean;
}): string {
  if (input.wrapperCli) {
    return `wrapperCli is set (under the sandbox the wrapper is ignored and the CLI data dir is not redirected) — remove wrapperCli and retry`;
  }
  if (!input.supportsReadIsolation) return `adapter ${input.cliId} does not support per-bot data dir redirection`;
  if (!input.sessionDataDirPresent) return 'SESSION_DATA_DIR is missing, so there is no per-bot data dir to copy into';
  return 'the CLI data dir is not redirected for this session';
}

/** Pure decision: what the worker must do with `credentialsSourceDir` for this spawn.
 *  `sourceDir` is the raw configured value (a `/config set` write stores it
 *  as typed), normalized here so every entry point gets the same rules.
 *  Unconfigured → `default` regardless of any sandbox setting. */
export function planCredentialSource(input: {
  sourceDir?: unknown;
  cliId: string;
  codexAuthSync?: string;
  /** Sandbox / readIsolation requested for this spawn (incl. the host-wide switch). */
  sandboxRequested: boolean;
  /** The spawn redirects the CLI into a per-bot data root (sandbox / forced home). */
  willRedirectCliData: boolean;
  /** Inputs explaining a non-redirect under a requested sandbox. */
  wrapperCli?: string;
  supportsReadIsolation: boolean;
  sessionDataDirPresent: boolean;
  /** The adapter is Claude-family (it exposes a CLAUDE_CONFIG_DIR data root). */
  isClaudeFamily: boolean;
  /** The bot's own bots.json `env` (injected into its CLI). */
  perBotEnv?: Record<string, string>;
  home?: string;
}): CredentialSourcePlan {
  const cannot = (why: string): CredentialSourcePlan => ({
    kind: 'refuse',
    reason: `this bot's credentialsSourceDir cannot take effect under the current sandbox/redirect conditions: ${why}`,
  });
  // Only a bot that is not sandboxed at all is outside this feature's reach
  // (it uses the global login, exactly as today). A sandboxed bot that was
  // configured for its own account must never fall back to the shared one.
  const notSandboxed = !input.sandboxRequested && !input.willRedirectCliData;
  let sourceDir: string | undefined;
  try {
    sourceDir = normalizeCredentialsSourceDir(input.sourceDir, input.home);
  } catch (e) {
    const reason = (e as Error).message;
    return notSandboxed
      ? { kind: 'ineffective', warning: `${reason} (ignored: this bot is not sandboxed)` }
      : cannot(reason);
  }
  if (!sourceDir) return { kind: 'default' };
  if (notSandboxed) {
    return {
      kind: 'ineffective',
      warning: `credentialsSourceDir=${sourceDir} has no effect: this bot is not sandboxed, `
        + `so its CLI uses the global login directly (nothing is copied)`,
    };
  }
  if (!input.willRedirectCliData) {
    return cannot(redirectBlocker(input));
  }
  if (input.codexAuthSync === 'isolated') {
    return { kind: 'refuse', reason: 'credentialsSourceDir cannot be combined with codexAuthSync "isolated"' };
  }
  const family = Object.prototype.hasOwnProperty.call(CREDENTIAL_SOURCE_SUPPORTED_CLIS, input.cliId)
    ? CREDENTIAL_SOURCE_SUPPORTED_CLIS[input.cliId]
    : undefined;
  if (family !== 'claude' || !input.isClaudeFamily) {
    return {
      kind: 'refuse',
      reason: `credentialsSourceDir is not supported for cli ${input.cliId} yet (supported: `
        + `${Object.keys(CREDENTIAL_SOURCE_SUPPORTED_CLIS).join(', ')}); refusing to start rather than run with the shared login`,
    };
  }
  const conflicting = claudeAuthOverrideKeys(input.perBotEnv);
  if (conflicting.length) {
    return {
      kind: 'refuse',
      reason: `credentialsSourceDir cannot be combined with per-bot env ${conflicting.join(', ')} `
        + `(the bot would not run as the source account)`,
    };
  }
  return { kind: 'copy', family, sourceDir };
}

/**
 * Read the credential files for `family` from `sourceDir`. Throws with a
 * specific reason when any file is missing, not a regular file, empty, or (for
 * Claude) not an OAuth credential. Returns relative name → raw content.
 */
export function readCredentialSource(sourceDir: string, family: CredentialSourceFamily): Record<string, string> {
  const layout = CREDENTIAL_SOURCE_LAYOUTS[family];
  const out: Record<string, string> = {};
  for (const name of layout.files) {
    const path = join(sourceDir, layout.subdir, name);
    let raw: string;
    try {
      raw = readRegularFileNoFollow(path).trim();
    } catch (e) {
      throw new Error(`credential source ${path} is unreadable: ${(e as Error).message}`);
    }
    if (!raw) throw new Error(`credential source ${path} is empty`);
    if (family === 'claude' && name === '.credentials.json') assertClaudeOauthCredential(raw, path);
    out[name] = raw;
  }
  return out;
}

/** O_NOFOLLOW + fstat on the SAME descriptor: a leaf symlink is refused and
 *  the bytes returned are exactly the bytes validated (no stat→read window). */
function readRegularFileNoFollow(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    return readFileSync(fd, 'utf-8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Align the per-bot Claude state file (`<data root>/.claude.json`) with the
 * source account. It is seeded ONCE from the global `~/.claude.json`, so a bot
 * that ran before being pointed at account B still carries the shared
 * account's `oauthAccount` (what `/status` shows) and possibly a
 * `primaryApiKey` (an API-key login Claude would authenticate with).
 *
 *  - `<sourceDir>/claude/.claude.json` present → its `oauthAccount` replaces
 *    ours (removed when it has none); it must be a readable regular JSON
 *    object file, else throw.
 *  - absent → `oauthAccount` is removed so Claude re-derives it from the
 *    copied token.
 *  - `primaryApiKey` is always removed.
 * Everything else (projects/trust, mcpServers, UI flags) is kept. Written
 * atomically 0600. Throws on any failure (caller fails the spawn closed).
 */
export function reconcileClaudeAccountState(statePath: string, sourceDir: string): void {
  const layout = CREDENTIAL_SOURCE_LAYOUTS.claude;
  const srcPath = join(sourceDir, layout.subdir, '.claude.json');
  let srcAccount: unknown;
  let srcRaw: string | undefined;
  try {
    srcRaw = readRegularFileNoFollow(srcPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`credential source ${srcPath} is unreadable: ${(e as Error).message}`);
    }
  }
  if (srcRaw !== undefined) {
    const parsed = parseJsonObject(srcRaw);
    if (!parsed) throw new Error(`credential source ${srcPath} is not a JSON object`);
    srcAccount = parsed.oauthAccount;
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseJsonObject(readRegularFileNoFollow(statePath));
    if (!parsed) throw new Error('not a JSON object');
    data = parsed;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`per-bot Claude state ${statePath} is unreadable: ${(e as Error).message}`);
    }
  }
  if (srcAccount !== undefined && srcAccount !== null) data.oauthAccount = srcAccount;
  else delete data.oauthAccount;
  delete data.primaryApiKey;
  writeFileAtomic0600(statePath, `${JSON.stringify(data, null, 2)}\n`);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** `primaryApiKey` in a Claude state file (an API-key login). */
export function claudeStateAuthOverrides(statePath: string): string[] {
  let raw: string;
  try { raw = readFileSync(statePath, 'utf-8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : ['<unreadable>'];
  }
  const data = parseJsonObject(raw);
  if (!data) return ['<unreadable>'];
  return typeof data.primaryApiKey === 'string' && data.primaryApiKey ? ['primaryApiKey'] : [];
}

function assertClaudeOauthCredential(raw: string, path: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error(`credential source ${path} is not valid JSON`);
  }
  const oauth = (parsed as { claudeAiOauth?: { accessToken?: unknown } } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    throw new Error(`credential source ${path} has no claudeAiOauth.accessToken`);
  }
}

/**
 * Per-session record of which credential source the session's CLI generation
 * was LAUNCHED with (the normalized dir, or none for the shared login). A
 * persistent pane (tmux/herdr/zellij/zmx) survives worker restarts and keeps
 * the login it started with, so the next worker must refuse to reattach when
 * the configured source no longer matches — otherwise a bot switched to
 * account B silently keeps running as A. Lives in the worker data dir, outside
 * the pane's reach. Absent record ≡ launched with the shared login, so
 * sessions that never used this feature reattach exactly as before.
 */
export function credentialSourceStampPath(dataDir: string, sessionId: string): string {
  return join(dataDir, 'credentials-source', `${sessionId}.json`);
}

/** The recorded source dir, or null when absent (shared login). A present but
 *  unreadable/garbage record yields a value no configuration can match, so it
 *  forces a cold spawn rather than a reattach. */
export function readCredentialSourceStamp(dataDir: string, sessionId: string): string | null {
  const path = credentialSourceStampPath(dataDir, sessionId);
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : UNREADABLE_STAMP;
  }
  try {
    const parsed = JSON.parse(raw) as { sourceDir?: unknown };
    return typeof parsed?.sourceDir === 'string' && parsed.sourceDir ? parsed.sourceDir : UNREADABLE_STAMP;
  } catch {
    return UNREADABLE_STAMP;
  }
}
const UNREADABLE_STAMP = '\u0000unreadable';

/** Record the source a cold-spawned generation launched with; clears the
 *  record for a shared-login launch. Throws on failure so a later reattach can
 *  never trust a stale record. */
export function writeCredentialSourceStamp(dataDir: string, sessionId: string, sourceDir: string | undefined): void {
  const path = credentialSourceStampPath(dataDir, sessionId);
  if (!sourceDir) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic0600(path, `${JSON.stringify({ sourceDir })}\n`);
}

/** Write `body` to `path` via a fresh 0600 temp file + rename: never follows
 *  an existing leaf symlink and always leaves a private regular file. */
export function writeFileAtomic0600(path: string, body: string): void {
  const parent = dirname(path);
  assertRealDirectory(parent);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  // O_EXCL creation with 0600 (umask can only narrow it): always private.
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, body); // loops until the whole buffer is written
    } finally {
      closeSync(fd);
    }
    // Re-check right before publishing: the parent must still be the same
    // real directory (not swapped for a symlink since the first check).
    assertRealDirectory(parent);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Throw unless `dir` itself is a real directory, not a symlink. The per-bot
 *  data root (`<BOT_HOME>/claude`) is sandbox-writable, so a CLI could swap it
 *  for a symlink to redirect this host-side write; BOT_HOME's own parent is
 *  not writable from the sandbox, so the leaf is the component to pin. (Host
 *  ancestors such as a symlinked $HOME are trusted and intentionally allowed.) */
function assertRealDirectory(dir: string): void {
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to write credentials: ${dir} is not a real directory`);
  }
}
