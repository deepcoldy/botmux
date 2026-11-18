/**
 * 会话上下文回退（/rewind）的纯逻辑层。
 *
 * 只处理 Claude Code 的 append-only transcript（`<dataDir>/projects/<hash>/<id>.jsonl`）：
 * 按「真实用户轮次」切检查点，把文件截断到某一轮的起点，使下一次 `--resume` 读到的
 * 上下文正好是被回退后的样子。调用方负责先停掉 CLI 进程、再调用本模块，并自行做
 * 权限 / 空闲 / 远端后端等业务判定。
 *
 * 为什么不用 Claude 自带的 `--resume-session-at <uuid>`：它只在 `-p` 非交互模式下生效
 * （CLI 文案原话 "Ignored outside print mode"），botmux 跑的是交互 TUI。
 * 为什么不用 `--fork-session`：群上下文的「已送达」记录按原生 session id 分代
 * （groupContextEpoch），换新 id 会让整段群历史——包括想丢掉的那条——重新注入。
 */

import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, readlinkSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  extractTurnStartText,
  isMeaningfulQueuedCommand,
  isMeaningfulUserEvent,
  isScheduledTurnStartEvent,
  isSyntheticNoModelReplyEvent,
  isTranscriptRateLimitEvent,
  type TranscriptEvent,
} from '../services/claude-transcript.js';
import { stripBotmuxDisplayBlocks } from '../utils/prompt-display-strip.js';
import { rewindBackupSuffix } from './rewind-backup-retention.js';

export interface RewindCheckpoint {
  /** 1 = 最近一轮；仅在一次扫描结果内稳定。 */
  index: number;
  /** 该轮首条记录在 transcript 中的字节偏移（回退目标）。 */
  offset: number;
  /** transcript 记录里的 ISO 时间戳（若有）。 */
  at?: string;
  /** 该轮用户消息的短摘要。 */
  preview: string;
  /** transcript 记录的 uuid（若有）。确认执行时用它校验目标没有漂移。 */
  uuid?: string;
  /** 该轮在最近一次 compact 之前：它的内容已被压进摘要，截断会把摘要连同压缩
   *  一起丢掉、让 resume 读回压缩前的全量历史。这种检查点只展示、不允许回退。 */
  beforeCompaction: boolean;
  /** 截断后保留的前缀里还有 user/assistant 记录。第一轮之前只剩 mode/permission-mode
   *  等元数据行，`claude --resume` 对这种文件直接报 "No conversation found"，worker
   *  随后降级成新会话（换原生 id ⟹ 群上下文换代、整段背景重新注入），正好违背回退的
   *  目的。这种检查点不允许回退。 */
  resumable: boolean;
  /** 回退到这一轮会删掉的字节数，按本次扫描从同一个文件描述符读到的内容计。 */
  removedBytes: number;
}

/** 会话记录所在的、会话里的 CLI 可写的那棵树（见 transcript-resolver 的
 *  writableTreeRoot）。给出时，打开之后还要证明打开的就是树里那个文件。 */
export interface TranscriptTreeScope {
  writableTreeRoot?: string;
  /** 截断前的备份放在这里，而不是 transcript 旁边。给了 writableTreeRoot 时必填：
   *  那棵树里不再创建任何文件，备份只进会话 CLI 写不到的目录。 */
  backupDir?: string;
}

const CHUNK_BYTES = 1 << 20;
const BACKUP_COPY_CHUNK_BYTES = 1 << 20;
const PREVIEW_CHARS = 60;

/** `/rewind` 列表展示、也唯一接受的序号范围（新的在前，1 = 最近一轮）。
 *  confirm 时另有更深的内部重扫，用来在序号漂移后按身份找回预览的轮次。 */
export const REWIND_CHECKPOINT_LIMIT = 10;

/** 从一条 `<user_message>` / `<botmux_*>` 注入口袋里剥出人真正说的话。 */
export function summarizeUserText(text: string): string {
  let body = text;
  const m = /<user_message>([\s\S]*?)<\/user_message>/i.exec(body);
  if (m) body = m[1] ?? '';
  body = stripBotmuxDisplayBlocks(body)
    // bare（transcript + solo）续轮没有 <user_message> 壳；上面整块剥掉追加
    // 在用户正文后的 <botmux_formatting>（含块体），再清掉其余残留标签，
    // 否则内部提示会混进预览文案。
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
}

/** 轮次起点与 bridge 归因队列 / 用量账本同一口径：真实用户输入、type-ahead 出队、
 *  内置定时任务触发。tool_result、isMeta、compact 摘要、sidechain、轮中吸收的排队
 *  消息都不是起点——它们随所在轮一起被删。 */
function isTurnStart(ev: TranscriptEvent): boolean {
  // Top-level user records only: Claude Code ≥ 2.1.31x also writes
  // `api-request-blob` records whose `message.role` is "user" (a copy of the
  // request body); the role-based predicates alone would take one for a turn.
  return (ev.type === 'user' && (isMeaningfulUserEvent(ev) || isScheduledTurnStartEvent(ev)))
    || isMeaningfulQueuedCommand(ev);
}

function isCompactBoundary(ev: TranscriptEvent): boolean {
  return ev.type === 'system' && ev.subtype === 'compact_boundary';
}

/**
 * 证明描述符 `fd` 就是 `path` 在 `root` 之下、一路没有经过链接所指的那个文件。
 * O_NOFOLLOW 只管路径最后一段，所以要在打开之后、读写之前核对实际打开的对象：
 * 有 /proc 时由内核给出它的位置，必须正好是「root 的真实位置 + 路径的后缀」；
 * 没有时逐级 lstat，root 之下每一级都得是目录本身、末级是普通文件且与 fd 同 inode。
 */
export function assertOpenedInsideTree(
  fd: number,
  path: string,
  root: string,
  openedPath: (fd: number) => string = descriptor => readlinkSync(`/proc/self/fd/${descriptor}`),
): void {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing to use ${path}: not under ${root}`);
  }
  let opened: string | undefined;
  try { opened = openedPath(fd); } catch { opened = undefined; }
  if (opened !== undefined) {
    if (opened !== join(realpathSync(root), rel)) {
      throw new Error(`refusing to use ${path}: the opened file is not the one under ${root}`);
    }
    return;
  }
  const parts = rel.split(sep);
  let current = resolve(root);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]!);
    const st = lstatSync(current);
    const leaf = i === parts.length - 1;
    if (leaf ? !st.isFile() : !st.isDirectory()) {
      throw new Error(`refusing to use ${path}: ${current} is not a ${leaf ? 'regular file' : 'directory'}`);
    }
    if (leaf) assertSameInode(st, fstatSync(fd), path);
  }
}

/**
 * 打开 transcript：不跟随链接、不在 FIFO 上阻塞，打开后从描述符确认是普通文件，
 * 路径经过 CLI 可写的树时再确认打开的就是树里那个文件。之后的读取、大小和截断都只
 * 经这个描述符，不再按路径另开。
 */
function openTranscript(path: string, scope: TranscriptTreeScope, access: number): number {
  const fd = openSync(path, access | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`refusing to read non-regular file ${path}`);
    if (scope.writableTreeRoot) assertOpenedInsideTree(fd, path, scope.writableTreeRoot);
    return fd;
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/**
 * 扫描 transcript，返回最近 `limit` 个检查点（新的在前，index=1 为最近一轮）。
 * 流式读取，不把整个文件读进内存。
 */
export function scanClaudeTranscriptCheckpoints(path: string, limit = 20, scope: TranscriptTreeScope = {}): RewindCheckpoint[] {
  const fd = openTranscript(path, scope, fsConstants.O_RDONLY);
  try {
    return scanDescriptor(fd, limit);
  } finally {
    closeSync(fd);
  }
}

/** 一个打开着的 transcript：扫描和截断都经同一个描述符，截断的一定是扫描读的那个文件。 */
export interface OpenTranscript {
  scan(limit?: number): RewindCheckpoint[];
  /** The last turn, read from the held descriptor (see {@link inspectLastClaudeTurn}). */
  lastTurn(limit?: number): LastTurnInspection;
  cut(offset: number, now?: number, opts?: { backup?: 'full' | 'removed' }): RewindResult;
}

/** 打开 transcript（读写，规则同 {@link scanClaudeTranscriptCheckpoints}），在 `use`
 *  返回前一直持有这个描述符。按扫描结果算出的偏移只在这个描述符上截断：路径在两步
 *  之间被换成别的文件也碰不到它，inode 号也不会在持有期间被别的文件复用。 */
export function withOpenTranscript<T>(path: string, scope: TranscriptTreeScope, use: (transcript: OpenTranscript) => T): T {
  const fd = openTranscript(path, scope, fsConstants.O_RDWR);
  try {
    return use({
      scan: (limit = 20) => scanDescriptor(fd, limit),
      lastTurn: (limit = LAST_TURN_SCAN_LIMIT_BYTES) => lastTurnOfDescriptor(fd, limit),
      cut: (offset, now = Date.now(), opts = {}) => {
        // The backup is created next to the path: it must still name the
        // file held here (held open, its inode cannot have been reused).
        assertSameInode(lstatSync(path), fstatSync(fd), path);
        return rewindOpenTranscript(fd, path, offset, now, { ...scope, ...opts });
      },
    });
  } finally {
    closeSync(fd);
  }
}

function scanDescriptor(fd: number, limit: number): RewindCheckpoint[] {
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending: Buffer = Buffer.alloc(0);
  let pendingStart = 0;
  const found: Omit<RewindCheckpoint, 'index' | 'beforeCompaction' | 'removedBytes'>[] = [];
  let lastCompactionOffset = -1;
  let sawConversation = false;

  const handleLine = (line: Buffer, offset: number) => {
    // Fail-CLOSED conversation gate. The substring match is only a cheap
    // prefilter: a nested record such as
    // `{"type":"attachment",...,"attachment":{"type":"assistant"}}` contains
    // the same bytes without being a top-level assistant record. Flipping on
    // the substring alone would mark a pre-conversation prefix as resumable,
    // allowing a rewind that leaves only metadata rows — `claude --resume`
    // then answers "No conversation found" and the worker mints a fresh native
    // id, which re-injects the entire group context (the failure this command
    // exists to avoid). Only a parsed top-level `assistant` record counts.
    if (!sawConversation && line.includes('"type":"assistant"')) {
      try {
        const early: unknown = JSON.parse(line.toString('utf8'));
        if (early && typeof early === 'object' && (early as TranscriptEvent).type === 'assistant') {
          sawConversation = true;
        }
      } catch {
        // Malformed line: leave the gate false — offering one checkpoint too
        // few is safe; offering a non-resumable one is not.
      }
    }
    // Cheap gate: most lines are assistant/tool records.
    if (!line.includes('"type":"user"') && !line.includes('"type":"attachment"')
      && !line.includes('compact_boundary')) return;
    let ev: TranscriptEvent;
    try {
      const parsed: unknown = JSON.parse(line.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      ev = parsed as TranscriptEvent;
    } catch {
      return;
    }
    if (isCompactBoundary(ev)) {
      lastCompactionOffset = offset;
      return;
    }
    const resumable = sawConversation;
    if (ev.type === 'user' || ev.type === 'assistant') sawConversation = true;
    if (!isTurnStart(ev)) return;
    // Empty preview = no text; the caller renders a localized placeholder.
    const preview = summarizeUserText(extractTurnStartText(ev));
    found.push({
      offset,
      resumable,
      ...(typeof ev.timestamp === 'string' ? { at: ev.timestamp } : {}),
      ...(typeof ev.uuid === 'string' ? { uuid: ev.uuid } : {}),
      preview,
    });
  };

  let readPos = 0;
  {
    for (;;) {
      // Positional: a descriptor shared with a later cut keeps no file offset.
      const n = readSync(fd, buf, 0, CHUNK_BYTES, readPos);
      if (n <= 0) break;
      readPos += n;
      const chunk = buf.subarray(0, n);
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const base = pendingStart;
      let pos = 0;
      for (;;) {
        const nl = data.indexOf(10, pos);
        if (nl < 0) break;
        handleLine(data.subarray(pos, nl), base + pos);
        pos = nl + 1;
      }
      pending = Buffer.from(data.subarray(pos));
      pendingStart = base + pos;
    }
    // A trailing line without '\n' is a write in progress, not a checkpoint.
  }

  // Everything read, including a trailing partial line: that is what a cut at
  // any checkpoint would remove right now.
  const scannedBytes = pendingStart + pending.length;
  const tail = found.slice(-Math.max(1, limit));
  return tail
    .map((c, i) => ({
      ...c,
      index: tail.length - i,
      beforeCompaction: c.offset < lastCompactionOffset,
      removedBytes: scannedBytes - c.offset,
    }))
    .reverse();
}

/** 确认执行时重扫，按 uuid（无 uuid 时按偏移 + 预览）找回预览时选中的那一轮。
 *  预览与确认之间若来了新的一轮，序号会整体后移；按身份找可以避免删错轮。 */
export function findCheckpoint(
  checkpoints: readonly RewindCheckpoint[],
  target: Pick<RewindCheckpoint, 'offset' | 'preview' | 'uuid'>,
): RewindCheckpoint | undefined {
  return checkpoints.find(cp => (target.uuid
    ? cp.uuid === target.uuid
    : cp.offset === target.offset && cp.preview === target.preview));
}

/** What the transcript's last turn amounts to, read from its end. */
export type LastTurnOutcome =
  /** Only API-error records (or the no-model-reply placeholder) answered it:
   *  no tool call, no text — a turn that failed without doing anything. */
  | 'error_only'
  /** It called a tool or answered with text. */
  | 'progress'
  /** Anything this module must not cut around: an interrupt, a slash command,
   *  a queued input folded into the turn, a compaction, a rate limit, a write
   *  still in progress, an unreadable line, or a turn too long to read back. */
  | 'other'
  /** No turn start at all. */
  | 'no_turn';

export interface LastTurnInspection {
  outcome: LastTurnOutcome;
  /** Byte offset of the last turn's start record: where a cut would land. */
  offset?: number;
  uuid?: string;
  /** The turn's input as Claude recorded it. */
  text?: string;
  /** A user/assistant record precedes the turn, so the cut file still
   *  resumes (see {@link RewindCheckpoint.resumable}). */
  resumable?: boolean;
}

/** A file named by device and inode (the transcript a cut cut). */
export interface FileIdentity {
  dev: number;
  ino: number;
}

const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

/** Upper bound on bytes read back from the end of the transcript. A failed
 *  turn is a few records; anything longer did work and is not a candidate. */
const LAST_TURN_SCAN_LIMIT_BYTES = 8 << 20;

/** Meta user record Claude Code writes before resuming a turn cut mid-flight. */
const RESUME_NUDGE = 'Continue from where you left off.';

/** Attachments that carry input of their own (a queued prompt, a file the
 *  user edited), as opposed to per-turn context. */
const CONTENT_ATTACHMENT_RE = /queued_command|edited_/;

/** Complete lines of `fd`, last first, with their byte offsets. Stops once
 *  `limit` bytes were read (the caller then sees the generator end early and
 *  treats the region as unread). */
function* linesFromEnd(fd: number, size: number, limit: number): Generator<{ line: Buffer; offset: number }, boolean> {
  let pos = size;
  let pending: Buffer = Buffer.alloc(0);
  let read = 0;
  while (pos > 0) {
    if (read >= limit) return false;
    const n = Math.min(CHUNK_BYTES, pos);
    pos -= n;
    const chunk = Buffer.allocUnsafe(n);
    let got = 0;
    while (got < n) {
      const r = readSync(fd, chunk, got, n - got, pos + got);
      if (r <= 0) throw new Error(`unexpected EOF reading ${n} bytes at ${pos}`);
      got += r;
    }
    read += n;
    const data = pending.length > 0 ? Buffer.concat([chunk, pending]) : chunk;
    let end = data.length;
    for (let nl = data.lastIndexOf(10, end - 1); nl >= 0; nl = end > 0 ? data.lastIndexOf(10, end - 1) : -1) {
      if (nl + 1 < end) yield { line: data.subarray(nl + 1, end), offset: pos + nl + 1 };
      end = nl;
    }
    pending = Buffer.from(data.subarray(0, end));
  }
  if (pending.length > 0) yield { line: pending, offset: 0 };
  return true;
}

/** An assistant record that did something: called a tool or wrote text.
 *  Thinking alone is not progress. Unknown block types count as progress, so
 *  a shape this module does not know never makes a turn look empty. */
function assistantMadeProgress(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block: any) => {
    if (!block || typeof block !== 'object') return false;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return false;
    if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0;
    return true;
  });
}

function isTopLevelConversationLine(line: Buffer): boolean {
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return false;
  try {
    const ev: unknown = JSON.parse(line.toString('utf8'));
    const type = ev && typeof ev === 'object' ? (ev as TranscriptEvent).type : undefined;
    return type === 'user' || type === 'assistant';
  } catch {
    return false;
  }
}

/**
 * Read the transcript's LAST turn back from the end of the file: where it
 * starts, what its input was, and whether anything but API errors answered it.
 * Only the tail is read, so it stays cheap on a transcript of hundreds of MB.
 *
 * Fail-closed: every record this does not positively recognise as error-only
 * bookkeeping makes the outcome `progress` or `other`, never `error_only`.
 */
export function inspectLastClaudeTurn(
  path: string,
  limit = LAST_TURN_SCAN_LIMIT_BYTES,
  scope: TranscriptTreeScope = {},
): LastTurnInspection {
  // What is read here can reach the CLI (the cut turn's write-edge blocks):
  // opened like every transcript read here (no link, no FIFO, inside the
  // CLI-writable tree when there is one).
  const fd = openTranscript(path, scope, fsConstants.O_RDONLY);
  try {
    return lastTurnOfDescriptor(fd, limit);
  } finally {
    closeSync(fd);
  }
}

function lastTurnOfDescriptor(fd: number, limit: number): LastTurnInspection {
  const size = fstatSync(fd).size;
  if (size === 0) return { outcome: 'no_turn' };
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  // A trailing line without '\n' is a write in progress.
  if (last[0] !== 10) return { outcome: 'other' };
  let errors = 0;
  let start: { ev: TranscriptEvent; offset: number } | undefined;
  let readToFileStart = false;
  const lines = linesFromEnd(fd, size, limit);
  for (let next = lines.next(); ; next = lines.next()) {
    if (next.done) {
      readToFileStart = next.value;
      break;
    }
    const { line, offset } = next.value;
    let ev: TranscriptEvent;
    try {
      const parsed: unknown = JSON.parse(line.toString('utf8'));
      if (!parsed || typeof parsed !== 'object') return { outcome: 'other' };
      ev = parsed as TranscriptEvent;
    } catch {
      return { outcome: 'other' };
    }
    if (isCompactBoundary(ev)) return { outcome: 'other' };
    if (isTurnStart(ev)) {
      start = { ev, offset };
      break;
    }
    // A subagent's record belongs to a Task tool call of this turn.
    if ((ev as any).isSidechain === true) return { outcome: 'progress' };
    if (ev.type === 'assistant') {
      if (ev.isApiErrorMessage === true) {
        // Rate limits have their own handling; a cancelled request is a stop.
        if (isTranscriptRateLimitEvent(ev) || String(ev.error ?? '').toLowerCase().includes('cancel')) {
          return { outcome: 'other' };
        }
        errors += 1;
        continue;
      }
      if (isSyntheticNoModelReplyEvent(ev)) {
        errors += 1;
        continue;
      }
      if (assistantMadeProgress(ev.message?.content)) return { outcome: 'progress' };
      continue;
    }
    if (ev.type === 'user') {
      // The nudge Claude Code writes when it resumes a turn cut mid-flight
      // (before its no-model-reply placeholder) belongs to the turn. Any
      // other meta record carries something of its own — a peer session's
      // message, a subagent's hand-back — that a cut would lose.
      if ((ev as any).isMeta === true && extractTurnStartText(ev).trim() === RESUME_NUDGE) continue;
      const content = ev.message?.content;
      if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) {
        return { outcome: 'progress' };
      }
      // An interrupt, a slash command's records, a compaction summary.
      return { outcome: 'other' };
    }
    // An input folded into this turn has no record of its own, and a note
    // that the user edited a file is not written again: cutting the turn
    // would lose them. The other attachments are context Claude Code
    // derives afresh for the next turn (hook context, date, skill listing…).
    if (ev.type === 'attachment' && CONTENT_ATTACHMENT_RE.test(String((ev as any).attachment?.type ?? ''))) {
      return { outcome: 'other' };
    }
    // system (turn_duration, retry notices), attachments, snapshots, request
    // metadata: bookkeeping, not output.
  }
  if (!start) return { outcome: readToFileStart && errors === 0 ? 'no_turn' : 'other' };
  let resumable = false;
  for (let next = lines.next(); !next.done; next = lines.next()) {
    if (isTopLevelConversationLine(next.value.line)) {
      resumable = true;
      break;
    }
  }
  return {
    outcome: errors > 0 ? 'error_only' : 'other',
    offset: start.offset,
    ...(typeof start.ev.uuid === 'string' ? { uuid: start.ev.uuid } : {}),
    text: extractTurnStartText(start.ev),
    resumable,
  };
}

export interface RewindResult {
  backupPath: string;
  removedBytes: number;
  /** The transcript that was cut: the only file
   *  {@link restoreRewoundTranscript} writes the bytes back to. */
  transcript: FileIdentity;
  /** `backup: 'removed'` only: the bytes cut, as read from the pinned
   *  descriptor. A restore puts back these — never what is in the backup file
   *  by then, which sits in a directory the sandboxed CLI can write. */
  removed?: Buffer;
}

/**
 * 把 transcript 截断到 `offset`（某轮起点）。先复制一份完整备份，再原地截断；
 * 拒绝非行首偏移，避免把半行留在文件里导致 `--resume` 解析失败。
 *
 * 沙盒会话的 transcript 在 agent 可写的 BOT_HOME 下：拒绝符号链接（不跟随截断），
 * 备份目标用 O_EXCL|O_NOFOLLOW 创建（目标已存在——包括 agent 预埋的同名链接——就
 * 失败，不写穿）。备份内容只从已经 lstat + O_NOFOLLOW 钉住的源描述符读取：路径在
 * 打开之后被换成软链（unlink + symlink）也只会截断/备份原 inode，绝不沿路径重新
 * 打开去读链接目标。
 */
/** 打开后的 inode 必须就是 lstat 看到的那个。O_NOFOLLOW 只挡得住「换成软链」
 *  （open 直接失败），挡不住路径在两步之间被换成**另一个普通文件**——那同样会
 *  通过校验并截断一个无关文件。dev+ino 任一不符即拒绝。 */
export function assertSameInode(
  expected: { dev: number; ino: number },
  actual: { dev: number; ino: number },
  path: string,
): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`refusing to rewind: ${path} was replaced between validation and open`);
  }
}

export function rewindClaudeTranscript(
  path: string,
  offset: number,
  now: number = Date.now(),
  opts: {
    /** Test seam: runs after lstat validated the pathname but BEFORE it is
     *  opened. Reproduces the lstat→open race window. */
    beforeOpen?: () => void;
    /** Test seam: runs after the source descriptor was validated and opened
     *  but before the backup is read from it. Lets the symlink-swap regression
     *  replace the pathname deterministically mid-operation. */
    beforeBackup?: () => void;
    /** Test seam: runs after the backup was written, before the transcript is
     *  cut. Lets a test take the backup away in that window. */
    beforeCut?: () => void;
    /** `removed` keeps only the bytes being cut (`<path>.rewind-<stamp>.removed.bak`).
     *  An automatic rewind of one failed turn runs on every failure: copying a
     *  transcript of hundreds of MB each time is not affordable, and the part
     *  that stays needs no backup. Default `full` (the /rewind command). */
    backup?: 'full' | 'removed';
  } & TranscriptTreeScope = {},
): RewindResult {
  const pre = lstatSync(path);
  if (!pre.isFile()) throw new Error(`refusing to rewind non-regular file ${path}`);
  opts.beforeOpen?.();
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    // Pin the descriptor to the inode lstat inspected (regular-file swap TOCTOU).
    assertSameInode({ dev: pre.dev, ino: pre.ino }, fstatSync(fd), path);
    if (opts.writableTreeRoot) assertOpenedInsideTree(fd, path, opts.writableTreeRoot);
    return rewindOpenTranscript(fd, path, offset, now, opts);
  } finally {
    closeSync(fd);
  }
}

/** Copy `size` bytes from the ALREADY-VALIDATED source descriptor into a new
 *  O_EXCL|O_NOFOLLOW regular file. Never reopens the source by path: under the
 *  agent-writable sandbox data dir the pathname can be swapped to a symlink
 *  between validation and use, and a path-based copy would then read whatever
 *  the link points at (host data the daemon can read but the sandbox cannot)
 *  into the agent-readable backup. The backup's descriptor is returned open:
 *  the caller closes it once the cut is done, so its inode number cannot be
 *  handed to another file meanwhile (see {@link cutWhileBackupHeld}). */
function copyBackupFromDescriptor(
  srcFd: number, backupPath: string, size: number, from = 0, keep = false, backupDir?: string,
): { fd: number; removed?: Buffer } {
  const create = () => openSync(
    backupPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let dstFd: number;
  try {
    dstFd = create();
  } catch (err) {
    // The retention sweep removes an empty backup directory left unchanged
    // for days (rewind-backup-retention.ts): it may have gone between the
    // caller creating it and this. Made anew, its fresh mtime keeps it.
    if (!backupDir || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    dstFd = create();
  }
  try {
    if (!fstatSync(dstFd).isFile()) {
      throw new Error(`refusing to write rewind backup to non-regular file ${backupPath}`);
    }
    const buf = Buffer.allocUnsafe(BACKUP_COPY_CHUNK_BYTES);
    const total = size - from;
    const kept: Buffer[] = [];
    let copied = 0;
    while (copied < total) {
      // Positional reads against the pinned descriptor — the pathname is
      // irrelevant from here on.
      const n = readSync(srcFd, buf, 0, Math.min(buf.length, total - copied), from + copied);
      if (n <= 0) throw new Error(`unexpected EOF while backing up transcript (${copied}/${total} bytes)`);
      let written = 0;
      while (written < n) {
        const w = writeSync(dstFd, buf, written, n - written);
        if (w <= 0) throw new Error('short write while creating rewind backup');
        written += w;
      }
      if (keep) kept.push(Buffer.from(buf.subarray(0, n)));
      copied += n;
    }
    if (copied !== total) throw new Error(`rewind backup size mismatch (${copied}/${total} bytes)`);
    // The CLI is supposed to be dead; a growing source here means it is not.
    // Refuse rather than back up or cut a moving file.
    if (fstatSync(srcFd).size !== size) {
      throw new Error(`transcript changed size while creating backup ${backupPath}`);
    }
    if (fstatSync(dstFd).size !== total) {
      throw new Error(`rewind backup short write (${fstatSync(dstFd).size}/${total} bytes)`);
    }
    return { fd: dstFd, ...(keep ? { removed: Buffer.concat(kept, total) } : {}) };
  } catch (err) {
    try { closeSync(dstFd); } catch { /* best effort */ }
    try { unlinkSync(backupPath); } catch { /* may not have been created */ }
    throw err;
  }
}

/** Cut the transcript only while `backupPath` still names the backup just
 *  written: backups are pruned now (rewind-backup-retention.ts), and a cut
 *  must never land with its backup gone, or with another file under the name
 *  the caller will report. Closes the backup's descriptor either way; a
 *  backup found gone or replaced is left as it is. */
function cutWhileBackupHeld(fd: number, offset: number, backupFd: number, backupPath: string, beforeCut?: () => void): void {
  try {
    beforeCut?.();
    // Held open, the backup's inode number cannot have gone to another file.
    const held = fstatSync(backupFd);
    let named;
    try { named = lstatSync(backupPath); } catch { named = undefined; }
    if (!named?.isFile() || !sameFile(named, held)) {
      throw new Error(`rewind backup ${backupPath} went away before the cut; transcript left as it was`);
    }
    ftruncateSync(fd, offset);
  } finally {
    closeSync(backupFd);
  }
}

function rewindOpenTranscript(
  fd: number,
  path: string,
  offset: number,
  now: number,
  opts: { beforeBackup?: () => void; beforeCut?: () => void; backup?: 'full' | 'removed' } & TranscriptTreeScope = {},
): RewindResult {
  const st = fstatSync(fd);
  if (!Number.isInteger(offset) || offset <= 0 || offset > st.size) {
    throw new Error(`invalid rewind offset ${offset} (file size ${st.size})`);
  }
  if (offset < st.size) {
    const byte = Buffer.alloc(1);
    readSync(fd, byte, 0, 1, offset - 1);
    if (byte[0] !== 10) throw new Error(`rewind offset ${offset} is not at a line boundary`);
  }
  // A tree the session's CLI can write to gets no file from here: neither a
  // check before creating it nor a cleanup after can keep a path in such a
  // tree pointing where it pointed.
  if (opts.writableTreeRoot && !opts.backupDir) {
    throw new Error(`refusing to rewind ${path}: no backup directory outside the CLI-writable tree`);
  }
  const removedOnly = opts.backup === 'removed';
  // Named so the retention sweep recognises it (rewind-backup-retention.ts).
  const backupSuffix = rewindBackupSuffix(now, removedOnly ? 'removed' : 'full');
  const backupPath = opts.backupDir ? join(opts.backupDir, `${basename(path)}${backupSuffix}`) : `${path}${backupSuffix}`;
  opts.beforeBackup?.();
  const backup = copyBackupFromDescriptor(fd, backupPath, st.size, removedOnly ? offset : 0, removedOnly, opts.backupDir);
  cutWhileBackupHeld(fd, offset, backup.fd, backupPath, opts.beforeCut);
  const removed = backup.removed;
  return {
    backupPath,
    removedBytes: st.size - offset,
    transcript: { dev: st.dev, ino: st.ino },
    ...(removed ? { removed } : {}),
  };
}

/** Most bytes of records a CLI may append after a cut and still allow it to be
 *  undone (a few metadata lines; a conversation would be far bigger). */
const RESTORE_TAIL_LIMIT_BYTES = 1 << 20;

/** Records outside the conversation tree: no uuid of their own, not a
 *  message. Claude Code writes `cost-state` when it exits, even a resumed CLI
 *  that never got an input (2.1.326). */
function isMetadataLine(record: Record<string, unknown>): boolean {
  return record.type !== 'user' && record.type !== 'assistant' && record.type !== 'system'
    && record.type !== 'attachment' && record.uuid === undefined && record.parentUuid === undefined;
}

/** What Claude Code records for a local slash command (a bot's startup
 *  command such as `/effort high`): a caveat, the command, its output — user
 *  records with no model turn behind them (2.1.326), the output also as a
 *  `system` / `local_command` record (earlier builds). */
const LOCAL_COMMAND_RECORD_RE = /^<(?:local-command-caveat|command-name|local-command-stdout|local-command-stderr)>/;
const LOCAL_COMMAND_OUTPUT_RE = /^<(?:local-command-stdout|local-command-stderr)>/;
function isLocalCommandRecord(record: Record<string, unknown>): boolean {
  if (record.type === 'system') {
    return record.subtype === 'local_command' && typeof record.content === 'string'
      && LOCAL_COMMAND_OUTPUT_RE.test(record.content.trimStart());
  }
  if (record.type !== 'user') return false;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) && content.length === 1 && (content[0] as { type?: unknown })?.type === 'text'
      ? String((content[0] as { text?: unknown }).text ?? '') : undefined;
  return text !== undefined && LOCAL_COMMAND_RECORD_RE.test(text.trimStart());
}

/** A record a CLI may have written after a cut that still lets the cut turn
 *  go back as the conversation's latest turn. */
function mayFollowRestoredTurn(line: string): boolean {
  try {
    const ev: unknown = JSON.parse(line);
    if (!ev || typeof ev !== 'object') return false;
    const record = ev as Record<string, unknown>;
    return isMetadataLine(record) || isLocalCommandRecord(record);
  } catch {
    return false;
  }
}

/**
 * Undo a cut made with `backup: 'removed'`: put the removed bytes back — the
 * ones the cut read (`RewindResult.removed`), not the backup file's. What
 * the CLI appended since may only be metadata outside the conversation and
 * local slash commands (see {@link mayFollowRestoredTurn}). The removed bytes
 * are appended after them, never written back in place: the turn's first
 * record still names its old parent, and a resumed Claude Code (2.1.326)
 * continues from the last record in the file — so the conversation runs
 * through the restored turn again, the commands left on a side branch (a
 * resumed CLI runs its startup commands anew anyway). Appending also means a
 * write cut short (the worker dies) leaves a partial last line, never bytes
 * interleaved with the ones before. Anything else after the cut — a model
 * turn, a partial line, the turn already put back — means the transcript
 * moved on and nothing is changed. Same descriptor discipline as the cut
 * itself. Returns whether the transcript holds the cut turn again.
 */
export function restoreRewoundTranscript(
  path: string,
  cut: { offset: number; transcript: FileIdentity; removed: Buffer },
  scope: TranscriptTreeScope = {},
): boolean {
  // The transcript sits in a directory the sandboxed CLI can write: opened the
  // way every transcript read here is (no link, no FIFO, inside that tree),
  // it must still be the inode the cut cut. The bytes come from the cut
  // itself; a cut always removes some (it starts at a turn).
  if (cut.removed.length === 0) return false;
  const pre = lstatSync(path);
  if (!pre.isFile()) return false;
  const fd = openTranscript(path, scope, fsConstants.O_RDWR);
  try {
    const st = fstatSync(fd);
    if (!sameFile(pre, st) || !sameFile(cut.transcript, st)) return false;
    const size = st.size;
    if (size < cut.offset || size - cut.offset > RESTORE_TAIL_LIMIT_BYTES) return false;
    const tail = Buffer.alloc(size - cut.offset);
    if (tail.length > 0 && readSync(fd, tail, 0, tail.length, cut.offset) !== tail.length) return false;
    // Whole lines only: the text after the last newline must be empty.
    const lines = tail.toString('utf8').split('\n');
    if (lines.pop() !== '' || !lines.every(mayFollowRestoredTurn)) return false;
    let written = 0;
    while (written < cut.removed.length) {
      const w = writeSync(fd, cut.removed, written, cut.removed.length - written, size + written);
      if (w <= 0) throw new Error('short write while restoring a rewound transcript');
      written += w;
    }
    return fstatSync(fd).size === size + cut.removed.length;
  } finally {
    closeSync(fd);
  }
}

/**
 * 等 transcript 停止增长：连续 `quietMs` 内大小不变才算 CLI 真的不再写。
 * suspend/kill 是异步退出的，worker 退出后 Claude 还可能 flush 最后一行；
 * 在它还在写的时候截断，会让晚到的半行接在截断点后面。超时返回 false，调用方拒绝回退。
 */
export async function waitForTranscriptQuiet(
  path: string,
  opts: { quietMs?: number; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const quietMs = opts.quietMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pollMs = opts.pollMs ?? 100;
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let lastSize = statSync(path).size;
  let stableFor = 0;
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    const size = statSync(path).size;
    if (size === lastSize) {
      stableFor += pollMs;
      if (stableFor >= quietMs) return true;
    } else {
      lastSize = size;
      stableFor = 0;
    }
  }
  return false;
}
