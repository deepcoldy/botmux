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

export interface SessionPageOptions<T> {
  /** Names resolved outside the row (current bot name, group name) that the
   *  browser shows next to a session, so a keyword search can find them too. */
  searchText?: (row: T) => ReadonlyArray<unknown>;
}

const CLOSED_PAGE_SIZE = 50;
/** Keyword search is a browser text box, not a document; anything longer is not a real query. */
export const SESSION_QUERY_MAX_LENGTH = 200;
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

/** Split a keyword query the way the ⌘K palette does (whitespace-separated, case-insensitive). */
function parseQuery(raw: string | null): string[] {
  if (raw === null) return [];
  if (raw.length > SESSION_QUERY_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('invalid_session_query');
  }
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The fields the ⌘K palette and the Workbench rail match a session on. Server
 * matching is a plain substring superset of theirs (no fuzzy title match), so
 * every row the browser would rank still arrives; the browser then ranks the
 * merged rows itself. `larkAppId` stays out on purpose, like the palette.
 */
function sessionSearchText(row: SessionListRow, extra: ReadonlyArray<unknown>): string {
  const r = row as SessionListRow & Record<string, unknown>;
  const workspace = (r.workspace && typeof r.workspace === 'object' ? r.workspace : {}) as Record<string, unknown>;
  return [
    r.title, r.chatDisplayName, r.botName, r.cliId, r.repoName, r.gitBranch, r.workingDir,
    workspace.rootPath, workspace.displayName, workspace.branch, r.sessionId, r.chatId,
    ...extra,
  ].filter(value => typeof value === 'string' && value).join('\n').toLowerCase();
}

/** Select browser rows before expensive presentation work; legacy callers keep all rows. */
export function selectSessionPage<T extends SessionListRow>(
  rows: T[],
  params: URLSearchParams,
  options: SessionPageOptions<T> = {},
): SessionPage<T> {
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
  const rawQuery = params.get('q');
  if (view === 'board' && rawQuery !== null) throw new Error('invalid_session_query');
  const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
  const tokens = parseQuery(rawQuery);
  const closed = rows.filter(row => row.status === 'closed'
    && (tokens.length === 0 || matchesTokens(sessionSearchText(row, options.searchText?.(row) ?? []), tokens)))
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

function matchesTokens(text: string, tokens: readonly string[]): boolean {
  return tokens.every(token => text.includes(token));
}
