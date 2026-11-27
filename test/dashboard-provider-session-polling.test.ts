// How the browser store keeps WeCom (provider) session rows fresh: nothing on a
// timer; a data-less hint on `/events` makes it read the rows once over REST.
// The event name and the path come from the server module, so the two sides
// cannot drift apart unnoticed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WECOM_SESSIONS_HINT_EVENT, WECOM_SESSIONS_PATH } from '../src/dashboard/wecom/session-observer.js';

type Listener = (event: { data: string }) => void;

class FakeEventSource {
  static instance: FakeEventSource | null = null;
  readonly listeners = new Map<string, Listener>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  readyState = 0;
  constructor(readonly url: string) { FakeEventSource.instance = this; }
  addEventListener(type: string, listener: Listener): void { this.listeners.set(type, listener); }
  emit(type: string, body: unknown): void { this.listeners.get(type)?.({ data: JSON.stringify(body) }); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  close(): void { this.readyState = 2; }
}

const BOARD = '/api/sessions?view=board';
const larkRow = { sessionId: 'lark-1', status: 'working', larkAppId: 'cli_lark', title: 'Lark' };
const wecomRow = { sessionId: 'wecom:cfg:core:1', provider: 'wecom', providerBotId: 'cfg', status: 'working', cliId: 'codex', title: 'first' };

let boardCalls = 0;
let wecomCalls = 0;
let board: () => Record<string, unknown>;
let wecom: () => Promise<Response> | Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function boot(options: { canReadProviderSessions?: () => boolean; onSessionSnapshot?: (body: Record<string, unknown>) => void } = {}) {
  const mod = await import('../src/dashboard/web/store.js');
  await mod.bootstrap({ canReadProviderSessions: () => true, ...options });
  return mod;
}

const hint = () => FakeEventSource.instance!.emit(WECOM_SESSIONS_HINT_EVENT, {});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  boardCalls = 0;
  wecomCalls = 0;
  board = () => ({ sessions: [larkRow] });
  wecom = () => json({ sessions: [], wecomSessionIds: [], wecomConnectionCount: 1 });
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === BOARD) {
      boardCalls += 1;
      return json(board());
    }
    if (path === WECOM_SESSIONS_PATH) {
      wecomCalls += 1;
      return wecom();
    }
    return json({ schedules: [] });
  }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeEventSource.instance = null;
});

describe('provider session refresh', () => {
  it('never re-reads the board or asks for WeCom sessions in a Feishu-only deployment', async () => {
    await boot();
    const afterBootstrap = boardCalls;

    await vi.advanceTimersByTimeAsync(120_000);

    expect(afterBootstrap).toBe(1);
    expect(boardCalls).toBe(afterBootstrap);
    expect(wecomCalls).toBe(0);
  });

  it('reads nothing on a timer while WeCom connections and sessions exist', async () => {
    board = () => ({ sessions: [larkRow, wecomRow], wecomSessionIds: [wecomRow.sessionId], wecomConnectionCount: 1 });
    await boot();

    await vi.advanceTimersByTimeAsync(120_000);

    expect(boardCalls).toBe(1);
    expect(wecomCalls).toBe(0);
  });

  it('reads the WeCom rows once per hint and keeps the Feishu rows as the stream left them', async () => {
    board = () => ({ sessions: [larkRow, wecomRow], wecomSessionIds: [wecomRow.sessionId], wecomConnectionCount: 1 });
    const snapshots: Array<Record<string, unknown>> = [];
    const { store } = await boot({ onSessionSnapshot: body => snapshots.push(body) });
    store.applySse('session.update', { sessionId: larkRow.sessionId, patch: { title: 'fresh from SSE' } });
    const second = { ...wecomRow, sessionId: 'wecom:cfg:core:2', title: 'second' };
    wecom = () => json({ sessions: [{ ...wecomRow, title: 'renamed' }, second], wecomSessionIds: [wecomRow.sessionId, second.sessionId], wecomConnectionCount: 1 });

    hint();
    await vi.advanceTimersByTimeAsync(0);

    expect(wecomCalls).toBe(1);
    expect(store.sessions.get(wecomRow.sessionId)?.title).toBe('renamed');
    expect(store.sessions.get(second.sessionId)?.title).toBe('second');
    expect(store.sessions.get(larkRow.sessionId)?.title).toBe('fresh from SSE');
    // The roster hears the read too (it carries the connection count).
    expect(snapshots.at(-1)).toMatchObject({ wecomConnectionCount: 1 });

    // A complete read without the row deletes it; an incomplete one deletes nothing.
    wecom = () => json({ sessions: [], wecomConnectionCount: 1 });
    hint();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.sessions.has(second.sessionId)).toBe(true);
    wecom = () => json({ sessions: [], wecomSessionIds: [], wecomConnectionCount: 0 });
    hint();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.sessions.has(second.sessionId)).toBe(false);
    expect(store.sessions.has(wecomRow.sessionId)).toBe(false);
    expect(store.sessions.has(larkRow.sessionId)).toBe(true);
  });

  it('turns hints during a read into exactly one more read, applying the last answer', async () => {
    const { store } = await boot();
    const first = deferred<Response>();
    wecom = () => first.promise;

    hint();
    await vi.advanceTimersByTimeAsync(0);
    hint();
    hint();
    hint();
    await vi.advanceTimersByTimeAsync(0);
    expect(wecomCalls).toBe(1);

    wecom = () => json({ sessions: [{ ...wecomRow, title: 'latest' }], wecomSessionIds: [wecomRow.sessionId], wecomConnectionCount: 1 });
    first.resolve(json({ sessions: [{ ...wecomRow, title: 'older' }], wecomSessionIds: [wecomRow.sessionId], wecomConnectionCount: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(wecomCalls).toBe(2);
    expect(store.sessions.get(wecomRow.sessionId)?.title).toBe('latest');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wecomCalls).toBe(2);
  });

  it('reads a hint that arrives during a full reconcile only after that snapshot lands', async () => {
    const { store } = await boot();
    const snapshot = deferred<Response>();
    vi.mocked(fetch).mockImplementation(async (path: any) => {
      if (path === BOARD) {
        boardCalls += 1;
        return snapshot.promise;
      }
      if (path === WECOM_SESSIONS_PATH) {
        wecomCalls += 1;
        return json({ sessions: [{ ...wecomRow, title: 'from the hint' }], wecomSessionIds: [wecomRow.sessionId], wecomConnectionCount: 1 });
      }
      return json({ schedules: [] });
    });

    FakeEventSource.instance!.open();
    await vi.advanceTimersByTimeAsync(0);
    hint();
    await vi.advanceTimersByTimeAsync(0);
    expect(boardCalls).toBe(2);
    expect(wecomCalls).toBe(0);

    // The board was asked before the hint; its WeCom row is older than the hint's.
    snapshot.resolve(json({ sessions: [larkRow, { ...wecomRow, title: 'from the board' }], wecomSessionIds: [wecomRow.sessionId], wecomConnectionCount: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(wecomCalls).toBe(1);
    expect(store.sessions.get(wecomRow.sessionId)?.title).toBe('from the hint');
  });

  it('ignores hints for an identity that cannot read provider sessions', async () => {
    await boot({ canReadProviderSessions: () => false });

    hint();
    await vi.advanceTimersByTimeAsync(0);

    expect(wecomCalls).toBe(0);
  });
});
