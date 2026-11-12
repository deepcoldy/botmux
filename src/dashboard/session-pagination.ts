/** Bounded browser snapshots and stable keyset pagination for closed sessions. */
interface SessionListRow {
  sessionId: string;
  status?: unknown;
  closedAt?: unknown;
  lastMessageAt?: unknown;
}

export interface SessionPage<T> {
  sessions: T[];
  closedCursor?: string | null;
  closedTotal?: number;
}

const CLOSED_PAGE_SIZE = 50;
type ClosedKey = [number, string];

/** Resolve the stable descending history key, falling back for legacy rows. */
function closedKey(row: SessionListRow): ClosedKey {
  const time = row.closedAt ?? row.lastMessageAt;
  return [typeof time === 'number' && Number.isFinite(time) ? time : 0, row.sessionId];
}

/** Compare history keys without locale-dependent ordering. */
function compareKeys(a: ClosedKey, b: ClosedKey): number {
  return b[0] - a[0] || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
}

/** Validate a bounded opaque cursor; malformed cursors are client errors. */
function decodeCursor(raw: string): ClosedKey {
  if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid_session_cursor');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); }
  catch { throw new Error('invalid_session_cursor'); }
  if (!Array.isArray(parsed) || parsed.length !== 2
    || typeof parsed[0] !== 'number' || !Number.isFinite(parsed[0])
    || typeof parsed[1] !== 'string' || !parsed[1] || parsed[1].length > 200) {
    throw new Error('invalid_session_cursor');
  }
  return [parsed[0], parsed[1]];
}

/** Select browser rows before expensive presentation work; legacy callers keep all rows. */
export function selectSessionPage<T extends SessionListRow>(rows: T[], params: URLSearchParams): SessionPage<T> {
  const view = params.get('view');
  if (view === null) return { sessions: rows };
  if (view === 'single') {
    const id = params.get('sessionId');
    if (!id) throw new Error('invalid_session_id');
    return { sessions: rows.filter(row => row.sessionId === id) };
  }
  if (view !== 'board' && view !== 'closed') throw new Error('invalid_session_view');
  const rawCursor = params.get('cursor');
  if (view === 'board' && rawCursor !== null) throw new Error('invalid_session_cursor');
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
  const closed = rows.filter(row => row.status === 'closed')
    .sort((a, b) => compareKeys(closedKey(a), closedKey(b)));
  const remaining = cursor ? closed.filter(row => compareKeys(closedKey(row), cursor) > 0) : closed;
  const page = remaining.slice(0, CLOSED_PAGE_SIZE);
  const last = page.at(-1);
  return {
    sessions: view === 'board' ? [...rows.filter(row => row.status !== 'closed'), ...page] : page,
    closedTotal: closed.length,
    closedCursor: remaining.length > page.length && last
      ? Buffer.from(JSON.stringify(closedKey(last))).toString('base64url') : null,
  };
}
