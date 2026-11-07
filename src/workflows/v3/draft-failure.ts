/**
 * Why a draft's orchestrating bot failed to call its model — a closed set the
 * Dashboard turns into words (design 2026-11-03
 * workflow-dashboard-orchestration §9, follow-up of D2).
 *
 * Only structured error codes decide the category (the worker's terminal
 * code, the trigger's error code, a code-shaped token in a failure text); the
 * raw error and terminal tail shown beside it go through `maskFailureText`
 * first. The categories follow
 * `recoveryCauseI18nKey` (ordinary-recovery-notice): one rule for "what kind
 * of failure is this" across cards and the Dashboard.
 *
 * Pure (no node imports): the Dashboard page uses it too.
 */

export const WORKFLOW_DRAFT_FAILURE_CATEGORIES = [
  /** The model credential may not use the model, or authentication failed. */
  'permission',
  /** Quota used up / rate limited / no capacity. */
  'quota',
  /** The model service is unreachable, or the connection broke mid-reply. */
  'unreachable',
  /** The model service refused the request as invalid. */
  'rejected',
  /** The call ran past its time budget. */
  'timeout',
  /** The bot's session could not be started or would not take the turn. */
  'session',
  'unknown',
] as const;

export type WorkflowDraftFailureCategory = typeof WORKFLOW_DRAFT_FAILURE_CATEGORIES[number];

export const WORKFLOW_DRAFT_FAILURE_STEPS = ['clarify_start', 'clarify_turn', 'architect'] as const;
export type WorkflowDraftFailureStep = typeof WORKFLOW_DRAFT_FAILURE_STEPS[number];

/** What a failure record keeps of an error code: a short identifier only. */
export const WORKFLOW_DRAFT_FAILURE_CODE_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

/** Prefixes of the terminal codes CLI adapters emit (claude-transcript,
 *  codex, grok, pi, traex, …), as they appear inside a failure text. */
const CODE_TOKEN_RE = /\b((?:provider|codex|claude|grok|pi|traex|omp|ebsd|riff|mojo|agy|gemini|kimi|qwen|cursor|opencode|doubao)_[a-z0-9_]{2,60})\b/;
const TERMINAL_TEXT_RE = /worker reported terminal failure:\s*([a-z0-9][a-z0-9_.:-]{0,63})/i;

/** Names of things that hold a secret, not a failure (an env var name such
 *  as CLAUDE_CODE_OAUTH_TOKEN, a key's label). */
const SECRET_NAME_RE = /token|secret|passw|cookie|api_?key|apikey|private_?key|access_?key|credential_?value/;

/**
 * Code-shaped and word-shaped: the codes adapters emit are short words joined
 * by `_` (provider_rate_limited), never a long run of letters and digits — a
 * key that happens to start with a CLI's prefix is not a code.
 */
function looksLikeCode(code: string): boolean {
  if (SECRET_NAME_RE.test(code)) return false;
  return code.split(/[_.:-]/).every((part) => part.length <= 24 && (part.match(/[0-9]/g)?.length ?? 0) <= 3);
}

/** A safe error code, or undefined (anything that is not code-shaped). */
export function normalizeFailureCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase();
  if (!code || code === 'unknown') return undefined;
  return WORKFLOW_DRAFT_FAILURE_CODE_RE.test(code) && looksLikeCode(code) ? code : undefined;
}

/**
 * The error code inside a failure text (the trigger's
 * "worker reported terminal failure: <code>", or a code-shaped token), never
 * the text itself.
 */
export function extractFailureCode(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const terminal = TERMINAL_TEXT_RE.exec(text);
  if (terminal) return normalizeFailureCode(terminal[1]);
  // Codes are written in lower case; an upper-case name (an env var such as
  // CLAUDE_CODE_OAUTH_TOKEN) is not one.
  const token = CODE_TOKEN_RE.exec(text);
  return token ? normalizeFailureCode(token[1]) : undefined;
}

// ─── 原始报错 / 终端输出的脱敏 ─────────────────────────────────────────────
//
// Every rule runs in time linear in the text: a failed turn's screen may be a
// whole session's output, and one rule that backtracks quadratically over a
// long row (`???…`, `a-a-a-…`, a run of blanks) would stall the worker.

const HIDDEN = '‹hidden›';

/** The characters of a credential's name (`ANTHROPIC_API_KEY`, `x-api-key`). */
const NAME = 'A-Za-z0-9_-';
/** Words that make a name a secret's. Not author… / authentic…: the
 *  `401 Unauthorized: <reason>` of an error is no credential. */
const SECRET_WORD = String.raw`token|secret|passw(?:or)?d|api[_-]?key|apikey|encrypt[_-]?key|auth(?!or|en)|cookie|session|signature|credential|private[_-]?key|access[_-]?key`;
/** `<word>_key` names of data, not of a secret (`idempotency_key`,
 *  `partition_key`; `env_key` names the variable that holds one). */
const DATA_KEY = String.raw`(?:idempotency|partition|sort|primary|foreign|cache|object|routing|shard|dedupe?|lookup|group|row|hash|env)[_-](?:key|sig)(?![${NAME}])`;
/** A secret's name: one holding a SECRET_WORD, or `key` / `sig` (alone or
 *  after a `-` / `_`: `x-key`, `ENCRYPTION_KEY`). The runs around the word
 *  are bounded. */
const SECRET_KEY = String.raw`[${NAME}]{0,64}(?:${SECRET_WORD})[${NAME}]{0,64}|(?:(?!${DATA_KEY})[${NAME}]{0,64}[_-])?(?:key|sig)`;
/** Where a name may begin: where a run of name characters begins (the
 *  character before it is matched, and kept), never inside one — from every
 *  `-` of a long `a-a-a-…` row a name would rescan the rest of it. Not a
 *  lookbehind: the Dashboard page runs this module too. */
const NAME_START = `(?:^|[^${NAME}])`;
/** The same as Chinese labels (`密码：…`). */
const SECRET_KEY_ZH = '密钥|秘钥|密码|口令|令牌|凭证|凭据';
/** Box-drawing borders: a TUI's frame, never part of a value. */
const BOX = '│┃║';
/** `:` or `=`, half- or full-width (`App Secret：…`), then a TUI border between
 *  the separator and the value (`│ token: │` puts it on the next row). */
const SEP = String.raw`\s*[:=：＝][\s│┃║|]*`;
/** An exception's class name and its colon (`CredentialsError: …`): what
 *  follows is its message, which a secret's name may still be in. */
const ERROR_NAME_AHEAD = String.raw`(?!["']?[${NAME}]{0,128}(?:error|exception|failure|failed)\\?["']?${SEP})`;
/** A secret's name and separator, up to its value (`"name": `, `name=`, `{\"name\":`). */
const SECRET_NAME = String.raw`(?:${NAME_START}${ERROR_NAME_AHEAD}["']?(?:${SECRET_KEY})|["']?(?:${SECRET_KEY_ZH})[为是]?)\\?["']?${SEP}`;
/** A command-line flag naming a secret (`--app-secret`, `--api-key`, `-token`). */
const SECRET_FLAG = String.raw`(?:^|[^\w-])--?(?:${SECRET_KEY})`;
/** What an error writes after "Bearer" / "Basic" (`Missing bearer or basic
 *  authentication in header`): words, not a credential. */
const SCHEME_PROSE = String.raw`(?!(?:or|and|auth|authentication|authorization|token|tokens|scheme|realm|header|credentials?)(?![A-Za-z0-9_+/=.~-]))`;

/** Ordered: the rest-of-line rules first, so a later rule never sees half a header. */
const FAILURE_SECRET_SHAPES: ReadonlyArray<{ re: RegExp; keep?: boolean; weakName?: true; countable?: true }> = [
  // Authorization / Cookie headers: whatever scheme, the whole value.
  { re: new RegExp(String.raw`(\b(?:proxy-)?authori[sz]ation\\?["']?${SEP})[^\n]+`, 'gi'), keep: true },
  { re: new RegExp(String.raw`(\b(?:set-)?cookie\\?["']?${SEP})[^\n]+`, 'gi'), keep: true },
  { re: new RegExp(String.raw`\bBearer[ \t]+["']?${SCHEME_PROSE}[^\s"'<>${BOX}]{8,}`, 'gi') },
  // "Bearer" at a row's end (a TUI box), the credential on the next row
  // only when shaped like one: the next row may be the error's next words.
  { re: new RegExp(String.raw`(\bBearer[ \t${BOX}|]*\n[ \t${BOX}|]*)(?=[^\s"'<>${BOX}]{0,256}[0-9])[^\s"'<>${BOX}]{16,}`, 'gi'), keep: true },
  // Case-sensitive below the keyword: `[a-z][A-Z]` is base64's mixed case.
  { re: new RegExp(String.raw`\b(?:[Bb]asic|BASIC)\s+${SCHEME_PROSE}(?=[A-Za-z0-9+/=]{0,256}[0-9+/=]|[A-Za-z0-9+/=]{0,256}[a-z][A-Z])[A-Za-z0-9+/=]{8,}`, 'g') },
  { re: /\bgh[pousr]_[A-Za-z0-9_]{8,}/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{8,}/g },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  // A PEM private key written on one row (`\n` escapes, a JSON string): its
  // body, up to the END marker. One spread over rows is maskPemBlocks'. A
  // marker quoted in prose or code has no body after it.
  { re: /(-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----)(?=(?:\\[nr]|\s){0,8}[A-Za-z0-9+/=]{16})[^-\n]+/g, keep: true },
  { re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{8,}/g },
  // A JWT starts a run: from inside one (after each `-`) it would rescan it.
  { re: new RegExp(String.raw`(${NAME_START})eyJ[${NAME}]{8,}\.[${NAME}]{8,}(?:\.[${NAME}]+)?`, 'g'), keep: true },
  { re: /\bsk-[A-Za-z0-9_-]{8,}/gi },
  // More vendor prefixes (GitLab, Slack apps, npm, Hugging Face, Stripe): a
  // long run after them, with a digit or very long (`npm_config_cache` stays).
  { re: /\b(?:glpat-|xapp-|npm_|hf_|[sr]k_(?:live|test)_)(?=[A-Za-z0-9_-]{0,64}[0-9]|[A-Za-z0-9_-]{30})[A-Za-z0-9_-]{16,}/g },
  // `curl -u user:password`, `mysql -pPASSWORD`.
  { re: /(\bcurl\b[^\n]{0,200}?\s(?:-u|--user)\s+[^\s:@'"]+:)[^\s'"]+/g, keep: true },
  { re: /(\bmysql(?:dump|admin)?\b[^\n]{0,200}?\s-p)[^\s'"]+/g, keep: true },
  // A token as a URL's whole userinfo: https://<token>@github.com/…
  { re: /(\/\/)(?=[A-Za-z0-9_-]{0,256}[0-9])[A-Za-z0-9_-]{20,}(?=@)/g, keep: true },
  // A Chinese label without a separator: 密钥是 …, App Secret 为 …
  { re: new RegExp(String.raw`((?:${SECRET_KEY_ZH}|secret|password|token)\s*[为是]\s*)[A-Za-z0-9+/=_.-]{8,}`, 'gi'), keep: true },
  // URL userinfo and every query value (?sig=, ?key=, ?t=, access_token=…).
  // A query name never holds `?`: one that could ran quadratic over `???…`.
  { re: /(\/\/[^\s/:@]*:)[^\s/@]+(?=@)/g, keep: true },
  { re: /([?&](?!(?:model|page|per_page|limit|offset|lang|locale|format|version|v|tab|sort|order|region)=)[^\s=&#?"'<>]+=)(?!(?:true|false|\d{1,6})(?![^\s&#"'<>]))[^\s&#"'<>]+/g, keep: true },
  // --name value, an argv array's "--name","value" (on one row or printed one
  // element a row): the next word, or a quoted value whole. Never a
  // separator: `-API_KEY = "…"` (a diff's removed row) is the name rule's.
  {
    re: new RegExp(
      String.raw`(${SECRET_FLAG}(?:[ \t]+(?![:=：＝])|\\?["'][ \t]*,\s*))(?:\\?"[^"\n]*"?|\\?'[^'\n]*'?|[^\s"'<>${BOX}]+)`,
      'gim',
    ),
    keep: true,
    countable: true,
  },
  // --name at a row's end (a box's border after it), its value word-wrapped
  // onto the next row (a TUI wraps by words), bare or quoted: only a value
  // shaped like a credential — a help text's next row starts with words.
  {
    re: new RegExp(
      String.raw`(${SECRET_FLAG}[ \t${BOX}|,]*\n[ \t${BOX}|]*)(?:\\?"(?=[^"\n${BOX}]{0,256}[0-9])[^"\n${BOX}]{8,}"?|\\?'(?=[^'\n${BOX}]{0,256}[0-9])[^'\n${BOX}]{8,}'?|(?=[^\s"'<>${BOX}]{0,256}[0-9])[^\s"'<>${BOX}]{8,})`,
      'gim',
    ),
    keep: true,
  },
  // "name": "value with blanks", name='…', {\"name\":\"…\"}: up to the closing
  // quote (escapes skipped) or a box border; when the row ends first — even
  // right after the opening quote — to the row's end, and the rows below
  // carry on (maskWrappedRows). An empty value ("") stays.
  {
    re: new RegExp(String.raw`(${SECRET_NAME}(\\?["']))(?!\2)(?:(?!\2)(?:\\.|[^\\\n${BOX}]))*`, 'gi'),
    keep: true,
    weakName: true,
  },
  // name: value, name=value, "name": value.
  { re: new RegExp(String.raw`(${SECRET_NAME}\\?["']?)[^\s"',;&\\}<>${BOX}]+`, 'gi'), keep: true, weakName: true },
];

/** A name that is only a word (`token: …`, `key: …`): an error's prose uses
 *  these too (`Failed to refresh token: Unauthorized`, `missing required
 *  key: model`). After such a name and a colon, an unquoted value is masked
 *  only when shaped like a credential; `token=…` and a quoted value are data. */
const WEAK_NAME_RE = /^(?:token|key|session|credentials?|o?auth2?|sig)$|tokens/i;
/** A count's name (`max_tokens`, `promptTokenCount`, `--max-tokens`): a
 *  number after it is the count. */
const COUNT_NAME_RE = /tokens|count|limit|budget|(?:^|[_-])(?:max|min)(?:[_-]|$)/i;
/** An exception's class name (`ExpiredTokenException: …`, `CredentialsProviderError: …`):
 *  what follows is its message. */
const ERROR_NAME_RE = /(?:error|exception|failure|failed)$/i;
/** A value that only names where the secret comes from (`process.env.X`,
 *  `os.environ["X"]`, `${X}`, `$X`, `getToken()`): no secret in it. A call
 *  is a whole one, its name without digits (`Xk9mP2(qL!…` is a password). */
const SECRET_REFERENCE_RE = /^["']?(?:process\.env\.[A-Za-z_]\w*|os\.environ(?:\[|\.get\()|\$\{?[A-Z_][A-Z0-9_]*\}?["']?$|[A-Za-z_$][A-Za-z_$.]{0,64}\([^()]{0,128}\)["']?$)/;
function credentialShaped(value: string): boolean {
  if (value.length < 8 || /\s/.test(value)) return false;
  return /[0-9+/=]/.test(value) || value.length >= 20;
}
/** The bare name inside a name rule's prefix (`"token": ` → `token`). */
function prefixName(prefix: string): string {
  return prefix.replace(/^[^A-Za-z0-9_\-一-鿿]*/, '').replace(/[\\"'\s:=：＝]+$/, '');
}

/** A row's indent or box border, before its text. */
const ROW_LEAD = String.raw`[\s${BOX}|]*`;
/** The row's text ends in a masked value (blanks or a border may follow):
 *  the value may go on in the row below. */
const MASKED_ROW_END_RE = new RegExp(String.raw`${HIDDEN}[\s${BOX}|]*$`);
/** …a quoted one, whose closing quote is not on its row: `"‹hidden›`. */
const OPEN_QUOTE_ROW_END_RE = new RegExp(String.raw`(\\?["'])${HIDDEN}[\s${BOX}]*$`);
/** Below that: the rest of the value up to its closing quote. The lead is
 *  taken whole (a lookahead): backtracking into it is quadratic over a long
 *  blank row. */
const CLOSING_QUOTE_ROW_RE: Readonly<Record<string, RegExp>> = Object.fromEntries(
  ['"', "'", '\\"', "\\'"].map((quote) => {
    const q = quote.replace(/\\/g, '\\\\');
    return [quote, new RegExp(String.raw`^(?=(${ROW_LEAD}))\1(?:(?!${q})(?:\\.|[^\\]))+(?=${q})`)];
  }),
);
/** Below a masked row's end: the rest of a token the terminal wrapped — a run
 *  of token characters opening the row (after its indent or border) that
 *  ends the row's text (blanks, borders, closing brackets, quotes or
 *  separators may follow) or meets a closing quote, bracket, `;` or `&`. */
const TOKEN_CHARS = '[A-Za-z0-9._~+/=-]';
/** Not the rest of a value: a new assignment (`NAME=value`, an env dump's
 *  next row, a diff's `+NAME=value`). */
const NOT_ASSIGNMENT = String.raw`(?![+-]?[A-Za-z_][A-Za-z0-9_.-]{0,64}=[^=\s])`;
/** …and shaped like a token's tail, not a word (`Unauthorized`,
 *  `Retrying...`): a digit or a token symbol inside it, a lower-case letter
 *  before an upper-case one, or long. */
const TOKEN_TAIL = String.raw`(?=${TOKEN_CHARS}{0,256}(?:[0-9+/=_~]|[.-][A-Za-z0-9])|${TOKEN_CHARS}{0,256}[a-z][A-Z]|${TOKEN_CHARS}{16})`;
const CONTINUATION_ROW_RE = new RegExp(
  String.raw`^(${ROW_LEAD})${NOT_ASSIGNMENT}${TOKEN_TAIL}${TOKEN_CHARS}{4,}(?=[\s${BOX}|)\]}"'\`,;]*$|\\?["'\`)\]};&])`,
);
/** A hard wrap's tail that more text follows on its row (`<rest> -e FOO=bar
 *  image`): a run opening the row with digits and both cases of letters, or
 *  a long run of letters and digits alone. Not a model name, a timestamp or
 *  a path (`claude-opus-4-1`, `2026-11-07T05:…`, `model_hub/es1_o50`). */
const ENTROPIC_RUN_RE = new RegExp(
  String.raw`^(${ROW_LEAD})${NOT_ASSIGNMENT}(?:(?=${TOKEN_CHARS}{0,256}[0-9])(?=${TOKEN_CHARS}{0,256}[a-z])(?=${TOKEN_CHARS}{0,256}[A-Z])${TOKEN_CHARS}{8,}`
  + String.raw`|(?=[A-Za-z0-9]{0,256}[0-9])(?=[A-Za-z0-9]{0,256}[A-Za-z])[A-Za-z0-9]{24,}(?![A-Za-z0-9]))`,
);

/** Rows below one that ended in a masked value: the rest of that value. */
function maskWrappedRows(text: string): string {
  const rows = text.split('\n');
  for (let i = 1; i < rows.length; i++) {
    const above = rows[i - 1]!;
    if (!above.includes(HIDDEN)) continue;
    const quote = OPEN_QUOTE_ROW_END_RE.exec(above)?.[1];
    const closed = quote ? rows[i]!.replace(CLOSING_QUOTE_ROW_RE[quote]!, `$1${HIDDEN}`) : rows[i]!;
    if (closed !== rows[i]) rows[i] = closed;
    else if (MASKED_ROW_END_RE.test(above)) {
      const next = rows[i]!.replace(CONTINUATION_ROW_RE, `$1${HIDDEN}`);
      rows[i] = next !== rows[i] ? next : rows[i]!.replace(ENTROPIC_RUN_RE, `$1${HIDDEN}`);
    }
  }
  return rows.join('\n');
}

const PEM_BEGIN_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** A row's text without its indent, borders and line number (`cat -n`,
 *  `rg -n`'s `path:12:`). Trimmed by hand: `/[\s│]+$/` is retried from
 *  every blank of a long blank row. */
const ROW_EDGE = new Set([' ', '\t', '│', '┃', '║', '|']);
const LINE_NUMBER_RE = /^(?:[^\s:]{0,200}:\d{1,7}:|\d{1,7}[\t:])[ \t]*/;
function rowText(row: string): string {
  let start = 0;
  let end = row.length;
  while (start < end && ROW_EDGE.has(row[start]!)) start++;
  while (end > start && ROW_EDGE.has(row[end - 1]!)) end--;
  return row.slice(start, end).replace(LINE_NUMBER_RE, '');
}
/** A row of a key's body: base64 (or nothing, between header and body), or
 *  a header (`Proc-Type: …`, PGP's `Version: …`). */
const PEM_BODY_RE = /^(?:[A-Za-z0-9+/=]*|(?:Proc-Type|DEK-Info|Version|Comment|Hash):.*)$/;
const BASE64_ROW_RE = /^[A-Za-z0-9+/=]+$/;
/** An END marker opening its row (not one quoted in code or an error). */
const PEM_END_ROW_RE = /^-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const maskRow = (row: string) => row.replace(/^([\s│┃║|]*).*$/, `$1${HIDDEN}`);
/** A PEM private key printed over rows (`cat key.pem`, a YAML block): every
 *  body row after its BEGIN marker, whole (the indent kept), up to its END
 *  marker or the first row that is no body (a marker quoted in code or an
 *  error message has none). A key whose BEGIN row is not in the text (a
 *  screen window cut through it) is found from its END row: the base64 rows
 *  right above it. Before the shape rules: a label rule would otherwise eat
 *  the BEGIN marker. */
function maskPemBlocks(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text;
  const rows = text.split('\n');
  let inside = false;
  for (let i = 0; i < rows.length; i++) {
    if (inside) {
      if (PEM_END_RE.test(rows[i]!) || !PEM_BODY_RE.test(rowText(rows[i]!))) inside = false;
      else rows[i] = maskRow(rows[i]!);
    } else if (PEM_BEGIN_RE.test(rows[i]!) && !PEM_END_RE.test(rows[i]!)) {
      inside = true;
    } else if (PEM_END_ROW_RE.test(rowText(rows[i]!))) {
      // Above it: a full row of base64 each (a key's rows are 64 wide), the
      // last one before END any length.
      for (let j = i - 1; j >= 0; j--) {
        const body = rowText(rows[j]!);
        if (!BASE64_ROW_RE.test(body) || (j < i - 1 && body.length < 16)) break;
        rows[j] = maskRow(rows[j]!);
      }
    }
  }
  return rows.join('\n');
}

/**
 * A failure's raw text (a provider's error, a worker's stderr, a terminal
 * tail) as the draft may keep and show it: escapes and control characters
 * dropped, credential shapes masked — quoted JSON keys, headers, URL query
 * values, command-line flags, a token wrapped onto the rows below (behind an
 * indent or a TUI border) — and the user name in home paths. Mask before
 * clipping: a clip never leaves half a key unmasked. Stricter than the stuck
 * card's rules on purpose (this text is shown raw); the error's own words
 * stay readable.
 */
export function maskFailureText(text: string): string {
  const plain = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  let out = maskPemBlocks(plain.replace(/(\/(?:home|Users)\/)[^/\s]+/g, '$1~'));
  for (const { re, keep, weakName, countable } of FAILURE_SECRET_SHAPES) {
    out = out.replace(re, (match: string, prefix?: unknown) => {
      if (!(keep && typeof prefix === 'string' && match.startsWith(prefix))) return HIDDEN;
      if (weakName || countable) {
        const name = prefixName(prefix);
        const value = match.slice(prefix.length);
        if (COUNT_NAME_RE.test(name) && /^\d[\d,_]*$/.test(value)) return match;
        if (weakName) {
          if (ERROR_NAME_RE.test(name) || SECRET_REFERENCE_RE.test(value)) return match;
          if (WEAK_NAME_RE.test(name) && /[:：]\s*$/.test(prefix) && !credentialShaped(value)) return match;
        }
      }
      return `${prefix}${HIDDEN}`;
    });
  }
  return maskWrappedRows(out);
}

/**
 * Error code → category. Claude files a 403 "Access denied for model" under
 * `provider_authentication_failed` (its API error code says auth) and a plain
 * 403 under `provider_permission_denied`: both are "the credential may not
 * use this model".
 */
export function classifyFailureCode(code: string | undefined): WorkflowDraftFailureCategory {
  if (!code) return 'unknown';
  const c = code.toLowerCase();
  if (/auth|permission|credential|forbidden|access_denied|unauthori[sz]ed/.test(c)) return 'permission';
  if (/rate_limit|_limited\b|limited$|usage_limit|quota|capacity|overloaded|insufficient_balance/.test(c)) return 'quota';
  if (/timeout|timed_out/.test(c)) return 'timeout';
  if (/server_error|unexpected_eof|no_model_reply|connection|upstream|unreachable|network|disconnect/.test(c)) return 'unreachable';
  if (/invalid_request|rejected|bad_request|output_limit/.test(c)) return 'rejected';
  return 'unknown';
}

/** A model failure worth remembering for the bot (a model call happened and
 *  failed for a known reason), as opposed to the bot's session not starting
 *  or an outcome nobody can attribute. */
export function failureCountsAgainstModel(category: WorkflowDraftFailureCategory): boolean {
  return category === 'permission' || category === 'quota' || category === 'unreachable' || category === 'rejected';
}
