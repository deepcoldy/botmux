/**
 * Read-only access to Kimi Code's native session log (verified on Kimi Code
 * 2.5.0, wire `protocol_version` 1.5).
 *
 * Layout (see adapters/cli/kimi-session.ts for how sessions are indexed):
 *   <KIMI_CODE_HOME>/session_index.jsonl            { sessionId, sessionDir, workDir }
 *   <sessionDir>/state.json                         { createdAt, lastPrompt, … }
 *   <sessionDir>/agents/main/wire.jsonl             main agent event log
 *   <sessionDir>/agents/<agent-N>/wire.jsonl        sub-agents (not read here)
 *   <KIMI_CODE_HOME>/config.toml                    [models."<alias>"] max_context_size
 *
 * The wire log is append-only JSONL. Records used here:
 *   - `turn.prompt`                      a new main-agent turn (input text)
 *   - `context.append_loop_event`        `event.type` = `content.part`
 *                                        (`part.type` think | text), `tool.call`,
 *                                        `tool.result`, `step.end` (finishReason)
 *   - `agent.turn.ended` / `turn.ended`  turn boundary
 *   - `usage.record`                     billed usage of ONE model call
 *   - `token_counting.measured|rebased`  current context size
 *   - `llm.request`                      model alias + thinking effort
 *
 * Kimi persists one model step at a time: the thinking, text and tool calls of
 * a step are appended together once the model call returns, so readers update
 * per step, not per token.
 *
 * This module only OBSERVES the log (activity for the reply card and usage
 * numbers). Turn boundaries and final replies stay with the existing Kimi
 * path (OSC 7501 program status + `botmux send`).
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { CotEntry } from '../types.js';
import {
  isKimiSessionId,
  kimiHome,
  readKimiSessionIndex,
  sameKimiWorkDir,
  type KimiSessionIndexEntry,
} from '../adapters/cli/kimi-session.js';
import { boundSubjectForTransport, subjectFromInputObject } from './cot-subject.js';

export const KIMI_MAIN_AGENT_ID = 'main';

/** Same preview budget as the Codex / Grok / Pi activity readers. */
const COT_TOOL_ARGS_MAX_CHARS = 600;
const COT_TOOL_RESULT_MAX_CHARS = 800;
/** The first `turn.prompt` of a botmux-created session sits within the first
 *  ~70 KB of its wire log (measured over local 2.x sessions); the head probe
 *  reads a comfortable multiple of that. */
const WIRE_HEAD_PROBE_BYTES = 256 * 1024;

export function kimiMainWirePath(sessionDir: string): string {
  return join(sessionDir, 'agents', KIMI_MAIN_AGENT_ID, 'wire.jsonl');
}

function readRange(path: string, position: number, bytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, position);
    return buf.subarray(0, n).toString('utf8');
  } catch { return undefined; } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** Index entry → its session dir, only when it stays inside `<home>/sessions`
 *  and is named after its id (the containment rule Kimi itself applies). */
function containedSessionDir(home: string, entry: KimiSessionIndexEntry): string | undefined {
  const sessionsRoot = resolve(join(home, 'sessions')) + sep;
  const dir = resolve(entry.sessionDir);
  if (!dir.startsWith(sessionsRoot) || dir.split(sep).pop() !== entry.sessionId) return undefined;
  return dir;
}

export interface KimiIndexedSession {
  sessionDir: string;
  wirePath: string;
  workDir?: string;
}

/** Every session Kimi has indexed so far, oldest first (index order). */
export function listKimiSessions(env: NodeJS.ProcessEnv = process.env): KimiIndexedSession[] {
  const home = kimiHome(env);
  const out: KimiIndexedSession[] = [];
  for (const entry of readKimiSessionIndex(home)) {
    const dir = containedSessionDir(home, entry);
    if (dir) out.push({ sessionDir: dir, wirePath: kimiMainWirePath(dir), workDir: entry.workDir });
  }
  return out;
}

const INDEX_TAIL_BYTES = 8 * 1024;

/** Cheap change stamp for "which Kimi session is the newest one carrying a
 *  marker": the index (Kimi appends to it whenever it creates a session —
 *  first prompt, `/new`) plus the state.json of its newest entry (rewritten on
 *  every prompt, so a `/new` session's first prompt shows up even though the
 *  index did not change). `''` when there is no index.
 *
 *  The state.json part carries BOTH mtime and size: a prompt rewrite that
 *  lands in the same millisecond as the previous write keeps mtimeMs identical
 *  (observed in tight test loops and possible on a fast disk), and size still
 *  changes when `lastPrompt` changes. Size alone is not enough — an
 *  equal-length rewrite would be invisible — so both are kept. */
export function kimiSessionIndexStamp(env: NodeJS.ProcessEnv = process.env): string {
  const home = kimiHome(env);
  const indexPath = join(home, 'session_index.jsonl');
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(indexPath);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch { return ''; }
  let newestState = '';
  const tail = readRange(indexPath, Math.max(0, size - INDEX_TAIL_BYTES), Math.min(size, INDEX_TAIL_BYTES));
  const lines = tail?.split('\n') ?? [];
  for (let i = lines.length - 1; i >= 0 && !newestState; i--) {
    try {
      const row = JSON.parse(lines[i]) as { sessionId?: unknown; sessionDir?: unknown; deleted?: unknown };
      if (typeof row.sessionId !== 'string' || typeof row.sessionDir !== 'string' || row.deleted === true) continue;
      const dir = containedSessionDir(home, { sessionId: row.sessionId, sessionDir: row.sessionDir });
      if (!dir) continue;
      try {
        const st = statSync(join(dir, 'state.json'));
        newestState = `${st.mtimeMs}:${st.size}`;
      } catch { newestState = '-'; }
    } catch { /* partial first line of the tail window, or a torn line */ }
  }
  return `${size}:${mtimeMs}:${newestState}`;
}

/** Main-agent wire log of a native Kimi session id (`session_<uuid>`). */
export function findKimiWireBySessionId(
  kimiSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isKimiSessionId(kimiSessionId)) return undefined;
  const home = kimiHome(env);
  const entries = readKimiSessionIndex(home);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.sessionId !== kimiSessionId) continue;
    const dir = containedSessionDir(home, entry);
    return dir ? kimiMainWirePath(dir) : undefined;
  }
  return undefined;
}

interface KimiSessionState { createdAt?: number; lastPrompt?: string }

function readSessionState(sessionDir: string): KimiSessionState | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(sessionDir, 'state.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw as KimiSessionState : undefined;
  } catch { return undefined; }
}


const SESSION_MARKER_RE = /<session_id>([^<\s]+)<\/session_id>/;

type MarkerVerdict = 'match' | 'foreign' | 'miss';

/** Does this Kimi session carry the botmux routing marker? Cheapest evidence
 *  first: `state.json.lastPrompt` (the latest prompt's head, where the routing
 *  envelope starts), then the head of the wire log, then the whole log. A
 *  lastPrompt that carries ANOTHER botmux session's marker is that session's
 *  conversation and is skipped without reading the log. */
function sessionMarkerVerdict(sessionDir: string, marker: string): MarkerVerdict {
  const lastPrompt = readSessionState(sessionDir)?.lastPrompt;
  if (typeof lastPrompt === 'string') {
    if (lastPrompt.includes(marker)) return 'match';
    if (SESSION_MARKER_RE.test(lastPrompt)) return 'foreign';
  }
  return wireMarkerVerdict(kimiMainWirePath(sessionDir), marker);
}

/** Logs known to lack a marker, keyed by log + marker, valued by the log's
 *  `size:mtime` when it was read. Turn boundaries and every streaming-card
 *  tick re-run the lookup (fresh), so a cwd full of large hand-typed sessions
 *  would otherwise be re-read in full each time. A log whose size and mtime
 *  are unchanged still lacks the marker; any write moves one of them and
 *  re-reads it. Matches are not kept: the lookup stops at the first one. */
const wireMarkerMisses = new Map<string, string>();
const WIRE_MARKER_MISS_CACHE_MAX = 256;

function wireMarkerVerdict(wire: string, marker: string): MarkerVerdict {
  let stamp: string;
  try {
    const st = statSync(wire);
    stamp = `${st.size}:${st.mtimeMs}`;
  } catch { return 'miss'; }
  const key = `${wire}\0${marker}`;
  if (wireMarkerMisses.get(key) === stamp) return 'miss';
  wireMarkerMisses.delete(key);
  if (scanWireForMarker(wire, marker)) return 'match';
  if (wireMarkerMisses.size >= WIRE_MARKER_MISS_CACHE_MAX) {
    const oldest = wireMarkerMisses.keys().next().value;
    if (oldest !== undefined) wireMarkerMisses.delete(oldest);
  }
  wireMarkerMisses.set(key, stamp);
  return 'miss';
}

/** The head of the log (where a botmux session's first prompt lands), then
 *  the whole log only when the head did not hold all of it. */
function scanWireForMarker(wire: string, marker: string): boolean {
  const head = readRange(wire, 0, WIRE_HEAD_PROBE_BYTES);
  if (head === undefined) return false;
  if (head.includes(marker)) return true;
  if (Buffer.byteLength(head, 'utf8') < WIRE_HEAD_PROBE_BYTES) return false;
  try { return readFileSync(wire, 'utf8').includes(marker); } catch { return false; }
}

/** Whose conversation a session's latest prompt belongs to, from state.json
 *  alone (a few hundred bytes; cheap enough to poll): `match` = this botmux
 *  session, `foreign` = another botmux session, `unknown` = no prompt yet or
 *  one typed without a routing envelope. */
export function kimiSessionPromptOwner(sessionDir: string, botmuxSessionId: string): 'match' | 'foreign' | 'unknown' {
  const lastPrompt = readSessionState(sessionDir)?.lastPrompt;
  if (typeof lastPrompt !== 'string') return 'unknown';
  if (lastPrompt.includes(`<session_id>${botmuxSessionId}</session_id>`)) return 'match';
  return SESSION_MARKER_RE.test(lastPrompt) ? 'foreign' : 'unknown';
}

export interface FindKimiWireOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Main-agent wire log of the newest Kimi session in `workingDir` whose log
 * carries `<session_id>{botmuxSessionId}</session_id>` (every botmux prompt's
 * routing envelope does). Mirrors findKimiSessionForBotmuxSession's
 * newest-first rule but avoids reading whole logs where cheaper evidence
 * decides; used where it runs repeatedly (usage refresh).
 */
export function findKimiWireForBotmuxSession(
  botmuxSessionId: string,
  workingDir: string | undefined,
  opts: FindKimiWireOptions = {},
): string | undefined {
  if (!botmuxSessionId) return undefined;
  const home = kimiHome(opts.env ?? process.env);
  const marker = `<session_id>${botmuxSessionId}</session_id>`;
  const entries = readKimiSessionIndex(home);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (workingDir && entry.workDir && !sameKimiWorkDir(entry.workDir, workingDir)) continue;
    const dir = containedSessionDir(home, entry);
    if (!dir) continue;
    if (sessionMarkerVerdict(dir, marker) === 'match') {
      return kimiMainWirePath(dir);
    }
  }
  return undefined;
}

/** `max_context_size` of `[models."<alias>"]` in Kimi's config.toml. */
export function readKimiModelContextWindow(
  modelAlias: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!modelAlias) return undefined;
  let text: string;
  try { text = readFileSync(join(kimiHome(env), 'config.toml'), 'utf8'); } catch { return undefined; }
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const header = /^\[\s*models\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
      inSection = !!header && (header[1] ?? header[2] ?? header[3]) === modelAlias;
      continue;
    }
    if (!inSection) continue;
    const m = /^max_context_size\s*=\s*([0-9_]+)\s*(?:#.*)?$/.exec(line);
    if (m) {
      const n = Number(m[1].replace(/_/g, ''));
      return Number.isFinite(n) && n > 0 ? n : undefined;
    }
  }
  return undefined;
}

// ─── Activity (CoT) extraction ─────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function stringifyArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try { return JSON.stringify(args); } catch { return ''; }
}

function toolOutputText(result: unknown): string {
  if (!result || typeof result !== 'object') return typeof result === 'string' ? result : '';
  const output = (result as { output?: unknown }).output;
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map(part => (part && typeof part === 'object' && typeof (part as any).text === 'string') ? (part as any).text : '')
      .filter(Boolean)
      .join('\n');
  }
  return stringifyArgs(output);
}

function toolSubject(args: unknown, display: unknown): string {
  const fromArgs = subjectFromInputObject(args);
  if (fromArgs) return fromArgs;
  if (display && typeof display === 'object') {
    const d = display as Record<string, unknown>;
    for (const key of ['command', 'path', 'query', 'url', 'description']) {
      if (typeof d[key] === 'string' && (d[key] as string).trim()) return d[key] as string;
    }
  }
  return '';
}

/** True for records that belong to the main agent (records written without an
 *  agentId — e.g. `agent.turn.ended` — are main-agent by file). */
export function isKimiMainAgentRecord(record: any): boolean {
  return !(typeof record?.agentId === 'string' && record.agentId !== KIMI_MAIN_AGENT_ID);
}

/**
 * Stateful converter from wire records to activity entries.
 *
 * Thinking parts and tool calls/results are emitted as they appear. A text
 * part is held until its step resolves: when the step goes on to call a tool
 * it is public narration and is emitted; when the step ends the turn it is
 * the closing answer, which is delivered by the normal reply path and would
 * otherwise appear twice on the card, so it is dropped (as are texts of
 * failed / interrupted steps).
 */
export class KimiActivityParser {
  private pendingText: string[] = [];

  push(record: any): CotEntry[] {
    if (!record || typeof record !== 'object' || !isKimiMainAgentRecord(record)) return [];
    switch (record.type) {
      case 'turn.prompt':
      case 'agent.turn.started':
      case 'agent.turn.ended':
      case 'turn.ended':
        this.pendingText = [];
        return [];
      case 'context.append_loop_event':
        return this.loopEvent(record.event);
      default:
        return [];
    }
  }

  private flushNarration(): CotEntry[] {
    const text = this.pendingText.join('').trim();
    this.pendingText = [];
    return text ? [{ kind: 'text', text }] : [];
  }

  private loopEvent(ev: any): CotEntry[] {
    if (!ev || typeof ev !== 'object') return [];
    switch (ev.type) {
      case 'content.part': {
        const part = ev.part;
        if (part?.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
          return [{ kind: 'thinking', text: part.think }];
        }
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          this.pendingText.push(part.text);
        }
        return [];
      }
      case 'tool.call': {
        if (typeof ev.toolCallId !== 'string' || !ev.toolCallId) return this.flushNarration();
        const subject = boundSubjectForTransport(toolSubject(ev.args, ev.display));
        return [
          ...this.flushNarration(),
          {
            kind: 'tool_call',
            id: ev.toolCallId,
            name: typeof ev.name === 'string' && ev.name ? ev.name : 'tool',
            args: truncate(stringifyArgs(ev.args), COT_TOOL_ARGS_MAX_CHARS),
            ...(subject ? { subject } : {}),
          },
        ];
      }
      case 'tool.result': {
        if (typeof ev.toolCallId !== 'string' || !ev.toolCallId) return [];
        return [{ kind: 'tool_result', id: ev.toolCallId, result: truncate(toolOutputText(ev.result), COT_TOOL_RESULT_MAX_CHARS) }];
      }
      case 'step.end':
        if (ev.finishReason === 'tool_use') return this.flushNarration();
        this.pendingText = [];
        return [];
      default:
        return [];
    }
  }
}
