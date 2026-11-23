import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionContentSearch } from '../src/dashboard/session-content-search.js';
import { projectSessionsForAudience, type SessionBoardAudience } from '../src/dashboard/public-redact.js';
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
  const search = vi.fn<Query>().mockReturnValue({ query: 'needle', results: [], truncated: false });
  const warn = vi.fn<(reason: string) => void>();
  const run = createSessionContentSearch({ search, now: Date.now, warn });
  return { run, search, warn };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe('Dashboard content search', () => {
  it('returns no rows or snippets and performs no query for anonymous visitors', async () => {
    const f = fixture(); f.search.mockReturnValue({ query: 'needle', results: [topic(['s1'], 'private answer')], truncated: false });
    expect(await f.run('needle', 'anonymous', [{ sessionId: 's1' }])).toEqual({
      sessions: [], contentMatches: [], contentSearch: 'not_allowed',
    });
    expect(f.search).not.toHaveBeenCalled(); expect(f.warn).not.toHaveBeenCalled();
  });

  it.each(['management', 'workbench'] satisfies SessionBoardAudience[])(
    'expands topic order into matching memory rows for %s, using the first hit', async audience => {
      const f = fixture();
      const rows = [{ sessionId: 's1', title: 'metadata one', previewText: 'preview' },
        { sessionId: 's2', title: 'metadata two' }, { sessionId: 's3', title: 'metadata three' }];
      const first = topic(['s2', 'missing', 's1'], 'first representative', 200);
      first.hits.items.push({ kind: 'reply', snippet: 'not the representative', time: 100 });
      f.search.mockReturnValue({ query: 'needle', results: [first, topic(['s3'], 'second topic')], truncated: false });
      const result = await f.run('needle', audience, rows);
      expect(result.contentSearch).toBe('ok');
      expect(result.sessions).toEqual([rows[1], rows[0], rows[2]]);
      expect(result.contentMatches).toEqual([
        { sessionId: 's2', snippet: 'first representative', time: 200 },
        { sessionId: 's1', snippet: 'first representative', time: 200 },
        { sessionId: 's3', snippet: 'second topic', time: 100 },
      ]);
      expect(projectSessionsForAudience(result.sessions, audience)).toEqual(result.sessions);
      expect(rows[0]).not.toHaveProperty('snippet');
      const options = f.search.mock.calls[0][1];
      expect([...options.visibleSessionIds!]).toEqual(['s1','s2','s3']);
      expect(options).toMatchObject({ candidateLimit: 5000,busyTimeoutMs: 250 });
      expect(options).not.toHaveProperty('sessions');
      expect(options).not.toHaveProperty('anchors');
    },
  );

  it('passes visible session ids to the query worker so a result beyond global rank 20 is not discarded', async () => {
    const f = fixture();
    const offline = Array.from({ length: 20 },(_,i) => `offline_${i}`);
    f.search.mockImplementation((request,options) => {
      const all = [...offline.map(id => topic([id],'invisible')),topic(['visible'],'visible answer')];
      const results = all.filter(result => options.visibleSessionIds?.has(result.sessions[0].sessionId)).slice(0,request.limit);
      return { query: request.query,results,truncated: results.length < all.length };
    });
    const result = await f.run('needle','management',[{ sessionId: 'visible' }]);
    expect(result.sessions.map(row => row.sessionId)).toEqual(['visible']);
    expect(result.contentMatches).toEqual([{ sessionId: 'visible',snippet: 'visible answer',time: 100 }]);
    expect([...f.search.mock.calls[0][1].visibleSessionIds!]).toEqual(['visible']);
  });

  it('expands related source sessions even when the physical topic has no visible session row', async () => {
    const f = fixture();
    const cross = topic(['target'],'cross answer');
    cross.relatedSessions = [{ sessionId: 'source',bot: 'bot',cliId: 'codex',status: 'active' }];
    f.search.mockReturnValue({ query: 'needle',results: [cross],truncated: false });
    const result = await f.run('needle','management',[{ sessionId: 'source' }]);
    expect(result.sessions.map(row => row.sessionId)).toEqual(['source']);
    expect(result.contentMatches).toEqual([{ sessionId: 'source',snippet: 'cross answer',time: 100 }]);
  });

  it('does not settle before the asynchronous query completes', async () => {
    const f = fixture();
    let complete: ((value: QueryResult) => void) | undefined;
    f.search.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    let settled = false;
    const pending = f.run('needle','management',[{ sessionId: 's1' }]).then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete!({ query: 'needle',results: [topic(['s1'],'async answer')],truncated: false });
    expect((await pending).contentMatches[0]).toMatchObject({ sessionId: 's1',snippet: 'async answer' });
  });

  it('does not query for fewer than two non-whitespace characters', async () => {
    const f = fixture();
    for (const query of ['', '   ', ' 风 ', '😀']) {
      expect(await f.run(query, 'management', [])).toEqual({ sessions: [], contentMatches: [], contentSearch: 'too_short' });
    }
    expect(f.search).not.toHaveBeenCalled();
    expect((await f.run('风 险', 'management', [])).contentSearch).toBe('ok');
  });

  it('accepts an empty query result and ignores topics with no current matching session', async () => {
    const f = fixture();
    expect(await f.run('needle', 'management', [])).toEqual({ sessions: [], contentMatches: [], contentSearch: 'ok' });
    f.search.mockReturnValue({ query: 'needle', results: [topic(['deleted'], 'private')], truncated: false });
    expect(await f.run('needle', 'management', [{ sessionId: 'other' }])).toEqual({ sessions: [], contentMatches: [], contentSearch: 'ok' });
  });

  it.each(['topic_index_unavailable', 'foreign_topic_index', 'topic_index_schema_mismatch', 'topic_search_disabled', 'database is locked'])(
    'degrades %s to an unavailable result', async reason => {
      const f = fixture(); f.search.mockImplementation(() => { throw new Error(reason); });
      expect(await f.run('needle', 'management', [{ sessionId: 's1' }])).toEqual({
        sessions: [], contentMatches: [], contentSearch: 'unavailable',
      });
      expect(f.warn).toHaveBeenCalledWith(reason);
    },
  );

  it('warns once per reason within ten minutes, then allows another warning', async () => {
    const f = fixture(); f.search.mockImplementation(() => { throw new Error('database is locked'); });
    await f.run('one', 'management', []); await f.run('two', 'management', []);
    expect(f.warn).toHaveBeenCalledTimes(1);
    f.search.mockImplementation(() => { throw new Error('topic_index_unavailable'); });
    await f.run('three', 'management', []); expect(f.warn).toHaveBeenCalledTimes(2);
    f.search.mockImplementation(() => { throw new Error('database is locked'); });
    vi.advanceTimersByTime(600_000); await f.run('four', 'management', []);
    expect(f.warn).toHaveBeenCalledTimes(3);
  });
});
