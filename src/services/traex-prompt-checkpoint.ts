/** A native transcript boundary frozen BEFORE input is written. A checkpoint
 * is useful only if its prefix is intact and its entire suffix proves one
 * failed request with no assistant output, tools, compaction or newer input. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { assertOpenedInsideTree, withOpenTranscript, type LastTurnInspection, type TranscriptTreeScope } from '../core/context-rewind.js';
import type { FailedTurnTranscript } from '../core/failed-turn-rewind.js';
import { matchRecordedInput } from '../core/failed-turn-rewind.js';
import { resolveTraexImagePurgeTarget } from './traex-tool-image-recovery.js';

export interface TraexPromptCheckpoint {
  sessionId: string;
  offset: number;
  prefixHash: string;
}
const MAX_BYTES = 64 * 1024 * 1024;
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function rows(bytes: Buffer): any[] {
  if (!bytes.length || bytes.at(-1) !== 10) throw new Error('incomplete transcript');
  return bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
}
function identity(bytes: Buffer, sessionId: string): void {
  const meta = rows(bytes).filter(row => row.type === 'session_meta');
  if (meta.length !== 1 || meta[0].payload?.id !== sessionId) throw new Error('native session mismatch');
}
function read(path: string, root: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    assertOpenedInsideTree(fd, path, root);
    const size = fstatSync(fd).size;
    if (size > MAX_BYTES) throw new Error('transcript exceeds read budget');
    const bytes = readFileSync(fd);
    if (bytes.length !== size) throw new Error('transcript changed during read');
    return bytes;
  } finally { closeSync(fd); }
}
export function captureTraexPromptCheckpoint(path: string | undefined, root: string): TraexPromptCheckpoint | undefined {
  if (!path) return;
  try {
    const target = resolveTraexImagePurgeTarget(path);
    if (!target) return;
    const bytes = read(path, root);
    identity(bytes, target.sessionId);
    return { sessionId: target.sessionId, offset: bytes.length, prefixHash: hash(bytes) };
  } catch { return; }
}
export function inspectTraexPromptCheckpoint(bytes: Buffer, checkpoint: TraexPromptCheckpoint, input: string): LastTurnInspection {
  const refuse = (): LastTurnInspection => ({ outcome: 'other' });
  try {
    if (!Number.isSafeInteger(checkpoint.offset) || checkpoint.offset <= 0 || checkpoint.offset >= bytes.length
      || bytes[checkpoint.offset - 1] !== 10 || !/^[a-f0-9]{64}$/.test(checkpoint.prefixHash)) return refuse();
    const prefix = bytes.subarray(0, checkpoint.offset);
    identity(prefix, checkpoint.sessionId);
    if (hash(prefix) !== checkpoint.prefixHash) return refuse();
    let user: string | undefined;
    let mirror: string | undefined;
    let failed = false;
    for (const row of rows(bytes.subarray(checkpoint.offset))) {
      if (failed) return refuse();
      const p = row.payload;
      if (row.type === 'response_item' && p?.type === 'message' && p.role === 'user') {
        if (user !== undefined || !Array.isArray(p.content)
          || p.content.some((b: any) => b.type !== 'input_text' && b.type !== 'input_image')) return refuse();
        user = p.content.filter((b: any) => b.type === 'input_text').map((b: any) => b.text).join('');
        if (!matchRecordedInput(user!, input)) return refuse();
      } else if (row.type === 'event_msg' && p?.type === 'user_message') {
        if (mirror !== undefined || !matchRecordedInput(p.message ?? '', input)) return refuse();
        mirror = p.message;
      } else if (row.type === 'event_msg' && p?.type === 'error') {
        // The ordered task_complete, rather than an error during an unfinished
        // request, must prove this request has ended.
      } else if (row.type === 'event_msg' && p?.type === 'task_complete') {
        if (failed || !p.error || p.last_agent_message) return refuse();
        failed = true;
      } else if (row.type === 'event_msg' && ['task_started', 'turn_started', 'token_count'].includes(p?.type)) {
        // Metadata carries no work. Unknown records fail closed.
      } else if (row.type === 'turn_context') {
        // Native per-request configuration, never conversation history.
      } else return refuse();
    }
    const written = user ?? mirror;
    if (written === undefined || !failed) return refuse();
    return { outcome: 'error_only', resumable: true, offset: checkpoint.offset, text: written, uuid: hash(bytes) };
  } catch { return refuse(); }
}
export function inspectTraexFailedPrompt(path: string, root: string, checkpoint: TraexPromptCheckpoint, input: string): LastTurnInspection {
  if (resolveTraexImagePurgeTarget(path)?.sessionId !== checkpoint.sessionId) return { outcome: 'other' };
  return inspectTraexPromptCheckpoint(read(path, root), checkpoint, input);
}
export function withTraexFailedPrompt<T>(path: string, root: string, scope: TranscriptTreeScope,
  checkpoint: TraexPromptCheckpoint, input: string, use: (transcript: FailedTurnTranscript) => T): T {
  if (resolveTraexImagePurgeTarget(path)?.sessionId !== checkpoint.sessionId) throw new Error('native session mismatch');
  return withOpenTranscript(path, { ...scope, writableTreeRoot: root }, transcript => use({
    lastTurn: () => inspectTraexPromptCheckpoint(transcript.read(MAX_BYTES), checkpoint, input),
    cut: offset => transcript.cut(offset, Date.now(), { backup: 'removed' }),
  }));
}
