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

/** The reserved list for display (Dashboard「botmux 保留」group). */
export function reservedSessionEnvKeys(): { keys: string[]; prefixes: string[] } {
  return { keys: [...RESERVED_ENV_KEYS].sort(), prefixes: [...RESERVED_ENV_PREFIXES] };
}

/**
 * Login-shell shim the worker points the pane at when the lark tool binding or
 * trigger-user identity wraps CLI tools (core/cli-identity.ts). With either
 * feature on, the worker overwrites these per session, so a configured value
 * can never take effect there; with both off they are ordinary user variables.
 */
const IDENTITY_SHELL_ENV_KEYS: ReadonlySet<string> = new Set(['ZDOTDIR', 'BASH_ENV']);
/** Git attribution for the acting person (gitIdentityConfigEnv emits COUNT=3,
 *  so the numbered keys are exactly 0..2). Injected only by trigger-user auth. */
const IDENTITY_GIT_ENV_KEYS: ReadonlySet<string> = new Set([
  'GIT_ASKPASS', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_KEY_2', 'GIT_CONFIG_VALUE_2',
]);
/** May be overridden but never removed: botmux resolves the CLI binary and
 *  its own wrapper dir through them, so a session without them cannot start. */
const UNSET_FORBIDDEN_ENV_KEYS: ReadonlySet<string> = new Set(['PATH', 'HOME']);

/** Which identity wrappers are active for a bot (see {@link sessionEnvLock}). */
export interface SessionEnvLockContext {
  /** Lark tool binding or trigger-user auth: ZDOTDIR / BASH_ENV are botmux's. */
  identityShell?: boolean;
  /** Trigger-user auth: GIT_ASKPASS / GIT_CONFIG_* are botmux's. */
  identityGit?: boolean;
}

/**
 * - `reserved`  botmux-owned in every session: cannot be set or removed.
 * - `identity`  owned by an identity wrapper that is ON for this bot: same.
 * - `no-unset`  may be set, may not be removed.
 */
export type SessionEnvLock = 'reserved' | 'identity' | 'no-unset';

/** Names an active identity wrapper owns for a bot with `ctx` (display). */
export function identityWrapperEnvKeys(ctx: SessionEnvLockContext): string[] {
  return [
    ...(ctx.identityShell || ctx.identityGit ? [...IDENTITY_SHELL_ENV_KEYS] : []),
    ...(ctx.identityGit ? [...IDENTITY_GIT_ENV_KEYS] : []),
  ];
}

/**
 * The single lock rule for the session environment (global + per-bot layers,
 * the Dashboard editor and the spawn-time composition all ask this function).
 */
export function sessionEnvLock(key: string, ctx: SessionEnvLockContext = {}): SessionEnvLock | null {
  if (isReservedPerBotEnvKey(key)) return 'reserved';
  if (ctx.identityShell && IDENTITY_SHELL_ENV_KEYS.has(key)) return 'identity';
  if (ctx.identityGit && (IDENTITY_SHELL_ENV_KEYS.has(key) || IDENTITY_GIT_ENV_KEYS.has(key))) return 'identity';
  if (UNSET_FORBIDDEN_ENV_KEYS.has(key)) return 'no-unset';
  return null;
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
    /** 1-based start lines of logical lines skipped as non-assignments (shell
     *  glue such as `set -euo pipefail`); always empty for JSON. */
    ignoredLines: number[];
  }
  | { ok: false; reason: 'invalid_json' | 'invalid_env_line' | 'empty'; line?: number };

/**
 * Parse the per-bot env editor text into a raw key/value map. Accepts:
 *  - a JSON object `{"KEY":"v"}`, or a Claude settings snippet `{"env":{...}}`
 *    (unwrapped only when `env` is the sole key and holds an object — env
 *    values are primitives, so this can't shadow a real variable);
 *  - dotenv / shell lines, tokenized with shell quoting rules: `KEY=v`,
 *    `export KEY=v`, several `A=1 B=2` per line, `'literal'`, `"v\n"`, `#`
 *    comments (only at a word start, so `HASH=a#b` stays a value), and `\`
 *    line continuations joined like the shell does — which is what makes the
 *    `exec env \ KEY='v' \ claude "$@"` launcher shape work: assignments after
 *    an `exec`/`env` prefix are taken, the trailing command is dropped.
 * Rejected rather than guessed (so nothing is silently stored wrong):
 * unterminated quotes, a dangling final `\`, unquoted `; & | < > ( ) \``,
 * and words after plain assignments (`TOKEN=abc def` — likely missing quotes).
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
  for (const logical of tokenizeShellLines(src.replace(/\r\n?/g, '\n'))) {
    if ('error' in logical) return { ok: false, reason: 'invalid_env_line', line: logical.line };
    const { words, line } = logical;
    if (words.length === 0) continue;
    let i = 0;
    let launcher = false;
    let afterEnv = false;
    while (i < words.length && LAUNCHER_PREFIX_WORDS.has(words[i].text) && !words[i].quoted) {
      if (words[i].text !== 'export') launcher = true;
      if (words[i].text === 'env') afterEnv = true;
      i++;
    }
    // dotenv-style spacing around `=` (`KEY = v`, `KEY =v`, `KEY= v`, also
    // after `export`): one assignment with exactly one value word. Checked
    // after prefix stripping so `export KEY = v` can't fall through to the
    // "not an assignment" skip; extra words are an error, never a skip.
    const spaced = launcher ? null : dotenvSpacedAssignment(words.slice(i));
    if (spaced === 'invalid') return { ok: false, reason: 'invalid_env_line', line };
    if (spaced) { env[spaced[0]] = spaced[1]; continue; }
    const assignments: Array<[string, string]> = [];
    for (; i < words.length; i++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(words[i].text);
      // Shell assignments need an unquoted `NAME=` (`"A=1"` is a command word);
      // `env`'s own arguments are parsed after unquoting, so there it counts.
      if (!m || (words[i].nameQuoted && !afterEnv)) break;
      assignments.push([m[1], words[i].text.slice(m[0].length)]);
    }
    if (assignments.length === 0) { ignoredLines.push(line); continue; }
    // `exec env A=1 claude "$@"` — the trailing command is expected glue.
    // `A=1 junk` is not: most likely an unquoted value with a space.
    if (i < words.length && !launcher) return { ok: false, reason: 'invalid_env_line', line };
    for (const [k, v] of assignments) env[k] = v;
  }
  if (Object.keys(env).length === 0) return { ok: false, reason: 'invalid_env_line', line: ignoredLines[0] };
  return { ok: true, format: 'dotenv', env, ignoredLines };
}

/**
 * Recognize a dotenv assignment written with whitespace around `=`:
 * `KEY = v` / `KEY =v` / `KEY =""` (name word, then a word starting with `=`)
 * or `KEY= v` (empty `KEY=` followed by a single non-assignment value word).
 * Returns `null` when the words are not in that shape, `'invalid'` when they
 * are but carry extra words (likely a missing quote).
 */
function dotenvSpacedAssignment(words: ShellWord[]): [string, string] | 'invalid' | null {
  if (words.length < 2 || words[0].quoted) return null;
  const head = words[0].text;
  if (ENV_KEY_RE.test(head) && !words[1].nameQuoted && words[1].text.startsWith('=')) {
    // A bare unquoted `=` takes the next word as the value; `=v` / `=""` carries it.
    const bareEquals = words[1].text === '=' && !words[1].quoted;
    if (words.length > (bareEquals ? 3 : 2)) return 'invalid';
    return [head, bareEquals ? (words[2]?.text ?? '') : words[1].text.slice(1)];
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=$/.exec(head);
  // `A= B=2` stays two shell assignments (A empty), handled by the caller.
  if (m && !words[0].nameQuoted && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[1].text)) {
    if (words.length > 2) return 'invalid';
    return [m[1], words[1].text];
  }
  return null;
}

/** Unquoted leading words allowed before assignments on one logical line. */
const LAUNCHER_PREFIX_WORDS = new Set(['export', 'exec', 'env']);

interface ShellWord {
  text: string;
  /** Any part of the word was quoted. */
  quoted: boolean;
  /** A quote/escape appeared before the first unquoted `=` (so it isn't an assignment). */
  nameQuoted: boolean;
}

/**
 * Split text into logical lines of shell words. Handles `'…'` (literal),
 * `"…"` (dotenv-style `\n \t \r` plus shell `\" \\ \$ \``; any other escape
 * keeps its backslash), unquoted `\x`, `\`-newline continuation, and `#`
 * comments at a word start. Yields `{ error }` for constructs we refuse.
 */
function* tokenizeShellLines(src: string): Generator<{ words: ShellWord[]; line: number } | { error: true; line: number }> {
  let lineNo = 1;
  let startLine = 1;
  let words: ShellWord[] = [];
  let cur: ShellWord | null = null;
  const word = () => (cur ??= { text: '', quoted: false, nameQuoted: false });
  const markQuoted = (w: ShellWord) => {
    w.quoted = true;
    if (!w.text.includes('=')) w.nameQuoted = true;
  };
  const endWord = () => { if (cur) { words.push(cur); cur = null; } };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') {
      endWord();
      yield { words, line: startLine };
      words = [];
      lineNo++;
      startLine = lineNo;
      continue;
    }
    if (ch === ' ' || ch === '\t') { endWord(); continue; }
    if (ch === '#' && !cur) {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= src.length) return yield { error: true, line: startLine };  // dangling continuation
      if (src[i + 1] === '\n') { i++; lineNo++; continue; }  // continuation: join lines
      const w = word();
      markQuoted(w);
      w.text += src[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      const w = word();
      markQuoted(w);
      let closed = false;
      for (i++; i < src.length; i++) {
        const c = src[i];
        if (c === ch) { closed = true; break; }
        if (c === '\n') lineNo++;
        if (ch === '"' && c === '\\' && i + 1 < src.length) {
          const nx = src[++i];
          if (nx === '\n') { lineNo++; continue; }
          w.text += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r'
            : nx === '"' || nx === '\\' || nx === '$' || nx === '`' ? nx
            : '\\' + nx;
          continue;
        }
        w.text += c;
      }
      if (!closed) return yield { error: true, line: startLine };
      continue;
    }
    if (';&|<>()`'.includes(ch)) return yield { error: true, line: startLine };
    word().text += ch;
  }
  endWord();
  yield { words, line: startLine };
}
