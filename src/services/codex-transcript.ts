/**
 * Reader for Codex's per-session rollout JSONL.
 *
 * Codex stores each session's full transcript at
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<cliSessionId>.jsonl
 * and creates the file lazily on the first user submit. The bridge fallback
 * cares about exactly two records:
 *
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
  readlinkSync,
  readSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { codexHistoryPath, codexSessionsRoot } from './codex-paths.js';
import { baselineJsonlCursor } from './jsonl-cursor.js';
import type { CodexThreadSettings } from './codex-service-tier.js';

const IS_LINUX = platform() === 'linux';
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

/** Enumerate the filesystem paths a process currently has open, normalised to
 *  a plain string[] regardless of platform. Returns undefined only when the
 *  enumeration itself is unavailable (unreadable /proc, lsof failed); an empty
 *  array means "readable, but no matching fds". Both `findCodexRolloutByPid`
 *  and `findCodexRolloutSetByPid` derive from THIS single source so their
 *  Linux `/proc` and macOS/BSD `lsof` normalisation can never drift apart.
 *
 *  Linux: `/proc/<pid>/fd/*` fast path.
 *  macOS / BSD: `lsof -p <pid> -Fn` 兜底（同 session-discovery 里的 readCwd）。 */
function codexProcessOpenTargets(pid: number): string[] | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      const targets: string[] = [];
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        targets.push(target);
      }
      return targets;
    }
    // /proc 不可读时落到下面的 lsof 兜底（极少见，但兜一下）
  }
  // BSD ps 的 lsof：每个 fd 输出一行 `f<n>` 加一行 `n<path>`，socket / pipe
  // 之类的内部条目以 `n->0x...` 或 `n<garbage>` 开头，所以只接受 `n/` 开头。
  let out: string;
  try {
    out = execSync(`lsof -p ${pid} -Fn`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
  return out.split('\n').flatMap(line =>
    line.startsWith('n/') ? [line.slice(1)] : [],
  );
}

/** Find the rollout file an externally-running Codex process has open. A
 *  single open rollout is authoritative for that pid. Multiple open rollouts
 *  are ambiguous: current Codex versions can keep parent and sibling-agent
 *  transcripts open in the same process, so choosing the first fd can bind
 *  an adopted pane to the wrong conversation.
 *
 *  两种平台都用 `codexSessionIdFromRolloutPath` 提取 sid。 */
export function findCodexRolloutByPid(pid: number): CodexRolloutRef | undefined {
  const targets = codexProcessOpenTargets(pid);
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
  const targets = codexProcessOpenTargets(pid);
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
 *  without a live pid. */
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
   *   - 'assistant_final' closes the currently-collecting turn with output
   *   - 'turn_aborted' closes it without producing fallback output */
  kind: 'user' | 'assistant_final' | 'turn_aborted';
  /** Concatenated text from the message's content blocks (input_text for
   *  user, output_text for assistant). */
  text: string;
  /** Optional durable-delivery terminal outcome carried by bridges with an
   *  explicit completion record (for example Grok `turn_completed`). Codex
   *  final-answer records omit it and retain the historical completed
   *  default. */
  terminalStatus?: 'completed' | 'failed' | 'ambiguous';
  terminalErrorCode?: string;
  /** Safe, bounded user-facing detail extracted from a structured failure.
   *  Raw provider payloads stay in the rollout/Web terminal. */
  terminalErrorSummary?: string;
  sourceSessionId?: string;
  /** Keep the pending turn's original markTimeMs instead of moving it to the
   *  transcript user timestamp. Used by bridges whose committed user
   *  timestamp can lag behind in-turn delivery markers. */
  preserveMarkTimeMs?: boolean;
}

/** Terminal lifecycle edges understood by the shared structured bridge. */
export function isStructuredTerminalEvent(event: Pick<CodexBridgeEvent, 'kind'>): boolean {
  return event.kind === 'assistant_final' || event.kind === 'turn_aborted';
}

export const CODEX_RATE_LIMIT_ERROR_CODE = 'codex_rate_limited';
export const CODEX_AUTH_ERROR_CODE = 'codex_auth_failed';
export const CODEX_INVALID_REQUEST_ERROR_CODE = 'codex_invalid_request';
export const CODEX_CONNECTION_ERROR_CODE = 'codex_connection_failed';
export const CODEX_TASK_FAILED_ERROR_CODE = 'codex_task_failed';

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

function safeFailureSummary(error: unknown): string | undefined {
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

function codexTaskFailureCode(error: unknown): string {
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
  if (/econn|connection|network|socket|timed?\s*out|timeout|dns|enotfound/.test(normalized)) {
    return CODEX_CONNECTION_ERROR_CODE;
  }
  return CODEX_TASK_FAILED_ERROR_CODE;
}

export function isCodexRateLimitEvent(event: CodexBridgeEvent): boolean {
  return event.kind === 'assistant_final'
    && event.terminalStatus === 'failed'
    && event.terminalErrorCode === CODEX_RATE_LIMIT_ERROR_CODE;
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
  events: readonly { kind: 'user' | 'assistant_final' | 'turn_aborted'; text: string }[],
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
}

/** Bounded backward-scan cap for the one-shot runtime bootstrap — runtime
 *  identity is advisory and must never synchronously parse a multi-GB rollout
 *  on attach (same guard rationale as usage-side MAX_USAGE_TRANSCRIPT_BYTES).
 *  Mirrors traex-transcript's TRAEX_RUNTIME_SCAN_MAX_BYTES. */
const CODEX_RUNTIME_SCAN_MAX_BYTES = 4 * 1024 * 1024;

/** Executor-confirmed model / reasoning-effort as recorded in a Codex
 *  `turn_context` event. Codex writes this on every turn (top-level `model`
 *  and `effort`, with a `collaboration_mode.settings` mirror), so it — not the
 *  optional `thread_settings_applied` record — is the reliable in-session
 *  model/effort source. Mirrors traex-transcript's runtimeFromTraexEntry. */
function runtimeFromCodexEntry(obj: any): { model?: string; reasoningEffort?: string } | undefined {
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
 *  between the two. Only the trailing `maxTailBytes` of the file is scanned. */
export function findCodexSessionIdByBotmuxSessionId(
  botmuxSessionId: string,
  opts?: { maxTailBytes?: number; codexHome?: string; noFollow?: boolean },
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
    const start = Math.max(0, size - maxTailBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // The window almost certainly opens mid-line — drop the partial line.
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }
    const marker = JSON.stringify(botmuxSessionId).slice(1, -1);
    const lines = text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes(marker)) continue;
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed?.text === 'string' && parsed.text.includes(botmuxSessionId)) {
          return codexHistoryCliSessionId(parsed);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed / invalid fd */ }
    }
  }
  return undefined;
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

/** Normalise a `turn_aborted.reason` into a stable, bounded error code for the
 *  durable-delivery terminal outcome. Mirrors the traex reader. */
function codexAbortErrorCode(reason: unknown): string {
  const normalized = (typeof reason === 'string' ? reason : 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';
  return `codex_turn_aborted:${normalized}`;
}

/** Increment-read the rollout from `fromOffset`. Mirrors the byte-offset
 *  contract of claude-transcript.drainTranscript so callers can swap them
 *  out and reuse the existing fs.watch / poll wakeup machinery. */
export function drainCodexRollout(path: string, fromOffset: number): CodexDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  // Truncated/rotated jsonl — re-read from the top. Codex doesn't normally
  // rewrite rollouts, but mirror Claude's defensive handling.
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const len = size - start;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  const pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  const newOffset = start + Buffer.byteLength(completeText, 'utf8');

  const events: CodexBridgeEvent[] = [];
  let latestThreadSettings: CodexThreadSettings | undefined;
  let latestModel: string | undefined;
  let latestReasoningEffort: string | undefined;
  // Track byte offset within the file as we walk lines so synthetic uuids
  // are stable across re-drains.
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;  // the \n after an empty line
      continue;
    }
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1;  // include \n
    const lineStart = cursor;
    cursor += lineByteLen;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const settings = codexThreadSettingsFromEvent(obj);
    if (settings) {
      latestThreadSettings = settings;
      continue;
    }
    // turn_context carries the executor model/effort on every turn (latest-wins,
    // since /model and /effort change independently). Published via the same
    // active_runtime channel TRAE uses.
    const runtime = runtimeFromCodexEntry(obj);
    if (runtime) {
      if (runtime.model) latestModel = runtime.model;
      if (runtime.reasoningEffort) latestReasoningEffort = runtime.reasoningEffort;
      continue;
    }
    const p = obj?.payload;
    if (!p || typeof p !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    // User turn-start: response_item message role=user. Stable across every
    // codex version, and the ONLY event the RPC rollout-match probe reads
    // (codex-rpc-lifecycle.rolloutUserTurnMatches), so it must stay a
    // response_item user message.
    if (obj.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const text = joinTextBlocks(p.content, 'input_text');
      if (!text) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text });
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
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: typeof p.last_agent_message === 'string' ? p.last_agent_message : '',
        ...(failed ? {
          terminalStatus: 'failed' as const,
          terminalErrorCode: codexTaskFailureCode(p.error),
          terminalErrorSummary: safeFailureSummary(p.error),
        } : {}),
      });
      continue;
    }
    // A cancelled turn writes `turn_aborted` (turn_id, reason) and NO
    // task_complete. Side effects may already have run, so release the durable
    // delivery as `ambiguous` rather than wedge the turn as running forever.
    if (obj.type === 'event_msg'
      && p.type === 'turn_aborted'
      && typeof p.turn_id === 'string'
      && p.turn_id.length > 0) {
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: '',
        terminalStatus: 'ambiguous',
        terminalErrorCode: codexAbortErrorCode(p.reason),
      });
      continue;
    }
    // Everything else is skipped: role=developer/system instructions,
    // reasoning, function_call*, and every assistant `response_item` message
    // (mid-turn OR final) — the turn boundary comes only from task_complete.
  }
  return { events, newOffset, pendingTail, latestThreadSettings, latestModel, latestReasoningEffort };
}

function codexThreadSettingsFromEvent(obj: any): CodexThreadSettings | undefined {
  if (obj?.type !== 'event_msg' || obj.payload?.type !== 'thread_settings_applied') return undefined;
  const raw = obj.payload.thread_settings;
  const serviceTier = raw?.service_tier;
  if (typeof serviceTier !== 'string' || !serviceTier) return undefined;
  const model = typeof raw?.model === 'string' && raw.model ? raw.model : undefined;
  // Effort follows an in-session `/effort` switch. Codex records it both at the
  // top level and under collaboration_mode.settings; take the top-level value
  // first, matching the model precedence above.
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
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size === 0) return undefined;
    fd = openSync(path, 'r');
    let end = size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const block = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = block.length;
      if (lineEnd > 0 && block[lineEnd - 1] === 0x0a) lineEnd--;
      let carryEnd = lineEnd;
      for (let i = lineEnd - 1; i >= 0; i--) {
        if (block[i] !== 0x0a) continue;
        const line = block.subarray(i + 1, lineEnd).toString('utf8');
        lineEnd = i;
        carryEnd = i;
        if (!line.includes('thread_settings_applied')) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        const settings = codexThreadSettingsFromEvent(obj);
        if (settings) return settings;
      }
      carry = block.subarray(0, carryEnd);
      end = start;
    }
    if (carry.length > 0) {
      let obj: any;
      try { obj = JSON.parse(carry.toString('utf8')); } catch { return undefined; }
      return codexThreadSettingsFromEvent(obj);
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** One-shot bootstrap of the current Codex runtime (model / reasoning effort)
 *  from `turn_context` records, for attach/restore paths that cursor straight
 *  to the tail without draining history. Scans BACKWARD in fixed-size chunks
 *  and stops once both fields resolve — the newest `turn_context` sits near the
 *  tail. A hard byte cap bounds the pathological missing-field case. A
 *  non-newline-terminated trailing partial is excluded via baselineJsonlCursor
 *  so a crash mid-write cannot surface a half-written record. Mirrors
 *  traex-transcript's readLatestTraexRuntime. */
export function readLatestCodexRuntime(
  path: string,
): { model?: string; reasoningEffort?: string } {
  if (!path || !existsSync(path)) return {};
  let completeEnd: number;
  try { completeEnd = baselineJsonlCursor(path).newOffset; } catch { return {}; }
  if (completeEnd <= 0) return {};

  let latestModel: string | undefined;
  let latestReasoningEffort: string | undefined;
  const emit = (): { model?: string; reasoningEffort?: string } => ({
    ...(latestModel ? { model: latestModel } : {}),
    ...(latestReasoningEffort ? { reasoningEffort: latestReasoningEffort } : {}),
  });
  const consider = (line: string): boolean => {
    if (!line.trim()) return false;
    let runtime: { model?: string; reasoningEffort?: string } | undefined;
    try { runtime = runtimeFromCodexEntry(JSON.parse(line)); } catch { return false; }
    if (latestModel === undefined && runtime?.model) latestModel = runtime.model;
    if (latestReasoningEffort === undefined && runtime?.reasoningEffort) {
      latestReasoningEffort = runtime.reasoningEffort;
    }
    return latestModel !== undefined && latestReasoningEffort !== undefined;
  };

  const floor = Math.max(0, completeEnd - CODEX_RUNTIME_SCAN_MAX_BYTES);
  const chunkBytes = 64 * 1024;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    let end = completeEnd;
    let carry = Buffer.alloc(0);
    while (end > floor) {
      const start = Math.max(floor, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const block = carry.length > 0 ? Buffer.concat([chunk, carry]) : chunk;
      let lineEnd = block.length;
      if (lineEnd > 0 && block[lineEnd - 1] === 0x0a) lineEnd--;
      let carryEnd = lineEnd;
      for (let i = lineEnd - 1; i >= 0; i--) {
        if (block[i] !== 0x0a) continue;
        const line = block.subarray(i + 1, lineEnd).toString('utf8');
        lineEnd = i;
        carryEnd = i;
        if (consider(line)) return emit();
      }
      carry = start === floor && floor > 0
        ? Buffer.alloc(0)
        : block.subarray(0, carryEnd);
      end = start;
    }
    if (carry.length > 0) consider(carry.toString('utf8'));
  } catch {
    return emit();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return emit();
}
