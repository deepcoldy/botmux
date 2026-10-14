import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JsonRpcStdioCore, type JsonRpcMessage } from '../src/utils/jsonrpc-stdio.js';

class RpcErr extends Error {
  constructor(readonly method: string, readonly payload: unknown) { super(`${method}: ${JSON.stringify(payload)}`); }
}

function make(opts: { dispatch?: 'sync' | 'microtask'; invalid?: string[] } = {}) {
  const messages: JsonRpcMessage[] = [];
  const invalid = opts.invalid ?? [];
  const core = new JsonRpcStdioCore({
    dispatch: opts.dispatch,
    mapRpcError: (method, error) => new RpcErr(method, error),
    onMessage: msg => messages.push(msg),
    onInvalidLine: line => invalid.push(line),
  });
  return { core, messages, invalid };
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe('JsonRpcStdioCore framing', () => {
  it('assembles lines across chunks, trims, skips blanks and tolerates CRLF', () => {
    const { core, messages } = make();
    core.push('{"method":"a","par');
    expect(messages).toEqual([]);
    core.push('ams":1}\n\n   \r\n{"method":"b"}\r\n{"method":"c"}');
    expect(messages).toEqual([{ method: 'a', params: 1 }, { method: 'b' }]);
    core.push('\n');
    expect(messages.at(-1)).toEqual({ method: 'c' });
  });

  it('reports non-JSON lines via onInvalidLine and silently skips falsy JSON values', () => {
    const { core, messages, invalid } = make();
    core.push('not json\nnull\n0\nfalse\n""\n{"method":"ok"}\n');
    expect(invalid).toEqual(['not json']);
    expect(messages).toEqual([{ method: 'ok' }]);
  });

  it('does not require onInvalidLine', () => {
    const core = new JsonRpcStdioCore({ mapRpcError: (m, e) => new RpcErr(m, e), onMessage: () => undefined });
    expect(() => core.push('{broken\n')).not.toThrow();
  });
});

describe('JsonRpcStdioCore request tracking', () => {
  it('allocates ids from 1 and settles a response by id regardless of order', async () => {
    const { core, messages } = make();
    const a = core.nextId(); const b = core.nextId();
    expect([a, b]).toEqual([1, 2]);
    const pa = core.track(a, 'ma'); const pb = core.track(b, 'mb');
    core.push(line({ id: 2, result: { v: 'b' } }) + line({ id: 1, result: 'a' }));
    await expect(pa).resolves.toBe('a');
    await expect(pb).resolves.toEqual({ v: 'b' });
    expect(messages).toEqual([]);
  });

  it('maps a truthy error through mapRpcError with the original method', async () => {
    const { core } = make();
    const id = core.nextId();
    const p = core.track(id, 'thread/read');
    core.push(line({ id, error: { code: -32000, message: 'nope' } }));
    const err = await p.catch(e => e);
    expect(err).toBeInstanceOf(RpcErr);
    expect(err.method).toBe('thread/read');
    expect(err.payload).toEqual({ code: -32000, message: 'nope' });
  });

  it('resolves undefined for a falsy-but-defined error with no result, like the old clients', async () => {
    const { core } = make();
    const id = core.nextId();
    const p = core.track(id, 'm');
    core.push(line({ id, error: null }));
    await expect(p).resolves.toBeUndefined();
  });

  it('drops a response whose id is unknown or already settled, and never forwards it', async () => {
    const { core, messages } = make();
    const id = core.nextId();
    const p = core.track(id, 'm');
    core.push(line({ id, result: 1 }) + line({ id, result: 2 }) + line({ id: 99, result: 3 }) + line({ id: 98, error: { code: 1 } }));
    await expect(p).resolves.toBe(1);
    expect(messages).toEqual([]);
  });

  it('forwards server requests, notifications and non-numeric-id messages to onMessage', () => {
    const { core, messages } = make();
    core.push(
      line({ id: 7, method: 'item/tool/call', params: {} })
      + line({ id: 'x', method: 'srv/req' })
      + line({ method: 'turn/started' })
      + line({ id: 'str', result: 1 }),
    );
    expect(messages.map(m => m.method ?? `result:${m.id}`)).toEqual(['item/tool/call', 'srv/req', 'turn/started', 'result:str']);
  });

  it('failAll rejects everything outstanding once and clears the table', async () => {
    const { core } = make();
    const ps = [core.track(core.nextId(), 'a'), core.track(core.nextId(), 'b', { timeoutMs: 10_000 })];
    const boom = new Error('child exited');
    core.failAll(boom);
    await expect(ps[0]).rejects.toBe(boom);
    await expect(ps[1]).rejects.toBe(boom);
    core.push(line({ id: 1, result: 'late' }));
    core.failAll(new Error('second'));
  });

  it('abort rejects one request, clears its timer, and is a no-op afterwards', async () => {
    vi.useFakeTimers();
    try {
      const { core } = make();
      const id = core.nextId();
      const p = core.track(id, 'm', { timeoutMs: 50 });
      const err = new Error('write failed');
      core.abort(id, err);
      core.abort(id, new Error('ignored'));
      await expect(p).rejects.toBe(err);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('JsonRpcStdioCore timeouts', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rejects with the caller-built timeout error and forgets the request', async () => {
    const { core, messages } = make();
    const id = core.nextId();
    const p = core.track(id, 'turn/start', { timeoutMs: 100, onTimeout: (m, ms) => new Error(`${m} timed out after ${ms}ms`) });
    const settled = p.catch(e => e);
    vi.advanceTimersByTime(99);
    core.push(line({ id: 5, result: 'unrelated' }));
    vi.advanceTimersByTime(1);
    expect((await settled).message).toBe('turn/start timed out after 100ms');
    core.push(line({ id, result: 'late reply' }));
    expect(messages).toEqual([]);
  });

  it('a response before the deadline clears the timer', async () => {
    const { core } = make();
    const id = core.nextId();
    const p = core.track(id, 'm', { timeoutMs: 100 });
    core.push(line({ id, result: 'fast' }));
    await expect(p).resolves.toBe('fast');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a default message without onTimeout, and unrefTimer unrefs the timer', async () => {
    const { core } = make();
    const unref = vi.fn();
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      const t = realSetTimeout(fn, ms) as unknown as { unref: () => void };
      const original = t.unref.bind(t);
      t.unref = () => { unref(); return original(); };
      return t;
    }) as never);
    try {
      const a = core.track(core.nextId(), 'plain', { timeoutMs: 10 });
      const b = core.track(core.nextId(), 'unref', { timeoutMs: 10, unrefTimer: true });
      const settled = Promise.all([a.catch(e => e), b.catch(e => e)]);
      vi.advanceTimersByTime(10);
      const [ea, eb] = await settled;
      expect(ea.message).toBe('plain: timed out after 10ms');
      expect(eb.message).toBe('unref: timed out after 10ms');
      expect(unref).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});

describe('JsonRpcStdioCore dispatch modes', () => {
  it("'sync' handles every line of a chunk before returning", () => {
    const { core, messages } = make({ dispatch: 'sync' });
    core.push(line({ method: 'a' }) + line({ method: 'b' }));
    expect(messages.map(m => m.method)).toEqual(['a', 'b']);
  });

  it("'microtask' yields between lines so a response's continuation runs before the next line", async () => {
    const order: string[] = [];
    const core = new JsonRpcStdioCore({
      dispatch: 'microtask',
      mapRpcError: (m, e) => new RpcErr(m, e),
      onMessage: msg => order.push(`notify:${msg.method}`),
    });
    const id = core.nextId();
    void core.track(id, 'turn/start').then(() => order.push('continuation'));
    core.push(line({ id, result: {} }) + line({ method: 'turn/completed' }));
    // first line handled synchronously; the notification waits one microtask
    expect(order).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['continuation', 'notify:turn/completed']);
  });

  it("'microtask' keeps one drain loop when pushed re-entrantly mid-drain", async () => {
    const seen: string[] = [];
    const core = new JsonRpcStdioCore({
      dispatch: 'microtask',
      mapRpcError: (m, e) => new RpcErr(m, e),
      onMessage: msg => {
        seen.push(msg.method);
        if (msg.method === 'a') core.push(line({ method: 'c' }));
      },
    });
    core.push(line({ method: 'a' }) + line({ method: 'b' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it("'sync' lets the same continuation run only after the whole chunk (the ordering 'microtask' exists to fix)", async () => {
    const order: string[] = [];
    const core = new JsonRpcStdioCore({
      dispatch: 'sync',
      mapRpcError: (m, e) => new RpcErr(m, e),
      onMessage: msg => order.push(`notify:${msg.method}`),
    });
    const id = core.nextId();
    void core.track(id, 'turn/start').then(() => order.push('continuation'));
    core.push(line({ id, result: {} }) + line({ method: 'turn/completed' }));
    expect(order).toEqual(['notify:turn/completed']);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['notify:turn/completed', 'continuation']);
  });
});
