import { mkdtemp, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
export async function isResourceSizeLimitError(error: any): Promise<boolean> {
  const data = error?.response?.data;
  if (Number(data?.code ?? error?.code) === LARK_RESOURCE_SIZE_LIMIT_CODE) return true;
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
        if (bytes > 32 * 1024) return false;
        body += chunk.toString();
      }
    } catch { return false; }
    finally { clearTimeout(timer); data.destroy?.(); }
  }
  try { return Number(JSON.parse(body).code) === LARK_RESOURCE_SIZE_LIMIT_CODE; }
  catch { return false; }
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
): Promise<void> {
  let total = 0;
  // A one-byte probe avoids the ordinary endpoint's whole-file size limit.
  let probe: ResourceStream | undefined;
  try {
    probe = await request(0, 0);
    total = validateRange(probe, 0, 0);
  } finally { probe?.destroy(); }
  if (total > MAX_BYTES) throw new RangeDownloadError('Resource exceeds the 2 GiB download limit');

  const temporaryDir = await mkdtemp(join(dirname(savePath), '.botmux-download-'));
  const temporaryPath = join(temporaryDir, 'resource.part');
  try {
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      for (let offset = 0; offset < total;) {
        const end = Math.min(total - 1, offset + CHUNK_BYTES - 1);
        const expected = end - offset + 1;
        for (let attempt = 0;; attempt++) {
          let response: ResourceStream | undefined;
          try {
            response = await request(offset, end);
            validateRange(response, offset, end, total);
            let received = 0;
            for await (const chunk of response) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (received + buffer.length > expected) {
                throw new RangeDownloadError('Resource range body exceeds the requested size');
              }
              try {
                let written = 0;
                while (written < buffer.length) {
                  const result = await file.write(buffer, written, buffer.length - written, offset + received + written);
                  if (!result.bytesWritten) throw new Error('Zero-byte write');
                  written += result.bytesWritten;
                }
              } catch { throw new RangeDownloadError('Unable to write resource to disk'); }
              received += buffer.length;
            }
            if (received !== expected) throw new RangeDownloadError('Resource range body length mismatch');
            break;
          } catch (error) {
            response?.destroy();
            await file.truncate(offset);
            if (attempt >= 2 || !transient(error)) throw error;
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
          } finally { response?.destroy(); }
        }
        offset = end + 1;
      }
      if ((await file.stat()).size !== total) throw new RangeDownloadError('Resource final size mismatch');
    } finally { await file.close(); }
    await rename(temporaryPath, savePath);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}
