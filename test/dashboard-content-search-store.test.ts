import { describe, expect, it, vi } from 'vitest';
import { Store, contentMatchesForQuery } from '../src/dashboard/web/store.js';

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>(resolve => { complete = resolve; });
  return { promise, resolve(value: T) { if (!complete) throw new Error('missing resolver'); complete(value); } };
}
function page(id: string, snippet = 'needle answer') {
  return new Response(JSON.stringify({ sessions: [{ sessionId: id, status: 'closed', title: 'unrelated metadata' }],
    contentMatches: [{ sessionId: id, snippet, time: 100 }], contentSearch: 'ok' }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Dashboard browser content search store', () => {
  it('requests content even when all closed history is loaded and preserves history cursors', async () => {
    const request = vi.fn(async (_path: string) => page('s1'));
    const store = new Store(request);
    store.replaceSessionsSnapshot([], { closedCursor: null, closedTotal: 0 });
    await store.searchClosedSessions('needle'); expect(request).not.toHaveBeenCalled();
    await store.searchContent('needle');
    expect(request).toHaveBeenCalledWith('/api/sessions?view=content&q=needle');
    expect(store.getSnapshot()).toMatchObject({ closedCursor: null, closedTotal: 0 });
    expect(store.sessions.get('s1')?.title).toBe('unrelated metadata');
    expect(contentMatchesForQuery(store.getSnapshot().contentSearch, 'needle').get('s1')).toEqual({
      snippet: 'needle answer', time: 100, rank: 0,
    });
  });

  it('normalizes both requests identically and makes old matches ineligible as input changes or clears', async () => {
    const request = vi.fn(async (_path: string) => page('s1'));
    const store = new Store(request);
    store.replaceSessionsSnapshot([], { closedCursor: 'older' });
    const input = '  needle\n\u0000 second   ' + 'x'.repeat(220);
    await store.searchClosedSessions(input); await store.searchContent(input);
    const queries = request.mock.calls.map(call => new URL(call[0], 'http://localhost').searchParams.get('q'));
    expect(queries[0]).toBe(queries[1]); expect(queries[0]?.length).toBe(200);
    const snapshot = store.getSnapshot().contentSearch;
    expect(contentMatchesForQuery(snapshot, input).size).toBe(1);
    expect(contentMatchesForQuery(snapshot, 'different').size).toBe(0);
    expect(contentMatchesForQuery(snapshot, '').size).toBe(0);
    const before = request.mock.calls.length;
    await store.searchContent(' \u0000 ');
    expect(request).toHaveBeenCalledTimes(before);
    expect(store.getSnapshot().contentSearch.matches.size).toBe(0);
  });

  it('drops an older response before merging its rows or snippets', async () => {
    const old = deferred<Response>(); const current = deferred<Response>();
    const request = vi.fn((path: string) => path.includes('q=old') ? old.promise : current.promise);
    const store = new Store(request);
    const first = store.searchContent('old'); const second = store.searchContent('current');
    current.resolve(page('new', 'current answer')); await second;
    old.resolve(page('old', 'stale answer')); await first;
    expect([...store.sessions.keys()]).toEqual(['new']);
    expect(store.getSnapshot().contentSearch.query).toBe('current');
    expect([...store.getSnapshot().contentSearch.matches.keys()]).toEqual(['new']);
  });

  it('retries after snapshot replacement and replays SSE received while the content page was pending', async () => {
    const first = deferred<Response>(); const second = deferred<Response>(); const retry = deferred<void>();
    let reads = 0;
    const store = new Store(() => { if (++reads === 1) return first.promise; retry.resolve(); return second.promise; });
    const pending = store.searchContent('needle');
    store.replaceSessionsSnapshot([{ sessionId: 'live', status: 'working' }], { closedCursor: 'older' });
    first.resolve(page('stale'));
    await retry.promise;
    expect(store.sessions.has('stale')).toBe(false);
    store.applySse('session.update', { sessionId: 'history', patch: { title: 'SSE title' } });
    store.applySse('session.exited', { sessionId: 'history' });
    second.resolve(page('history'));
    await pending;
    expect(store.sessions.get('history')).toMatchObject({ title: 'SSE title', status: 'closed' });
    expect(store.getSnapshot().closedCursor).toBe('older');
    expect(store.getSnapshot().contentSearch.matches.has('history')).toBe(true);
  });

  it('keeps existing rows authoritative and silently degrades request failures or unavailable responses', async () => {
    const request = vi.fn<(path: string) => Promise<Response>>().mockResolvedValueOnce(page('s1'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(new Response(JSON.stringify({
        sessions: [], contentMatches: [], contentSearch: 'unavailable',
      })));
    const store = new Store(request);
    store.replaceSessionsSnapshot([{ sessionId: 's1', status: 'working', title: 'current row' }]);
    await store.searchContent('needle');
    expect(store.sessions.get('s1')?.title).toBe('current row');
    await expect(store.searchContent('offline')).resolves.toBeUndefined();
    expect(store.getSnapshot().contentSearch.matches.size).toBe(0);
    await store.searchContent('unavailable');
    expect(store.getSnapshot().contentSearch.matches.size).toBe(0);
    expect(store.sessions.get('s1')?.title).toBe('current row');
  });
});
