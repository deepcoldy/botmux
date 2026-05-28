/**
 * Reader for Codex's per-session rollout JSONL.
 *
 * Codex stores each session's full transcript at
 *   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<cliSessionId>.jsonl
 * and creates the file lazily on the first user submit. Inside, the bridge
 * fallback only cares about two `response_item.payload.type === 'message'`
 * shapes:
 *
 *   - role=user             → the user's prompt text (input_text content)
 *   - role=assistant +
 *     phase=final_answer    → the model's final reply (output_text content)
 *
 * Why these and not `event_msg`:
 *   - `response_item` is the canonical transcript record; `event_msg` is a
 *     UI-event stream that can carry the same final text via two channels
 *     (`agent_message phase=final_answer` AND `task_complete.last_agent_message`).
 *     Picking `response_item` keeps the reader to a single source of truth
 *     and avoids any chance of double-emit if both paths are present.
 *   - Skipping role=developer (system instructions), phase=commentary
 *     (mid-turn status), reasoning, and function_call* keeps the bridge
 *     focused on what the user actually said and what the model finally
 *     answered — same scope as the Claude bridge.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const CODEX_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');
const IS_LINUX = platform() === 'linux';

/** Extract the cliSessionId encoded in a rollout filename. Codex's session
 *  id is UUID-shaped (8-4-4-4-12 hex), which lets us anchor the regex on
 *  the UUID alone — the `<ts>` segment between "rollout-" and the sid
 *  contains its own dashes that would otherwise let a greedy match swallow
 *  parts of the sid. Returns undefined for paths that don't match. */
export function codexSessionIdFromRolloutPath(path: string): string | undefined {
  const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1] : undefined;
}

/** Find the rollout file an externally-running Codex process has open. The
 *  Codex process keeps fd open on its current rollout for the entire
 *  lifetime of the session, so this is the authoritative way to bind a
 *  Codex pid to its sessionId — far more reliable than scanning
 *  `~/.codex/sessions` by mtime (which would race with sibling Codex panes
 *  in the same project).
 *
 *  Linux: `/proc/<pid>/fd/*` fast path.
 *  macOS / BSD: `lsof -p <pid> -Fn` 兜底（同 session-discovery 里的 readCwd）。
 *  两种平台都用 `codexSessionIdFromRolloutPath` 提取 sid。 */
export function findCodexRolloutByPid(pid: number): { path: string; cliSessionId: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const hit = matchCodexRolloutPath(target);
        if (hit) return hit;
      }
      return undefined;
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
  for (const line of out.split('\n')) {
    if (!line.startsWith('n/')) continue;
    const target = line.slice(1);
    const hit = matchCodexRolloutPath(target);
    if (hit) return hit;
  }
  return undefined;
}

function matchCodexRolloutPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  if (!target.includes('/.codex/sessions/')) return undefined;
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
   *   - 'assistant_final' closes the currently-collecting turn */
  kind: 'user' | 'assistant_final';
  /** Concatenated text from the message's content blocks (input_text for
   *  user, output_text for assistant). */
  text: string;
  sourceSessionId?: string;
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
  events: readonly { kind: 'user' | 'assistant_final'; text: string }[],
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
}

/** Locate the rollout file for a given Codex sessionId. Codex names files
 *  `rollout-<ts>-<sid>.jsonl`, so a suffix match is unambiguous. The
 *  directory tree is small (year/month/day) — a one-shot recursive scan
 *  is cheap enough that we don't bother caching. */
export function findCodexRolloutBySessionId(cliSessionId: string): string | undefined {
  if (!cliSessionId || !existsSync(CODEX_SESSIONS_ROOT)) return undefined;
  const suffix = `-${cliSessionId}.jsonl`;
  const stack: string[] = [CODEX_SESSIONS_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name.endsWith(suffix)) {
        return full;
      }
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
    if (obj?.type !== 'response_item') continue;
    const p = obj.payload;
    if (!p || typeof p !== 'object' || p.type !== 'message') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    if (p.role === 'user') {
      const text = joinTextBlocks(p.content, 'input_text');
      if (!text) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text });
    } else if (p.role === 'assistant' && p.phase === 'final_answer') {
      const text = joinTextBlocks(p.content, 'output_text');
      if (!text) continue;
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text });
    }
    // Skip role=developer (instructions), phase=commentary (mid-turn
    // status), and any reasoning / function_call* events — see file
    // header for rationale.
  }
  return { events, newOffset, pendingTail };
}
