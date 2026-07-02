/**
 * Reader for CoCo's per-session events JSONL.
 *
 * CoCo (Rust, 用 `dirs` crate 选 cache dir) 的会话路径按平台分叉：
 *   Linux: ~/.cache/coco/sessions/<sessionId>/events.jsonl
 *   macOS: ~/Library/Caches/coco/sessions/<sessionId>/events.jsonl
 * Windows 这里不考虑（botmux 跟 tmux 强绑，跑不了 Windows）。
 *
 * The bridge fallback only needs the original user prompt and the final
 * assistant message. Those appear as event objects containing
 * `message.message.role === "user" | "assistant"`. CoCo also writes
 * additional user-shaped system reminders; we intentionally keep only
 * user messages whose `extra.is_original_user_input === true` so a Lark
 * turn fingerprints against the user's prompt, not injected context.
 */
import { existsSync, statSync, readdirSync, readlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';
import { cocoCacheRoot } from './coco-paths.js';
import { scanJsonlFromOffset } from './jsonl-cursor.js';
import { logger } from '../utils/logger.js';

const COCO_SESSIONS_ROOT = join(cocoCacheRoot(), 'sessions');
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IS_LINUX = platform() === 'linux';
// substring anchor —— 同时匹配 Linux 的 `/.cache/coco/sessions/` 和 macOS 的
// `/Library/Caches/coco/sessions/` 两种路径形态。anchor 后紧跟一段 UUID 才认
// 账（matchCocoSessionPath 里 SESSION_UUID_RE 校验），避免误命中。
const COCO_SESSIONS_ANCHOR = '/coco/sessions/';

export interface CocoBridgeEvent {
  /** Synthetic uuid for dedup: `<absPath>:<byteOffset>` of the line start. */
  uuid: string;
  /** Wall-clock ms parsed from `created_at`, falling back to Date.now(). */
  timestampMs: number;
  /** 'user' starts a pending Lark turn; 'assistant_final' closes it. */
  kind: 'user' | 'assistant_final';
  /** Message text. */
  text: string;
}

export interface CocoDrainResult {
  events: CocoBridgeEvent[];
  newOffset: number;
  pendingTail: string;
}

export function cocoEventsPathForSession(sessionId: string): string {
  return join(COCO_SESSIONS_ROOT, sessionId, 'events.jsonl');
}

/** Find which CoCo session a running CoCo process is bound to by scanning
 *  its open file handles. Unlike Codex (which keeps its rollout fd open
 *  continuously), CoCo opens-writes-closes `events.jsonl` per event, so we
 *  look for ANY open file under the session dir — `session.log` and
 *  `traces.jsonl` are held open for the session's lifetime and reveal the
 *  same `<sid>` segment.
 *
 *  Linux: `/proc/<pid>/fd` 快路径，procfs 会把 unlinked-but-open 的 fd 标
 *  ` (deleted)`，跳过它们以免读到失效 inode（曾被 e2e 清理触发）。
 *  macOS / BSD: `lsof -p <pid> -Fn` 兜底。macOS 上 lsof 不给 deleted 标记，
 *  但 worker 端在 `codexBridgeAttach` 之前还有 `existsSync(sessionDir)` 的
 *  二次校验，所以这里不会让一个失效 sid 跑死循环。 */
export function findCocoSessionByPid(
  pid: number,
): { sessionId: string; eventsPath: string } | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (IS_LINUX) {
    const fdDir = `/proc/${pid}/fd`;
    if (existsSync(fdDir)) {
      let entries: string[];
      try { entries = readdirSync(fdDir); } catch { return undefined; }
      for (const fd of entries) {
        let target: string;
        try { target = readlinkSync(join(fdDir, fd)); } catch { continue; }
        // procfs 标 deleted 的 fd 跳过 —— 后面 lsof 路径上没这个保护，因
        // 为 macOS lsof 不给标记；worker 端 sessionDir existsSync 兜底。
        if (target.endsWith(' (deleted)')) continue;
        const hit = matchCocoSessionPath(target);
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
    const hit = matchCocoSessionPath(target);
    if (hit) return hit;
  }
  return undefined;
}

function matchCocoSessionPath(target: string): { sessionId: string; eventsPath: string } | undefined {
  const idx = target.indexOf(COCO_SESSIONS_ANCHOR);
  if (idx < 0) return undefined;
  const sid = target.slice(idx + COCO_SESSIONS_ANCHOR.length).split('/')[0];
  if (!sid || !SESSION_UUID_RE.test(sid)) return undefined;
  return { sessionId: sid, eventsPath: cocoEventsPathForSession(sid) };
}

function messageText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

function parseCocoBridgeEvent(path: string, line: string, lineStart: number): CocoBridgeEvent | null {
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  const msg = obj?.message?.message;
  if (!msg || typeof msg !== 'object') return null;
  const ts = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
  const timestampMs = Number.isFinite(ts) ? ts : Date.now();

  if (msg.role === 'user') {
    if (msg.extra?.is_original_user_input !== true) return null;
    const content = messageText(msg.content);
    if (!content) return null;
    return { uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text: content };
  }
  if (msg.role === 'assistant') {
    // CoCo emits two assistant shapes per turn:
    //   - finish_reason:'tool_calls' — mid-turn "thinking out loud" before
    //     a tool call. Sometimes carries visible text (e.g. "Let me run
    //     the tests..."). Treating these as final would close the
    //     pending Lark turn early with mid-turn narration; the actual
    //     `stop` message that follows would then drop on the floor
    //     because the queue's collecting slot is already cleared.
    //   - finish_reason:'stop' — the model's terminal answer. This is
    //     what the bridge fallback should forward.
    // Only the latter becomes assistant_final; everything else is skipped.
    const finishReason = msg.response_meta?.finish_reason;
    if (finishReason !== 'stop') return null;
    const content = messageText(msg.content);
    if (!content) return null;
    return { uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text: content };
  }
  return null;
}

/** Increment-read a CoCo events.jsonl from `fromOffset`. */
export function drainCocoEvents(path: string, fromOffset: number): CocoDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: 0, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  let start = fromOffset;
  if (size < start) start = 0;
  if (size === start) return { events: [], newOffset: start, pendingTail: '' };

  const events: CocoBridgeEvent[] = [];
  const scanned = scanJsonlFromOffset(path, start, {
    endOffset: size,
    onLine: (line, lineStart) => {
      const event = parseCocoBridgeEvent(path, line, lineStart);
      if (event) events.push(event);
    },
    onError: (error) => {
      logger.warn(
        `[coco-transcript] failed to scan ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });
  if (!scanned) return { events: [], newOffset: start, pendingTail: '' };
  return { events, newOffset: scanned.newOffset, pendingTail: scanned.pendingTail };
}
