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
 * File sandbox: the backend applies this per-pane/per-child env to the outer
 * bwrap/Seatbelt process. Neither wrapper clears inherited env, so the values
 * reach the CLI without being placed in bwrap argv; bwrap's own `--setenv`
 * pairs only override botmux-managed sandbox values such as HOME/PATH/relay.
 * Both paths retain the same per-bot boundary and are regression-tested.
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
  // Scratch is owned by the logical session. A bot-wide override would merge
  // every topic into one uncollectable directory and can point heavy builds at
  // a tmpfs-backed /tmp. The worker injects all three keys per session.
  'TMPDIR',
  'TMP',
  'TEMP',
  'IS_SANDBOX',
  // The bots.json the CLI child loads. NOT covered by the `BOTMUX` prefix, and
  // it is the TOP of the registry precedence chain — so a per-bot `env` setting
  // it would let a bot REDIRECT THE REGISTRY THAT DEFINES IT: point it at an
  // attacker-authored file and the child's `botmux send` resolves a different
  // fleet (different appIds, different oncall chats, different brand label),
  // while the host keeps believing it configured this bot. The daemon pins the
  // exact path it loaded (see core/config-dir.ts resolveChildBotsConfig), so a
  // per-bot value has no legitimate use.
  'BOTS_CONFIG',
  // Claude session-identity markers (mirrors CLAUDE_SESSION_MARKER_ENV_KEYS in
  // utils/child-env.ts): explicitly configuring one would mark the bot's CLI
  // as a nested Claude child session (CLAUDE_CODE_CHILD_SESSION silently turns
  // transcript persistence off) or pin a foreign session identity. CLAUDE_EFFORT
  // stays configurable — it's a behavior knob, not an identity marker.
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  // lark-cli keystore data root (Linux): `<value>/lark-cli` holds THIS bot's
  // appsecret + the shared master key. The file sandbox freezes the keystore path
  // from the worker's OWN process env value and denies the store (carving out only
  // this bot's keys); a per-bot inject would (a) NOT reach a sandboxed child anyway
  // (bwrap uses a --setenv allowlist that excludes it + the worker re-pins it), so
  // it would be silently overridden — confusing — and (b) if it DID take effect on a
  // non-sandboxed path, relocate the keystore out from under the frozen policy. So a
  // per-bot `env` must not set it: reserve it (rejected + diagnosable), not silently
  // accepted-then-ignored. The authoritative value is the worker's env.
  'LARKSUITE_CLI_DATA_DIR',
  // Grok data root: daemon installs hooks/skills and drains transcripts under
  // the process-level GROK_HOME. A per-bot inject would only reach the child
  // CLI and split-brain path resolution (see grok-paths header).
  'GROK_HOME',
  // DSH profile/session home is a process-level path: adapters must pre-create
  // and sandbox-bind the same directory the child will use. Per-bot injection
  // happens too late for authPaths/readonlyRoots and would split-brain the
  // runner/TUI profile state, so keep it process-level like GROK_HOME.
  'DSH_HOME',
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

/**
 * Compute the env map to persist from a dashboard save. `replace` = `incoming`
 * as-is; `merge` = `prev` minus `remove`, then `incoming` overrides same-named
 * keys. Returns `null` when the result is empty (= clear the field).
 */
export function nextPerBotEnv(opts: {
  prev?: Record<string, string>;
  incoming: Record<string, string>;
  mode: 'replace' | 'merge';
  remove?: readonly string[];
}): Record<string, string> | null {
  let next: Record<string, string>;
  if (opts.mode === 'merge') {
    next = { ...(opts.prev ?? {}) };
    for (const k of opts.remove ?? []) delete next[k];
    Object.assign(next, opts.incoming);
  } else {
    next = { ...opts.incoming };
  }
  return Object.keys(next).length ? next : null;
}

/** Input format recognised by {@link parsePerBotEnvText}. */
export type PerBotEnvTextFormat = 'json' | 'dotenv';

export type PerBotEnvTextParse =
  | {
    ok: true;
    format: PerBotEnvTextFormat;
    /** Raw `KEY -> value` (last duplicate wins); NOT yet sanitized. */
    env: Record<string, unknown>;
    /** 1-based line numbers skipped as non-assignments (shell glue such as
     *  `exec env \` or `claude "$@"`); always empty for JSON. */
    ignoredLines: number[];
  }
  | { ok: false; reason: 'invalid_json' | 'invalid_env_line' | 'empty'; line?: number };

/**
 * Parse the per-bot env editor text into a raw key/value map. Accepts:
 *  - a JSON object `{"KEY":"v"}`, or a Claude settings snippet `{"env":{...}}`
 *    (unwrapped only when `env` is the sole key and holds an object — env
 *    values are primitives, so this can't shadow a real variable);
 *  - dotenv / shell lines: `KEY=v`, `export KEY=v`, `KEY='v'`, `KEY="v\n"`,
 *    `# comments`, inline ` # comments` after unquoted values, and the
 *    `exec env \` + `  KEY='v' \` launcher-script shape (trailing `\` and
 *    non-assignment lines are skipped and reported via `ignoredLines`).
 * `$VAR` references are kept literally — nothing is expanded or executed.
 * Pure + total: never throws. Name/reserved-key validation stays with
 * {@link sanitizePerBotEnv} / {@link isReservedPerBotEnvKey}.
 */
export function parsePerBotEnvText(text: string): PerBotEnvTextParse {
  const src = text.replace(/^\uFEFF/, '').trim();
  if (!src) return { ok: false, reason: 'empty' };
  // `[`/`"` can't start a dotenv line — treat as (non-object) JSON so the
  // error says "not a JSON object" rather than "bad line 1".
  if (/^[{["]/.test(src)) {
    let parsed: unknown;
    try { parsed = JSON.parse(src); } catch { return { ok: false, reason: 'invalid_json' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid_json' };
    let obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === 'env' && obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
      obj = obj.env as Record<string, unknown>;
    }
    return { ok: true, format: 'json', env: { ...obj }, ignoredLines: [] };
  }

  const env: Record<string, unknown> = {};
  const ignoredLines: number[] = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (/(^|\s)\\$/.test(line)) line = line.slice(0, -1).trimEnd();
    line = line.replace(/^export\s+/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) { ignoredLines.push(i + 1); continue; }
    const value = parseEnvValue(m[2]);
    if (value === null) return { ok: false, reason: 'invalid_env_line', line: i + 1 };
    env[m[1]] = value;
  }
  if (Object.keys(env).length === 0) return { ok: false, reason: 'invalid_env_line', line: ignoredLines[0] };
  return { ok: true, format: 'dotenv', env, ignoredLines };
}

/** Unquote one dotenv value; `null` = unterminated quote / trailing junk. */
function parseEnvValue(raw: string): string | null {
  const v = raw.trim();
  const q = v[0];
  if (q !== "'" && q !== '"') return v.replace(/\s+#.*$/, '');
  let out = '';
  for (let i = 1; i < v.length; i++) {
    const ch = v[i];
    if (ch === q) return /^\s*(#.*)?$/.test(v.slice(i + 1)) ? out : null;
    if (q === '"' && ch === '\\' && i + 1 < v.length) {
      const nx = v[++i];
      out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
      continue;
    }
    out += ch;
  }
  return null;
}
