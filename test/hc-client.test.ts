import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { HcClient, HcError, type HcChannelClose, type HcChunkInfo, type HcDisconnect } from '../src/adapters/backend/hc/client.js';
import type { HcEvent, HcSnapshot } from '../src/adapters/backend/hc/types.js';
import {
  FRAME_AUTOMATIC_INPUT,
  FRAME_CLOSE,
  FRAME_CREDIT,
  FRAME_DATA,
  FRAME_FACTS,
  FRAME_FOCUS,
  FRAME_RESIZE,
  FrameDecoder,
  MAX_FRAME_PAYLOAD,
  STREAM_CHUNK,
  STREAM_WINDOW,
  decodeCredit,
  encodeFrame,
  encodeResize,
  type Frame,
} from '../src/adapters/backend/hc/wire.js';

interface Req { id: number; method: string; params: Record<string, unknown> }

const HELLO = {
  generation: 1,
  version: '0.1.19',
  core: { id: 'fake', name: 'fake' },
  framed: true,
  methods: ['terminal.attach', 'events.subscribe'],
  features: ['framed', 'attach', 'events', 'automatic_input'],
};

const PAINT = Buffer.from('\x18\x1b[!p\x1b[?2026l\x1b[H\x1b[2Jready\x1b[?9001l', 'latin1');

class FakeConn {
  readonly frames: Frame[] = [];
  hello: unknown = null;
  private readonly decoder = new FrameDecoder();
  private line = Buffer.alloc(0);
  private framed = false;

  constructor(readonly socket: Socket, private readonly core: FakeCore) {
    socket.on('data', chunk => this.data(chunk));
    socket.on('error', () => {});
  }

  send(channel: number, kind: number, payload?: string | Uint8Array): void {
    this.socket.write(encodeFrame(channel, kind, typeof payload === 'string' ? Buffer.from(payload) : payload));
  }

  reply(id: number, result: unknown): void {
    this.send(0, FRAME_DATA, JSON.stringify({ jsonrpc: '2.0', id, result }));
  }

  sentOn(channel: number): Frame[] {
    return this.frames.filter(f => f.channel === channel && f.kind !== FRAME_CREDIT);
  }

  credit(channel: number): number {
    return this.frames
      .filter(f => f.channel === channel && f.kind === FRAME_CREDIT)
      .reduce((sum, f) => sum + (decodeCredit(f.payload) ?? 0), 0);
  }

  requests(method: string): Req[] {
    return this.frames
      .filter(f => f.channel === 0)
      .map(f => JSON.parse(f.payload.toString()) as Req)
      .filter(r => r.method === method);
  }

  private data(chunk: Buffer): void {
    if (!this.framed) {
      this.line = Buffer.concat([this.line, chunk]);
      const nl = this.line.indexOf(0x0a);
      if (nl < 0) return;
      this.hello = JSON.parse(this.line.subarray(0, nl).toString());
      const reply = this.core.helloReply(this.hello);
      if (reply === null) return;
      this.framed = true;
      for (const byte of Buffer.from(`${reply}\n`)) this.socket.write(Buffer.of(byte));
      chunk = this.line.subarray(nl + 1);
    }
    for (const frame of this.decoder.push(chunk)) {
      const copy = { ...frame, payload: Buffer.from(frame.payload) };
      this.frames.push(copy);
      if (copy.channel === 0 && copy.kind === FRAME_DATA) {
        const req = JSON.parse(copy.payload.toString()) as Req;
        if (req.method === 'ping') this.reply(req.id, { pong: true });
        else this.core.onRequest(req, this);
      } else {
        this.core.onFrame(copy, this);
      }
    }
  }
}

class FakeCore {
  readonly conns: FakeConn[] = [];
  helloReply: (req: unknown) => string | null = () => JSON.stringify({ jsonrpc: '2.0', id: 0, result: HELLO });
  onRequest: (req: Req, conn: FakeConn) => void = () => {};
  onFrame: (frame: Frame, conn: FakeConn) => void = () => {};

  private constructor(private readonly server: Server, readonly path: string) {
    server.on('connection', socket => this.conns.push(new FakeConn(socket, this)));
  }

  static start(path: string): Promise<FakeCore> {
    const server = createServer();
    const core = new FakeCore(server, path);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve(core));
    });
  }

  get conn(): FakeConn {
    return this.conns.at(-1)!;
  }

  stop(): Promise<void> {
    for (const conn of this.conns) conn.socket.destroy();
    return new Promise(resolve => this.server.close(() => resolve()));
  }
}

const dir = mkdtempSync('/tmp/hcc-');
let serial = 0;
const cores: FakeCore[] = [];
const clients: HcClient[] = [];

async function fake(): Promise<FakeCore> {
  const core = await FakeCore.start(join(dir, `c${++serial}.sock`));
  cores.push(core);
  return core;
}

async function connect(core: FakeCore): Promise<HcClient> {
  const client = await HcClient.connect(core.path, { timeoutMs: 3000 });
  clients.push(client);
  return client;
}

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/** Everything either side wrote before this has been read by the other. */
async function settle(client: HcClient): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await client.call('ping');
}

function rejection(promise: Promise<unknown>): Promise<HcError> {
  return promise.then(
    () => { throw new Error('expected a rejection'); },
    (err: unknown) => {
      expect(err).toBeInstanceOf(HcError);
      return err as HcError;
    },
  );
}

function serveAttach(core: FakeCore, channel: number, after?: (conn: FakeConn) => void): void {
  core.onRequest = (req, conn) => {
    if (req.method !== 'terminal.attach') return;
    conn.reply(req.id, { channel, terminal: { address: req.params.terminal, state: 'live' }, resize_notifications: false });
    after?.(conn);
  };
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const core of cores.splice(0)) await core.stop();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('HcClient', () => {
  describe('connecting', () => {
    it('reports unreachable when nothing listens at the socket, without creating one', async () => {
      const missing = join(dir, 'missing.sock');
      expect((await rejection(HcClient.connect(missing))).code).toBe('unreachable');
      const notSocket = join(dir, 'plain-file');
      writeFileSync(notSocket, '');
      // Darwin reports ENOTSOCK for a plain file, while Linux reports ECONNREFUSED.
      expect((await rejection(HcClient.connect(notSocket))).code).toBe(process.platform === 'darwin' ? 'io' : 'unreachable');
    });

    it('sends a generation-1 framed hello and then speaks frames', async () => {
      const core = await fake();
      const client = await connect(core);
      expect(core.conn.hello).toEqual({ jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: 1, framed: true } });
      expect(client.version).toBe('0.1.19');
      expect(client.hasFeature('automatic_input')).toBe(true);
      expect(client.hasFeature('shell')).toBe(false);
      await expect(client.call('ping')).resolves.toEqual({ pong: true });
    });

    it('refuses a core that rejects the hello, stays line-based, speaks another generation or hangs up', async () => {
      const core = await fake();
      core.helloReply = () => JSON.stringify({
        jsonrpc: '2.0', id: 0,
        error: { code: -32000, message: 'unsupported generation', data: { kind: 'unsupported_generation', hint: 'upgrade' } },
      });
      const refused = await rejection(HcClient.connect(core.path));
      expect([refused.code, refused.kind, refused.hint]).toEqual(['rpc', 'unsupported_generation', 'upgrade']);

      core.helloReply = () => JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ...HELLO, framed: false } });
      expect((await rejection(HcClient.connect(core.path))).code).toBe('protocol');

      core.helloReply = () => JSON.stringify({ jsonrpc: '2.0', id: 0, result: { ...HELLO, generation: 2 } });
      expect((await rejection(HcClient.connect(core.path))).code).toBe('protocol');

      core.helloReply = () => {
        setImmediate(() => core.conn.socket.destroy());
        return null;
      };
      expect((await rejection(HcClient.connect(core.path))).code).toBe('disconnected');

      core.helloReply = () => null;
      expect((await rejection(HcClient.connect(core.path, { timeoutMs: 30 }))).code).toBe('timeout');
    });
  });

  describe('calls', () => {
    it('matches concurrent replies to their requests by id', async () => {
      const core = await fake();
      const held: Req[] = [];
      core.onRequest = (req, conn) => {
        held.push(req);
        if (held.length < 3) return;
        for (const r of [...held].reverse()) conn.reply(r.id, { echo: r.params.n });
      };
      const client = await connect(core);
      const results = await Promise.all([1, 2, 3].map(n => client.call('terminal.get', { n })));
      expect(results).toEqual([{ echo: 1 }, { echo: 2 }, { echo: 3 }]);
      expect(new Set(held.map(r => r.id)).size).toBe(3);
    });

    it('rejects with the error kind and hint the core gives', async () => {
      const core = await fake();
      core.onRequest = (req, conn) => conn.send(0, FRAME_DATA, JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        error: { code: -32001, message: 'no terminal t9', data: { kind: 'not_found', hint: 'hc list' } },
      }));
      const client = await connect(core);
      const err = await rejection(client.call('terminal.get', { terminal: 't9' }));
      expect([err.code, err.kind, err.hint, err.rpcCode]).toEqual(['rpc', 'not_found', 'hc list', -32001]);
      expect(err.message).toContain('no terminal t9');
    });

    it('times a call out, ignores its late reply and keeps the connection', async () => {
      const core = await fake();
      const client = await connect(core);
      const err = await rejection(client.call('terminal.wait', {}, { timeoutMs: 20 }));
      expect(err.code).toBe('timeout');
      await until(() => core.conn.requests('terminal.wait').length === 1, 'the wait request');
      core.conn.reply(core.conn.requests('terminal.wait')[0]!.id, { late: true });
      await expect(client.call('ping')).resolves.toEqual({ pong: true });
      expect(client.closed).toBe(false);
    });

    it('ends pending calls, streams and subscriptions when the connection drops', async () => {
      const core = await fake();
      core.onRequest = (req, conn) => {
        if (req.method === 'terminal.attach') conn.reply(req.id, { channel: 1, terminal: { address: 't1' } });
        if (req.method === 'events.subscribe') conn.reply(req.id, { channel: 2, seq: 0, terminals: [] });
      };
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
      const sub = await client.subscribe();
      const closes: HcChannelClose[] = [];
      stream.onClose(info => closes.push(info));
      stream.onData(() => {});
      sub.onClose(info => closes.push(info));
      sub.onEvent(() => {});
      const disconnects: HcDisconnect[] = [];
      client.onDisconnect(info => disconnects.push(info));
      const pending = rejection(client.call('terminal.wait'));
      await until(() => core.conn.requests('terminal.wait').length === 1, 'the wait request');

      core.conn.socket.destroy();

      expect((await pending).code).toBe('disconnected');
      await until(() => disconnects.length === 1, 'the disconnect');
      expect(closes.map(c => c.kind)).toEqual(['disconnected', 'disconnected']);
      expect(stream.writeAutomatic('x')).toBe(false);
      expect((await rejection(client.call('ping'))).code).toBe('disconnected');
      const late: HcDisconnect[] = [];
      client.onDisconnect(info => late.push(info));
      expect(late).toEqual(disconnects);
    });

    it('ends the connection as closed when this side closes it', async () => {
      const core = await fake();
      const client = await connect(core);
      const disconnects: HcDisconnect[] = [];
      client.onDisconnect(info => disconnects.push(info));
      client.close();
      expect(disconnects.map(d => d.error.code)).toEqual(['closed']);
      await until(() => core.conn.socket.destroyed || core.conn.socket.readableEnded, 'the core to see the hang-up');
    });
  });

  describe('attach streams', () => {
    it('sends attach params as hc 0.1.19 names them and opens the replied channel', async () => {
      const core = await fake();
      serveAttach(core, 5, conn => {
        conn.send(5, FRAME_DATA, Buffer.concat([PAINT, Buffer.from('live')]));
        conn.send(5, FRAME_DATA, 'more');
      });
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 100, rows: 30, display: { cell: [9, 18] } });
      expect(core.conn.requests('terminal.attach')[0]!.params).toEqual({
        terminal: 't1', cols: 100, rows: 30, observe: false, resize_notifications: false, history: 0, resumed: false,
        display: { cell: [9, 18] },
      });
      expect(stream.channel).toBe(5);
      expect(stream.terminal.address).toBe('t1');
      const chunks: Array<[string, HcChunkInfo]> = [];
      stream.onData((chunk, info) => chunks.push([chunk.toString('latin1'), info]));
      await until(() => chunks.length === 3, 'paint and live data');
      expect(chunks).toEqual([
        [PAINT.toString('latin1'), { paint: true, firstPaint: true, paintDone: true }],
        ['live', { paint: false, firstPaint: false, paintDone: false }],
        ['more', { paint: false, firstPaint: false, paintDone: false }],
      ]);
    });

    it('holds data and credit until the first data listener, then credits every byte it delivers', async () => {
      const core = await fake();
      const payloads = [PAINT, Buffer.alloc(STREAM_CHUNK, 0x61), Buffer.from('tail')];
      serveAttach(core, 1, conn => { for (const p of payloads) conn.send(1, FRAME_DATA, p); });
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
      await settle(client);
      expect(core.conn.credit(1)).toBe(0);

      let received = 0;
      stream.onData(chunk => { received += chunk.length; });
      const total = payloads.reduce((n, p) => n + p.length, 0);
      expect(received).toBe(total);
      await until(() => core.conn.credit(1) === total, 'credit for the delivered bytes');
    });

    it('keeps a stream flowing well past the credit window', async () => {
      const core = await fake();
      const total = 6 * STREAM_WINDOW + 123;
      let credit = STREAM_WINDOW;
      let sent = 0;
      let peer: FakeConn | null = null;
      const pump = () => {
        while (peer && sent < total && credit > 0) {
          const n = Math.min(STREAM_CHUNK, credit, total - sent);
          peer.send(1, FRAME_DATA, Buffer.alloc(n, 0x62));
          credit -= n;
          sent += n;
        }
      };
      serveAttach(core, 1, conn => { peer = conn; pump(); });
      core.onFrame = frame => {
        if (frame.channel !== 1 || frame.kind !== FRAME_CREDIT) return;
        credit += decodeCredit(frame.payload) ?? 0;
        pump();
      };
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
      let received = 0;
      stream.onData(chunk => { received += chunk.length; });
      await until(() => received === total, 'every byte of the stream');
      expect(sent).toBe(total);
    });

    it('reports the core CLOSE with its exit after all data, also to late listeners', async () => {
      const core = await fake();
      const end = { reason: 'exited', exit_code: 7, signal: null, finished_ms: 1234 };
      serveAttach(core, 1, conn => {
        conn.send(1, FRAME_DATA, PAINT);
        conn.send(1, FRAME_DATA, 'got:hello\r\n');
        conn.send(1, FRAME_CLOSE, JSON.stringify(end));
      });
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
      const order: string[] = [];
      stream.onClose(info => order.push(`close:${JSON.stringify(info)}`));
      stream.onData(chunk => order.push(`data:${chunk.length}`));
      await until(() => order.length === 3, 'data then close');
      expect(order).toEqual([`data:${PAINT.length}`, 'data:11', `close:${JSON.stringify({ kind: 'ended', end })}`]);
      const late: HcChannelClose[] = [];
      stream.onClose(info => late.push(info));
      expect(late).toEqual([{ kind: 'ended', end }]);
      expect(stream.closed).toBe(true);
      expect(stream.writeAutomatic('x')).toBe(false);
      expect(stream.resize(80, 24)).toBe(false);

      const signaled = { reason: 'killed', exit_code: null, signal: 1, finished_ms: 99 };
      serveAttach(core, 2, conn => {
        conn.send(2, FRAME_DATA, 'bye\x18');
        conn.send(2, FRAME_CLOSE, JSON.stringify(signaled));
      });
      const killed = await client.attach({ terminal: 't2', cols: 80, rows: 24 });
      const events: string[] = [];
      killed.onClose(info => events.push(JSON.stringify(info)));
      killed.onData(chunk => events.push(chunk.toString('latin1')));
      await until(() => events.length === 3, 'the last output and the kill');
      expect(events.slice(0, 2).join('')).toBe('bye\x18');
      expect(events[2]).toBe(JSON.stringify({ kind: 'ended', end: signaled }));
    });

    it('detaches with a CLOSE frame and drops what was still in flight', async () => {
      const core = await fake();
      serveAttach(core, 1, conn => conn.send(1, FRAME_DATA, PAINT));
      core.onFrame = (frame, conn) => {
        if (frame.channel !== 1 || frame.kind !== FRAME_CLOSE) return;
        conn.send(1, FRAME_DATA, 'in flight');
        conn.send(1, FRAME_CLOSE);
      };
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
      const seen: string[] = [];
      stream.onData(chunk => seen.push(chunk.toString('latin1')));
      await until(() => seen.length === 1, 'the paint');
      const closes: HcChannelClose[] = [];
      stream.onClose(info => closes.push(info));
      stream.close();
      expect(closes).toEqual([{ kind: 'detached' }]);
      await until(() => core.conn.sentOn(1).some(f => f.kind === FRAME_CLOSE), 'the CLOSE frame');
      await settle(client);
      expect(seen).toEqual([PAINT.toString('latin1')]);
      expect(core.conn.sentOn(1).map(f => f.kind)).toEqual([FRAME_CLOSE]);
    });

    it('sends automatic input, typed input and controls as their own frame kinds', async () => {
      const core = await fake();
      serveAttach(core, 1);
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24 });
      expect(stream.writeAutomatic('hello\r')).toBe(true);
      expect(stream.writeHuman(Uint8Array.of(3))).toBe(true);
      expect(stream.resize(120, 40)).toBe(true);
      expect(stream.focus(true)).toBe(true);
      expect(stream.facts({ fg: '#ffffff' })).toBe(true);
      await until(() => core.conn.sentOn(1).length === 5, 'five frames');
      expect(core.conn.sentOn(1).map(f => [f.kind, [...f.payload]])).toEqual([
        [FRAME_AUTOMATIC_INPUT, [...Buffer.from('hello\r')]],
        [FRAME_DATA, [3]],
        [FRAME_RESIZE, [...encodeResize(120, 40)]],
        [FRAME_FOCUS, [1]],
        [FRAME_FACTS, [...Buffer.from(JSON.stringify({ fg: '#ffffff' }))]],
      ]);
    });

    it('sends nothing from an observer', async () => {
      const core = await fake();
      serveAttach(core, 1);
      const client = await connect(core);
      const stream = await client.attach({ terminal: 't1', cols: 80, rows: 24, observe: true });
      expect(core.conn.requests('terminal.attach')[0]!.params.observe).toBe(true);
      expect([
        stream.writeAutomatic('x'), stream.writeHuman('x'), stream.resize(100, 30), stream.focus(true), stream.facts({}),
      ]).toEqual([false, false, false, false, false]);
      await settle(client);
      expect(core.conn.sentOn(1)).toEqual([]);
    });

    it('closes the stream that a reply arriving after its timeout opened', async () => {
      const core = await fake();
      const client = await connect(core);
      const err = await rejection(client.attach({ terminal: 't1', cols: 80, rows: 24 }, { timeoutMs: 20 }));
      expect(err.code).toBe('timeout');
      await until(() => core.conn.requests('terminal.attach').length === 1, 'the attach request');
      const req = core.conn.requests('terminal.attach')[0]!;
      core.conn.reply(req.id, { channel: 3, terminal: { address: 't1' } });
      core.conn.send(3, FRAME_DATA, PAINT);
      await until(() => core.conn.sentOn(3).some(f => f.kind === FRAME_CLOSE), 'a CLOSE for the orphaned channel');
      expect(core.conn.credit(3)).toBe(0);
    });
  });

  describe('event subscriptions', () => {
    const line = (method: string, params: object) => `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
    const event = (seq: number, type: string, data: object | null = {}) => line('event', { type, terminal: 't1', data, seq });

    it('delivers events in order, including those sent before the reply and lines split across frames', async () => {
      const core = await fake();
      let bytes = 0;
      const send = (conn: FakeConn, text: string) => {
        bytes += Buffer.byteLength(text);
        conn.send(1, FRAME_DATA, text);
      };
      core.onRequest = (req, conn) => {
        if (req.method !== 'events.subscribe') return;
        const early = event(11, 'created', { address: 't1' });
        send(conn, early.slice(0, 10));
        send(conn, early.slice(10));
        conn.reply(req.id, { seq: 10, terminals: [{ address: 't1' }], channel: 1 });
        send(conn, event(9, 'stale') + line('heartbeat', { seq: 11 }) + event(12, 'foreground', null));
      };
      const client = await connect(core);
      const sub = await client.subscribe({ terminal: 't1' });
      expect(core.conn.requests('events.subscribe')[0]!.params).toEqual({ terminal: 't1' });
      expect(sub.snapshot).toEqual({ seq: 10, terminals: [{ address: 't1' }] });

      const events: HcEvent[] = [];
      const missed: HcSnapshot[] = [];
      const heartbeats: number[] = [];
      sub.onHeartbeat(seq => heartbeats.push(seq));
      sub.onMissed(snapshot => missed.push(snapshot));
      sub.onEvent(e => events.push(e));
      await until(() => events.length === 2, 'the first two events');
      expect(events).toEqual([
        { type: 'created', terminal: 't1', data: { address: 't1' }, seq: 11 },
        { type: 'foreground', terminal: 't1', data: null, seq: 12 },
      ]);
      expect(heartbeats).toEqual([11]);

      const tail = line('missed', { seq: 20, terminals: [] }) + event(15, 'stale') + event(21, 'finished', { exit_code: 7 });
      send(core.conn, tail.slice(0, 50));
      send(core.conn, tail.slice(50));
      await until(() => events.length === 3, 'the event after the gap');
      expect(missed).toEqual([{ seq: 20, terminals: [] }]);
      expect(sub.snapshot).toEqual({ seq: 20, terminals: [] });
      expect(events[2]).toMatchObject({ type: 'finished', seq: 21, data: { exit_code: 7 } });
      expect(sub.seq).toBe(21);
      await until(() => core.conn.credit(1) === bytes, 'credit for every event byte');
    });

    it('returns credit for event lines nobody listens to yet', async () => {
      const core = await fake();
      const text = event(2, 'created').repeat(50);
      core.onRequest = (req, conn) => {
        conn.reply(req.id, { seq: 1, terminals: [], channel: 1 });
        conn.send(1, FRAME_DATA, text);
      };
      const client = await connect(core);
      await client.subscribe();
      await until(() => core.conn.credit(1) === Buffer.byteLength(text), 'credit without a listener');
    });

    it('unsubscribes with a CLOSE frame', async () => {
      const core = await fake();
      core.onRequest = (req, conn) => conn.reply(req.id, { seq: 0, terminals: [], channel: 4 });
      const client = await connect(core);
      const sub = await client.subscribe();
      const closes: HcChannelClose[] = [];
      sub.onClose(info => closes.push(info));
      sub.close();
      expect(closes).toEqual([{ kind: 'detached' }]);
      await until(() => core.conn.sentOn(4).some(f => f.kind === FRAME_CLOSE), 'the CLOSE frame');
    });

    it('drops the connection when an event stream stays silent past the heartbeat timeout', async () => {
      const core = await fake();
      core.onRequest = (req, conn) => conn.reply(req.id, { seq: 0, terminals: [], channel: 1 });
      const client = await connect(core);
      const sub = await client.subscribe({}, { heartbeatTimeoutMs: 40 });
      const closes: HcChannelClose[] = [];
      sub.onClose(info => closes.push(info));
      sub.onEvent(() => {});
      const disconnects: HcDisconnect[] = [];
      client.onDisconnect(info => disconnects.push(info));
      await until(() => disconnects.length === 1, 'the silence timeout');
      expect(disconnects[0]!.error.code).toBe('timeout');
      expect(closes.map(c => c.kind)).toEqual(['disconnected']);
    });
  });

  describe('protocol errors', () => {
    it('drops the connection on an oversized frame or an unreadable reply', async () => {
      const core = await fake();
      const first = await connect(core);
      const header = Buffer.alloc(9);
      header.writeUInt32LE(MAX_FRAME_PAYLOAD + 1, 5);
      const firstDown: HcDisconnect[] = [];
      first.onDisconnect(info => firstDown.push(info));
      core.conn.socket.write(header);
      await until(() => firstDown.length === 1, 'the oversized frame');
      expect(firstDown[0]!.error.code).toBe('protocol');

      const second = await connect(core);
      const secondDown: HcDisconnect[] = [];
      second.onDisconnect(info => secondDown.push(info));
      core.conn.send(0, FRAME_DATA, 'not json');
      await until(() => secondDown.length === 1, 'the unreadable reply');
      expect(secondDown[0]!.error.code).toBe('protocol');
    });
  });
});
