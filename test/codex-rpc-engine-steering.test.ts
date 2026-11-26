import { describe, expect, it, vi } from 'vitest';
import { CodexRpcEngine } from '../src/codex-rpc-engine.js';

type Frame = { id?: number; method?: string; params?: any };

/** Real engine transport/lifecycle with an explicit socket boundary: tests
 * control response order without launching a model or a host app-server. */
function harness(onRequestUserInput?: ConstructorParameters<typeof CodexRpcEngine>[0]['onRequestUserInput']) {
  const terminals: any[] = [];
  const dead = vi.fn();
  const frames: Frame[] = [];
  const engine = new CodexRpcEngine({
    cliBin: '/unused', cwd: '/tmp', env: {},
    onTurnTerminal: terminal => terminals.push(terminal),
    onDead: dead, onRequestUserInput,
  });
  const internal = engine as any;
  internal.threadId = 'thread';
  internal.ws = { readyState: 1, send: (text: string) => frames.push(JSON.parse(text)), close: vi.fn() };
  const response = (frame: Frame, result: unknown) => internal.onMessage(JSON.stringify({ id: frame.id, result }));
  const error = (frame: Frame, code: number, message: string) =>
    internal.onMessage(JSON.stringify({ id: frame.id, error: { code, message } }));
  const complete = () => internal.onMessage(JSON.stringify({
    method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'native', status: 'completed' } },
  }));
  const start = async () => {
    const started = engine.sendTurn('first', { turnId: 'first' });
    response(frames.at(-1)!, { turn: { id: 'native' } });
    await started;
  };
  return { engine, internal, terminals, dead, frames, response, error, complete, start };
}

describe('hybrid RPC ordered native steering', () => {
  it('sends two corrections to the exact native turn and settles each accepted identity once', async () => {
    const h = harness();
    await h.start();
    expect(h.engine.canSteer).toBe(true);
    const dispatch = vi.fn();
    const second = h.engine.steerTurn('second', { turnId: 'second' }, 'native', { onDispatch: dispatch });
    expect(h.engine.canSteer).toBe(false);
    expect(h.frames.at(-1)).toMatchObject({ method: 'turn/steer', params: {
      threadId: 'thread', expectedTurnId: 'native', input: [{ type: 'text', text: 'second', text_elements: [] }],
    } });
    expect(dispatch).toHaveBeenCalledOnce();
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    await expect(second).resolves.toEqual({ nativeTurnId: 'native' });
    const third = h.engine.steerTurn('third', { turnId: 'third' }, 'native');
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    await third;
    h.complete();
    h.complete();
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first', 'second', 'third']);
    expect(h.terminals.every(t => t.nativeTurnId === 'native' && t.status === 'completed')).toBe(true);
    expect(h.engine.activeNativeTurnId).toBeUndefined();
    expect(h.engine.canSteer).toBe(false);
    h.engine.stop();
  });

  it('buffers completion before a steer ACK until that accepted input joins its terminal group', async () => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    h.complete();
    expect(h.terminals).toEqual([]);
    expect(h.engine.canSteer).toBe(false);
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    await steered;
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first', 'second']);
    expect(h.engine.activeNativeTurnId).toBeUndefined();
    h.engine.stop();
  });

  it('a definite rejection releases only the original buffered terminal, never the rejected input', async () => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    const rejected = expect(steered).rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    h.complete();
    h.error(h.frames.at(-1)!, -32600, 'no active turn to steer');
    await rejected;
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first']);
    expect(h.dead).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it('method-not-found disables steering without killing the serial input engine', async () => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    const rejected = expect(steered).rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    h.error(h.frames.at(-1)!, -32601, 'method not found');
    await rejected;
    expect(h.engine.canSteer).toBe(false);
    h.complete();
    const next = h.engine.sendTurn('later', { turnId: 'later' });
    h.response(h.frames.at(-1)!, { turn: { id: 'later-native' } });
    await next;
    expect(h.engine.canSteer).toBe(false);
    expect(h.dead).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it.each([
    ['wrong native ID', 'wrong'],
    ['missing native ID', undefined],
  ])('fences a %s response as ambiguous and does not send a replacement', async (_label, turnId) => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    const rejected = expect(steered).rejects.toMatchObject({ deliveryDisposition: 'ambiguous' });
    h.response(h.frames.at(-1)!, turnId ? { turnId } : {});
    await rejected;
    expect(h.frames.filter(f => f.method === 'turn/steer')).toHaveLength(1);
    expect(h.engine.canSteer).toBe(false);
    expect(h.dead).toHaveBeenCalledOnce();
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first']);
    h.engine.stop();
  });

  it('does not dispatch an expired or foreign expected turn', async () => {
    const h = harness();
    await h.start();
    const dispatch = vi.fn();
    await expect(h.engine.steerTurn('second', { turnId: 'second' }, 'other', { onDispatch: dispatch }))
      .rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    h.complete();
    await expect(h.engine.steerTurn('second', { turnId: 'second' }, 'native', { onDispatch: dispatch }))
      .rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.frames.filter(f => f.method === 'turn/steer')).toHaveLength(0);
    h.engine.stop();
  });

  it('a lost response stays ambiguous and does not replay the correction', async () => {
    const h = harness();
    await h.start();
    await expect(h.engine.steerTurn('second', { turnId: 'second' }, 'native', { timeoutMs: 5 }))
      .rejects.toMatchObject({ deliveryDisposition: 'ambiguous' });
    expect(h.frames.filter(f => f.method === 'turn/steer')).toHaveLength(1);
    expect(h.engine.canSteer).toBe(false);
    expect(h.dead).toHaveBeenCalledOnce();
    h.engine.stop();
  });

  it('an unrelated server failure is ambiguous even when its response is explicit', async () => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    const rejected = expect(steered).rejects.toMatchObject({ deliveryDisposition: 'ambiguous' });
    h.error(h.frames.at(-1)!, -32000, 'internal failure after input processing');
    await rejected;
    expect(h.engine.canSteer).toBe(false);
    expect(h.dead).toHaveBeenCalledOnce();
    expect(h.frames.filter(f => f.method === 'turn/steer')).toHaveLength(1);
    h.engine.stop();
  });

  it('serializes an in-flight correction and refuses a duplicate accepted input before dispatch', async () => {
    const h = harness();
    await h.start();
    const second = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    await expect(h.engine.steerTurn('third', { turnId: 'third' }, 'native'))
      .rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    await second;
    await expect(h.engine.steerTurn('second', { turnId: 'second' }, 'native'))
      .rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    expect(h.frames.filter(f => f.method === 'turn/steer')).toHaveLength(1);
    h.complete();
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first', 'second']);
    h.engine.stop();
  });

  it('a socket refusal leaves the input undispatched and does not invoke its commit hook', async () => {
    const h = harness();
    await h.start();
    const dispatch = vi.fn();
    h.internal.ws.send = () => { throw new Error('socket no longer writable'); };
    await expect(h.engine.steerTurn('second', { turnId: 'second' }, 'native', { onDispatch: dispatch }))
      .rejects.toMatchObject({ deliveryDisposition: 'not_sent' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.engine.canSteer).toBe(false);
    expect(h.dead).not.toHaveBeenCalled();
    h.engine.stop();
  });

  it.each(['stop', 'death'])('%s settles the accepted group but never an unacknowledged correction', async kind => {
    const h = harness();
    await h.start();
    const second = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    await second;
    const third = h.engine.steerTurn('third', { turnId: 'third' }, 'native');
    const rejected = expect(third).rejects.toMatchObject({ deliveryDisposition: 'ambiguous' });
    if (kind === 'stop') h.engine.stop();
    else h.internal.failAll(new Error('engine died'));
    await rejected;
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first', 'second']);
    expect(h.terminals.every(t => t.status === (kind === 'stop' ? 'stopped' : 'engine-dead'))).toBe(true);
    h.engine.stop();
  });

  it('teardown preserves an exact completion already buffered behind an unacknowledged correction', async () => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    const rejected = expect(steered).rejects.toMatchObject({ deliveryDisposition: 'ambiguous' });
    h.complete();
    h.engine.stop();
    await rejected;
    expect(h.terminals).toMatchObject([{ identity: { turnId: 'first' }, status: 'completed' }]);
    expect(h.terminals[0].errorCode).toBeUndefined();
  });

  it('terminal callbacks cannot start a successor while older members are still being settled', async () => {
    const h = harness();
    await h.start();
    const steered = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    await steered;
    const callbackStarts: Promise<unknown>[] = [];
    h.internal.opts.onTurnTerminal = (terminal: any) => {
      h.terminals.push(terminal);
      if (terminal.identity.turnId === 'first') {
        const before = h.frames.length;
        callbackStarts.push(h.engine.sendTurn('next', { turnId: 'next' }).catch(error => error));
        if (h.frames.length > before) h.response(h.frames.at(-1)!, { turn: { id: 'next-native' } });
      }
    };
    h.complete();
    const result = await callbackStarts[0];
    expect(result).toMatchObject({ deliveryDisposition: 'not_sent' });
    expect(h.frames.filter(f => f.method === 'turn/start')).toHaveLength(1);
    expect(h.terminals.map(t => t.identity.turnId)).toEqual(['first', 'second']);
    const next = h.engine.sendTurn('next', { turnId: 'next' });
    h.response(h.frames.at(-1)!, { turn: { id: 'next-native' } });
    await next;
    h.engine.stop();
  });

  it('native questions use the newest accepted input identity', async () => {
    const question = vi.fn(async () => ({ answers: {} }));
    const h = harness(question);
    await h.start();
    const second = h.engine.steerTurn('second', { turnId: 'second' }, 'native');
    h.response(h.frames.at(-1)!, { turnId: 'native' });
    // A native question can share the same socket read with the ACK. Its
    // identity must already be bound before the sender's await continuation.
    h.internal.onMessage(JSON.stringify({ id: 900, method: 'item/tool/requestUserInput',
      params: { threadId: 'thread', turnId: 'native', questions: [] } }));
    await second;
    await vi.waitFor(() => expect(question).toHaveBeenCalled());
    expect(question.mock.calls[0][2]).toEqual({ turnId: 'second' });
    h.engine.stop();
  });
});
