import { describe, expect, it } from 'vitest';
import { SharedThreadClient, openSharedThread } from '../src/core/shared-thread-opening.js';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import type { Session } from '../src/types.js';

function fixture() {
  let session = { status: 'active', cliId: 'codex', sharedThreadOpening: {
    endpoint: 'unix:///tmp/shared.sock', cwd: '/tmp/project', title: 'New topic',
  } } as Session;
  const calls: string[] = [];
  const mutate = <T>(change: (row: Session) => T): T => {
    const copy = structuredClone(session);
    const result = change(copy);
    session = copy;
    return result;
  };
  const remote = { async request(method: string): Promise<any> {
    calls.push(method);
    return { thread: { id: 'native-thread' } };
  } };
  return { mutate, remote, calls, row: () => session, run: () => openSharedThread(mutate, remote) };
}

describe('new shared thread binding', () => {
  it('creates and binds without sending a turn', async () => {
    const f = fixture();
    await f.run();
    expect(f.calls).toEqual(['thread/start', 'thread/read', 'thread/name/set']);
    expect(f.row()).toMatchObject({ cliSessionId: 'native-thread', existingAppServerEndpoint: 'unix:///tmp/shared.sock' });
    await f.run();
    expect(f.calls.filter(method => method === 'thread/start')).toHaveLength(1);
  });

  it('resets an explicit serviceTier so the remote worker can attach', async () => {
    const f = fixture();
    f.row().serviceTier = 'priority';
    await f.run();
    expect(f.row().serviceTier).toBe('inherit');
    // The already-bound idempotent re-entry must keep the reset as well.
    f.row().serviceTier = 'priority';
    await f.run();
    expect(f.row().serviceTier).toBe('inherit');
  });

  it('retries preparation after a crash with the already persisted ID', async () => {
    const f = fixture();
    f.remote.request = async method => {
      if (method === 'thread/read') throw new Error('disconnected');
      return { thread: { id: 'native-thread' } };
    };
    await expect(f.run()).rejects.toThrow('disconnected');
    expect(f.row().sharedThreadOpening).toMatchObject({ phase: 'created', threadId: 'native-thread' });
    f.remote.request = async method => {
      expect(method).not.toBe('thread/start');
      return { thread: { id: 'native-thread' } };
    };
    await f.run();
    expect(f.row().cliSessionId).toBe('native-thread');
  });

  it('retains a received ID when the worker generation changes', async () => {
    const f = fixture();
    f.remote.request = async () => {
      f.row().workerGeneration = 2;
      return { thread: { id: 'native-thread' } };
    };
    await f.run();
    expect(f.row().sharedThreadOpening?.threadId).toBe('native-thread');
  });

  it('does not recreate when the creation reply was lost', async () => {
    const f = fixture();
    f.remote.request = async () => { throw new Error('lost reply'); };
    await expect(f.run()).rejects.toThrow('lost reply');
    await expect(f.run()).rejects.toThrow('result unknown');
  });

  it('does not create in the old directory if the route changed while connecting', async () => {
    const f = fixture();
    f.row().projectRouteRevision = 3;
    await expect(f.run()).rejects.toThrow('route changed');
    expect(f.calls).toEqual([]);
  });

  it('persists identity but refuses binding after close', async () => {
    const f = fixture();
    f.remote.request = async () => {
      f.row().status = 'closed';
      return { thread: { id: 'native-thread' } };
    };
    await expect(f.run()).rejects.toThrow('changed before binding');
    expect(f.row().sharedThreadOpening?.threadId).toBe('native-thread');
    expect(f.row().cliSessionId).toBeUndefined();
  });

  it('retains the receipt but does not bind after a route change', async () => {
    const f = fixture();
    f.remote.request = async () => {
      f.row().projectRouteRevision = 3;
      return { thread: { id: 'native-thread' } };
    };
    await expect(f.run()).rejects.toThrow('changed before binding');
    expect(f.row().sharedThreadOpening?.threadId).toBe('native-thread');
    expect(f.row().cliSessionId).toBeUndefined();
    await expect(f.run()).rejects.toThrow('route changed');
  });

  it('does not publish a half binding if the transaction fails', async () => {
    const f = fixture();
    await expect(openSharedThread(change => f.mutate(row => {
      const result = change(row);
      if (row.cliSessionId) throw new Error('disk full');
      return result;
    }), f.remote)).rejects.toThrow('disk full');
    expect(f.row().sharedThreadOpening?.threadId).toBe('native-thread');
    expect(f.row().cliSessionId).toBeUndefined();
    await f.run();
    expect(f.calls.filter(method => method === 'thread/start')).toHaveLength(1);
  });
});

it('rejects an outstanding request when the shared WebSocket disconnects', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  server.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(String(data));
    if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: {} }));
    if (request.method === 'thread/start') socket.close();
  }));
  const client = new SharedThreadClient(`ws://127.0.0.1:${address.port}`);
  try {
    await client.initialize();
    await expect(client.request('thread/start', {})).rejects.toThrow('disconnected');
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('uses JSON-RPC 2.0 for requests, notifications and bootstrap error responses', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const received: any[] = [];
  let pendingRead: any;
  server.on('connection', socket => socket.on('message', data => {
    const message = JSON.parse(String(data));
    received.push(message);
    if (message.method === 'initialize') {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'unsupported/server-request' }));
    }
    const answerRead = (request: any) => socket.send(JSON.stringify({
      jsonrpc: '2.0', id: request.id, result: { thread: { id: 'native-thread' } },
    }));
    if (message.id === 90 && message.error && pendingRead) answerRead(pendingRead);
    if (message.method === 'thread/read') {
      if (received.some(item => item.id === 90 && item.error)) answerRead(message);
      else pendingRead = message;
    }
  }));
  const client = new SharedThreadClient(`ws://127.0.0.1:${address.port}`);
  try {
    await client.initialize();
    await client.request('thread/read', { threadId: 'native-thread' });
    expect(received).toHaveLength(4);
    expect(received.every(message => message.jsonrpc === '2.0')).toBe(true);
    expect(received).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: 'initialize' }),
      expect.objectContaining({ method: 'initialized' }),
      expect.objectContaining({ method: 'thread/read' }),
      expect.objectContaining({ id: 90, error: expect.objectContaining({ code: -32601 }) }),
    ]));
  } finally {
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
