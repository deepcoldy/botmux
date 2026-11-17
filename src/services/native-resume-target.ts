import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

/** Host management requests an explicit, already prepared history copy. The
 * host does not convert provider data or accept a caller-controlled file path.
 * The owning worker resolves both IDs under its own native data root. */
export interface NativeResumeTarget {
  sourceId: string;
  targetId: string;
  sourceSha256: string;
  targetSha256: string;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const fields = ['sourceId', 'targetId', 'sourceSha256', 'targetSha256'];
const publicFailures = new Set([
  'invalid_native_resume_target', 'native_resume_target_unavailable', 'native_resume_target_not_idle',
  'native_resume_history_missing', 'native_resume_history_outside_root', 'native_resume_history_size',
  'native_resume_history_changed', 'native_resume_history_incomplete', 'native_resume_history_encoding',
  'native_resume_history_identity', 'native_resume_history_format', 'native_resume_history_not_terminal',
  'native_resume_history_lineage', 'native_resume_source_changed', 'native_resume_target_superseded',
]);

/** Never return filesystem paths, JSON excerpts or arbitrary exception text. */
export function nativeResumeTargetFailure(error: unknown): string {
  return error instanceof Error && publicFailures.has(error.message)
    ? error.message : 'native_resume_target_unavailable';
}

export function parseNativeResumeTarget(value: unknown): NativeResumeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_native_resume_target');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k))
    || fields.some(k => typeof v[k] !== 'string')
    || !uuid.test(String(v.sourceId ?? '')) || !uuid.test(String(v.targetId ?? ''))
    || String(v.sourceId).toLowerCase() === String(v.targetId).toLowerCase()
    || !hash.test(String(v.sourceSha256 ?? '')) || !hash.test(String(v.targetSha256 ?? ''))) {
    throw new Error('invalid_native_resume_target');
  }
  return { sourceId: v.sourceId as string, targetId: v.targetId as string,
    sourceSha256: v.sourceSha256 as string, targetSha256: v.targetSha256 as string };
}

function readOwned(root: string, path: string | undefined): Buffer {
  if (!path || !isAbsolute(root) || !isAbsolute(path)) throw new Error('native_resume_history_missing');
  const canonicalRoot = realpathSync(root), canonical = realpathSync(path);
  const part = relative(canonicalRoot, canonical);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) {
    throw new Error('native_resume_history_outside_root');
  }
  const fd = openSync(canonical, 'r');
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 64 * 1024 * 1024) throw new Error('native_resume_history_size');
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size
      || realpathSync(path) !== canonical) throw new Error('native_resume_history_changed');
    return bytes;
  } finally { closeSync(fd); }
}

function inspect(bytes: Buffer, id: string): { sourceId?: string; visible: boolean } {
  if (!bytes.length || bytes.at(-1) !== 10) throw new Error('native_resume_history_incomplete');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('native_resume_history_encoding');
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line) as {
    type?: string; timestamp?: string; payload?: Record<string, unknown>;
  });
  const header = rows[0];
  if (header?.type !== 'session_meta' || header.payload?.id !== id
    || header.payload.history_format !== 'canonical_v1') throw new Error('native_resume_history_identity');
  let mutation = -1, terminal = -1, visible = false, activeTurn: string | undefined;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (['response_item', 'compacted'].includes(row.type ?? '')) throw new Error('native_resume_history_format');
    if (row.type === 'history_mutation') {
      const p = row.payload;
      if (p?.version !== 1 || !['append', 'replace'].includes(String(p.operation)) || !Array.isArray(p.items)) {
        throw new Error('native_resume_history_format');
      }
      mutation = i;
      visible = p.operation === 'replace' ? p.items.length > 0 : visible || p.items.length > 0;
    }
    if (row.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(String(row.payload?.type))) {
      const turnId = row.payload?.turn_id;
      if (typeof turnId !== 'string' || !turnId.trim() || !Number.isFinite(Date.parse(row.timestamp ?? ''))) {
        throw new Error('native_resume_history_not_terminal');
      }
      if (row.payload?.type === 'task_started') { activeTurn = turnId; terminal = -1; }
      else if (!activeTurn || activeTurn === turnId) { terminal = i; activeTurn = undefined; }
    }
  }
  if (!visible || mutation < 0 || activeTurn || terminal <= mutation) throw new Error('native_resume_history_not_terminal');
  return { sourceId: typeof header.payload.forked_from_id === 'string' ? header.payload.forked_from_id : undefined, visible };
}

/** Re-run immediately before retirement, then after proven process quiescence.
 * No model call, original write, inferred provider conversion, or fresh-start
 * fallback is permitted here. The management caller owns copy semantics. */
export function verifyNativeResumeTarget(
  request: NativeResumeTarget,
  paths: { root: string; source: string | undefined; target: string | undefined },
): void {
  const value = parseNativeResumeTarget(request);
  const source = readOwned(paths.root, paths.source), target = readOwned(paths.root, paths.target);
  const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  if (sha(source) !== value.sourceSha256 || sha(target) !== value.targetSha256) {
    throw new Error('native_resume_history_changed');
  }
  inspect(source, value.sourceId);
  const copied = inspect(target, value.targetId);
  if (copied.sourceId !== value.sourceId) throw new Error('native_resume_history_lineage');
}
