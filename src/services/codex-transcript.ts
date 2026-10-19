/**
 * Reader for Codex's per-session rollout JSONL.
 *
 * Codex stores each session's full transcript at
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<cliSessionId>.jsonl
 * and creates the file lazily on the first user submit. The bridge fallback
 * cares about three records:
 *
 *   - native turn-start: `event_msg.payload` `task_started`, which can
 *     precede the persisted user message by a long interval.
 *   - user turn-start: `response_item.payload` message role=user
 *     (input_text content). Stable across every codex version.
 *   - turn terminal: `event_msg.payload` `task_complete`, which carries the
 *     final visible text in `last_agent_message` (may be empty) and fires
 *     exactly ONCE per turn.
 *
 * Why task_complete and NOT the assistant `response_item` message:
 *   - Codex USED to tag the final assistant message `phase:'final_answer'`,
 *     which older readers keyed on. Newer codex (observed >=0.146, and
 *     model-provider dependent) DROPPED that field: the final assistant
 *     message and every mid-turn assistant message are now byte-identically
 *     `phase:undefined`, so no assistant `response_item` is a safe boundary —
 *     keying on one would close the turn on the first mid-turn preamble and
 *     truncate (or, if a stale second final is buffered, double-emit).
 *   - `task_complete` is present in every observed schema (0.139 / 0.145 /
 *     0.146), fires once per turn, and dedups codex's THREE representations of
 *     one answer (event_msg agent_message / response_item message / event_msg
 *     task_complete) down to a single emit — no cross-source dedup needed.
 *   - A cancelled turn writes `turn_aborted` (no task_complete); we surface it
 *     as an `ambiguous` terminal so the durable delivery is released instead
 *     of wedging as "running" forever.
 *
 * This mirrors the traex reader (traex-transcript.ts), which adopted the same
 * task_complete boundary earlier for the identical no-reliable-phase reason.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { codexHistoryPath, codexSessionsRoot } from './codex-paths.js';
import { baselineJsonlCursor, beginJsonlDrain, iterateJsonlLines, scanJsonlBackward, scanJsonlBackwardFd } from './jsonl-cursor.js';
import type { CodexThreadSettings } from './codex-service-tier.js';
// cot-subject 与 process-open-files 只用语言/Node 内建，等价于内联，不违反本模块 dependency-free 口径。
import { listProcessOpenFiles } from '../utils/process-open-files.js';
import { boundSubjectForTransport, subjectFromArgsString, subjectFromInputObject } from './cot-subject.js';

const UNTRUSTED_SESSION_SCAN_MAX_DEPTH = 3;
const UNTRUSTED_SESSION_SCAN_MAX_ENTRIES = 50_000;

/** Extract the cliSessionId encoded in a rollout filename. Codex's session
 *  id is UUID-shaped (8-4-4-4-12 hex), which lets us anchor the regex on
 *  the UUID alone — the `<ts>` segment between "rollout-" and the sid
 *  contains its own dashes that would otherwise let a greedy match swallow
 *  parts of the sid. Returns undefined for paths that don't match. */
export function codexSessionIdFromRolloutPath(path: string): string | undefined {
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1] : undefined;
}

type CodexRolloutRef = { path: string; cliSessionId: string };

/** Find the rollout file an externally-running Codex process has open. A
 *  single open rollout is authoritative for that pid. Multiple open rollouts
 *  are ambiguous: current Codex versions can keep parent and sibling-agent
 *  transcripts open in the same process, so choosing the first fd can bind
 *  an adopted pane to the wrong conversation.
 *
 *  两种平台都用 `codexSessionIdFromRolloutPath` 提取 sid。 */
export function findCodexRolloutByPid(pid: number): CodexRolloutRef | undefined {
  const targets = listProcessOpenFiles(pid);
  if (!targets) return undefined;
  return findSingleCodexRollout(targets);
}

/** Enumerate ALL rollouts a Codex pid currently has open, keyed by lowercased
 *  sessionId. Unlike `findCodexRolloutByPid`, this does NOT collapse the
 *  parent+sibling multi-rollout case to `undefined` — it returns every match so
 *  a caller can test membership (`historySid ∈ set`).
 *
 *  This is the ownership gate for post-submit rollout re-attach: `history.jsonl`
 *  is a single global file shared by every Codex pane under one CODEX_HOME, so a
 *  concurrent sibling pane submitting identical text can make writeInput return
 *  the WRONG session id. Only a sid this exact pid actually holds open is safe to
 *  re-attach to; a foreign sid (another pane's) is rejected, leaving the current
 *  binding untouched. Returns an empty Set when the pid holds no rollout, and
 *  undefined only when the fd enumeration itself is unavailable — callers must
 *  treat undefined as "cannot prove ownership" (fail closed: do not re-attach). */
export function findCodexRolloutSetByPid(pid: number): Set<string> | undefined {
  const targets = listProcessOpenFiles(pid);
  if (!targets) return undefined;
  const set = new Set<string>();
  for (const target of targets) {
    const hit = matchCodexRolloutPath(target);
    if (hit) set.add(hit.cliSessionId.toLowerCase());
  }
  return set;
}

/** Pure ownership decision: is `cliSessionId` one of the rollouts the observed
 *  pid holds open? `ownedRollouts` is the lowercased sid set from
 *  findCodexRolloutSetByPid (undefined when fd enumeration was unavailable).
 *  FAIL CLOSED — a missing set or a non-member id returns false so the caller
 *  never binds the bridge to a session it can't prove the pid owns. Extracted so
 *  the exact predicate the worker's attach entry points use is unit-testable
 *  without a live pid. TRAE's rollouts share this predicate verbatim
 *  (`traexHistorySidIsOwned` is the same function). */
export function codexHistorySidIsOwned(
  cliSessionId: string,
  ownedRollouts: Set<string> | undefined,
): boolean {
  if (!ownedRollouts) return false;
  return ownedRollouts.has(cliSessionId.toLowerCase());
}

function findSingleCodexRollout(targets: Iterable<string>): CodexRolloutRef | undefined {
  let found: CodexRolloutRef | undefined;
  for (const target of targets) {
    const hit = matchCodexRolloutPath(target);
    if (!hit) continue;
    if (found && found.path !== hit.path) return undefined;
    found = hit;
  }
  return found;
}

function matchCodexRolloutPath(target: string): CodexRolloutRef | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  // The rollout lives under `<CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/`. CODEX_HOME
  // defaults to ~/.codex but can be a custom / per-bot-isolated root, and an
  // ADOPTED external Codex may have started under a CODEX_HOME the worker never
  // inherited — so anchoring on the literal `/.codex/sessions/` (or on the
  // worker's own codexSessionsRoot()) would make that rollout invisible. Once fd
  // ownership is a hard gate for bridge attach, an invisible rollout means the
  // legitimate session can never pass the gate. The path already came from the
  // target PID's open fds (that IS the ownership proof), so anchor only on the
  // env-independent structural shape: a `sessions/` path segment plus the
  // distinctive `rollout-<ts>-<uuid>.jsonl` filename (validated below).
  if (!/(^|\/)sessions\//.test(target)) return undefined;
  const sid = codexSessionIdFromRolloutPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

export interface CodexBridgeEvent {
  /** Synthetic uuid for dedup: `<absPath>:<byteOffset>` of the line start.
   *  Stable across re-drains because rollout files are append-only. */
  uuid: string;
  /** Wall-clock ms parsed from the event's `timestamp` field. Falls back
   *  to Date.now() if missing/unparseable so the gate's window math still
   *  has something to compare against. */
  timestampMs: number;
  /** Discriminator for the queue layer:
   *   - 'user' starts a pending Lark turn (fingerprint-matched)
   *   - 'turn_started' is Codex's authoritative task_started edge; it starts
   *     the pending head before the delayed response_item/user is persisted
   *   - 'assistant_final' closes the currently-collecting turn with output
   *   - 'turn_aborted' closes it without producing fallback output
   *   - 'turn_bind' adds a provider turn id to an already-started turn
   *     without starting, closing, or otherwise advancing the queue
   *   - 'cot' is a cosmetic mid-turn record (reasoning / tool call / tool
   *     output) attributed to the collecting turn for the CoT message; it
   *     never starts or closes a turn */
  kind: 'user' | 'turn_started' | 'assistant_final' | 'turn_aborted' | 'turn_bind' | 'cot';
  /** Concatenated text from the message's content blocks (input_text for
   *  user, output_text for assistant). Empty for 'cot' events. */
  text: string;
  /** For kind 'cot': the thinking / tool-call entries parsed from this line. */
  cotEntries?: CodexCotEntry[];
  /** Optional durable-delivery terminal outcome carried by bridges with an
   *  explicit completion record (for example Grok `turn_completed`). Codex
   *  final-answer records omit it and retain the historical completed
   *  default. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  terminalErrorCode?: string;
  /** Safe, bounded user-facing detail extracted from a structured failure.
   *  Raw provider payloads stay in the rollout/Web terminal. */
  terminalErrorSummary?: string;
  /** Codex `codex_rate_limited` terminals only: whether the provider reported
   *  account quota exhaustion (`usage`) or a transient rate limit (`rate`).
   *  Taken from the raw structured error before summary redaction, so an
   *  empty or redacted summary cannot flip a quota failure back to `rate`. */
  terminalLimitKind?: 'usage' | 'rate';
  sourceSessionId?: string;
  /** Native provider turn id when the transcript format exposes one. Bridges
   *  can use it to bind cosmetic/terminal events to the exact started turn
   *  instead of relying solely on whichever turn is currently collecting. */
  sourceTurnId?: string;
  /** The transcript parser has positive evidence that this user record starts
   * a distinct native turn while an older id-less turn remains open. */
  preserveCollecting?: boolean;
  /** Keep the pending turn's original markTimeMs instead of moving it to the
   *  transcript user timestamp. Used by bridges whose committed user
   *  timestamp can lag behind in-turn delivery markers. */
  preserveMarkTimeMs?: boolean;
}

/** One node of the native CoT message. Mirrors `CotEntry` in types.ts /
 *  `TranscriptCotEntry` in claude-transcript.ts — redeclared structurally to
 *  keep this module dependency-free. */
export type CodexCotEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | {
    kind: 'tool_call'; id: string; name: string; args: string;
    /** 截断前从原始 arguments / input / action 提取的单行主题（≤1000）；
     *  无可用字段时不带此键。 */
    subject?: string;
  }
  | { kind: 'tool_result'; id: string; result: string };

/** Per-entry truncation caps for the CoT tool timeline (same rationale and
 *  values as claude-transcript's): args/outputs can be hundreds of KB, the
 *  bubble only needs a recognisable preview. */
const COT_TOOL_ARGS_MAX_CHARS = 600;
const COT_TOOL_RESULT_MAX_CHARS = 800;

function truncateForCot(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 组装 tool_call 节点：args 截断、subject 传输层截断，主题为空时不带键。 */
function toolCallEntry(
  id: string,
  name: string,
  args: string,
  rawSubject: string,
): Extract<CodexCotEntry, { kind: 'tool_call' }> {
  const subject = boundSubjectForTransport(rawSubject);
  return {
    kind: 'tool_call', id, name,
    args: truncateForCot(args, COT_TOOL_ARGS_MAX_CHARS),
    ...(subject ? { subject } : {}),
  };
}

/** Codex shell outputs are usually a JSON string `{"output":"…","metadata":…}`;
 *  unwrap to the inner output when that shape parses, otherwise show the raw
 *  string (custom tools / newer formats). */
function stringifyCodexToolOutput(output: unknown): string {
  if (typeof output !== 'string') {
    try { return output === undefined ? '' : JSON.stringify(output); } catch { return ''; }
  }
  if (output.startsWith('{')) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') return parsed.output;
    } catch { /* not the wrapped shape — fall through to raw */ }
  }
  return output;
}

/**
 * Extract CoT (thinking process) entries from one Codex rollout
 * `response_item` payload. Returns [] for payload types that don't belong in
 * the thinking timeline (user/assistant messages, ghost snapshots, …).
 *
 *   - `reasoning` → thinking text. Codex records the display summary in
 *     `summary[]` (`summary_text` blocks — what the TUI shows) and, for some
 *     providers, raw CoT in `content[]` (`reasoning_text`); prefer the
 *     summary, fall back to raw.
 *   - `function_call` / `custom_tool_call` / `local_shell_call` /
 *     `web_search_call` → tool_call (name + truncated args).
 *   - `function_call_output` / `custom_tool_call_output` → tool_result
 *     (unwrapped + truncated output).
 */
export function codexCotEntriesFromResponseItem(p: any): CodexCotEntry[] {
  if (!p || typeof p !== 'object') return [];
  if (p.type === 'reasoning') {
    const texts: string[] = [];
    for (const b of Array.isArray(p.summary) ? p.summary : []) {
      if (b?.type === 'summary_text' && typeof b.text === 'string' && b.text.length > 0) texts.push(b.text);
    }
    if (texts.length === 0) {
      for (const b of Array.isArray(p.content) ? p.content : []) {
        if ((b?.type === 'reasoning_text' || b?.type === 'text') && typeof b.text === 'string' && b.text.length > 0) texts.push(b.text);
      }
    }
    return texts.length > 0 ? [{ kind: 'thinking', text: texts.join('\n\n') }] : [];
  }
  // 四种 tool_call 形态的主题都在截断**之前**从原始字符串 / 对象上取：
  // function_call 的 arguments 是 JSON 字符串，custom_tool_call 的 input 是裸
  // 字符串（apply_patch / 脚本），local_shell_call / web_search_call 的 action
  // 是对象——截断后的 JSON 解析不出主题。
  if (p.type === 'function_call' && typeof p.name === 'string') {
    const id = typeof p.call_id === 'string' && p.call_id ? p.call_id : (typeof p.id === 'string' ? p.id : '');
    if (!id) return [];
    const args = typeof p.arguments === 'string' ? p.arguments : '';
    return [toolCallEntry(id, p.name, args, subjectFromArgsString(args))];
  }
  if (p.type === 'custom_tool_call' && typeof p.name === 'string' && typeof p.call_id === 'string' && p.call_id) {
    const args = typeof p.input === 'string' ? p.input : '';
    return [toolCallEntry(p.call_id, p.name, args, subjectFromArgsString(args))];
  }
  if (p.type === 'local_shell_call') {
    const id = typeof p.call_id === 'string' && p.call_id ? p.call_id : (typeof p.id === 'string' ? p.id : '');
    if (!id) return [];
    let args = '';
    try { args = p.action === undefined ? '' : JSON.stringify(p.action); } catch { /* unserialisable — show none */ }
    return [toolCallEntry(id, 'shell', args, subjectFromInputObject(p.action))];
  }
  if (p.type === 'web_search_call') {
    const id = typeof p.call_id === 'string' && p.call_id ? p.call_id : (typeof p.id === 'string' ? p.id : '');
    if (!id) return [];
    let args = '';
    try { args = p.action === undefined ? '' : JSON.stringify(p.action); } catch { /* unserialisable — show none */ }
    return [toolCallEntry(id, 'web_search', args, subjectFromInputObject(p.action))];
  }
  if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && typeof p.call_id === 'string' && p.call_id) {
    const result = stringifyCodexToolOutput(p.output);
    return result.length > 0 ? [{ kind: 'tool_result', id: p.call_id, result: truncateForCot(result, COT_TOOL_RESULT_MAX_CHARS) }] : [];
  }
  return [];
}

export const CODEX_RATE_LIMIT_ERROR_CODE = 'codex_rate_limited';
export const CODEX_AUTH_ERROR_CODE = 'codex_auth_failed';
export const CODEX_INVALID_REQUEST_ERROR_CODE = 'codex_invalid_request';
export const CODEX_CONNECTION_ERROR_CODE = 'codex_connection_failed';
/** Model gateway / upstream service failure (5xx, gRPC stream cancel, …):
 *  the request reached the model service but the SERVER side failed. Distinct
 *  from `codex_connection_failed` (client could not reach the service at all)
 *  so the user-facing card can say "server-side transient, just retry later"
 *  instead of pointing at the local network. */
export const CODEX_UPSTREAM_ERROR_CODE = 'codex_upstream_error';
/** Explicit model capacity refusal; generic 5xx/stream errors stay upstream. */
export const CODEX_CAPACITY_ERROR_CODE = 'codex_capacity_exceeded';
export const CODEX_OUTPUT_LIMIT_ERROR_CODE = 'codex_output_limit_exceeded';
export const CODEX_TASK_FAILED_ERROR_CODE = 'codex_task_failed';
export const CODEX_OUTPUT_LIMIT_ERROR_MESSAGE = 'model output limit exceeded: max_output_tokens';

const CODEX_FAILURE_SUMMARY_MAX_CHARS = 320;
/** Pre-scan bound applied BEFORE the redaction regexes run. Well above the
 *  displayed max so it never truncates a shown reason, but small enough to keep
 *  the (super-linear-on-adversarial-input) patterns cheap. */
const CODEX_FAILURE_SUMMARY_PRESCAN_MAX_CHARS = 2_000;

/** Credential key names redacted from user-facing failure summaries. */
const CODEX_SECRET_KEY_ALTERNATION =
  'api[_-]?key|access[_-]?token|token|auth(?:orization)?|secret|password|signature|credential|cookie';
// Escape-safe quoted-value bodies. The two branches are mutually exclusive —
// `\\.` consumes an escaped pair, `[^\\<q>]` consumes any other non-quote char —
// so they never overlap and a missing close quote can NOT trigger exponential
// backtracking. Spanning `\\.` also means an embedded `\"` (or `\'`) does not
// prematurely end the value, so the WHOLE secret is covered, not just its head.
const CODEX_DQ_VALUE_BODY = '"(?:\\\\.|[^\\\\"])*"';
const CODEX_SQ_VALUE_BODY = "'(?:\\\\.|[^\\\\'])*'";
/** Quoted-JSON credential, double-quoted value: `"api_key":"..."`. */
const CODEX_QUOTED_SECRET_DQ = new RegExp(
  `(("(?:${CODEX_SECRET_KEY_ALTERNATION})")\\s*:\\s*)${CODEX_DQ_VALUE_BODY}`, 'gi');
/** Same, single-quoted value: `'secret':'...'`. */
const CODEX_QUOTED_SECRET_SQ = new RegExp(
  `(('(?:${CODEX_SECRET_KEY_ALTERNATION})')\\s*:\\s*)${CODEX_SQ_VALUE_BODY}`, 'gi');
/** Bare `key = value` — value is a quoted string (escape-safe, same as above so
 *  an embedded `\"` does not leak the tail) or a bare word. `\b` keeps
 *  `notpassword=` from matching `password`. */
const CODEX_BARE_SECRET = new RegExp(
  `(\\b(?:${CODEX_SECRET_KEY_ALTERNATION})\\s*[:=]\\s*)(?:${CODEX_DQ_VALUE_BODY}|${CODEX_SQ_VALUE_BODY}|[^\\s,;}]+)`, 'gi');
/** An UNCLOSED quoted credential value running to end-of-input — created when a
 *  real secret is cut mid-value by the pre-scan bound (or arrives truncated).
 *  Its prefix would otherwise slip past the closed-value redactors into the
 *  shown summary, so we fail closed instead. The trailing `\\?` absorbs a lone
 *  dangling backslash left when the pre-scan cut lands mid-escape — without it
 *  the exclusive value body rejects that final char and the whole probe misses,
 *  re-opening the leak. Same exclusive branches, so the probes stay linear. */
const CODEX_UNCLOSED_SECRET_DQ = new RegExp(
  `"(?:${CODEX_SECRET_KEY_ALTERNATION})"\\s*:\\s*"(?:\\\\.|[^\\\\"])*\\\\?$`, 'i');
const CODEX_UNCLOSED_SECRET_SQ = new RegExp(
  `'(?:${CODEX_SECRET_KEY_ALTERNATION})'\\s*:\\s*'(?:\\\\.|[^\\\\'])*\\\\?$`, 'i');
const CODEX_UNCLOSED_SECRET_BARE = new RegExp(
  `\\b(?:${CODEX_SECRET_KEY_ALTERNATION})\\s*[:=]\\s*(?:"(?:\\\\.|[^\\\\"])*|'(?:\\\\.|[^\\\\'])*)\\\\?$`, 'i');

function parseEmbeddedJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 20_000) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}

/** Peel provider wrappers such as `{ message: "{\"error\":{...}}" }`. */
function codexFailureLeaf(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 6; depth++) {
    const parsed = parseEmbeddedJson(current);
    if (parsed !== undefined) {
      current = parsed;
      continue;
    }
    if (!current || typeof current !== 'object') break;
    const value = current as Record<string, unknown>;
    if (value.error !== undefined) {
      current = value.error;
      continue;
    }
    const parsedMessage = parseEmbeddedJson(value.message);
    if (parsedMessage !== undefined) {
      current = parsedMessage;
      continue;
    }
    break;
  }
  return current;
}

/** Opt-in capacity discriminator for Codex recovery, separate from the shared
 * Codex-family taxonomy so TraeX and other readers retain their policy. */
export function isCodexCapacityError(error: unknown): boolean {
  if ([CODEX_RATE_LIMIT_ERROR_CODE, CODEX_AUTH_ERROR_CODE, CODEX_INVALID_REQUEST_ERROR_CODE]
    .includes(codexTaskFailureCode(error))) return false;
  const leaf = codexFailureLeaf(error);
  if (leaf && typeof leaf === 'object') {
    const record = leaf as Record<string, unknown>;
    const code = record.codex_error_info ?? record.codexErrorInfo ?? record.code;
    if (typeof code === 'string' && /^server_?overloaded$/i.test(code)) return true;
    return record.message === 'Selected model is at capacity. Please try a different model.';
  }
  return leaf === 'Selected model is at capacity. Please try a different model.';
}

/** Bounded, redacted user-facing summary of a structured task_complete error.
 *  Exported for the TRAE drainer, which mirrors the Codex error→failed
 *  terminal mapping on the same payload shape. */
export function safeFailureSummary(error: unknown): string | undefined {
  const leaf = codexFailureLeaf(error);
  let message = '';
  let code = '';
  let type = '';
  if (typeof leaf === 'string') {
    message = leaf;
  } else if (leaf && typeof leaf === 'object') {
    const value = leaf as Record<string, unknown>;
    message = typeof value.message === 'string' ? value.message : '';
    code = typeof value.code === 'string' || typeof value.code === 'number'
      ? String(value.code)
      : '';
    type = typeof value.type === 'string' ? value.type : '';
  }
  let summary = [code, type].filter(Boolean).join(' ');
  if (message) summary = summary ? `${summary}: ${message}` : message;
  if (!summary) return undefined;

  // Fail closed on unpeeled deep nesting. codexFailureLeaf bounds unwrapping to
  // 6 levels; a provider that wraps `message: JSON.stringify(...)` more deeply
  // leaves `message` as a still-nested JSON literal. Its escaped quotes (`\"`)
  // defeat the quote-paired redaction below and would leak the embedded secret
  // verbatim. When the reason we are about to show is itself a bare JSON
  // object/array literal, treat it as unsafe and surface no summary — the raw
  // error still lives in the rollout / web terminal / daemon logs.
  const messageTrimmed = message.trim();
  if (messageTrimmed.length >= 2
    && (messageTrimmed.startsWith('{') || messageTrimmed.startsWith('['))) {
    return undefined;
  }

  // Bound the input before running the redaction regexes. Only the first
  // CODEX_FAILURE_SUMMARY_MAX_CHARS survive to the user anyway, so trimming a
  // long tail loses no displayed content — but it caps the worst-case work of
  // the patterns below. The JWT-shaped pattern in particular backtracks
  // super-linearly on long `-`-rich runs (its char class includes `-` and `\b`
  // restarts after each one); an unbounded provider blob could otherwise spend
  // seconds in a single replace. Cutting to a few KB keeps that flat.
  if (summary.length > CODEX_FAILURE_SUMMARY_PRESCAN_MAX_CHARS) {
    summary = summary.slice(0, CODEX_FAILURE_SUMMARY_PRESCAN_MAX_CHARS);
  }

  // Fail closed on an UNCLOSED quoted/bare credential value. The pre-scan cut
  // above can slice a long real secret mid-value, leaving `password":"SEKR…`
  // with no closing quote — which the closed-value redactors below would NOT
  // match, leaking the prefix into the shown summary. Run this AFTER the cut so
  // it sees the same string the redactors will. (A genuinely truncated provider
  // error hits the same guard, which is the safe outcome.)
  if (CODEX_UNCLOSED_SECRET_DQ.test(summary)
    || CODEX_UNCLOSED_SECRET_SQ.test(summary)
    || CODEX_UNCLOSED_SECRET_BARE.test(summary)) {
    return undefined;
  }

  // Provider errors are untrusted. Keep the useful reason while removing
  // common credentials, signed URLs, mention/HTML syntax and control chars.
  summary = summary
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    // Quoted-JSON credential (`"api_key":"..."` / `'secret':'...'`). Both key
    // and value are quoted here — a quoted key with a bare-word value does NOT
    // match, so no trailing word is swallowed — and the value branches are
    // mutually exclusive so a pathological value cannot backtrack. See the
    // CODEX_QUOTED_SECRET_* definitions.
    .replace(CODEX_QUOTED_SECRET_DQ, '$1[REDACTED]')
    .replace(CODEX_QUOTED_SECRET_SQ, '$1[REDACTED]')
    // Bare `key = value`.
    .replace(CODEX_BARE_SECRET, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/`/g, "'")
    .replace(/@/g, '＠');
  if (!summary) return undefined;
  return summary.length > CODEX_FAILURE_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, CODEX_FAILURE_SUMMARY_MAX_CHARS - 1)}…`
    : summary;
}

/** Classify a structured task_complete error into a stable failure code.
 *  Shared with the TRAE drainer (traex-transcript.ts), whose task_complete
 *  error payloads use the same Codex-family shape — keep one classifier so
 *  both bridges map e.g. connection failures to the same code. */
export function codexTaskFailureCode(error: unknown): string {
  let serialized = '';
  try { serialized = JSON.stringify(error); } catch { serialized = String(error ?? ''); }
  const normalized = serialized.toLowerCase();
  if (/\b429\b|too many requests|rate[_ -]?limit/.test(normalized)) return CODEX_RATE_LIMIT_ERROR_CODE;
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication|invalid[_ -]?(?:api[_ -]?)?key/.test(normalized)) {
    return CODEX_AUTH_ERROR_CODE;
  }
  if (/invalid_request|invalid request|validation|empty_string|\b400\b|\b-4003\b/.test(normalized)) {
    return CODEX_INVALID_REQUEST_ERROR_CODE;
  }
  // Model gateway / upstream failures: the service answered but failed
  // server-side (proxy 5xx, gRPC stream cancel, overloaded backend). Checked
  // BEFORE the connection branch so e.g. "gateway timeout" classifies as
  // upstream rather than a local connectivity problem. Observed live:
  // "upstream stream error: rpc error: code = 1 desc = Cancelled by backend
  // [biz error]" (model gateway cancelling the stream mid-turn).
  if (/upstream|rpc error|cancell?ed by backend|gateway|\b50[0234]\b|service unavailable|internal server error|overloaded/.test(normalized)) {
    return CODEX_UPSTREAM_ERROR_CODE;
  }
  if (/econn|connection|network|socket|timed?\s*out|timeout|dns|enotfound/.test(normalized)) {
    return CODEX_CONNECTION_ERROR_CODE;
  }
  return CODEX_TASK_FAILED_ERROR_CODE;
}

/** Codex rollout terminals only. Account quota exhaustion is written as
 *  `{"message":"You’ve hit your usage limit. … try again at 9:00 AM.",
 *    "codex_error_info":"usage_limit_exceeded"}` — no 429 / "rate limit" token,
 *  so the shared classifier files it under `codex_task_failed`: the turn posts
 *  a generic failure card and never reaches Codex's dedicated limited chain
 *  (owner notice + quotaFallbackBot handoff). Kept out of codexTaskFailureCode
 *  so TRAE / pi keep their taxonomy (TraeX continuation would otherwise start
 *  retrying an exhausted quota as a transient rate limit). */
export function codexRolloutFailureCode(error: unknown): string {
  if (isCodexUsageLimitError(error)) return CODEX_RATE_LIMIT_ERROR_CODE;
  if (isCodexCapacityError(error)) return CODEX_CAPACITY_ERROR_CODE;
  return codexTaskFailureCode(error);
}

function isCodexUsageLimitError(error: unknown): boolean {
  let serialized = '';
  try { serialized = JSON.stringify(error); } catch { serialized = String(error ?? ''); }
  return /usage[_ -]?limit/i.test(serialized ?? '');
}

/** Structured limit kind of a Codex rollout failure, or undefined when the
 *  failure is not a limit at all. Decided on the raw error (including
 *  `codex_error_info`), never on the redacted display summary. */
export function codexRolloutLimitKind(error: unknown): 'usage' | 'rate' | undefined {
  if (isCodexUsageLimitError(error)) return 'usage';
  return codexTaskFailureCode(error) === CODEX_RATE_LIMIT_ERROR_CODE ? 'rate' : undefined;
}

/** Exact opt-in classifier used only by the TraeX task-continuation
 * path. Keeping it out of codexTaskFailureCode preserves every other CLI's
 * existing public error taxonomy. */
export function isExactCodexOutputLimitError(error: unknown): boolean {
  const leaf = codexFailureLeaf(error);
  const leafMessage = typeof leaf === 'string'
    ? leaf
    : leaf && typeof leaf === 'object' && typeof (leaf as Record<string, unknown>).message === 'string'
      ? String((leaf as Record<string, unknown>).message)
      : '';
  return leafMessage.trim().toLowerCase() === CODEX_OUTPUT_LIMIT_ERROR_MESSAGE;
}

export function isCodexRateLimitEvent(event: CodexBridgeEvent): boolean {
  return event.kind === 'assistant_final'
    && event.terminalStatus === 'failed'
    && event.terminalErrorCode === CODEX_RATE_LIMIT_ERROR_CODE;
}

/** Codex thread ids are UUID-shaped; anything else must never reach a
 *  filesystem lookup built from it. */
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A collaboration sub-agent whose `SubAgentActivity` `started` record was
 *  read from the parent rollout. `startedAtMs` is the record timestamp, so a
 *  split-live attach can apply the same history/live cutoff as parent events. */
export interface CodexSpawnedSubagent {
  threadId: string;
  startedAtMs: number;
}

/** `event_msg/item_completed` → `SubAgentActivity` `started` carries the
 *  spawned collaboration sub-agent's own thread id. */
function spawnedSubagentThreadId(obj: any): string | undefined {
  if (obj?.type !== 'event_msg') return undefined;
  const p = obj.payload;
  if (p?.type !== 'item_completed') return undefined;
  const item = p.item;
  if (item?.type !== 'SubAgentActivity' || item.kind !== 'started') return undefined;
  const id = item.agent_thread_id;
  return typeof id === 'string' && CODEX_THREAD_ID_RE.test(id) ? id : undefined;
}

function localDateDir(sessionsRoot: string, ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return join(sessionsRoot, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
}

/** `<sessions>/YYYY/MM/DD/rollout-*.jsonl` → `<sessions>`, so a sub-agent is
 *  looked up under the same CODEX_HOME as its parent rollout. */
export function codexSessionsRootFromRolloutPath(rolloutPath: string): string {
  return dirname(dirname(dirname(dirname(rolloutPath))));
}

/** Locate a collaboration sub-agent's rollout. Codex files a rollout under
 *  the local-date directory of its creation, so only the dates around the
 *  `started` record are listed — never a recursive scan of the whole
 *  sessions tree, which this runs against on every ingest tick until found. */
export function findCodexSubagentRollout(
  threadId: string,
  startedAtMs: number,
  opts?: { sessionsRoot?: string },
): string | undefined {
  if (!CODEX_THREAD_ID_RE.test(threadId)) return undefined;
  const sessionsRoot = opts?.sessionsRoot ?? codexSessionsRoot();
  const suffix = `-${threadId}.jsonl`;
  const day = 24 * 60 * 60 * 1000;
  const dirs = new Set([startedAtMs, startedAtMs - day, startedAtMs + day].map(ms => localDateDir(sessionsRoot, ms)));
  for (const dir of dirs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    const name = names.find(n => n.startsWith('rollout-') && n.endsWith(suffix));
    if (!name) continue;
    const full = join(dir, name);
    try {
      if (lstatSync(full).isFile()) return full;
    } catch { /* raced with removal */ }
  }
  return undefined;
}

/** Incremental read position in a sub-agent rollout. `ordinal` counts the
 *  complete records already consumed; `ownFromOrdinal` is where the
 *  sub-agent's own records start (learned from its first `session_meta`). */
export interface CodexSubagentCursor {
  offset: number;
  ordinal: number;
  ownFromOrdinal?: number;
}

export const INITIAL_CODEX_SUBAGENT_CURSOR: CodexSubagentCursor = Object.freeze({ offset: 0, ordinal: 0 });

export interface CodexSubagentLimitDrain {
  /** Rate/usage-limit terminals (`isCodexRateLimitEvent` shape) found in the
   *  sub-agent's OWN newly appended complete lines. Every other record —
   *  including history inherited from the parent on fork — is ignored. */
  events: CodexBridgeEvent[];
  cursor: CodexSubagentCursor;
}

/** First record of a sub-agent rollout → ordinal of its first own record.
 *  A fork copies parent history (task_complete failures included, restamped
 *  with the fork time) in front of the sub-agent's own records, and Codex
 *  records the boundary as `subagent_history_start_ordinal`. A fork without
 *  that boundary cannot be split safely, so none of it is trusted. */
function codexSubagentOwnFromOrdinal(obj: any): number {
  if (obj?.type !== 'session_meta') return 0;
  const meta = obj.payload ?? {};
  const boundary = meta.subagent_history_start_ordinal;
  if (Number.isInteger(boundary) && boundary >= 0) return boundary;
  const forked = typeof meta.forked_from_id === 'string' && meta.forked_from_id !== '';
  return forked ? Number.POSITIVE_INFINITY : 0;
}

/** Incrementally read a sub-agent rollout for limit terminals only. A
 *  sub-agent's `task_complete` error is returned to the parent as an ordinary
 *  tool result, so the parent turn keeps `working` and neither the structured
 *  parent drain nor the (active-work suppressed) screen scan sees the limit.
 *  Codex quota is per account, so a sub-agent's usage limit means the parent
 *  is out too. */
export function drainCodexSubagentLimits(
  path: string,
  from: CodexSubagentCursor = INITIAL_CODEX_SUBAGENT_CURSOR,
): CodexSubagentLimitDrain {
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], cursor: from }; }
  // Truncation/rotation: the ordinal is only meaningful from the file start.
  const base: CodexSubagentCursor = size < from.offset ? INITIAL_CODEX_SUBAGENT_CURSOR : from;
  const start = base.offset;
  if (size === start) return { events: [], cursor: base };
  const len = size - start;
  const buf = Buffer.alloc(len);
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return { events: [], cursor: from }; }
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { events: [], cursor: base };
  const complete = text.slice(0, lastNl + 1);
  const events: CodexBridgeEvent[] = [];
  let ordinal = base.ordinal;
  let ownFromOrdinal = base.ownFromOrdinal;
  let cursor = start;
  for (const line of complete.split('\n')) {
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;
    if (line === '') continue;
    const recordOrdinal = ordinal++;
    if (recordOrdinal === 0) {
      let meta: any;
      try { meta = JSON.parse(line); } catch { /* not a session_meta */ }
      ownFromOrdinal = codexSubagentOwnFromOrdinal(meta);
    }
    if (recordOrdinal < (ownFromOrdinal ?? 0)) continue;
    // Cheap prefilter: only failed task_complete records matter here.
    if (!line.includes('"task_complete"') || !line.includes('"error"')) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const p = obj?.payload;
    if (obj?.type !== 'event_msg' || p?.type !== 'task_complete') continue;
    if (p.error === null || p.error === undefined) continue;
    const limitKind = codexRolloutLimitKind(p.error);
    if (!limitKind) continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    events.push({
      uuid: `${path}:${lineStart}`,
      timestampMs: Number.isFinite(ts) ? ts : Date.now(),
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_RATE_LIMIT_ERROR_CODE,
      terminalErrorSummary: safeFailureSummary(p.error),
      terminalLimitKind: limitKind,
      ...(typeof p.turn_id === 'string' ? { sourceTurnId: p.turn_id } : {}),
    });
  }
  return {
    events,
    cursor: {
      offset: start + Buffer.byteLength(complete, 'utf8'),
      ordinal,
      ...(ownFromOrdinal !== undefined ? { ownFromOrdinal } : {}),
    },
  };
}

/** Extract the last completed user/assistant turn from a Codex / CoCo bridge
 *  event sequence. Used by /adopt to surface the previous turn as a
 *  preamble card in the Lark thread — gives the user context to continue
 *  from. CoCo events share the same shape (uuid/timestampMs/kind/text),
 *  so this works for both bridges.
 *
 *  Algorithm: scan tail-first for the most recent `assistant_final`, then
 *  pair it with the most recent `user` event that precedes it. Returns
 *  undefined when either side is missing — typically a fresh session whose
 *  user typed something but the model hasn't replied yet. */
export function extractLastCodexTurn(
  events: readonly Pick<CodexBridgeEvent, 'kind' | 'text'>[],
): { userText: string; assistantText: string } | undefined {
  let assistantIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'assistant_final') { assistantIdx = i; break; }
  }
  if (assistantIdx < 0) return undefined;
  let userIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (events[i].kind === 'user') { userIdx = i; break; }
  }
  if (userIdx < 0) return undefined;
  return {
    userText: events[userIdx].text,
    assistantText: events[assistantIdx].text,
  };
}

/** Split a drained event list into "history" (older than the live cutoff)
 *  and "live" (cutoff or newer). The Codex adopt bridge uses this when
 *  it discovers the rollout file LATE (after the user already typed in
 *  iTerm or sent a Lark message): drain-from-0 produces a mix of pre-
 *  adopt history and post-adopt live events. The worker then `absorb()`s
 *  the history (so it isn't replayed) and `ingest()`s the live partition
 *  (so the local-turn synthesis / fingerprint match still works). Pure
 *  function — no I/O, easy to test against fixed timestamps. */
export function splitCodexEventsByCutoff(
  events: readonly CodexBridgeEvent[],
  liveSinceMs: number,
): { history: CodexBridgeEvent[]; live: CodexBridgeEvent[] } {
  const history: CodexBridgeEvent[] = [];
  const live: CodexBridgeEvent[] = [];
  for (const ev of events) {
    if (ev.timestampMs < liveSinceMs) history.push(ev);
    else live.push(ev);
  }
  return { history, live };
}

export interface CodexDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line that was written without its terminating \n yet. Currently
   *  informational — only complete lines produce events. */
  pendingTail: string;
  /** Latest complete settings record in this byte range, if any. */
  latestThreadSettings?: CodexThreadSettings;
  /** Newest executor model observed in this byte range (from `turn_context`),
   *  latest-wins. Undefined when no `turn_context` appeared in the range. */
  latestModel?: string;
  /** Newest executor reasoning effort observed in this byte range (from
   *  `turn_context`), latest-wins. Undefined when none appeared. */
  latestReasoningEffort?: string;
  /** Native collaboration sub-agents whose `SubAgentActivity` `started`
   *  record appeared in this byte range. Sub-agents write their own rollout
   *  (`rollout-<ts>-<thread id>.jsonl`), so their terminal failures never
   *  reach this drain; the worker tails those files separately. */
  spawnedSubagents?: CodexSpawnedSubagent[];
  /** Stateless-reader continuation carried by the worker between live ticks.
   *  `nextOffset` binds the turn lower bound to the exact cursor it follows,
   *  so truncation or an unrelated seek cannot reuse stale state. */
  state?: CodexDrainState;
}

export interface CodexDrainState {
  nextOffset: number;
  turnStartOffset: number;
}

/** Model / reasoning-effort pair read from a rollout's `turn_context` record. */
export interface RolloutRuntimeSnapshot {
  model?: string;
  reasoningEffort?: string;
}

/** Bounded backward-scan cap for the one-shot runtime bootstrap — runtime
 *  identity is advisory and must never synchronously parse a multi-GB rollout
 *  on attach (same guard rationale as usage-side MAX_USAGE_TRANSCRIPT_BYTES). */
const CODEX_RUNTIME_SCAN_MAX_BYTES = 4 * 1024 * 1024;

/** Executor-confirmed model / reasoning-effort as recorded in a
 *  `turn_context` event. Codex writes this on every turn (top-level `model`
 *  and `effort`, with a `collaboration_mode.settings` mirror), so it — not the
 *  optional `thread_settings_applied` record — is the reliable in-session
 *  model/effort source. TRAE's rollout shares the record shape, so the TRAE
 *  reader uses this too. */
export function runtimeFromTurnContext(obj: any): RolloutRuntimeSnapshot | undefined {
  if (obj?.type !== 'turn_context') return undefined;
  const payload = obj.payload;
  if (!payload || typeof payload !== 'object') return undefined;
  const settings = payload.collaboration_mode?.settings;
  const model = payload.model ?? settings?.model;
  const reasoningEffort = payload.reasoning_effort
    ?? payload.effort
    ?? settings?.reasoning_effort;
  const normalizedModel = typeof model === 'string' && model.trim()
    ? model.trim()
    : undefined;
  const normalizedReasoningEffort = typeof reasoningEffort === 'string' && reasoningEffort.trim()
    ? reasoningEffort.trim()
    : undefined;
  if (!normalizedModel && !normalizedReasoningEffort) return undefined;
  return {
    ...(normalizedModel ? { model: normalizedModel } : {}),
    ...(normalizedReasoningEffort ? { reasoningEffort: normalizedReasoningEffort } : {}),
  };
}

/** Locate the rollout file for a given Codex sessionId. Codex names files
 *  `rollout-<ts>-<sid>.jsonl`, so a suffix match is unambiguous. The
 *  directory tree is small (year/month/day) — a one-shot recursive scan
 *  is cheap enough that we don't bother caching. */
export function findCodexRolloutBySessionId(
  cliSessionId: string,
  opts?: { codexHome?: string; noFollow?: boolean },
): string | undefined {
  const sessionsRoot = opts?.codexHome
    ? join(opts.codexHome, 'sessions')
    : codexSessionsRoot();
  if (!cliSessionId) return undefined;
  try {
    // BOT_HOME is untrusted and requires no-follow roots. A normal CODEX_HOME
    // remains compatible with legitimate user-managed symlinks.
    if (opts?.noFollow && opts.codexHome && !lstatSync(opts.codexHome).isDirectory()) return undefined;
    const rootStat = opts?.noFollow ? lstatSync(sessionsRoot) : statSync(sessionsRoot);
    if (!rootStat.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const suffix = `-${cliSessionId}.jsonl`;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: sessionsRoot, depth: 0 }];
  let visitedEntries = 0;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    try {
      const dirStat = opts?.noFollow ? lstatSync(dir) : statSync(dir);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }
    let directory: ReturnType<typeof opendirSync>;
    try { directory = opendirSync(dir); } catch { continue; }
    try {
      let entry: Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        visitedEntries++;
        if (opts?.noFollow && visitedEntries > UNTRUSTED_SESSION_SCAN_MAX_ENTRIES) {
          return undefined;
        }
        const full = join(dir, entry.name);
        let isDirectory = entry.isDirectory();
        let isFile = entry.isFile();
        // Some filesystems report DT_UNKNOWN. Resolve those with the same trust
        // policy, but never stat through a known symlink in untrusted BOT_HOME.
        if (!isDirectory && !isFile && !entry.isSymbolicLink()) {
          try {
            const stat = opts?.noFollow ? lstatSync(full) : statSync(full);
            isDirectory = stat.isDirectory();
            isFile = stat.isFile();
          } catch {
            continue;
          }
        }
        if (isDirectory) {
          if (!opts?.noFollow || depth < UNTRUSTED_SESSION_SCAN_MAX_DEPTH) {
            stack.push({ dir: full, depth: depth + 1 });
          }
        } else if (isFile && entry.name.endsWith(suffix)) {
          try {
            const fileStat = opts?.noFollow ? lstatSync(full) : statSync(full);
            if (fileStat.isFile()) return full;
          } catch {
            continue;
          }
        }
      }
    } finally {
      try { directory.closeSync(); } catch { /* already closed */ }
    }
  }
  return undefined;
}

function codexHistoryCliSessionId(parsed: unknown): string | undefined {
  return parsed && typeof parsed === 'object' && typeof (parsed as any).session_id === 'string'
    ? (parsed as any).session_id
    : undefined;
}

/** history.jsonl grows without bound; recent sessions live at the end, so a
 *  bounded tail window keeps the lookup O(window) instead of O(file). */
const HISTORY_TAIL_BYTES = 4 * 1024 * 1024;

/** Find the newest Codex session whose history entry includes a botmux
 *  session id. Fresh dashboard rows often only know botmux's UUID; Codex's
 *  rollout filename uses its own UUID, and history.jsonl is the durable bridge
 *  between the two. Only the trailing `maxTailBytes` of the file is scanned
 *  (default 4 MiB; pass `Infinity` to search the whole file — the scan is
 *  chunked newest-first, so memory stays bounded either way and a recent hit
 *  reads only the tail).
 *
 *  A history entry that mentions the id but carries no `session_id` ends the
 *  lookup with `undefined` by default (the newest mention is authoritative).
 *  `skipUnmapped` instead keeps looking at older mentions — the resume path's
 *  historical behaviour, where any mapping beats none. */
export function findCodexSessionIdByBotmuxSessionId(
  botmuxSessionId: string,
  opts?: { maxTailBytes?: number; codexHome?: string; noFollow?: boolean; skipUnmapped?: boolean },
): string | undefined {
  if (!botmuxSessionId) return undefined;
  const historyPath = opts?.codexHome
    ? join(opts.codexHome, 'history.jsonl')
    : codexHistoryPath();
  let fd: number | undefined;
  try {
    // O_NOFOLLOW rejects a symlink swapped in after lstat; O_NONBLOCK keeps a
    // malicious FIFO from blocking the daemon. fstat then accepts only regular
    // files. (O_NOFOLLOW is available on the supported Linux/macOS targets.)
    if (opts?.noFollow && opts.codexHome && !lstatSync(opts.codexHome).isDirectory()) return undefined;
    const pathStat = opts?.noFollow ? lstatSync(historyPath) : statSync(historyPath);
    if (!pathStat.isFile()) return undefined;
    fd = openSync(
      historyPath,
      constants.O_RDONLY
        | (opts?.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0)
        | (constants.O_NONBLOCK ?? 0),
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) return undefined;
    const size = opened.size;
    const maxTailBytes = Math.max(1, opts?.maxTailBytes ?? HISTORY_TAIL_BYTES);
    const marker = JSON.stringify(botmuxSessionId).slice(1, -1);
    let found: string | undefined;
    scanJsonlBackwardFd(fd, {
      endOffset: size,
      // A tail window almost certainly opens mid-line — drop that partial line.
      floor: Math.max(0, size - maxTailBytes),
      dropPartialAtFloor: true,
      onLine: (lineBytes) => {
        const line = lineBytes.toString('utf8');
        if (!line.includes(marker)) return false;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.text === 'string' && parsed.text.includes(botmuxSessionId)) {
            found = codexHistoryCliSessionId(parsed);
            return found !== undefined || !opts?.skipUnmapped;
          }
        } catch {
          // not a JSON history entry — keep looking at older lines
        }
        return false;
      },
    });
    return found;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed / invalid fd */ }
    }
  }
}

/** Concatenate all text blocks of a content array. Codex rollout content
 *  is always an array of `{type, text}`; the kinds we care about are
 *  `input_text` (user) and `output_text` (assistant). Other block types
 *  (image_url, audio, etc.) are ignored — the bridge only forwards text. */
function joinTextBlocks(content: unknown, kind: 'input_text' | 'output_text'): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as any).type === kind) {
      const text = (block as any).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/** Codex persists automatic context refreshes as role=user, including mid-turn
 * date/subagent updates. They must not look like local input to an adopt queue.
 * Explicit content kinds win over text so a user can quote an environment block.
 * Older rollouts lack kinds; recognize only a complete standalone wrapper there. */
function isCodexEnvironmentUpdate(metadata: unknown, text: string): boolean {
  if (metadata && typeof metadata === 'object' && 'content_item_kinds' in metadata) {
    const kinds: unknown = metadata.content_item_kinds;
    return Array.isArray(kinds) && kinds.length > 0
      && kinds.every((kind: unknown) => kind === 'environments.environment_context');
  }
  const trimmed = text.trim();
  const opening = '<environment_context>';
  const closing = '</environment_context>';
  return trimmed.length >= opening.length + closing.length
    && trimmed.startsWith(opening)
    && trimmed.indexOf(closing) === trimmed.length - closing.length;
}

/** Normalise a `turn_aborted.reason` into a stable, bounded error code
 *  (`<prefix>:<reason>`) for the durable-delivery terminal outcome. `prefix` is
 *  the CLI's own `*_turn_aborted` namespace; the codex and TRAE readers share
 *  the normalisation. */
export function rolloutAbortErrorCode(prefix: string, reason: unknown): string {
  const normalized = (typeof reason === 'string' ? reason : 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
  return `${prefix}:${normalized}`;
}

function codexAbortErrorCode(reason: unknown): string {
  return rolloutAbortErrorCode('codex_turn_aborted', reason);
}

/** Find the byte immediately after the previous completed/aborted turn. An
 * incremental drain can start in the middle of a turn, so this supplies a
 * stable lower bound for the small backward lookups below. */
function precedingTurnStartOffset(path: string, beforeOffset: number): number {
  let result = 0;
  try {
    scanJsonlBackward(path, {
      endOffset: beforeOffset,
      onLine: (line, offset) => {
        let obj: any;
        try { obj = JSON.parse(line.toString('utf8')); } catch { return false; }
        const p = obj?.payload;
        if (obj?.type !== 'event_msg' || (p?.type !== 'task_complete' && p?.type !== 'turn_aborted')) {
          return false;
        }
        result = Math.min(beforeOffset, offset + line.length + 1);
        return true;
      },
    });
  } catch {
    return 0;
  }
  return result;
}

/** Resolve a custom tool output against the rollout itself. Outputs can land
 * in a later incremental drain than their calls, so the byte offset alone is
 * insufficient; a backward chunk scan keeps the parser stateless without
 * loading an arbitrarily large rollout into memory. */
function precedingToolCall(
  path: string,
  beforeOffset: number,
  lowerBoundOffset: number,
  callId: string,
): { name: string; deferred: boolean } | undefined {
  const consider = (line: string): { name: string; deferred: boolean } | undefined => {
    if (!line.includes(callId)) return undefined;
    let obj: any;
    try { obj = JSON.parse(line); } catch { return undefined; }
    const p = obj?.payload;
    if (obj?.type !== 'response_item' || p?.call_id !== callId || typeof p.name !== 'string') return undefined;
    if (p.type === 'function_call') {
      return { name: p.name, deferred: p.name === 'exec_command' };
    }
    if (p.type === 'custom_tool_call') {
      return {
        name: p.name,
        deferred: p.name === 'exec' && hasWrappedExecCommand(typeof p.input === 'string' ? p.input : ''),
      };
    }
    return undefined;
  };
  let found: { name: string; deferred: boolean } | undefined;
  try {
    scanJsonlBackward(path, {
      endOffset: beforeOffset,
      floor: lowerBoundOffset,
      onLine: (line) => {
        found = consider(line.toString('utf8'));
        return found !== undefined;
      },
    });
  } catch {
    return undefined;
  }
  return found;
}

function wrappedToolNames(input: string): string[] {
  return wrappedToolCalls(input).map(call => call.name);
}

interface WrappedToolCall {
  name: string;
  args: string;
  source: string;
  index: number;
}

/** Extract direct `tools.foo(...)` calls from an exec wrapper without
 * evaluating its JavaScript. Balancing parentheses keeps object literals,
 * strings and template literals intact for command identity matching. */
function wrappedToolCalls(input: string): WrappedToolCall[] {
  const calls: WrappedToolCall[] = [];
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let cursor = 0; cursor < input.length; cursor++) {
    const char = input[cursor]!;
    const next = input[cursor + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        cursor++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      cursor++;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      cursor++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (!input.startsWith('tools.', cursor)
      || (cursor > 0 && /[\w$]/.test(input[cursor - 1]!))) continue;
    let nameEnd = cursor + 'tools.'.length;
    while (nameEnd < input.length && /[\w$]/.test(input[nameEnd]!)) nameEnd++;
    const name = input.slice(cursor + 'tools.'.length, nameEnd);
    if (!name || !/[A-Za-z_$]/.test(name[0]!)) continue;
    let open = nameEnd;
    while (open < input.length && /\s/.test(input[open]!)) open++;
    if (input[open] !== '(') continue;
    let depth = 0;
    let innerQuote: '"' | "'" | '`' | undefined;
    let innerEscaped = false;
    let innerLineComment = false;
    let innerBlockComment = false;
    let end = -1;
    for (let i = open; i < input.length; i++) {
      const innerChar = input[i]!;
      const innerNext = input[i + 1];
      if (innerLineComment) {
        if (innerChar === '\n') innerLineComment = false;
        continue;
      }
      if (innerBlockComment) {
        if (innerChar === '*' && innerNext === '/') {
          innerBlockComment = false;
          i++;
        }
        continue;
      }
      if (innerQuote) {
        if (innerEscaped) {
          innerEscaped = false;
        } else if (innerChar === '\\') {
          innerEscaped = true;
        } else if (innerChar === innerQuote) {
          innerQuote = undefined;
        }
        continue;
      }
      if (innerChar === '/' && innerNext === '/') {
        innerLineComment = true;
        i++;
      } else if (innerChar === '/' && innerNext === '*') {
        innerBlockComment = true;
        i++;
      } else if (innerChar === '"' || innerChar === "'" || innerChar === '`') {
        innerQuote = innerChar;
      } else if (innerChar === '(') {
        depth++;
      } else if (innerChar === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    calls.push({
      name,
      args: input.slice(open + 1, end),
      source: input.slice(cursor, end + 1),
      index: calls.length,
    });
    cursor = end;
  }
  return calls;
}

function hasWrappedExecCommand(input: string): boolean {
  return wrappedToolNames(input).includes('exec_command');
}

function nativeCommandCandidates(item: any): string[] {
  const candidates: string[] = [];
  for (const parsed of Array.isArray(item?.parsed_cmd) ? item.parsed_cmd : []) {
    if (typeof parsed?.cmd === 'string' && parsed.cmd) candidates.push(parsed.cmd);
  }
  if (Array.isArray(item?.command)) {
    const script = [...item.command].reverse().find((part): part is string => typeof part === 'string' && part.length > 0);
    if (script) candidates.push(script);
  }
  return [...new Set(candidates)];
}

function commandTemplateMatches(input: string, command: string): boolean {
  const templateStart = /\bcmd\s*:\s*`/g;
  let match: RegExpExecArray | null;
  while ((match = templateStart.exec(input)) !== null) {
    let end = match.index + match[0].length;
    let escaped = false;
    for (; end < input.length; end++) {
      const char = input[end]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '`') break;
    }
    const template = input.slice(match.index + match[0].length, end);
    const chunks = template.split(/\$\{[^}]*\}/g).filter(chunk => chunk.length >= 3);
    let cursor = 0;
    let matched = chunks.length > 0;
    for (const chunk of chunks) {
      const index = command.indexOf(chunk, cursor);
      if (index === -1) {
        matched = false;
        break;
      }
      cursor = index + chunk.length;
    }
    if (matched) return true;
    templateStart.lastIndex = end + 1;
  }
  return false;
}

function wrapperContainsCommand(input: string, command: string): boolean {
  if (input.includes(command)) return true;
  try {
    if (input.includes(JSON.stringify(command).slice(1, -1))) return true;
  } catch {
    // Fall through to the shell-token normalisation below.
  }
  const withoutTokenQuotes = command.replace(/(['"])([^\s'"]+)\1/g, '$2');
  return (withoutTokenQuotes !== command && input.includes(withoutTokenQuotes))
    || commandTemplateMatches(input, command);
}

/** Reconstruct the current turn only when it ends. The live reader defers
 * outer exec wrappers so native CommandExecution can replace only the exact
 * exec_command it represents. Non-command tools and unmatched commands are
 * restored at the terminal boundary. */
type TerminalExecEntry = { offset: number; timestampMs: number; payload: any; type: string };

function terminalExecFallbacks(
  path: string,
  beforeOffset: number,
  turnStartOffset: number,
  knownRelevant?: TerminalExecEntry[],
): CodexBridgeEvent[] {
  const relevant: TerminalExecEntry[] = knownRelevant ?? [];
  if (!knownRelevant) {
    try {
      scanJsonlBackward(path, {
        endOffset: beforeOffset,
        floor: turnStartOffset,
        onLine: (line, offset) => {
          let obj: any;
          try { obj = JSON.parse(line.toString('utf8')); } catch { return; }
          const p = obj?.payload;
          if ((obj?.type === 'response_item' && (
            p?.type === 'custom_tool_call' || p?.type === 'custom_tool_call_output'
            || p?.type === 'function_call' || p?.type === 'function_call_output'
          ))
            || (obj?.type === 'event_msg' && p?.type === 'item_completed')) {
            const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
            relevant.push({ offset, timestampMs: Number.isFinite(ts) ? ts : Date.now(), payload: p, type: obj.type });
          }
        },
      });
    } catch {
      return [];
    }
  }

  const calls: Array<{
    id: string; name: string; input: string; output?: string; outputOffset?: number; outputTimestampMs?: number;
  }> = [];
  const nativeCommands: Array<{ id?: string; candidates: string[] }> = [];
  const orderedRelevant = knownRelevant ? relevant : relevant.reverse();
  for (const entry of orderedRelevant) {
    const p = entry.payload;
    if (entry.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'exec'
      && typeof p.call_id === 'string' && p.call_id
      && hasWrappedExecCommand(typeof p.input === 'string' ? p.input : '')) {
      calls.push({ id: p.call_id, name: 'exec', input: typeof p.input === 'string' ? p.input : '' });
    } else if (entry.type === 'response_item' && p.type === 'function_call' && p.name === 'exec_command'
      && typeof p.call_id === 'string' && p.call_id) {
      calls.push({ id: p.call_id, name: 'exec_command', input: typeof p.arguments === 'string' ? p.arguments : '' });
    } else if (entry.type === 'response_item'
      && (p.type === 'custom_tool_call_output' || p.type === 'function_call_output')) {
      const call = calls.find(candidate => candidate.id === p.call_id);
      if (call) {
        call.output = stringifyCodexToolOutput(p.output);
        call.outputOffset = entry.offset;
        call.outputTimestampMs = entry.timestampMs;
      }
    } else if (entry.type === 'event_msg' && p.type === 'item_completed') {
      if (p.item?.type === 'CommandExecution') {
        nativeCommands.push({
          id: typeof p.item.id === 'string' ? p.item.id : undefined,
          candidates: nativeCommandCandidates(p.item),
        });
      }
    }
  }
  return calls.flatMap(call => {
    if (call.outputOffset === undefined) return [];
    const innerCalls = call.name === 'exec_command'
      ? [{ name: 'exec_command', args: call.input, source: call.input, index: 0 }]
      : wrappedToolCalls(call.input);
    const availableNative = new Set(nativeCommands.map((_, index) => index));
    const preserved = innerCalls.filter(inner => {
      if (inner.name !== 'exec_command') return true;
      const nativeIndex = nativeCommands.findIndex((native, index) => availableNative.has(index) && (
        native.id === call.id
        || native.candidates.some(command => wrapperContainsCommand(inner.source, command))
      ));
      if (nativeIndex === -1) return true;
      availableNative.delete(nativeIndex);
      return false;
    });
    if (preserved.length === 0) return [];
    const preserveOuterShape = call.name === 'exec' && innerCalls.length === 1;
    const toolCalls = preserved.map(inner => {
      const id = preserveOuterShape || preserved.length === 1 ? call.id : `${call.id}:${inner.index}`;
      const name = preserveOuterShape ? call.name : inner.name;
      const args = preserveOuterShape ? call.input : inner.args;
      return toolCallEntry(id, name, args, subjectFromArgsString(args));
    });
    const cotEntries: CodexCotEntry[] = toolCalls.flatMap((toolCall, index) => [
      toolCall,
      {
        kind: 'tool_result' as const,
        id: toolCall.id,
        result: index === toolCalls.length - 1
          ? truncateForCot(call.output ?? '', COT_TOOL_RESULT_MAX_CHARS)
          : '',
      },
    ]);
    return [{
      uuid: `${path}:${call.outputOffset}`, timestampMs: call.outputTimestampMs ?? Date.now(),
      kind: 'cot' as const, text: '', cotEntries,
    }];
  });
}

/** Increment-read the rollout from `fromOffset`. Mirrors the byte-offset
 *  contract of claude-transcript.drainTranscript so callers can swap them
 *  out and reuse the existing fs.watch / poll wakeup machinery. */
export function drainCodexRollout(
  path: string,
  fromOffset: number,
  previousState?: CodexDrainState,
): CodexDrainResult {
  // Truncated/rotated jsonl (size < fromOffset) re-reads from the top. Codex
  // doesn't normally rewrite rollouts, but mirror Claude's defensive handling.
  const step = beginJsonlDrain(path, fromOffset);
  if (step.kind === 'skip') return { events: [], newOffset: step.newOffset, pendingTail: '' };
  const start = step.start;
  const reusableState = !step.reset && previousState?.nextOffset === start
    && previousState.turnStartOffset >= 0
    && previousState.turnStartOffset <= start
    ? previousState
    : undefined;
  if (step.kind === 'idle') {
    return { events: [], newOffset: start, pendingTail: '', state: reusableState };
  }
  const { completeText, pendingTail, newOffset } = step.window;

  const events: CodexBridgeEvent[] = [];
  const spawnedSubagents: CodexSpawnedSubagent[] = [];
  let latestThreadSettings: CodexThreadSettings | undefined;
  let latestModel: string | undefined;
  let latestReasoningEffort: string | undefined;
  // Remember both deferred and ordinary calls seen in this drain. A plain
  // deferred-id set cannot distinguish an ordinary call from a call that
  // landed in an earlier incremental chunk, which forced every ordinary
  // output through a synchronous backward file scan.
  const toolCallDeferralById = new Map<string, boolean>();
  // Most live drains only consume newly appended lines in the current turn.
  // Reuse the worker-carried lower bound across ticks, or resolve it lazily
  // once when a cross-drain lookup / terminal fallback first needs it.
  let turnStartOffset: number | undefined = start === 0
    ? 0
    : reusableState?.turnStartOffset;
  let turnFullyCovered = turnStartOffset === start;
  const resolveTurnStartOffset = (): number => {
    turnStartOffset ??= precedingTurnStartOffset(path, start);
    return turnStartOffset;
  };
  const turnExecEntries: TerminalExecEntry[] = [];
  // Walk lines with their byte offsets so synthetic uuids are stable across
  // re-drains.
  for (const { line, lineStart, lineEnd } of iterateJsonlLines(completeText, start)) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const settings = codexThreadSettingsFromEvent(obj);
    if (settings) {
      latestThreadSettings = settings;
      continue;
    }
    // turn_context carries the executor model/effort on every turn (latest-wins,
    // since Codex can change them independently). Published via the same
    // active_runtime channel TRAE uses.
    const runtime = runtimeFromTurnContext(obj);
    if (runtime) {
      if (runtime.model) latestModel = runtime.model;
      if (runtime.reasoningEffort) latestReasoningEffort = runtime.reasoningEffort;
      continue;
    }
    const p = obj?.payload;
    if (!p || typeof p !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    const subagentThreadId = spawnedSubagentThreadId(obj);
    if (subagentThreadId) spawnedSubagents.push({ threadId: subagentThreadId, startedAtMs: timestampMs });
    // Codex can persist task_started well before the matching response_item
    // user record (AGENTS/environment scaffolding may be written in between).
    // Surface this authoritative lifecycle edge so the queue does not expire
    // a real running turn merely because fingerprint evidence is late.
    if (obj.type === 'event_msg'
      && p.type === 'task_started'
      && typeof p.turn_id === 'string'
      && p.turn_id.length > 0) {
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'turn_started',
        text: '',
        sourceTurnId: p.turn_id,
      });
      continue;
    }
    if ((obj.type === 'response_item' && (
      p.type === 'custom_tool_call' || p.type === 'custom_tool_call_output'
      || p.type === 'function_call' || p.type === 'function_call_output'
    )) || (obj.type === 'event_msg' && p.type === 'item_completed')) {
      turnExecEntries.push({ offset: lineStart, timestampMs, payload: p, type: obj.type });
    }
    // User turn-start: response_item message role=user. Stable across every
    // codex version, and the ONLY event the RPC rollout-match probe reads
    // (codex-rpc-lifecycle.rolloutUserTurnMatches), so it must stay a
    // response_item user message.
    if (obj.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = joinTextBlocks(p.content, 'input_text');
      if (!text) continue;
      if (isCodexEnvironmentUpdate(p.internal_chat_message_metadata_passthrough, text)) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text });
      continue;
    }
    // Mid-turn thinking timeline: reasoning summaries and tool calls/outputs
    // become cosmetic 'cot' events. The queue attributes them to the
    // collecting turn for the native CoT message; they never start or close
    // a turn (the boundaries above/below stay authoritative).
    if (obj.type === 'response_item') {
      if (p.type === 'custom_tool_call' && typeof p.call_id === 'string' && p.call_id) {
        const deferred = p.name === 'exec' && hasWrappedExecCommand(typeof p.input === 'string' ? p.input : '');
        toolCallDeferralById.set(p.call_id, deferred);
        if (deferred) continue;
      }
      if (p.type === 'function_call' && p.name === 'exec_command' && typeof p.call_id === 'string' && p.call_id) {
        toolCallDeferralById.set(p.call_id, true);
        continue;
      }
      if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output')
        && typeof p.call_id === 'string') {
        const knownDeferral = toolCallDeferralById.get(p.call_id);
        toolCallDeferralById.delete(p.call_id);
        if (knownDeferral ?? precedingToolCall(path, lineStart, resolveTurnStartOffset(), p.call_id)?.deferred) continue;
      }
      const cotEntries = codexCotEntriesFromResponseItem(p);
      if (cotEntries.length > 0) {
        events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'cot', text: '', cotEntries });
        continue;
      }
    }
    if (obj.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution') {
      const item = p.item;
      const command = Array.isArray(item.command) ? item.command : [];
      const subject = nativeCommandCandidates(item)[0] ?? '';
      let args = '';
      try { args = command.length > 0 ? JSON.stringify({ command }) : ''; } catch { /* ignore malformed command */ }
      const id = typeof item.id === 'string' && item.id ? item.id : `${path}:${lineStart}:command`;
      const cotEntries: CodexCotEntry[] = [toolCallEntry(id, 'shell', args, subject)];
      const formatted = typeof item.formatted_output === 'string' ? item.formatted_output : '';
      const aggregated = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      const streams = [item.stdout, item.stderr]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join('\n');
      const output = formatted || aggregated || streams;
      cotEntries.push({ kind: 'tool_result', id, result: truncateForCot(output, COT_TOOL_RESULT_MAX_CHARS) });
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'cot', text: '', cotEntries });
      continue;
    }
    // Turn terminal: event_msg `task_complete` carries the final visible text
    // in `last_agent_message` (may be empty) and fires exactly ONCE per turn.
    // This is the SOLE assistant_final source. Codex assistant `response_item`
    // messages are NOT a safe boundary: the `phase:'final_answer'` marker was
    // dropped (>=0.146), and mid-turn assistant messages are byte-identical to
    // the final one (both phase:undefined) — keying on them would close a turn
    // on the first mid-turn preamble and truncate/duplicate. Taking only
    // task_complete also dedups codex's triple representation of one answer
    // (event_msg agent_message / response_item message / event_msg
    // task_complete). Mirrors the traex reader. See file header.
    if (obj.type === 'event_msg'
      && p.type === 'task_complete'
      && typeof p.turn_id === 'string'
      && p.turn_id.length > 0) {
      const failed = p.error !== null && p.error !== undefined;
      const failureLimitKind = failed ? codexRolloutLimitKind(p.error) : undefined;
      const terminalTurnStart = turnFullyCovered
        ? (turnStartOffset ?? start)
        : resolveTurnStartOffset();
      events.push(...terminalExecFallbacks(
        path,
        lineStart,
        terminalTurnStart,
        turnFullyCovered ? turnExecEntries : undefined,
      ));
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: typeof p.last_agent_message === 'string' ? p.last_agent_message : '',
        ...(failed ? {
          terminalStatus: 'failed' as const,
          terminalErrorCode: codexRolloutFailureCode(p.error),
          terminalErrorSummary: safeFailureSummary(p.error),
          ...(failureLimitKind ? { terminalLimitKind: failureLimitKind } : {}),
        } : {}),
        sourceTurnId: p.turn_id,
      });
      turnStartOffset = lineEnd;
      turnFullyCovered = true;
      turnExecEntries.length = 0;
      toolCallDeferralById.clear();
      continue;
    }
    // A cancelled turn writes `turn_aborted` (turn_id, reason) and NO
    // task_complete. Side effects may already have run, so release the durable
    // delivery as `ambiguous` rather than wedge the turn as running forever.
    if (obj.type === 'event_msg'
      && p.type === 'turn_aborted'
      && typeof p.turn_id === 'string'
      && p.turn_id.length > 0) {
      const terminalTurnStart = turnFullyCovered
        ? (turnStartOffset ?? start)
        : resolveTurnStartOffset();
      events.push(...terminalExecFallbacks(
        path,
        lineStart,
        terminalTurnStart,
        turnFullyCovered ? turnExecEntries : undefined,
      ));
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: '',
        terminalStatus: 'ambiguous',
        terminalErrorCode: codexAbortErrorCode(p.reason),
        sourceTurnId: p.turn_id,
      });
      turnStartOffset = lineEnd;
      turnFullyCovered = true;
      turnExecEntries.length = 0;
      toolCallDeferralById.clear();
      continue;
    }
    // Everything else is skipped: role=developer/system instructions and
    // every assistant `response_item` message (mid-turn OR final) — the turn
    // boundary comes only from task_complete. Reasoning / tool calls surface
    // as cosmetic 'cot' events above, never as boundaries.
  }
  return {
    events,
    newOffset,
    pendingTail,
    latestThreadSettings,
    latestModel,
    latestReasoningEffort,
    ...(spawnedSubagents.length > 0 ? { spawnedSubagents } : {}),
    ...(turnStartOffset !== undefined ? {
      state: { nextOffset: newOffset, turnStartOffset },
    } : {}),
  };
}

function codexThreadSettingsFromEvent(obj: any): CodexThreadSettings | undefined {
  if (obj?.type !== 'event_msg' || obj.payload?.type !== 'thread_settings_applied') return undefined;
  const raw = obj.payload.thread_settings;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  // Codex omits service_tier when /fast is disabled; that is an applied
  // default-tier snapshot, not a malformed settings record.
  const rawServiceTier = raw.service_tier;
  const serviceTier = rawServiceTier === undefined || rawServiceTier === ''
    ? 'default'
    : rawServiceTier;
  if (typeof serviceTier !== 'string') return undefined;
  const model = typeof raw?.model === 'string' && raw.model ? raw.model : undefined;
  // Effort follows in-session changes made through Codex's own model controls.
  // Codex records it both at the top level and under collaboration_mode.settings;
  // take the top-level value first, matching the model precedence above.
  const rawEffort = raw?.reasoning_effort
    ?? raw?.collaboration_mode?.settings?.reasoning_effort;
  const reasoningEffort = typeof rawEffort === 'string' && rawEffort.trim()
    ? rawEffort.trim()
    : undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    serviceTier,
  };
}

/**
 * One-shot bootstrap for an existing rollout. Reads backwards in fixed-size
 * chunks and stops at the newest settings record, keeping memory bounded even
 * for long sessions. Live changes use `drainCodexRollout`'s byte offset and do
 * not call this function.
 */
export function scanCodexThreadSettings(
  path: string,
  opts: { chunkBytes?: number } = {},
): CodexThreadSettings | undefined {
  if (!existsSync(path)) return undefined;
  const chunkBytes = Math.max(1024, opts.chunkBytes ?? 64 * 1024);
  let settings: CodexThreadSettings | undefined;
  try {
    const size = statSync(path).size;
    if (size === 0) return undefined;
    scanJsonlBackward(path, {
      endOffset: size,
      chunkBytes,
      onLine: (lineBytes) => {
        const line = lineBytes.toString('utf8');
        if (!line.includes('thread_settings_applied')) return false;
        let obj: any;
        try { obj = JSON.parse(line); } catch { return false; }
        settings = codexThreadSettingsFromEvent(obj);
        return settings !== undefined;
      },
    });
  } catch {
    return undefined;
  }
  return settings;
}

/** One-shot bootstrap of the current runtime (model / reasoning effort) from
 *  `turn_context` records, for attach/restore paths that cursor straight to
 *  the tail without draining history. Scans BACKWARD in fixed-size chunks and
 *  stops once both fields resolve — the newest `turn_context` sits near the
 *  tail. `scanMaxBytes` bounds the pathological missing-field case. A
 *  non-newline-terminated trailing partial is excluded via baselineJsonlCursor
 *  so a crash mid-write cannot surface a half-written record. Shared by the
 *  Codex and TRAE readers (same rollout record shape). */
export function readLatestRolloutRuntime(path: string, scanMaxBytes: number): RolloutRuntimeSnapshot {
  if (!path || !existsSync(path)) return {};
  let completeEnd: number;
  try { completeEnd = baselineJsonlCursor(path).newOffset; } catch { return {}; }
  if (completeEnd <= 0) return {};

  let latestModel: string | undefined;
  let latestReasoningEffort: string | undefined;
  const emit = (): RolloutRuntimeSnapshot => ({
    ...(latestModel ? { model: latestModel } : {}),
    ...(latestReasoningEffort ? { reasoningEffort: latestReasoningEffort } : {}),
  });
  // Backward scan keeps the first (newest) value seen for each field; returns
  // true once both are known so the scan can stop early.
  const consider = (line: string): boolean => {
    if (!line.trim()) return false;
    let runtime: RolloutRuntimeSnapshot | undefined;
    try { runtime = runtimeFromTurnContext(JSON.parse(line)); } catch { return false; }
    if (latestModel === undefined && runtime?.model) latestModel = runtime.model;
    if (latestReasoningEffort === undefined && runtime?.reasoningEffort) {
      latestReasoningEffort = runtime.reasoningEffort;
    }
    return latestModel !== undefined && latestReasoningEffort !== undefined;
  };

  try {
    // The leading fragment at the byte-cap floor is a truncated historical
    // partial and is dropped; at true file start it is a complete record.
    scanJsonlBackward(path, {
      endOffset: completeEnd,
      floor: Math.max(0, completeEnd - scanMaxBytes),
      dropPartialAtFloor: true,
      onLine: (line) => consider(line.toString('utf8')),
    });
  } catch {
    return emit();
  }
  return emit();
}

export function readLatestCodexRuntime(path: string): RolloutRuntimeSnapshot {
  return readLatestRolloutRuntime(path, CODEX_RUNTIME_SCAN_MAX_BYTES);
}
