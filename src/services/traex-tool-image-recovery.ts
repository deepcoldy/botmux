/** TRAE can persist a tool image before uploading it. A failed upload then
 * poisons later requests, including text-only ones. This explicit repair drops
 * saved tool images, keeps user images/text/tool receipts, and resumes the same
 * native session. It is never an automatic retry of the failed tool. */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { PurgeReport, PurgeResumeTarget } from './transcript-image-purge.js';

export const TRAEX_TOOL_IMAGE_UPLOAD_ERROR_CODE = 'traex_tool_image_upload_failed';

/** Match the native error, not a quoted phrase in a tool result or prompt. */
export function isTraexToolImageUploadError(error: unknown): boolean {
  let value = error;
  for (let depth = 0; depth < 6; depth++) {
    if (typeof value === 'string') {
      if (value.length > 8_192) return false;
      const message = value;
      try { value = JSON.parse(message); } catch {
        return /^failed to resolve image resource:\s*tool image upload failed;\s*retry the request\s*$/i.test(message.trim());
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      value = record.error ?? record.message;
    } else return false;
  }
  return false;
}

export function resolveTraexImagePurgeTarget(path: string | undefined): PurgeResumeTarget | undefined {
  if (!path) return undefined;
  const match = /^rollout-.+-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/i.exec(basename(path));
  return match ? { jsonlPath: path, sessionId: match[1] } : undefined;
}

/** Only replayable tool output is changed. Event mirrors/history snapshots
 * may also contain tool-output records; user message image blocks stay intact. */
function replaceToolImages(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + replaceToolImages(entry), 0);
  const record = value as Record<string, unknown>;
  let removed = 0;
  if ((record.type === 'custom_tool_call_output' || record.type === 'function_call_output')
    && Array.isArray(record.output)) {
    record.output = record.output.map(block => {
      if (block && typeof block === 'object' && block.type === 'input_image') {
        removed++;
        return { type: 'input_text', text: '[tool image removed]' };
      }
      return block;
    });
  }
  for (const child of Object.values(record)) removed += replaceToolImages(child);
  return removed;
}

const BACKUP_INFIX = '.botmux-tool-images-bak-';
const MAX_READ_BYTES = 256 * 1024 * 1024;

/** Called only after the worker proves its CLI/process scope has exited.
 * Equal-sized, whitespace-padded lines retain all native batch byte offsets
 * and ordinals. Unknown/malformed records and growing lines fail closed. */
export function purgeTraexToolImages(target: PurgeResumeTarget, opts: {
  trustedSessionsRoot: string;
  dryRun?: boolean;
  maxReadBytes?: number;
}): PurgeReport {
  const file = target.jsonlPath;
  const report: PurgeReport = { files: [], removed: 0, imageBlocks: 0,
    unmeasurable: [], skippedSourceTypes: [], failedFiles: [], outOfScopeFiles: [] };
  let tmp: string | undefined;
  try {
    if (resolveTraexImagePurgeTarget(file)?.sessionId !== target.sessionId) throw new Error('native session mismatch');
    const root = resolve(opts.trustedSessionsRoot);
    const realRoot = realpathSync(root);
    const rel = relative(root, resolve(file));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== resolve(file)) {
      throw new Error('outside trusted sessions root');
    }
    const expectedReal = join(realRoot, rel);
    const checkPath = (): void => {
      if (realpathSync(root) !== realRoot || realpathSync(file) !== expectedReal || !lstatSync(file).isFile()) {
        throw new Error('transcript path changed or contains a symlink');
      }
    };
    checkPath();
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let raw: Buffer;
    let initial: ReturnType<typeof fstatSync>;
    try {
      initial = fstatSync(fd);
      if (!initial.isFile() || initial.size > (opts.maxReadBytes ?? MAX_READ_BYTES)) throw new Error('transcript exceeds repair read budget');
      raw = readFileSync(fd);
    } finally { closeSync(fd); }
    if (raw.length !== initial.size || (raw.length && raw[raw.length - 1] !== 10)) throw new Error('incomplete transcript');
    const repaired = Buffer.from(raw);
    let removed = 0;
    let matchedMeta = false;
    for (let start = 0; start < raw.length;) {
      const end = raw.indexOf(10, start);
      const entry = JSON.parse(raw.subarray(start, end).toString('utf8'));
      if (entry.type === 'session_meta') {
        if (entry.payload?.id !== target.sessionId) throw new Error('native session metadata mismatch');
        matchedMeta = true;
      }
      const count = replaceToolImages(entry.payload);
      if (count) {
        const encoded = Buffer.from(JSON.stringify(entry));
        if (encoded.length > end - start) throw new Error('repair would change native batch offsets');
        repaired.fill(32, start, end);
        encoded.copy(repaired, start);
        removed += count;
      }
      start = end + 1;
    }
    if (!matchedMeta) throw new Error('missing native session metadata');
    report.imageBlocks = removed;
    if (!removed) return report;
    if (opts.dryRun) {
      report.removed = removed;
      report.files.push({ file, removed });
      return report;
    }
    const writeExclusive = (path: string, data: Buffer): void => {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    };
    const backup = `${file}${BACKUP_INFIX}${Date.now()}-${randomBytes(6).toString('hex')}`;
    writeExclusive(backup, raw);
    tmp = `${file}.tmp-tool-images-${randomBytes(6).toString('hex')}`;
    writeExclusive(tmp, repaired);
    checkPath();
    const current = lstatSync(file);
    if (current.dev !== initial.dev || current.ino !== initial.ino || current.size !== initial.size
      || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs) {
      throw new Error('transcript changed while repairing');
    }
    renameSync(tmp, file);
    tmp = undefined;
    report.removed = removed;
    report.files.push({ file, removed, backup });
    // Retain the latest complete original, even when a prior repair failed.
    for (const name of readdirSync(dirname(file))) {
      const path = join(dirname(file), name);
      if (name.startsWith(`${basename(file)}${BACKUP_INFIX}`) && path !== backup) {
        try { if (lstatSync(path).isFile()) rmSync(path); } catch { /* backup retention is best effort */ }
      }
    }
  } catch (err) {
    report.failedFiles.push({ file, reason: err instanceof Error ? err.message : String(err) });
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
  return report;
}
