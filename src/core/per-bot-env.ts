/**
 * Per-bot environment variables (`bots.json` → `env`).
 *
 * A bot entry may declare `env: { KEY: value, ... }` to inject extra environment
 * variables into THAT bot's CLI process — e.g. point one bot at a third-party
 * Anthropic/OpenAI-compatible provider (GLM / Kimi / a self-hosted gateway) via
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, set an `HTTPS_PROXY`, or flip a
 * CLI-specific feature flag.
 *
 * IMPORTANT — injection layer: this env is delivered to the CLI **per session**,
 * NOT into the daemon's own process env. Under the tmux/zellij backends every
 * bot shares ONE backing server whose global env is captured from whichever
 * pane starts it first; putting provider creds into that shared global would let
 * bot A's base-url/token leak into bot B's panes (startup-order dependent). So
 * the worker passes this env as `SpawnOpts.injectEnv`, and the persistent
 * backends inject it via the per-pane `/usr/bin/env KEY=VAL` prefix (after rcfile
 * load, authoritative for that pane only) — never into the shared server env.
 * The pty backend, which has no shared server, merges it into the child env.
 *
 * This is NOT a secret vault: values live in `bots.json` and the process
 * environment in plaintext, visible to local diagnostic tools.
 *
 * Caveat — file sandbox: when a session runs inside the bwrap file sandbox the
 * CLI's env is carried via `bwrap --setenv` (not the backend's injectEnv path),
 * so per-bot env may not reach a sandboxed CLI. The common provider use case
 * (GLM etc.) doesn't run sandboxed; sandbox + per-bot env is a possible follow-up.
 */

/** Valid POSIX-ish env var name: letter/underscore start, then word chars. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names botmux owns to route the session, locate the daemon, and carry bot
 * creds — a per-bot `env` must never set these, or user config could hijack
 * session identity, clobber the CLI data root (Seed/Relay), or shadow a
 * botmux-managed flag. Mirrors the worker's injected/redacted keys
 * (BOTMUX_INJECTED_ENV_KEYS + REDACTED_CHILD_ENV_KEYS); kept as a local literal
 * so this stays a dependency-free leaf module. `LARK_APP_` covers both bare
 * creds; `BOTMUX` prefix covers all session-routing keys.
 */
const RESERVED_ENV_PREFIXES = ['BOTMUX', 'LARK_APP_'] as const;
const RESERVED_ENV_KEYS = new Set<string>([
  '__OWNER_OPEN_ID',
  'SESSION_DATA_DIR',
  'IS_SANDBOX',
  'CLAUDECODE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_RESUME_TOKEN_THRESHOLD',
  'CJADK_INTERACTIVE',
]);

/** Whether `key` is botmux-controlled and therefore rejected from per-bot env. */
export function isReservedPerBotEnvKey(key: string): boolean {
  if (RESERVED_ENV_KEYS.has(key)) return true;
  return RESERVED_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Sanitize a raw `env` value (from bots.json / dashboard / a config command)
 * into a clean `KEY -> string` map: drops anything that isn't a plain object,
 * keys with an invalid env-var name or a botmux-reserved name, and values that
 * aren't a string/number/boolean (primitives are stringified). Pure + total —
 * always returns an object, never throws.
 */
export function sanitizePerBotEnv(raw: unknown): Record<string, string> {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ENV_KEY_RE.test(key)) continue;
    if (isReservedPerBotEnvKey(key)) continue;
    if (typeof value === 'string') out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}
