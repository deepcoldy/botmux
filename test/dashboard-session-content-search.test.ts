import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionContentSearch } from '../src/dashboard/session-content-search.js';
import { projectSessionsForAudience, type SessionBoardAudience } from '../src/dashboard/public-redact.js';
import type { Session } from '../src/types.js';
import type { searchTopics } from '../src/services/topic-search/query.js';

type QueryResult = ReturnType<typeof searchTopics>;
type Query = Parameters<typeof createSessionContentSearch>[0]['search'];
function topic(ids: string[], snippet: string, time = 100): QueryResult['results'][number] {
  return {
    anchor: `om_${ids[0]}`, scope: 'thread', chatId: 'oc_chat', chatName: null,
    title: 'unrelated title', link: null, lastActiveAt: time, status: 'open', notes: [],
    sessions: ids.map(sessionId => ({ sessionId, bot: 'bot', cliId: 'codex', status: 'active' })),
    hits: { count: 1, items: [{ kind: 'inbound', snippet, time }] },
  };
}
function fixture() {
  let sessions: readonly Session[] = [];
  const search = vi.fn<Query>().mockReturnValue({ query: 'needle', results: [], truncated: false });
  const readSessions = vi.fn(() => sessions);
  const warn = vi.fn<(reason: string) => void>();
  const run = createSessionContentSearch({ search, readSessions, now: Date.now, warn });
  return { run, search, readSessions, warn, replaceSessions: (value: readonly Session[]) => { sessions = value; } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('Dashboard content search', () => {
  it('returns no rows or snippets and performs no reads for anonymous visitors', () => {
    const f = fixture(); f.search.mockReturnValue({ query: 'needle', results: [topic(['s1'], 'private answer')], truncated: false });
    expect(f.run('needle', 'anonymous', [{ sessionId: 's1' }])).toEqual({
      sessions: [], contentMatches: [], contentSearch: 'not_allowed',
    });
    expect(f.search).not.toHaveBeenCalled(); expect(f.readSessions).not.toHaveBeenCalled();
    expect(f.warn).not.toHaveBeenCalled();
  });

  it.each(['management', 'workbench'] satisfies SessionBoardAudience[])(
    'expands topic order into matching memory rows for %s, using the first hit', audience => {
      const f = fixture();
      const rows = [{ sessionId: 's1', title: 'metadata one', previewText: 'preview' },
        { sessionId: 's2', title: 'metadata two' }, { sessionId: 's3', title: 'metadata three' }];
      const first = topic(['s2', 'missing', 's1'], 'first representative', 200);
      first.hits.items.push({ kind: 'reply', snippet: 'not the representative', time: 100 });
      f.search.mockReturnValue({ query: 'needle', results: [first, topic(['s3'], 'second topic')], truncated: false });
      const result = f.run('needle', audience, rows);
      expect(result.contentSearch).toBe('ok');
      expect(result.sessions).toEqual([rows[1], rows[0], rows[2]]);
      expect(result.contentMatches).toEqual([
        { sessionId: 's2', snippet: 'first representative', time: 200 },
        { sessionId: 's1', snippet: 'first representative', time: 200 },
        { sessionId: 's3', snippet: 'second topic', time: 100 },
      ]);
      expect(projectSessionsForAudience(result.sessions, audience)).toEqual(result.sessions);
      expect(rows[0]).not.toHaveProperty('snippet');
      expect(f.search).toHaveBeenCalledWith({ query: 'needle', limit: 20, hits: 1 }, {
        sessions: [], busyTimeoutMs: 250,
      });
    },
  );

  it('does not query for fewer than two non-whitespace characters', () => {
    const f = fixture();
    for (const query of ['', '   ', ' 风 ', '😀']) {
      expect(f.run(query, 'management', [])).toEqual({ sessions: [], contentMatches: [], contentSearch: 'too_short' });
    }
    expect(f.search).not.toHaveBeenCalled(); expect(f.readSessions).not.toHaveBeenCalled();
    expect(f.run('风 险', 'management', []).contentSearch).toBe('ok');
  });

  it('accepts an empty query result and ignores topics with no current matching session', () => {
    const f = fixture();
    expect(f.run('needle', 'management', [])).toEqual({ sessions: [], contentMatches: [], contentSearch: 'ok' });
    f.search.mockReturnValue({ query: 'needle', results: [topic(['deleted'], 'private')], truncated: false });
    expect(f.run('needle', 'management', [{ sessionId: 'other' }])).toEqual({ sessions: [], contentMatches: [], contentSearch: 'ok' });
  });

  it('reuses a session snapshot for five seconds and refreshes it at expiry', () => {
    const f = fixture();
    f.run('first', 'management', []);
    const first = f.search.mock.calls[0][1].sessions;
    const next: readonly Session[] = [];
    f.replaceSessions(next);
    vi.advanceTimersByTime(4999); f.run('second', 'workbench', []);
    expect(f.readSessions).toHaveBeenCalledTimes(1);
    expect(f.search.mock.calls[1][1].sessions).toBe(first);
    vi.advanceTimersByTime(1); f.run('third', 'management', []);
    expect(f.readSessions).toHaveBeenCalledTimes(2);
    expect(f.search.mock.calls[2][1].sessions).toBe(next);
  });

  it.each(['topic_index_unavailable', 'foreign_topic_index', 'topic_index_schema_mismatch', 'topic_search_disabled', 'database is locked'])(
    'degrades %s to an unavailable result', reason => {
      const f = fixture(); f.search.mockImplementation(() => { throw new Error(reason); });
      expect(f.run('needle', 'management', [{ sessionId: 's1' }])).toEqual({
        sessions: [], contentMatches: [], contentSearch: 'unavailable',
      });
      expect(f.warn).toHaveBeenCalledWith(reason);
    },
  );

  it('warns once per reason within ten minutes, then allows another warning', () => {
    const f = fixture(); f.search.mockImplementation(() => { throw new Error('database is locked'); });
    f.run('one', 'management', []); f.run('two', 'management', []);
    vi.advanceTimersByTime(599_999); f.run('three', 'management', []);
    expect(f.warn).toHaveBeenCalledTimes(1);
    f.search.mockImplementation(() => { throw new Error('topic_index_unavailable'); });
    f.run('four', 'management', []); expect(f.warn).toHaveBeenCalledTimes(2);
    f.search.mockImplementation(() => { throw new Error('database is locked'); });
    vi.advanceTimersByTime(1); f.run('five', 'management', []);
    expect(f.warn).toHaveBeenCalledTimes(3);
  });
});
