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

import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, openSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs';
import {
  extractTurnStartText,
  isMeaningfulQueuedCommand,
  isMeaningfulUserEvent,
  isScheduledTurnStartEvent,
  type TranscriptEvent,
} from '../services/claude-transcript.js';

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
  body = body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…` : body;
}

/** 轮次起点与 bridge 归因队列 / 用量账本同一口径：真实用户输入、type-ahead 出队、
 *  内置定时任务触发。tool_result、isMeta、compact 摘要、sidechain、轮中吸收的排队
 *  消息都不是起点——它们随所在轮一起被删。 */
function isTurnStart(ev: TranscriptEvent): boolean {
  return isMeaningfulUserEvent(ev) || isMeaningfulQueuedCommand(ev) || isScheduledTurnStartEvent(ev);
}

function isCompactBoundary(ev: TranscriptEvent): boolean {
  return ev.type === 'system' && ev.subtype === 'compact_boundary';
}

/**
 * 扫描 transcript，返回最近 `limit` 个检查点（新的在前，index=1 为最近一轮）。
 * 流式读取，不把整个文件读进内存。
 */
export function scanClaudeTranscriptCheckpoints(path: string, limit = 20): RewindCheckpoint[] {
  const fd = openSync(path, 'r');
  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pending: Buffer = Buffer.alloc(0);
  let pendingStart = 0;
  const found: Omit<RewindCheckpoint, 'index' | 'beforeCompaction'>[] = [];
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

  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n <= 0) break;
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
  } finally {
    closeSync(fd);
  }

  const tail = found.slice(-Math.max(1, limit));
  return tail
    .map((c, i) => ({ ...c, index: tail.length - i, beforeCompaction: c.offset < lastCompactionOffset }))
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

export interface RewindResult {
  backupPath: string;
  removedBytes: number;
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
  } = {},
): RewindResult {
  const pre = lstatSync(path);
  if (!pre.isFile()) throw new Error(`refusing to rewind non-regular file ${path}`);
  opts.beforeOpen?.();
  const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
  try {
    // Pin the descriptor to the inode lstat inspected (regular-file swap TOCTOU).
    assertSameInode({ dev: pre.dev, ino: pre.ino }, fstatSync(fd), path);
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
 *  into the agent-readable backup. */
function copyBackupFromDescriptor(srcFd: number, backupPath: string, size: number): void {
  const dstFd = openSync(
    backupPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(dstFd).isFile()) {
      throw new Error(`refusing to write rewind backup to non-regular file ${backupPath}`);
    }
    const buf = Buffer.allocUnsafe(BACKUP_COPY_CHUNK_BYTES);
    let copied = 0;
    while (copied < size) {
      // Positional reads against the pinned descriptor — the pathname is
      // irrelevant from here on.
      const n = readSync(srcFd, buf, 0, Math.min(buf.length, size - copied), copied);
      if (n <= 0) throw new Error(`unexpected EOF while backing up transcript (${copied}/${size} bytes)`);
      let written = 0;
      while (written < n) {
        const w = writeSync(dstFd, buf, written, n - written);
        if (w <= 0) throw new Error('short write while creating rewind backup');
        written += w;
      }
      copied += n;
    }
    if (copied !== size) throw new Error(`rewind backup size mismatch (${copied}/${size} bytes)`);
    // The CLI is supposed to be dead; a growing source here means it is not.
    // Refuse rather than back up or cut a moving file.
    if (fstatSync(srcFd).size !== size) {
      throw new Error(`transcript changed size while creating backup ${backupPath}`);
    }
    if (fstatSync(dstFd).size !== size) {
      throw new Error(`rewind backup short write (${fstatSync(dstFd).size}/${size} bytes)`);
    }
  } catch (err) {
    try { unlinkSync(backupPath); } catch { /* may not have been created */ }
    throw err;
  } finally {
    closeSync(dstFd);
  }
}

function rewindOpenTranscript(
  fd: number,
  path: string,
  offset: number,
  now: number,
  opts: { beforeBackup?: () => void } = {},
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
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.rewind-${stamp}.bak`;
  opts.beforeBackup?.();
  copyBackupFromDescriptor(fd, backupPath, st.size);
  ftruncateSync(fd, offset);
  return { backupPath, removedBytes: st.size - offset };
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
