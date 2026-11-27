// The WeCom session observer behind the `/events` hint: when it collects, how
// often, who hears it, and that it leaves no timer behind. Fake timers; the
// collection is injected, so no WeCom file or core is read.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WECOM_SESSION_OBSERVER_INTERVAL_MS,
  WecomSessionObserver,
  type WecomSessionRead,
} from '../src/dashboard/wecom/session-observer.js';
import { handleWecomConnectionsApi } from '../src/dashboard/wecom/api.js';
import { wecomSessionsResponse } from '../src/dashboard/wecom/session-api.js';
import type { WecomSessionRow } from '../src/dashboard/wecom/sessions.js';

const INTERVAL = WECOM_SESSION_OBSERVER_INTERVAL_MS;

function row(id: string, fields: Partial<WecomSessionRow> = {}): WecomSessionRow {
  return {
    sessionId: `wecom:${id}`, provider: 'wecom', providerBotId: 'cfg', sourceId: 'wecom:cfg:core', botName: '企微助理',
    status: 'idle', offline: false, capabilities: { history: true }, ...fields,
  };
}

function read(sessions: WecomSessionRow[], fields: Partial<WecomSessionRead> = {}): WecomSessionRead {
  return { sessions, complete: true, connectionCount: 1, ...fields };
}

/** A collection whose answer the test sets, counting every call. */
function collector(initial: WecomSessionRead) {
  let next: WecomSessionRead | Promise<WecomSessionRead> = initial;
  const collect = vi.fn(async () => next);
  return { collect, answer(value: WecomSessionRead | Promise<WecomSessionRead>) { next = value; } };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('WeCom session observer', () => {
  it('collects once per interval however many host-admin streams are open', async () => {
    const source = collector(read([row('a')]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const heard = Array.from({ length: 5 }, () => vi.fn());
    for (const listener of heard) observer.watch(listener);
    observer.noteConnectionCount(1);

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(source.collect).toHaveBeenCalledTimes(3);
    // The first collection has nothing to compare with, so every stream hears it once; nothing changed after.
    for (const listener of heard) expect(listener).toHaveBeenCalledTimes(1);
  });

  it('hints only when what the browser is given changes, comparing rows by content', async () => {
    const source = collector(read([row('a'), row('b')]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const listener = vi.fn();
    observer.watch(listener);
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(listener).toHaveBeenCalledTimes(1);

    // Equal rows in new objects and another order: nothing to tell.
    source.answer(read([row('b'), row('a')]));
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(listener).toHaveBeenCalledTimes(1);

    source.answer(read([row('b'), row('a', { title: '改过的标题' })]));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(listener).toHaveBeenCalledTimes(2);

    source.answer(read([row('b'), row('a', { title: '改过的标题' })], { complete: false }));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(listener).toHaveBeenCalledTimes(3);

    source.answer(read([row('b'), row('a', { title: '改过的标题' })], { complete: false, connectionCount: 2 }));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('runs no timer and collects nothing without a host-admin stream', async () => {
    const source = collector(read([row('a')]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    observer.noteConnectionCount(3);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(source.collect).not.toHaveBeenCalled();
  });

  it('runs no timer while no connection is known (a Feishu-only deployment)', async () => {
    const source = collector(read([]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const listener = vi.fn();
    observer.watch(listener);
    observer.noteConnectionCount(0);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(source.collect).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('leaves no timer once the last host-admin stream closes', async () => {
    const source = collector(read([row('a')]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const closeFirst = observer.watch(vi.fn());
    const closeSecond = observer.watch(vi.fn());
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.collect).toHaveBeenCalledTimes(1);

    closeFirst();
    expect(vi.getTimerCount()).toBe(1);
    closeSecond();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(source.collect).toHaveBeenCalledTimes(1);
    expect(observer.current()).toBeUndefined();
  });

  it('sends one last hint and stops when a collection finds no connection', async () => {
    const source = collector(read([row('a')]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const listener = vi.fn();
    observer.watch(listener);
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(listener).toHaveBeenCalledTimes(1);

    source.answer(read([], { connectionCount: 0 }));
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(observer.current()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(source.collect).toHaveBeenCalledTimes(2);
  });

  it('sends one last hint and stops when a board request counts no connection', async () => {
    const source = collector(read([row('a')]));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const listener = vi.fn();
    observer.watch(listener);
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);

    observer.noteConnectionCount(0);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(source.collect).toHaveBeenCalledTimes(1);
  });

  it('never runs two collections at once: the next one waits for the slow one', async () => {
    let finish!: (value: WecomSessionRead) => void;
    const source = collector(new Promise<WecomSessionRead>(done => { finish = done; }));
    const observer = new WecomSessionObserver({ collect: source.collect });
    observer.watch(vi.fn());
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.collect).toHaveBeenCalledTimes(1);

    // While it is still collecting, board requests count connections and new tabs open streams.
    for (let index = 0; index < 4; index += 1) {
      observer.noteConnectionCount(1);
      observer.watch(vi.fn());
      await vi.advanceTimersByTimeAsync(INTERVAL);
    }
    expect(source.collect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    source.answer(read([row('a')]));
    finish(read([row('a')]));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.collect).toHaveBeenCalledTimes(2);
  });

  it('drops a collection that finishes after the last stream closed', async () => {
    let finish!: (value: WecomSessionRead) => void;
    const source = collector(new Promise<WecomSessionRead>(done => { finish = done; }));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const listener = vi.fn();
    const close = observer.watch(listener);
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.collect).toHaveBeenCalledTimes(1);

    close();
    finish(read([row('late')]));
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(listener).not.toHaveBeenCalled();
    expect(observer.current()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('after the last hint for gone connections, a collection begun before it changes nothing', async () => {
    let finish!: (value: WecomSessionRead) => void;
    const source = collector(new Promise<WecomSessionRead>(done => { finish = done; }));
    const observer = new WecomSessionObserver({ collect: source.collect });
    const listener = vi.fn();
    observer.watch(listener);
    observer.noteConnectionCount(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(source.collect).toHaveBeenCalledTimes(1);

    // A board request finds the connections gone while that collection still runs.
    observer.noteConnectionCount(0);
    expect(listener).toHaveBeenCalledTimes(1);
    // The collection, begun while the connection existed, finishes afterwards.
    finish(read([row('stale')], { connectionCount: 1 }));
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(observer.current()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(source.collect).toHaveBeenCalledTimes(1);
  });

  it('answers with the read its last hint was about while it runs', async () => {
    const first = read([row('a')]);
    const source = collector(first);
    const observer = new WecomSessionObserver({ collect: source.collect });
    let heard: WecomSessionRead | undefined;
    observer.watch(() => { heard = observer.current(); });
    observer.noteConnectionCount(1);
    expect(observer.current()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(heard).toBe(first);
    expect(observer.current()).toBe(first);
  });
});

describe('GET /api/wecom/sessions', () => {
  function response() {
    return {
      status: 0,
      body: '',
      writeHead(status: number) { this.status = status; },
      setHeader() {},
      end(body: string) { this.body = body; },
    };
  }

  it('refuses anyone but the host admin before reading anything', async () => {
    const sessions = vi.fn(async () => ({ sessions: [] }));
    const res = response();
    const url = new URL('http://localhost/api/wecom/sessions');

    expect(await handleWecomConnectionsApi({ method: 'GET' } as any, res as any, url, { hostAdmin: false, csrfValid: false, sessions })).toBe(true);

    expect(res.status).toBe(403);
    expect(sessions).not.toHaveBeenCalled();
  });

  it('answers the host admin with the rows the board would carry', async () => {
    const closed = Array.from({ length: 60 }, (_, index) => row(`closed-${index}`, { status: 'closed', closedAt: index }));
    const body = wecomSessionsResponse(read([row('open'), ...closed], { connectionCount: 2 }));

    // Every open row and the newest page of closed ones, as on the board.
    expect(body.sessions.map(item => item.sessionId)).toContain('wecom:open');
    expect(body.sessions.length).toBeLessThan(61);
    expect(body.sessions.map(item => item.sessionId)).toContain('wecom:closed-59');
    expect(body.sessions.map(item => item.sessionId)).not.toContain('wecom:closed-0');
    // Deletion metadata names every row, not only this page.
    expect(body.wecomSessionIds).toHaveLength(61);
    expect(body.wecomConnectionCount).toBe(2);

    const incomplete = wecomSessionsResponse(read([row('open')], { complete: false }));
    expect(incomplete).not.toHaveProperty('wecomSessionIds');
  });
});
