/** Durable, ordered transcript byte ranges followed by one BotMux session's
 * Claude process. Background tasks survive /clear, and /resume may revisit an
 * earlier file, so a unique path list is insufficient: each visit is a segment.
 * Paths are accepted only after the worker actually switches its bridge to
 * them; pid/fd discovery candidates never enter this file. */
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';

export interface BackgroundTranscriptSegment {
  path: string;
  fromOffset: number;
  /** End of this visit. The last/current visit is open-ended until rotation. */
  toOffset?: number;
}

interface BackgroundTranscriptChainFile {
  version: 1 | 2;
  paths?: string[];
  segments?: BackgroundTranscriptSegment[];
}

export function normalizeBackgroundTranscriptPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function normalizeBackgroundTranscriptSegments(
  segments: readonly BackgroundTranscriptSegment[],
): BackgroundTranscriptSegment[] {
  const out: BackgroundTranscriptSegment[] = [];
  for (const segment of segments) {
    if (!segment || typeof segment.path !== 'string' || !segment.path
      || !Number.isSafeInteger(segment.fromOffset) || segment.fromOffset < 0
      || (segment.toOffset !== undefined
        && (!Number.isSafeInteger(segment.toOffset) || segment.toOffset < segment.fromOffset))) continue;
    const normalized: BackgroundTranscriptSegment = {
      path: normalizeBackgroundTranscriptPath(segment.path),
      fromOffset: segment.fromOffset,
      ...(segment.toOffset !== undefined ? { toOffset: segment.toOffset } : {}),
    };
    const previous = out.at(-1);
    if (previous && previous.path === normalized.path
      && previous.fromOffset === normalized.fromOffset && previous.toOffset === normalized.toOffset) continue;
    out.push(normalized);
  }
  return out;
}

export function readBackgroundTranscriptChain(path: string): BackgroundTranscriptSegment[] {
  const parsed = readJsonFileSoft<BackgroundTranscriptChainFile | null>(path, {
    fallback: () => null,
    validate: (value): value is BackgroundTranscriptChainFile =>
      isJsonObject(value) && (value.version === 1 || value.version === 2),
    label: 'background-transcript-chain',
  });
  if (!parsed) return [];
  const segments = parsed.version === 1
    ? (Array.isArray(parsed.paths) ? parsed.paths : []).map(path => ({ path, fromOffset: 0 }))
    : Array.isArray(parsed.segments) ? parsed.segments : [];
  return normalizeBackgroundTranscriptSegments(segments);
}

export function writeBackgroundTranscriptChain(path: string, segments: readonly BackgroundTranscriptSegment[]): void {
  const payload: BackgroundTranscriptChainFile = {
    version: 2,
    segments: normalizeBackgroundTranscriptSegments(segments),
  };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(payload)}\n`, { mode: 0o600, followTargetSymlink: false });
}
