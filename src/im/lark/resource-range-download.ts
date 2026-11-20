import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { assertDownloadDirUnchanged, type DownloadDirGuard } from './client.js';
import type { Readable } from 'node:stream';

export const LARK_RESOURCE_SIZE_LIMIT_CODE = 234037;
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type ResourceStream = Readable & {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
};
export type ResourceRangeRequest = (start: number, end: number) => Promise<ResourceStream>;

class RangeDownloadError extends Error {}

/** SDK stream errors carry JSON in response.data, not response.data.code.
 * Read only a bounded error body; never serialize the SDK request/credentials. */
export async function getResourceErrorCode(error: any): Promise<number | undefined> {
  const data = error?.response?.data;
  const code = Number(data?.code ?? error?.code);
  if (Number.isFinite(code)) return code;
  let body = '';
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    body = data.toString().slice(0, 32 * 1024);
  } else if (data && typeof data[Symbol.asyncIterator] === 'function') {
    const timer = setTimeout(() => data.destroy?.(), 5_000);
    timer.unref();
    try {
      let bytes = 0;
      for await (const chunk of data) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 32 * 1024) return undefined;
        body += chunk.toString();
      }
    } catch { return undefined; }
    finally { clearTimeout(timer); data.destroy?.(); }
  }
  try {
    const parsedCode = Number(JSON.parse(body).code);
    return Number.isFinite(parsedCode) ? parsedCode : undefined;
  } catch { return undefined; }
}

export async function isResourceSizeLimitError(error: any): Promise<boolean> {
  return await getResourceErrorCode(error) === LARK_RESOURCE_SIZE_LIMIT_CODE;
}

function validateRange(stream: ResourceStream, start: number, end: number, total?: number): number {
  const header = stream.headers?.['content-range'];
  const match = typeof header === 'string' && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header);
  const size = match ? Number(match[3]) : NaN;
  if (stream.statusCode !== 206 || !match || Number(match[1]) !== start
    || Number(match[2]) !== end || !Number.isSafeInteger(size) || size <= end
    || (total !== undefined && size !== total)) {
    throw new RangeDownloadError('Resource download returned an invalid partial response / Content-Range');
  }
  return size;
}

function transient(error: any): boolean {
  if (error instanceof RangeDownloadError) return false;
  const status = error?.response?.status ?? error?.status ?? error?.statusCode;
  // No auth/permission/size retries. Only transport errors and transient HTTPs.
  return status === 429 || status >= 500 || (!status && error?.name !== 'UserTokenMissingError');
}

/** Retry at the same offset, stream to disk, and publish only a complete file.
 * The request callback retains its original app/user identity and API host. */
export async function downloadResourceWithRange(
  request: ResourceRangeRequest,
  savePath: string,
  guard?: DownloadDirGuard,
): Promise<void> {
  let total = 0;
  // The destination directory may be writable by a sandbox; the caller validated
  // it before any network wait and it must be the same directory when the file
  // lands (identity, and containment when confined).
  const dir = dirname(savePath);
  const dirBefore = lstatSync(dir);
  if (dirBefore.isSymbolicLink() || !dirBefore.isDirectory()) throw new RangeDownloadError(`Refusing to download into a non-directory: ${dir}`);
  const expected: DownloadDirGuard = guard ?? { dev: dirBefore.dev, ino: dirBefore.ino };
  const guardIntact = (): void => {
    try { assertDownloadDirUnchanged(dir, expected); } catch (e) { throw new RangeDownloadError((e as Error).message); }
  };
  guardIntact();
  // Open the staging file NOW, synchronously, in the directory just validated:
  // nothing may await between the check and the open, or the directory could be
  // swapped for a symlink meanwhile and the staging file created elsewhere.
  // The open descriptor then keeps writing into that directory whatever the
  // path resolves to later; the rename at the end is re-guarded.
  const temporaryPath = `${savePath}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
  const fd = openSync(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let renamed = false;
  try {
    // A one-byte probe avoids the ordinary endpoint's whole-file size limit.
    // Intentionally fail fast here: data retries start only after range metadata is validated.
    let probe: ResourceStream | undefined;
    try {
      probe = await request(0, 0);
      total = validateRange(probe, 0, 0);
    } finally { probe?.destroy(); }
    if (total > MAX_BYTES) throw new RangeDownloadError('Resource exceeds the 2 GiB download limit');

    for (let offset = 0; offset < total;) {
      const end = Math.min(total - 1, offset + CHUNK_BYTES - 1);
      const want = end - offset + 1;
      for (let attempt = 0;; attempt++) {
        let response: ResourceStream | undefined;
        try {
          response = await request(offset, end);
          validateRange(response, offset, end, total);
          let received = 0;
          for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (received + buffer.length > want) {
              throw new RangeDownloadError('Resource range body exceeds the requested size');
            }
            try {
              let written = 0;
              while (written < buffer.length) {
                const n = writeSync(fd, buffer, written, buffer.length - written, offset + received + written);
                if (!n) throw new Error('Zero-byte write');
                written += n;
              }
            } catch { throw new RangeDownloadError('Unable to write resource to disk'); }
            received += buffer.length;
          }
          if (received !== want) throw new RangeDownloadError('Resource range body length mismatch');
          break;
        } catch (error) {
          response?.destroy();
          // Defensive rollback: each retry overwrites the full range, but discard any
          // partial tail first so the temporary file contains only completed ranges.
          ftruncateSync(fd, offset);
          if (attempt >= 2 || !transient(error)) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
        } finally { response?.destroy(); }
      }
      offset = end + 1;
    }
    if (fstatSync(fd).size !== total) throw new RangeDownloadError('Resource final size mismatch');
    closeSync(fd);
    guardIntact();
    renameSync(temporaryPath, savePath);
    renamed = true;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    // Only touch the staging path while it still resolves into the validated
    // directory; otherwise leave it (it sits in the sandbox's own directory).
    if (!renamed) {
      try { assertDownloadDirUnchanged(dir, expected); unlinkSync(temporaryPath); } catch { /* */ }
    }
  }
}
