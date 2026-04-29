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
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CODEX_SESSIONS_ROOT = join(homedir(), '.codex', 'sessions');

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
