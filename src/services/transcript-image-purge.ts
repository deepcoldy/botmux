/**
 * Purge undersized images from a Claude Code transcript so the session can be
 * recovered with `claude --resume` instead of `/clear`.
 *
 * Why this exists: when the CLI reads an image file whose pixel dimensions are
 * below the model API minimum (observed: 1×1 placeholder PNGs), the image
 * block stays in the session jsonl and is replayed on every later request —
 * the API answers 400 forever, including for /compact and auto-continue. The
 * only in-CLI escape is /clear (loses context). Rewriting the transcript to
 * replace the offending blocks with text, then respawning with `--resume`,
 * keeps the full text history while removing the poison.
 *
 * Scope: the pinned session jsonl PLUS `<sid>/subagents/*.jsonl` next to it
 * (Task/Agent transcripts). The model-API 400 can only come from non-sidechain
 * records of the main transcript; the subagent scan is a cheap defence for
 * resume paths that replay sidechains, not a causal claim. Every rewritten
 * file keeps exactly one `.botmux-purge-bak-<ts>` backup (older ones are
 * pruned); writes are atomic (tmp + rename).
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** API-side floor quoted in the 400 ("Minimum allowed dimension: 14 pixels"). */
export const MIN_IMAGE_DIMENSION = 14;

/** Read budget shared by every file of one purge (main transcript first): the
 *  whole purge runs synchronously on the worker's event loop. */
const MAX_PURGE_BYTES = 256 * 1024 * 1024;

const BACKUP_INFIX = '.botmux-purge-bak-';

export interface PurgedFile {
  file: string;
  removed: number;
  backup?: string;
}

export interface UnmeasurableImage {
  file: string;
  /** 0-based position among the image blocks of `file`. Not the N of the API's
   *  `image data N` error: N counts image blocks in request-compile order across
   *  every record sent with that request (a future `requestIndex`). */
  fileIndex: number;
  mediaType?: string;
}

export interface PurgeReport {
  /** Files rewritten — or, for a dry run, files that would be rewritten. */
  files: PurgedFile[];
  removed: number;
  /** Image blocks seen across every scanned file, removed ones included. */
  imageBlocks: number;
  /** Base64 image blocks whose header we cannot decode; always kept. */
  unmeasurable: UnmeasurableImage[];
  /** Distinct `source.type` values of image blocks that are not base64. */
  skippedSourceTypes: string[];
  /** In-scope files that could not be read or rewritten. */
  failedFiles: Array<{ file: string; reason: string }>;
  /** Other transcripts under `<sid>/` the purge does not touch (logs only). */
  outOfScopeFiles: string[];
}

export interface PurgeResumeTarget {
  jsonlPath: string;
  sessionId: string;
}

/** Pick the transcript the bridge is actively following (it tracks /clear and
 * scratch views), falling back to the backend's launch-time path. */
export function resolvePurgeResumeTarget(
  activeBridgeJsonlPath: string | undefined,
  backendJsonlPath: string | undefined,
): PurgeResumeTarget | undefined {
  const jsonlPath = activeBridgeJsonlPath ?? backendJsonlPath;
  if (!jsonlPath) return undefined;
  const sessionId = basename(jsonlPath).replace(/\.jsonl$/i, '');
  if (!SESSION_SUBDIR_RE.test(sessionId)) return undefined;
  return { jsonlPath, sessionId };
}

interface ImageBlock {
  type: 'image';
  source: { type?: unknown; media_type?: unknown; data?: unknown };
}

interface Measured {
  width: number;
  height: number;
}

/** Decode pixel dimensions from an encoded image. Returns null for formats or
 *  buffers we cannot parse — an unparseable image must be left untouched
 *  (fail-safe: never delete an image the API might accept). */
export function measureImage(buf: Buffer): Measured | null {
  // PNG: signature, IHDR is the first chunk — width/height at bytes 16..23.
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50
    && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // GIF6/89a: logical screen descriptor width/height, LE u16 at 6/8.
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // JPEG: walk segment markers to the first SOFn frame.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 4 < buf.length) {
      if (buf[o] !== 0xff) { o += 1; continue; }
      const marker = buf[o + 1];
      o += 2;
      // SOF0..SOF15 excluding DHT(C4), DAC(CC), and standalone RSTn/D8/Dn.
      if (marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (o + 7 > buf.length) return null;
        return { height: buf.readUInt16BE(o + 3), width: buf.readUInt16BE(o + 5) };
      }
      if (o + 2 > buf.length) return null;
      const segLen = buf.readUInt16BE(o);
      if (segLen < 2) return null;
      o += segLen;
    }
    return null;
  }
  // WebP: RIFF .... WEBP, then VP8 / VP8L / VP8X.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP') {
    let o = 12;
    while (o + 8 <= buf.length) {
      const fourcc = buf.toString('ascii', o, o + 4);
      const size = buf.readUInt32LE(o + 4);
      const p = o + 8;
      if (fourcc === 'VP8X' && p + 10 <= buf.length) {
        // 24-bit (dimension - 1), little-endian.
        const w = 1 + buf.readUIntLE(p + 4, 3);
        const h = 1 + buf.readUIntLE(p + 7, 3);
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ' && p + 10 <= buf.length) {
        // Lossy: 3-byte frame tag, start code 9d 01 2a, then 14-bit w/h.
        if (buf[p + 3] === 0x9d && buf[p + 4] === 0x01 && buf[p + 5] === 0x2a) {
          return {
            width: buf.readUInt16LE(p + 6) & 0x3fff,
            height: buf.readUInt16LE(p + 8) & 0x3fff,
          };
        }
      }
      if (fourcc === 'VP8L' && p + 5 <= buf.length && buf[p] === 0x2f) {
        // Lossless: 14 bits (dim - 1) each, packed from byte 1.
        const bits = Number(buf.readUInt32LE(p + 1));
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      o = p + size + (size & 1);
    }
    return null;
  }
  return null;
}

function isImageBlock(v: unknown): v is ImageBlock {
  return !!v && typeof v === 'object'
    && (v as { type?: unknown }).type === 'image'
    && typeof (v as ImageBlock).source === 'object'
    && (v as ImageBlock).source !== null;
}

interface FileScan {
  imageBlocks: number;
  unmeasurable: Array<{ fileIndex: number; mediaType?: string }>;
  sourceTypes: Set<string>;
}

/** Replace undersized image blocks; otherwise recurse into containers.
 *  Mutates parsed JSON in place. Returns the number of replacements made. */
function sanitizeNode(node: unknown, minDimension: number, scan: FileScan): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const child = node[i];
      if (!isImageBlock(child)) {
        removed += sanitizeNode(child, minDimension, scan);
        continue;
      }
      const fileIndex = scan.imageBlocks;
      scan.imageBlocks += 1;
      if (child.source.type !== 'base64' || typeof child.source.data !== 'string') {
        scan.sourceTypes.add(typeof child.source.type === 'string' ? child.source.type : 'unknown');
        continue;
      }
      const mediaType = typeof child.source.media_type === 'string' ? child.source.media_type : undefined;
      const dims = measureImage(Buffer.from(child.source.data, 'base64'));
      if (!dims) {
        scan.unmeasurable.push({ fileIndex, ...(mediaType ? { mediaType } : {}) });
        continue;
      }
      if (dims.width < minDimension || dims.height < minDimension) {
        node[i] = {
          type: 'text',
          text: `[botmux: removed an undersized image (${dims.width}x${dims.height} px) `
            + `that the model API rejects; minimum allowed dimension is ${minDimension}px]`,
        };
        removed += 1;
      }
    }
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      removed += sanitizeNode(value, minDimension, scan);
    }
  }
  return removed;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
}

function writeExclusiveFile(stem: string, bytes: Buffer | string): string {
  for (let i = 0; ; i += 1) {
    const candidate = i === 0 ? stem : `${stem}-${i}`;
    let fd: number;
    try {
      // O_EXCL prevents a pre-planted name from being followed or overwritten.
      fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeFileSync(fd, bytes);
    } catch (err) {
      try { closeSync(fd); } finally { rmSync(candidate, { force: true }); }
      throw err;
    }
    closeSync(fd);
    return candidate;
  }
}

export function atomicReplaceTranscript(
  tmp: string,
  file: string,
  replace: (source: string, destination: string) => void = renameSync,
  beforeReplace?: () => void,
): void {
  try {
    beforeReplace?.();
    replace(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Keep only the newest backup of `file`: a backup holds the full transcript
 *  including the image bytes, so one per click would grow without bound. */
function pruneOlderBackups(file: string, keep: string): void {
  const dir = dirname(file);
  const prefix = `${basename(file)}${BACKUP_INFIX}`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const candidate = join(dir, name);
    if (!name.startsWith(prefix) || candidate === keep) continue;
    try {
      if (lstatSync(candidate).isFile()) unlinkSync(candidate);
    } catch { /* best effort */ }
  }
}

interface PurgeContext {
  minDimension: number;
  trustedRoot: string;
  dryRun: boolean;
  budgetBytes: number;
  remainingBytes: number;
  report: PurgeReport;
}

function purgeFile(file: string, ctx: PurgeContext): void {
  const { report } = ctx;
  let fd: number | undefined;
  let raw: Buffer;
  let initialStat: ReturnType<typeof fstatSync>;
  try {
    const realFile = realpathSync(file);
    if (realFile !== ctx.trustedRoot && !realFile.startsWith(`${ctx.trustedRoot}/`)) {
      report.failedFiles.push({ file, reason: 'outside trusted root' });
      return;
    }
    if (!lstatSync(file).isFile()) {
      report.failedFiles.push({ file, reason: 'not a regular file' });
      return;
    }
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    initialStat = fstatSync(fd);
    if (!initialStat.isFile()) {
      report.failedFiles.push({ file, reason: 'not a regular file' });
      return;
    }
    if (initialStat.size > ctx.remainingBytes) {
      report.failedFiles.push({ file, reason: `over the ${ctx.budgetBytes}-byte purge budget` });
      return;
    }
    raw = readFileSync(fd);
  } catch (err) {
    report.failedFiles.push({ file, reason: (err as NodeJS.ErrnoException).code ?? 'unreadable' });
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  ctx.remainingBytes -= raw.length;
  if (raw.length === 0) return;
  const trailingNewline = raw[raw.length - 1] === 0x0a;
  const lines = raw.toString('utf8').split('\n');
  // A trailing newline produces a phantom empty final element; keep it out of
  // the parse/join round-trip and restore it below instead.
  if (trailingNewline) lines.pop();
  const scan: FileScan = { imageBlocks: 0, unmeasurable: [], sourceTypes: new Set() };
  let removed = 0;
  const out: string[] = new Array(lines.length);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      out[i] = line;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out[i] = line;
      continue;
    }
    const n = sanitizeNode(parsed, ctx.minDimension, scan);
    if (n > 0) {
      removed += n;
      out[i] = JSON.stringify(parsed);
    } else {
      out[i] = line;
    }
  }
  report.imageBlocks += scan.imageBlocks;
  for (const entry of scan.unmeasurable) report.unmeasurable.push({ file, ...entry });
  for (const sourceType of scan.sourceTypes) {
    if (!report.skippedSourceTypes.includes(sourceType)) report.skippedSourceTypes.push(sourceType);
  }
  if (removed === 0) return;
  if (ctx.dryRun) {
    report.files.push({ file, removed });
    report.removed += removed;
    return;
  }
  let backup: string | undefined;
  try {
    backup = writeExclusiveFile(`${file}${BACKUP_INFIX}${timestamp()}`, raw);
    const tmp = writeExclusiveFile(
      `${file}.tmp-purge-${process.pid}-${randomBytes(6).toString('hex')}`,
      out.join('\n') + (trailingNewline ? '\n' : ''),
    );
    // The live transcript is never moved out of place. rename(2) replaces it in
    // one atomic step, so a crash before this point leaves the original visible
    // and a crash after it leaves the sanitized transcript visible.
    atomicReplaceTranscript(tmp, file, renameSync, () => {
      // Never replace a newer transcript snapshot: abort instead of silently
      // deleting records appended after the read above.
      const current = lstatSync(file);
      if (!current.isFile()
        || current.dev !== initialStat.dev
        || current.ino !== initialStat.ino
        || current.size !== initialStat.size
        || current.mtimeMs !== initialStat.mtimeMs) {
        throw new Error('transcript changed while purging');
      }
    });
  } catch (err) {
    if (backup) rmSync(backup, { force: true });
    report.failedFiles.push({ file, reason: err instanceof Error ? err.message : String(err) });
    return;
  }
  pruneOlderBackups(file, backup);
  report.files.push({ file, removed, backup });
  report.removed += removed;
}

/** Transcripts under `<sid>/` that the purge leaves alone, for diagnostics. */
function listOutOfScopeTranscripts(sessionDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (found.length >= 20) return;
      const path = join(dir, name);
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(path); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < 1 && name !== 'subagents') walk(path, depth + 1);
      } else if (st.isFile() && name.endsWith('.jsonl')) {
        found.push(path);
      }
    }
  };
  walk(sessionDir, 0);
  return found;
}

const SESSION_SUBDIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Purge the pinned session transcript and its Task/Agent subagent files.
 *  `dryRun` only reports what would be removed and writes nothing. */
export function purgeUndersizedImages(
  mainJsonlPath: string,
  opts: { minDimension?: number; trustedProjectsRoot?: string; dryRun?: boolean; maxReadBytes?: number } = {},
): PurgeReport {
  const report: PurgeReport = {
    files: [],
    removed: 0,
    imageBlocks: 0,
    unmeasurable: [],
    skippedSourceTypes: [],
    failedFiles: [],
    outOfScopeFiles: [],
  };
  let trustedRoot: string;
  try {
    trustedRoot = realpathSync(opts.trustedProjectsRoot ?? dirname(mainJsonlPath));
    const lexicalMain = resolve(mainJsonlPath);
    const lexicalRelative = relative(resolve(opts.trustedProjectsRoot ?? dirname(mainJsonlPath)), lexicalMain);
    const realMain = realpathSync(mainJsonlPath);
    if (lexicalRelative.startsWith('..') || lexicalRelative.includes('/../')
      || (realMain !== trustedRoot && !realMain.startsWith(`${trustedRoot}/`))) {
      report.failedFiles.push({ file: mainJsonlPath, reason: 'outside trusted root' });
      return report;
    }
  } catch (err) {
    report.failedFiles.push({ file: mainJsonlPath, reason: (err as NodeJS.ErrnoException).code ?? 'unreadable' });
    return report;
  }
  const ctx: PurgeContext = {
    minDimension: opts.minDimension ?? MIN_IMAGE_DIMENSION,
    trustedRoot,
    dryRun: opts.dryRun === true,
    budgetBytes: opts.maxReadBytes ?? MAX_PURGE_BYTES,
    remainingBytes: opts.maxReadBytes ?? MAX_PURGE_BYTES,
    report,
  };
  purgeFile(mainJsonlPath, ctx);
  // The model request is rebuilt from the main transcript; with that one
  // unreadable or unwritable, a subagent-only rewrite would read as success.
  if (report.failedFiles.length > 0) return report;

  // Layout: <projectsRoot>/<cwdHash>/<sid>.jsonl with subagents at
  // <projectsRoot>/<cwdHash>/<sid>/subagents/*.jsonl.
  const sid = basename(mainJsonlPath).replace(/\.jsonl$/i, '');
  if (!SESSION_SUBDIR_RE.test(sid)) return report;
  const sessionDir = join(dirname(mainJsonlPath), sid);
  const subDir = join(sessionDir, 'subagents');
  let entries: string[] = [];
  try {
    // Do not let a transcript-controlled/session-adjacent symlink redirect the
    // purge outside the pinned session tree.
    if (lstatSync(sessionDir).isDirectory()) {
      report.outOfScopeFiles = listOutOfScopeTranscripts(sessionDir);
      if (lstatSync(subDir).isDirectory()) entries = readdirSync(subDir);
    }
  } catch {
    return report;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    purgeFile(join(subDir, name), ctx);
  }
  return report;
}

/** One-line English summary for worker logs. */
export function describePurgeReport(report: PurgeReport): string {
  const parts = [`removed=${report.removed}`, `files=${report.files.length}`, `imageBlocks=${report.imageBlocks}`];
  if (report.unmeasurable.length > 0) {
    parts.push(`unmeasurable=${report.unmeasurable
      .map(entry => `${basename(entry.file)}#${entry.fileIndex}:${entry.mediaType ?? 'unknown'}`).join(',')}`);
  }
  if (report.skippedSourceTypes.length > 0) parts.push(`skippedSourceTypes=${report.skippedSourceTypes.join(',')}`);
  if (report.failedFiles.length > 0) {
    parts.push(`failedFiles=${report.failedFiles.map(entry => `${basename(entry.file)}(${entry.reason})`).join(',')}`);
  }
  if (report.outOfScopeFiles.length > 0) parts.push(`outOfScopeFiles=${report.outOfScopeFiles.join(',')}`);
  return parts.join(' ');
}
