/**
 * Reader for Pi agent's per-session JSONL transcript.
 *
 * Pi stores sessions under:
 *   ~/.pi/agent/sessions/<workspace-encoded>/<timestamp>_<sessionId>.jsonl
 *
 * For botmux wait-mode fallback we only care about:
 *   - user messages (`message.role === "user"`)
 *   - final assistant answers (`message.role === "assistant"` + `stopReason === "stop"`)
 *
 * Mid-turn assistant tool-use records are intentionally ignored so the worker
 * only emits the terminal answer, matching the Codex-family bridge contract.
 */
import { existsSync, statSync, openSync, readSync, closeSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const PI_SESSIONS_ROOT = join(homedir(), '.pi', 'agent', 'sessions');
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_LINUX = platform() === 'linux';

export interface PiBridgeEvent {
  uuid: string;
  timestampMs: number;
  kind: 'user' | 'assistant_final';
  text: string;
  sourceSessionId?: string;
}

export interface PiDrainResult {
  events: PiBridgeEvent[];
  newOffset: number;
  pendingTail: string;
}

function piSessionsDirForCwd(cwd: string): string {
  const normalized = cwd === '/' ? '--root--' : cwd.replace(/\//g, '--');
  return join(PI_SESSIONS_ROOT, normalized);
}

function piSessionIdFromPath(path: string): string | undefined {
  const m = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return m ? m[1] : undefined;
}

function matchPiTranscriptPath(target: string): { path: string; cliSessionId: string } | undefined {
  if (!target.endsWith('.jsonl')) return undefined;
  if (!target.includes('/.pi/agent/sessions/')) return undefined;
  const sid = piSessionIdFromPath(target);
  if (!sid) return undefined;
  return { path: target, cliSessionId: sid };
}

function joinTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if ((item as any).type === 'text' && typeof (item as any).text === 'string') {
      parts.push((item as any).text);
    }
  }
  return parts.join('\n').trim();
}

export function findPiTranscriptBySessionId(cliSessionId: string, cwd?: string): string | undefined {
  if (!cliSessionId || !SESSION_UUID_RE.test(cliSessionId)) return undefined;
  const suffix = `_${cliSessionId}.jsonl`;
  const roots = cwd ? [piSessionsDirForCwd(cwd), PI_SESSIONS_ROOT] : [PI_SESSIONS_ROOT];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack: string[] = [root];
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
  }
  return undefined;
}

export function findPiTranscriptByPid(pid: number): { path: string; cliSessionId: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        const hit = matchPiTranscriptPath(target);
        if (hit) return hit;
      }
      return undefined;
    }
  }
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
    const hit = matchPiTranscriptPath(target);
    if (hit) return hit;
  }
  return undefined;
}

export function drainPiTranscript(path: string, fromOffset: number): PiDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
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

  const sessionId = piSessionIdFromPath(path);
  const events: PiBridgeEvent[] = [];
  let cursor = start;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1;
      continue;
    }
    const lineStart = cursor;
    cursor += Buffer.byteLength(line, 'utf8') + 1;

    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.type !== 'message' || !obj.message || typeof obj.message !== 'object') continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const timestampMs = Number.isFinite(ts) ? ts : Date.now();
    const role = obj.message.role;

    if (role === 'user') {
      const content = joinTextContent(obj.message.content);
      if (!content) continue;
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'user',
        text: content,
        sourceSessionId: sessionId,
      });
      continue;
    }

    const stopReason =
      typeof obj.stopReason === 'string'
        ? obj.stopReason
        : typeof obj.message.stopReason === 'string'
          ? obj.message.stopReason
          : undefined;

    if (role === 'assistant' && stopReason === 'stop') {
      const content = joinTextContent(obj.message.content);
      if (!content) continue;
      events.push({
        uuid: `${path}:${lineStart}`,
        timestampMs,
        kind: 'assistant_final',
        text: content,
        sourceSessionId: sessionId,
      });
    }
  }

  return { events, newOffset, pendingTail };
}
