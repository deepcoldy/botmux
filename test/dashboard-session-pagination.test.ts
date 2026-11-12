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
});
