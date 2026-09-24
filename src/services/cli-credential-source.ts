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
 * family into the bot's per-bot data root. The field is CLI-agnostic; each CLI
 * family opts in by adding an entry to {@link CREDENTIAL_SOURCE_LAYOUTS}.
 *
 * Contract (fail closed — a bot configured for account B must never silently
 * run as the shared account):
 *  - not configured                  → historical behaviour, untouched.
 *  - configured, bot not redirected  → no per-bot data root exists to copy
 *    into, the CLI keeps using the global login; warn so the operator sees the
 *    field had no effect.
 *  - configured, redirected, CLI family without a layout → refuse to start.
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

/** Pure decision: what the worker must do with `credentialsSourceDir` for this spawn.
 *  `sourceDir` is the raw configured value (a `/config set` write stores it
 *  as typed), normalized here so every entry point gets the same rules. */
export function planCredentialSource(input: {
  sourceDir?: unknown;
  cliId: string;
  codexAuthSync?: string;
  /** The spawn redirects the CLI into a per-bot data root (sandbox / forced home). */
  willRedirectCliData: boolean;
  /** The adapter is Claude-family (it exposes a CLAUDE_CONFIG_DIR data root). */
  isClaudeFamily: boolean;
  /** The bot's own bots.json `env` (injected into its CLI). */
  perBotEnv?: Record<string, string>;
  home?: string;
}): CredentialSourcePlan {
  let sourceDir: string | undefined;
  try {
    sourceDir = normalizeCredentialsSourceDir(input.sourceDir, input.home);
  } catch (e) {
    const reason = (e as Error).message;
    return input.willRedirectCliData
      ? { kind: 'refuse', reason }
      : { kind: 'ineffective', warning: `${reason} (ignored: this bot is not sandboxed)` };
  }
  if (!sourceDir) return { kind: 'default' };
  if (!input.willRedirectCliData) {
    return {
      kind: 'ineffective',
      warning: `credentialsSourceDir=${sourceDir} has no effect: this bot is not sandboxed, `
        + `so its CLI uses the global login directly (nothing is copied)`,
    };
  }
  if (input.codexAuthSync === 'isolated') {
    return { kind: 'refuse', reason: 'credentialsSourceDir cannot be combined with codexAuthSync "isolated"' };
  }
  if (input.isClaudeFamily) {
    const conflicting = claudeAuthOverrideKeys(input.perBotEnv);
    if (conflicting.length) {
      return {
        kind: 'refuse',
        reason: `credentialsSourceDir cannot be combined with per-bot env ${conflicting.join(', ')} `
          + `(the bot would not run as the source account)`,
      };
    }
    return { kind: 'copy', family: 'claude', sourceDir };
  }
  return {
    kind: 'refuse',
    reason: `credentialsSourceDir is not supported for cli ${input.cliId} yet; `
      + `refusing to start rather than run with the shared login`,
  };
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
      // O_NOFOLLOW + fstat on the SAME descriptor: a leaf symlink is refused
      // and the bytes validated below are exactly the bytes copied (no
      // stat→read swap window).
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
        raw = readFileSync(fd, 'utf-8').trim();
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      throw new Error(`credential source ${path} is unreadable: ${(e as Error).message}`);
    }
    if (!raw) throw new Error(`credential source ${path} is empty`);
    if (family === 'claude' && name === '.credentials.json') assertClaudeOauthCredential(raw, path);
    out[name] = raw;
  }
  return out;
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
