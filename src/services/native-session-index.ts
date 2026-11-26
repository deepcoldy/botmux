import { closeSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Codex-family CLIs record a native rename as one appended line of
 * `<home>/session_index.jsonl` — `{"id","thread_name","updated_at"}` —
 * written when `/rename <title>` executes (recorded on Codex 0.167.0 and
 * TRAE 0.216.0). It is the rename's durable receipt: unlike the screen it
 * does not depend on footer or placeholder copy.
 */

/** Byte length now; 0 when the index does not exist yet. */
export function nativeSessionIndexSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/** Appended renames are a few hundred bytes; never read more than this. */
const MAX_DELTA_BYTES = 1024 * 1024;

/**
 * Whether a line appended after `fromByte` names `sessionId` exactly `title`.
 * A partial first line (the file was rewritten) or malformed lines are
 * skipped; an unreadable or not-yet-grown index proves nothing.
 */
export function nativeSessionIndexNamedSince(
  path: string,
  fromByte: number,
  title: string,
  sessionId: string,
): boolean {
  const wanted = title.trim();
  if (!wanted || !sessionId.trim()) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const start = Math.max(fromByte, size - MAX_DELTA_BYTES);
  const buffer = Buffer.alloc(size - start);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      // Codex/TRAE thread ids are UUIDs; persisted configuration may carry a
      // different case from the index writer without denoting another thread.
      if (typeof record.id === 'string' && record.id.toLowerCase() === sessionId.toLowerCase()
        && typeof record.thread_name === 'string' && record.thread_name.trim() === wanted) return true;
    } catch { /* partial or foreign line */ }
  }
  return false;
}

/**
 * A probe armed right before the rename command is typed: true once the
 * index records `title` for this exact native thread after that moment.
 * Without a native id there is no safe shared-file fallback: another thread's
 * same-title rename must never release this session's queued input.
 */
export function watchNativeSessionIndex(
  path: string,
  title: string,
  getSessionId: () => string | undefined,
  fromByte?: number,
): () => boolean {
  const baseline = fromByte ?? nativeSessionIndexSize(path);
  return () => {
    // Identity can be proven AFTER a persistent reattach armed this probe.
    // Keep the original baseline so the valid receipt written meanwhile still
    // counts; while no id is proven, no same-title record can release input.
    const sessionId = getSessionId();
    return sessionId?.trim()
      ? nativeSessionIndexNamedSince(path, baseline, title, sessionId)
      : false;
  };
}
