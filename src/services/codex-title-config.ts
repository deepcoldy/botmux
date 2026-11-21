/**
 * Provider wiring for the ISOLATED Codex title home.
 *
 * `generateCodexAppThreadTitle` runs the app-server inside a throwaway
 * `CODEX_HOME` so a title call cannot load the user's hooks, plugins, MCP
 * servers, memories or project instructions. That isolation used to copy
 * `auth.json` and NOTHING else — which silently dropped `config.toml`, i.e. the
 * only place a Bot's `model_provider` + `[model_providers.*]` live.
 *
 * That was invisible while the generator was Codex-internal, but the session
 * group `ai-summary` path now routes through it. For a Bot whose credentials are
 * meant for a gateway provider (relay / in-house endpoint, `env_key` or inline
 * `http_headers`), the isolated home fell back to codex's built-in `openai`
 * provider: the call either failed outright (placeholder kept forever) or — if
 * `auth.json` carries a ChatGPT subscription — quietly billed the HOST account
 * on the default endpoint instead of the Bot's configured provider.
 *
 * So this module copies the provider-loading slice of the source `config.toml`
 * and nothing else:
 *   - `model`               — the model name that provider serves
 *   - `model_provider`      — which provider the Bot's sessions use
 *   - `model_providers`     — the provider table (base_url / wire_api /
 *                             env_key / http_headers / requires_openai_auth …)
 *
 * Deliberately NOT copied (`model_reasoning_effort` included, even though it is
 * "a model key"): reasoning effort is pinned to `low` by the caller's
 * `thread/start` config, and everything else carries user payload — hooks,
 * plugins, `mcp_servers`, `projects`/`trust`, `profiles`, `features`,
 * `shell_environment_policy`, notify/OTEL settings. Inline `http_headers`
 * secrets inside a copied provider ARE credentialed material, exactly like
 * `auth.json`; they land in the same 0700 scratch home and are removed with it.
 *
 * Fail closed: if the source `config.toml` exists but cannot be read safely
 * (symlink, hard link, oversized, unstable) or does not parse, the title call is
 * abandoned instead of inheriting codex's default provider. A wrong provider is
 * worse than a missing title — it silently spends someone else's quota.
 */
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';

/** Top-level `config.toml` keys the isolated title home inherits. See the file
 *  header for why each one is here and why nothing else is. */
export const TITLE_CONFIG_INHERITED_KEYS = ['model', 'model_provider', 'model_providers'] as const;

/** Same ceiling `codex-profiles.readToml` uses for a config we only inspect. */
const MAX_CONFIG_BYTES = 256 * 1024;

export type TitleConfigFailure =
  | 'config_unsafe_file'
  | 'config_too_large'
  | 'config_changed'
  | 'config_invalid_toml'
  | 'config_write_failed';

export type IsolatedTitleHomeResult =
  | { ok: true; /** Keys actually written; empty when the source has no config. */ inherited: string[] }
  | { ok: false; reason: TitleConfigFailure };

type TomlTable = Record<string, unknown>;

/** A TOML table (not array/date/scalar). */
function isTable(value: unknown): value is TomlTable {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Date) && value.constructor?.name !== 'TomlDate';
}

/**
 * Read `config.toml` with the same defences as the profile scanner: no symlink,
 * single hard link, bounded size, identity stable across the read, and no parser
 * error text escaping to the caller.
 */
function readSourceConfig(path: string): { ok: true; config: TomlTable } | { ok: false; reason: TitleConfigFailure } {
  const fail = (reason: TitleConfigFailure) => ({ ok: false as const, reason });
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch {
    return fail('config_unsafe_file');
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return fail('config_unsafe_file');
  if (before.size > MAX_CONFIG_BYTES) return fail('config_too_large');
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return fail('config_unsafe_file');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_CONFIG_BYTES) {
      return fail('config_changed');
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_CONFIG_BYTES) return fail('config_too_large');
    // Identity must still match after the read: a config swapped mid-read would
    // otherwise pair one Bot's provider with another's credentials.
    const after = fstatSync(fd);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
      return fail('config_changed');
    }
    try {
      const parsed: unknown = parse(buffer.subarray(0, size).toString('utf8'));
      return isTable(parsed) ? { ok: true, config: parsed } : fail('config_invalid_toml');
    } catch {
      return fail('config_invalid_toml');
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Write the inherited slice of the source home's config into `targetHome`.
 *
 * `sourceCodexHome` is the Bot's own CODEX_HOME (the caller resolves the
 * default `~/.codex`); `targetHome` is the throwaway title home. Returns the
 * keys written so callers/tests can assert the whitelist held.
 */
export function provisionIsolatedTitleConfig(sourceCodexHome: string, targetHome: string): IsolatedTitleHomeResult {
  const sourcePath = join(sourceCodexHome, 'config.toml');
  if (!existsSync(sourcePath)) return { ok: true, inherited: [] };
  const read = readSourceConfig(sourcePath);
  if (!read.ok) return read;
  const inherited: TomlTable = {};
  const written: string[] = [];
  for (const key of TITLE_CONFIG_INHERITED_KEYS) {
    const value = read.config[key];
    if (value === undefined) continue;
    // A provider table is a map of provider → settings; anything else (array,
    // scalar, date) is a malformed config we refuse rather than pass through.
    if (key === 'model_providers' ? !isTable(value) : typeof value !== 'string') {
      return { ok: false, reason: 'config_invalid_toml' };
    }
    inherited[key] = value;
    written.push(key);
  }
  if (written.length === 0) return { ok: true, inherited: [] };
  try {
    // Fresh 0700 scratch dir; 0600 because a provider table may carry inline
    // http_headers credentials (same boundary as the copied auth.json).
    writeFileSync(join(targetHome, 'config.toml'), stringify(inherited), { mode: 0o600 });
  } catch {
    return { ok: false, reason: 'config_write_failed' };
  }
  return { ok: true, inherited: written };
}

/** Resolve the Bot's own Codex home from an already-composed child env. */
export function resolveSourceCodexHome(env: NodeJS.ProcessEnv | undefined, fallbackHome: string): string {
  const configured = env?.CODEX_HOME?.trim();
  if (!configured) return join(fallbackHome, '.codex');
  try {
    return realpathSync(configured);
  } catch {
    return configured;
  }
}
