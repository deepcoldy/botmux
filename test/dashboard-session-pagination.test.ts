/** Regression coverage for bounded session selection and stable archive cursors. */
import { describe, expect, it } from 'vitest';
import { selectSessionPage } from '../src/dashboard/session-pagination.js';

/** Construct archive rows, with equal timestamps to exercise the ID tie-break. */
function archive(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `closed-${String(index).padStart(4, '0')}`, status: 'closed', lastMessageAt: Math.floor(index / 3),
  }));
}

/** Build a browser list query without copying pagination internals into tests. */
function query(view: string, cursor?: string | null): URLSearchParams {
  const params = new URLSearchParams({ view });
  if (cursor != null) params.set('cursor', cursor);
  return params;
}

describe('bounded dashboard sessions', () => {
  it('keeps all active/dormant rows while bounding history and preserving legacy callers', () => {
    const open = [{ sessionId: 'idle', status: 'idle' }, { sessionId: 'sleep', status: 'dormant' }];
    const rows = [...archive(2029), ...open];
    const page = selectSessionPage(rows, query('board'));
    expect(page.sessions.filter(row => row.status !== 'closed')).toEqual(open);
    expect(page.sessions.filter(row => row.status === 'closed')).toHaveLength(50);
    expect(page.closedTotal).toBe(2029);
    expect(page.closedCursor).toBeTypeOf('string');
    expect(selectSessionPage(rows, new URLSearchParams())).toEqual({ sessions: rows });
    expect(rows).toHaveLength(2031);
  });

  it('walks the complete archive without duplicates, including tied timestamps', () => {
    const rows = archive(123);
    const first = selectSessionPage(rows, query('board'));
    const seen = first.sessions.map(row => row.sessionId);
    let cursor = first.closedCursor;
    while (cursor) {
      const next = selectSessionPage(rows, query('closed', cursor));
      expect(next.sessions.length).toBeLessThanOrEqual(50);
      seen.push(...next.sessions.map(row => row.sessionId));
      cursor = next.closedCursor;
    }
    expect(new Set(seen).size).toBe(rows.length);
    expect(seen).toHaveLength(rows.length);
    expect(seen[0]).toBe('closed-0122');
  });

  it('does not skip the next page when the cursor row disappears or new history is inserted', () => {
    const rows = archive(120);
    const first = selectSessionPage(rows, query('board'));
    const removedId = first.sessions.at(-1)!.sessionId;
    const next = selectSessionPage([
      ...rows.filter(row => row.sessionId !== removedId),
      { sessionId: 'newest', status: 'closed', lastMessageAt: 99999 },
    ], query('closed', first.closedCursor));
    expect(next.sessions).toEqual(selectSessionPage(rows, query('closed', first.closedCursor)).sessions);
  });

  it('returns a single historical row for deep links without returning the archive', () => {
    expect(selectSessionPage(archive(100), new URLSearchParams({ view: 'single', sessionId: 'closed-0000' })).sessions)
      .toEqual([archive(1)[0]]);
  });

  it('rejects malformed cursors and unsupported modes instead of falling back to full history', () => {
    for (const cursor of ['', 'not-json', 'a'.repeat(513), Buffer.from('[null,"id"]').toString('base64url')]) {
      expect(() => selectSessionPage(archive(10), query('closed', cursor))).toThrow('invalid_session_cursor');
    }
    expect(() => selectSessionPage([], query('invalid'))).toThrow('invalid_session_view');
    expect(() => selectSessionPage([], query('board', 'cursor'))).toThrow('invalid_session_cursor');
    expect(() => selectSessionPage([], query('single'))).toThrow('invalid_session_id');
    expect(selectSessionPage([], query('board'))).toMatchObject({ sessions: [], closedCursor: null, closedTotal: 0 });
  });

  it('rejects a well-formed cursor on the board view and an over-long one anywhere', () => {
    const rows = archive(120);
    const cursor = selectSessionPage(rows, query('board')).closedCursor!;
    expect(selectSessionPage(rows, query('closed', cursor)).sessions).toHaveLength(50);
    expect(() => selectSessionPage(rows, query('board', cursor))).toThrow('invalid_session_cursor');
    // Valid base64url of valid JSON (trailing whitespace is legal JSON) — only the length bound rejects it.
    const padded = Buffer.from(`[5,"closed-0001"]${' '.repeat(600)}`).toString('base64url');
    expect(padded.length).toBeGreaterThan(512);
    expect(() => selectSessionPage(rows, query('closed', padded))).toThrow('invalid_session_cursor');
  });

  it('stops handing out a cursor once the last closed row has been sent', () => {
    expect(selectSessionPage(archive(50), query('board')).closedCursor).toBeNull();
    const first = selectSessionPage(archive(100), query('board'));
    const last = selectSessionPage(archive(100), query('closed', first.closedCursor));
    expect(last.sessions).toHaveLength(50);
    expect(last.closedCursor).toBeNull();
  });
});

describe('closed-session keyword search (view=closed&q=)', () => {
  /** 120 closed rows (newest first = highest index) plus one live row; `patch` lands on one deep row. */
  function searchable(patch: Record<string, unknown>, at = 7) {
    const rows: Array<Record<string, unknown> & { sessionId: string; status: string }> = archive(120)
      .map(row => ({ ...row, larkAppId: 'cli_hidden_app', title: `Routine ${row.sessionId}` }));
    Object.assign(rows[at], patch);
    rows.push({ sessionId: 'live-1', status: 'idle', title: 'needle in a live row' });
    return rows;
  }
  const search = (rows: Parameters<typeof selectSessionPage>[0], q: string, extra?: (row: any) => unknown[]) => (
    selectSessionPage(rows, new URLSearchParams({ view: 'closed', q }), extra ? { searchText: extra } : {})
  );

  it('searches the whole closed archive, not just the first page, and leaves live rows to the board', () => {
    const rows = searchable({ title: 'Deploy NEEDLE pipeline' });
    expect(selectSessionPage(rows, query('board')).sessions.map(row => row.sessionId)).not.toContain('closed-0007');
    const page = search(rows, 'needle');
    expect(page.sessions.map(row => row.sessionId)).toEqual(['closed-0007']);
    expect(page).toMatchObject({ closedTotal: 1, closedCursor: null });
  });

  it('matches every field the palette and workbench show, requires all words, and never the app id', () => {
    const fields: Array<[Record<string, unknown>, string]> = [
      [{ chatDisplayName: 'Release war room' }, 'war room'],
      [{ botName: 'Night Builder' }, 'night builder'],
      [{ workingDir: '/srv/repos/payments-api' }, 'payments-api'],
      [{ workspace: { rootPath: '/srv/ws/ledger', displayName: 'Ledger', branch: 'feat/refunds' } }, 'refunds ledger'],
      [{ gitBranch: 'hotfix/tz' }, 'hotfix/tz'],
      [{ chatId: 'oc_target_chat' }, 'oc_target_chat'],
      [{ cliId: 'opencode' }, 'opencode'],
    ];
    for (const [patch, q] of fields) {
      expect(search(searchable(patch), q).sessions.map(row => row.sessionId), q).toEqual(['closed-0007']);
    }
    expect(search(searchable({}), 'closed-0007').sessions.map(row => row.sessionId)).toEqual(['closed-0007']);
    expect(search(searchable({ title: 'Deploy needle' }), 'needle missing').sessions).toEqual([]);
    expect(search(searchable({}), 'cli_hidden_app').sessions).toEqual([]);
  });

  it('matches names resolved outside the row (current bot name, group name)', () => {
    const rows = searchable({ chatId: 'oc_named' });
    const extra = (row: { chatId?: unknown }) => [row.chatId === 'oc_named' ? 'Quarterly planning' : undefined, 'Renamed bot'];
    expect(search(rows, 'quarterly', extra).sessions.map(row => row.sessionId)).toEqual(['closed-0007']);
    expect(search(rows, 'quarterly').sessions).toEqual([]);
  });

  it('pages matches 50 at a time in the stable history order', () => {
    const rows = archive(120).map(row => ({ ...row, title: 'shared word' }));
    const first = search(rows, 'shared');
    expect(first.sessions).toHaveLength(50);
    expect(first.sessions[0].sessionId).toBe('closed-0119');
    expect(first.closedTotal).toBe(120);
    const second = selectSessionPage(rows, new URLSearchParams({ view: 'closed', q: 'shared', cursor: first.closedCursor! }));
    expect(second.sessions[0].sessionId).toBe('closed-0069');
  });

  it('treats a blank query as plain paging and rejects malformed or misplaced ones', () => {
    const rows = archive(120);
    expect(search(rows, '   ')).toEqual(selectSessionPage(rows, query('closed')));
    expect(() => search(rows, 'x'.repeat(201))).toThrow('invalid_session_query');
    expect(search(rows, 'x'.repeat(200)).sessions).toEqual([]);
    expect(() => search(rows, 'a\u0000b')).toThrow('invalid_session_query');
    expect(() => search(rows, 'a\nb')).toThrow('invalid_session_query');
    expect(() => selectSessionPage(rows, new URLSearchParams({ view: 'board', q: 'x' }))).toThrow('invalid_session_query');
  });
});
