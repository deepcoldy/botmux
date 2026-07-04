/**
 * Content-addressed blob writer for OutputRef-shaped fields.
 *
 * Used by run-init (params), runtime (prompts / outputs), and host
 * executors to persist payloads too large for the inline envelope cap.
 * The hash is over canonical bytes — caller is responsible for handing
 * us already-serialized content; we don't second-guess the format.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import { canonicalJsonStringify } from './definition.js';
import type { EventLog } from './events/append.js';
import type { OutputRef } from './events/payloads.js';

export type WriteBlobOptions = {
  contentType?: string;
  schemaVersion?: number;
};

/**
 * Write a buffer as a content-addressed blob and return the `OutputRef`
 * to embed in event payloads.  Idempotent: identical bytes produce the
 * same path; we just overwrite (same content, same result).
 */
export async function writeBlob(
  log: EventLog,
  buf: Buffer,
  opts: WriteBlobOptions = {},
): Promise<OutputRef> {
  const hash = createHash('sha256').update(buf).digest('hex');
  const path = join(log.blobDir, hash);
  // 原子写：路径即 sha256，裸写半截会留下「名字对、内容错」的 blob。
  await atomicWriteFile(path, buf);
  return {
    outputHash: `sha256:${hash}`,
    outputPath: path,
    outputBytes: buf.length,
    outputSchemaVersion: opts.schemaVersion ?? 1,
    contentType: opts.contentType ?? 'application/octet-stream',
  };
}

/**
 * Canonical-JSON variant: sorts keys recursively so semantically equal
 * inputs hash to identical blob paths.  Use this any time the hash will
 * be compared across runs / retries (e.g. idempotency-key derivation).
 */
export async function writeJsonBlob(
  log: EventLog,
  value: unknown,
  opts: WriteBlobOptions = {},
): Promise<OutputRef> {
  const buf = Buffer.from(canonicalJsonStringify(value), 'utf-8');
  return writeBlob(log, buf, { contentType: 'application/json', ...opts });
}
