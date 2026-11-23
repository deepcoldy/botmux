/**
 * Native herdr-core client over one framed unix-socket connection. It never
 * starts a core: a missing or refused socket is an `unreachable` HcError, and
 * starting one (with a curated env) is the caller's decision.
 */
import { connect as netConnect, type Socket } from 'node:net';
import { logger } from '../../../utils/logger.js';
import { PaintTracker, type StreamSegment } from './paint.js';
import {
  FRAME_AUTOMATIC_INPUT,
  FRAME_CLOSE,
  FRAME_DATA,
  FRAME_FACTS,
  FRAME_FOCUS,
  FRAME_RESIZE,
  FrameDecoder,
  HC_PROTOCOL_GENERATION,
  MAX_FRAME_PAYLOAD,
  RPC_CHANNEL,
  creditFrames,
  decodeResize,
  encodeFrame,
  encodeResize,
  type CellSize,
  type Frame,
} from './wire.js';
import {
  parseHcEnd,
  type HcAttachParams,
  type HcDisplay,
  type HcEnd,
  type HcEvent,
  type HcHello,
  type HcSnapshot,
  type HcSubscribeParams,
  type HcTerminalRecord,
} from './types.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const MAX_HELLO_LINE_BYTES = 1 << 20;

/**
 * - unreachable: nothing listens at the socket (ENOENT, ECONNREFUSED);
 * - io: any other failure to connect (permissions, path too long, not a socket);
 * - disconnected: the connection ended or failed after it was made;
 * - closed: this client was closed;
 * - timeout: no answer in time, or an event stream went silent;
 * - protocol: the core sent something this client cannot read;
 * - rpc: the core answered with an error (`kind` holds hc's error kind).
 */
export type HcErrorCode = 'unreachable' | 'io' | 'disconnected' | 'closed' | 'timeout' | 'protocol' | 'rpc';

export class HcError extends Error {
  override name = 'HcError';
  readonly code: HcErrorCode;
  /** hc's error kind for `rpc`: not_found, finished, unavailable, live, name_taken, ... */
  readonly kind: string | undefined;
  readonly hint: string | undefined;
  readonly rpcCode: number | undefined;

  constructor(
    code: HcErrorCode,
    message: string,
    detail: { kind?: string; hint?: string; rpcCode?: number; cause?: unknown } = {},
  ) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.code = code;
    this.kind = detail.kind;
    this.hint = detail.hint;
    this.rpcCode = detail.rpcCode;
  }
}

export function isHcError(err: unknown, code?: HcErrorCode): err is HcError {
  return err instanceof HcError && (code === undefined || err.code === code);
}

export interface HcCallOptions {
  /** Non-finite disables the deadline. */
  timeoutMs?: number;
}

export interface HcSubscribeOptions extends HcCallOptions {
  /**
   * Ends the whole connection with a `timeout` error when the event channel
   * carries nothing for this long. The core sends a heartbeat every
   * HC_HEARTBEAT_MS (15 s by default) into an idle stream, so a few intervals
   * of silence mean a hung core.
   */
  heartbeatTimeoutMs?: number;
}

export interface HcChunkInfo {
  /** Part of a full-screen paint (CAN, reset, screen) rather than live output. */
  paint: boolean;
  /** Part of the paint that opened the stream. */
  firstPaint: boolean;
  /** The last bytes of that paint: a mirror fed everything so far shows the whole screen. */
  paintDone: boolean;
}

export type HcChannelClose =
  /** The core ended the stream: the program exited, was killed, lost, or the core stopped. */
  | { kind: 'ended'; end: HcEnd }
  /** This side closed it. */
  | { kind: 'detached' }
  | { kind: 'disconnected'; error: HcError };

export interface HcStream {
  readonly channel: number;
  /** The record as of the attach. */
  readonly terminal: HcTerminalRecord;
  readonly observe: boolean;
  readonly resizeNotifications: boolean;
  readonly closed: boolean;
  /**
   * Nothing is delivered, and no credit returned, until the first data listener
   * is registered; then everything received so far follows in order.
   */
  onData(listener: (chunk: Buffer, info: HcChunkInfo) => void): () => void;
  /** Core RESIZE before a replacement paint (observers with resizeNotifications only). */
  onResize(listener: (size: CellSize) => void): () => void;
  /** Fires once, after all data; a listener registered later gets it at once. */
  onClose(listener: (info: HcChannelClose) => void): () => void;
  /** Program-generated input (AUTOMATIC_INPUT): takes no size, never counts as a person typing. */
  writeAutomatic(bytes: string | Uint8Array): boolean;
  /** Typed input (DATA): makes this viewer the size leader and delays hc's own send/keys by its quiet period. */
  writeHuman(bytes: string | Uint8Array): boolean;
  /** Sets this viewer's size and makes it the size leader. */
  resize(cols: number, rows: number): boolean;
  focus(focused: boolean): boolean;
  facts(display: HcDisplay): boolean;
  close(): void;
}

export interface HcSubscription {
  readonly channel: number;
  /** The latest snapshot: the subscribe result, replaced by each `missed`. */
  readonly snapshot: HcSnapshot;
  /** Highest seq applied; events at or below it are dropped. */
  readonly seq: number;
  readonly closed: boolean;
  /**
   * Lines wait for the first event listener, as HcStream data waits for
   * onData; credit is returned as they arrive, so the core never marks this
   * subscriber behind for want of a listener.
   */
  onEvent(listener: (event: HcEvent) => void): () => void;
  /** The subscriber fell behind: replace all state with this snapshot. */
  onMissed(listener: (snapshot: HcSnapshot) => void): () => void;
  onHeartbeat(listener: (seq: number) => void): () => void;
  onClose(listener: (info: HcChannelClose) => void): () => void;
  close(): void;
}

export interface HcDisconnect {
  error: HcError;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: HcError) => void;
  timer: NodeJS.Timeout | null;
  /** Runs while the reply is read, before any later frame of the same read. */
  claim?: (result: unknown) => unknown;
}

interface Channel {
  receive(frame: Frame): void;
  end(info: HcChannelClose): void;
}

/** What a channel needs from its connection. */
interface Link {
  readonly alive: boolean;
  send(channel: number, kind: number, payload?: Uint8Array): boolean;
  credit(channel: number, bytes: number): void;
  /** The core ended the channel. */
  forget(channel: number): void;
  /** This side ends the channel; frames already in flight are dropped. */
  retire(channel: number): void;
  fail(error: HcError): void;
}

export class HcClient {
  readonly socketPath: string;
  readonly hello: HcHello;
  private readonly socket: Socket;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly channels = new Map<number, Channel>();
  /** Frames for channels whose reply has not been read yet (events can precede it). */
  private readonly early = new Map<number, Frame[]>();
  /** Channels closed here whose CLOSE echo has not come back. */
  private readonly retired = new Set<number>();
  private readonly credits = new Map<number, number>();
  private readonly disconnectListeners = new Set<(info: HcDisconnect) => void>();
  private disconnect: HcDisconnect | null = null;
  private nextId = 1;
  private reading = false;
  private creditQueued = false;
  private readonly link: Link;

  private constructor(socketPath: string, socket: Socket, hello: HcHello) {
    this.socketPath = socketPath;
    this.socket = socket;
    this.hello = hello;
    const client = this;
    this.link = {
      get alive() { return client.disconnect === null; },
      send: (channel, kind, payload) => this.write([encodeFrame(channel, kind, payload)]),
      credit: (channel, bytes) => this.credit(channel, bytes),
      forget: channel => this.forget(channel),
      retire: channel => this.retire(channel),
      fail: error => this.fail(error),
    };
  }

  /** Connects and switches to framed mode. Never starts a core. */
  static connect(socketPath: string, opts: HcCallOptions = {}): Promise<HcClient> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = netConnect({ path: socketPath });
      let connected = false;
      let settled = false;
      let line: Buffer[] = [];
      let lineBytes = 0;
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => fail(new HcError('timeout', `no hello from hc at ${socketPath} within ${timeoutMs}ms`)), timeoutMs)
        : null;
      timer?.unref();
      const fail = (err: HcError) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.destroy();
        reject(err);
      };
      const onError = (err: NodeJS.ErrnoException) => {
        if (connected) {
          fail(new HcError('disconnected', `hc connection failed during hello: ${err.message}`, { cause: err }));
        } else if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          fail(new HcError('unreachable', `no hc core listens at ${socketPath} (${err.code})`, { cause: err }));
        } else {
          fail(new HcError('io', `cannot connect to hc at ${socketPath}: ${err.message}`, { cause: err }));
        }
      };
      const onClose = () => fail(new HcError('disconnected', `hc closed the connection during hello at ${socketPath}`));
      const onData = (chunk: Buffer) => {
        const nl = chunk.indexOf(0x0a);
        if (nl < 0) {
          line.push(chunk);
          lineBytes += chunk.length;
          if (lineBytes > MAX_HELLO_LINE_BYTES) fail(new HcError('protocol', 'hello reply has no line end'));
          return;
        }
        line.push(chunk.subarray(0, nl));
        const rest = chunk.subarray(nl + 1);
        const text = Buffer.concat(line).toString('utf8');
        line = [];
        let hello: HcHello;
        try {
          hello = helloResult(text);
        } catch (err) {
          fail(err as HcError);
          return;
        }
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
        const client = new HcClient(socketPath, socket, hello);
        client.listen();
        resolve(client);
        if (rest.length > 0) client.onSocketData(rest);
      };
      socket.once('connect', () => {
        connected = true;
        const request = { jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: HC_PROTOCOL_GENERATION, framed: true } };
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }

  get version(): string {
    return this.hello.version;
  }

  get features(): readonly string[] {
    return this.hello.features;
  }

  hasFeature(name: string): boolean {
    return this.hello.features.includes(name);
  }

  get closed(): boolean {
    return this.disconnect !== null;
  }

  /** JSON-RPC on channel 0. Calls run concurrently in the core; replies match by id. */
  call<T = unknown>(method: string, params: object = {}, opts: HcCallOptions = {}): Promise<T> {
    return this.request(method, params, opts) as Promise<T>;
  }

  /** `terminal.attach`: a raw stream that opens with the first paint. */
  attach(params: HcAttachParams, opts: HcCallOptions = {}): Promise<HcStream> {
    const observe = params.observe ?? false;
    const wire: Record<string, unknown> = {
      terminal: params.terminal,
      cols: params.cols,
      rows: params.rows,
      observe,
      resize_notifications: params.resizeNotifications ?? false,
      history: params.history ?? 0,
      resumed: params.resumed ?? false,
    };
    if (params.display) wire.display = params.display;
    return this.request('terminal.attach', wire, opts, result => {
      const r = result as { channel?: unknown; terminal?: HcTerminalRecord; resize_notifications?: boolean };
      const channel = channelOf(r);
      const stream = new StreamChannel(this.link, channel, r.terminal as HcTerminalRecord, observe, r.resize_notifications === true);
      this.open(channel, stream);
      return stream;
    }) as Promise<HcStream>;
  }

  /** `events.subscribe`: the snapshot plus every later change, as one event stream. */
  subscribe(params: HcSubscribeParams = {}, opts: HcSubscribeOptions = {}): Promise<HcSubscription> {
    return this.request('events.subscribe', params, opts, result => {
      const r = result as { channel?: unknown; seq?: unknown; terminals?: unknown };
      const channel = channelOf(r);
      const snapshot: HcSnapshot = {
        seq: typeof r.seq === 'number' ? r.seq : 0,
        terminals: Array.isArray(r.terminals) ? r.terminals as HcTerminalRecord[] : [],
      };
      const sub = new EventChannel(this.link, channel, snapshot, opts.heartbeatTimeoutMs);
      this.open(channel, sub);
      return sub;
    }) as Promise<HcSubscription>;
  }

  /** Fires once when the connection ends, for any reason; a listener registered later gets it at once. */
  onDisconnect(listener: (info: HcDisconnect) => void): () => void {
    if (this.disconnect) {
      safely(() => listener(this.disconnect!));
      return () => {};
    }
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  /** Drops the connection. Terminals keep running; attached streams end as `disconnected`. */
  close(): void {
    this.fail(new HcError('closed', 'hc client closed'));
  }

  private listen(): void {
    this.socket.on('data', chunk => this.onSocketData(chunk));
    this.socket.on('error', err => this.fail(new HcError('disconnected', `hc connection failed: ${err.message}`, { cause: err })));
    this.socket.on('close', () => this.fail(new HcError('disconnected', `hc closed the connection at ${this.socketPath}`)));
  }

  private onSocketData(chunk: Buffer): void {
    if (this.disconnect) return;
    let frames: Frame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.fail(new HcError('protocol', (err as Error).message, { cause: err }));
      return;
    }
    this.reading = true;
    try {
      for (const frame of frames) {
        if (this.disconnect) return;
        this.dispatch(frame);
      }
    } finally {
      this.reading = false;
    }
    this.flushCredit();
  }

  private dispatch(frame: Frame): void {
    if (frame.channel === RPC_CHANNEL) {
      if (frame.kind === FRAME_DATA) this.reply(frame.payload);
      return;
    }
    const channel = this.channels.get(frame.channel);
    if (channel) {
      channel.receive(frame);
      return;
    }
    if (this.retired.has(frame.channel)) {
      if (frame.kind === FRAME_CLOSE) this.retired.delete(frame.channel);
      return;
    }
    // The core never ends a channel before its reply; this is a second CLOSE
    // (program end crossing our detach).
    if (frame.kind === FRAME_CLOSE) return;
    const held = this.early.get(frame.channel);
    if (held) held.push(frame);
    else this.early.set(frame.channel, [frame]);
  }

  private reply(payload: Buffer): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: { kind?: unknown; hint?: unknown } } };
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch (err) {
      this.fail(new HcError('protocol', `unreadable reply from hc: ${(err as Error).message}`, { cause: err }));
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) {
      // The caller gave up; a stream opened by this late reply would hold credit forever.
      const late = message.result as { channel?: unknown } | undefined;
      if (typeof late?.channel === 'number') this.abandon(late.channel);
      return;
    }
    this.pending.delete(message.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      const e = message.error;
      pending.reject(new HcError('rpc', `${pending.method}: ${typeof e.message === 'string' ? e.message : 'failed'}`, {
        kind: typeof e.data?.kind === 'string' ? e.data.kind : undefined,
        hint: typeof e.data?.hint === 'string' && e.data.hint ? e.data.hint : undefined,
        rpcCode: typeof e.code === 'number' ? e.code : undefined,
      }));
      return;
    }
    if (!pending.claim) {
      pending.resolve(message.result);
      return;
    }
    try {
      pending.resolve(pending.claim(message.result));
    } catch (err) {
      pending.reject(isHcError(err) ? err : new HcError('protocol', `${pending.method}: ${(err as Error).message}`, { cause: err }));
    }
  }

  private request(method: string, params: object, opts: HcCallOptions, claim?: (result: unknown) => unknown): Promise<unknown> {
    if (this.disconnect) return Promise.reject(this.disconnect.error);
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    if (payload.length > MAX_FRAME_PAYLOAD) {
      return Promise.reject(new HcError('protocol', `${method}: request of ${payload.length} bytes exceeds ${MAX_FRAME_PAYLOAD}`));
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new HcError('timeout', `${method}: no reply within ${timeoutMs}ms`));
        }, timeoutMs)
        : null;
      timer?.unref();
      this.pending.set(id, { method, resolve, reject, timer, claim });
      this.write([encodeFrame(RPC_CHANNEL, FRAME_DATA, payload)]);
    });
  }

  private open(channel: number, sink: Channel): void {
    this.channels.set(channel, sink);
    const held = this.early.get(channel);
    if (!held) return;
    this.early.delete(channel);
    for (const frame of held) {
      if (this.channels.get(channel) !== sink) break;
      sink.receive(frame);
    }
  }

  private abandon(channel: number): void {
    this.early.delete(channel);
    this.retire(channel);
    this.write([encodeFrame(channel, FRAME_CLOSE)]);
  }

  private forget(channel: number): void {
    this.channels.delete(channel);
    this.credits.delete(channel);
  }

  private retire(channel: number): void {
    this.forget(channel);
    this.retired.add(channel);
  }

  private credit(channel: number, bytes: number): void {
    if (bytes <= 0 || this.disconnect || !this.channels.has(channel)) return;
    this.credits.set(channel, (this.credits.get(channel) ?? 0) + bytes);
    if (this.reading || this.creditQueued) return;
    this.creditQueued = true;
    queueMicrotask(() => {
      this.creditQueued = false;
      this.flushCredit();
    });
  }

  private flushCredit(): void {
    if (this.credits.size === 0) return;
    const frames: Buffer[] = [];
    for (const [channel, bytes] of this.credits) frames.push(...creditFrames(channel, bytes));
    this.credits.clear();
    this.write(frames);
  }

  private write(frames: Buffer[]): boolean {
    if (this.disconnect || this.socket.destroyed || !this.socket.writable) return false;
    try {
      this.socket.write(frames.length === 1 ? frames[0]! : Buffer.concat(frames));
      return true;
    } catch (err) {
      this.fail(new HcError('disconnected', `hc write failed: ${(err as Error).message}`, { cause: err }));
      return false;
    }
  }

  private fail(error: HcError): void {
    if (this.disconnect) return;
    this.disconnect = { error };
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    const channels = [...this.channels.values()];
    this.channels.clear();
    this.early.clear();
    this.credits.clear();
    for (const channel of channels) channel.end({ kind: 'disconnected', error });
    const listeners = [...this.disconnectListeners];
    this.disconnectListeners.clear();
    for (const listener of listeners) safely(() => listener(this.disconnect!));
  }
}

/** Connects to the core at `socketPath`; see HcClient.connect. */
export function connectHc(socketPath: string, opts?: HcCallOptions): Promise<HcClient> {
  return HcClient.connect(socketPath, opts);
}

function helloResult(line: string): HcHello {
  let reply: { result?: HcHello; error?: { message?: unknown; data?: { kind?: unknown; hint?: unknown }; code?: unknown } };
  try {
    reply = JSON.parse(line);
  } catch (err) {
    throw new HcError('protocol', `unreadable hello reply: ${(err as Error).message}`, { cause: err });
  }
  if (reply.error) {
    const e = reply.error;
    throw new HcError('rpc', `hello: ${typeof e.message === 'string' ? e.message : 'refused'}`, {
      kind: typeof e.data?.kind === 'string' ? e.data.kind : undefined,
      hint: typeof e.data?.hint === 'string' && e.data.hint ? e.data.hint : undefined,
      rpcCode: typeof e.code === 'number' ? e.code : undefined,
    });
  }
  const hello = reply.result;
  if (!hello || hello.framed !== true) throw new HcError('protocol', 'hello did not switch the connection to framed mode');
  if (hello.generation !== HC_PROTOCOL_GENERATION) {
    throw new HcError('protocol', `hc speaks protocol generation ${String(hello.generation)}, not ${HC_PROTOCOL_GENERATION}`);
  }
  return { ...hello, features: Array.isArray(hello.features) ? hello.features : [], methods: Array.isArray(hello.methods) ? hello.methods : [] };
}

function channelOf(result: { channel?: unknown }): number {
  const channel = result?.channel;
  if (typeof channel !== 'number' || !Number.isInteger(channel) || channel <= RPC_CHANNEL) {
    throw new HcError('protocol', `reply carries no stream channel (${String(channel)})`);
  }
  return channel;
}

function toBytes(bytes: string | Uint8Array): Uint8Array {
  return typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn(`[hc] listener threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

type Queued<T> = { data: T } | { close: HcChannelClose };

/**
 * Ordered delivery for one channel: everything waits until the first primary
 * listener exists, close comes last and only once, and a late close listener
 * still hears it.
 */
abstract class Delivery<T> implements Channel {
  private queue: Array<Queued<T>> | null = [];
  private ending: HcChannelClose | null = null;
  private delivered: HcChannelClose | null = null;
  private readonly closeListeners = new Set<(info: HcChannelClose) => void>();

  constructor(protected readonly link: Link, readonly channel: number) {}

  get closed(): boolean {
    return this.ending !== null;
  }

  abstract receive(frame: Frame): void;
  protected abstract handle(item: T): void;

  end(info: HcChannelClose): void {
    if (this.ending) return;
    this.ending = info;
    this.push({ close: info });
  }

  onClose(listener: (info: HcChannelClose) => void): () => void {
    if (this.delivered) {
      safely(() => listener(this.delivered!));
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Detaches now: anything not yet delivered is dropped and close listeners hear `detached`. */
  close(): void {
    if (this.ending) return;
    this.link.retire(this.channel);
    this.link.send(this.channel, FRAME_CLOSE);
    this.queue = null;
    this.end({ kind: 'detached' });
  }

  protected enqueue(data: T): void {
    if (this.ending) return;
    this.push({ data });
  }

  /** Called when the first primary listener is registered. */
  protected flow(): void {
    const queue = this.queue;
    if (!queue) return;
    this.queue = null;
    for (const item of queue) this.run(item);
  }

  private push(item: Queued<T>): void {
    if (this.queue) this.queue.push(item);
    else this.run(item);
  }

  private run(item: Queued<T>): void {
    if (this.delivered) return;
    if ('data' in item) {
      this.handle(item.data);
      return;
    }
    this.delivered = item.close;
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    this.stopped();
    for (const listener of listeners) safely(() => listener(item.close));
  }

  protected stopped(): void {}
}

type StreamItem = { kind: 'data'; payload: Buffer } | { kind: 'resize'; size: CellSize } | { kind: 'flush' };

class StreamChannel extends Delivery<StreamItem> implements HcStream {
  private readonly paints = new PaintTracker();
  private readonly dataListeners = new Set<(chunk: Buffer, info: HcChunkInfo) => void>();
  private readonly resizeListeners = new Set<(size: CellSize) => void>();

  constructor(
    link: Link,
    channel: number,
    readonly terminal: HcTerminalRecord,
    readonly observe: boolean,
    readonly resizeNotifications: boolean,
  ) {
    super(link, channel);
  }

  receive(frame: Frame): void {
    switch (frame.kind) {
      case FRAME_DATA:
        this.enqueue({ kind: 'data', payload: frame.payload });
        break;
      case FRAME_RESIZE: {
        const size = decodeResize(frame.payload);
        if (size) this.enqueue({ kind: 'resize', size });
        break;
      }
      case FRAME_CLOSE:
        this.link.forget(this.channel);
        this.end(frame.payload.length === 0 ? { kind: 'detached' } : { kind: 'ended', end: closeReason(frame.payload) });
        break;
    }
  }

  onData(listener: (chunk: Buffer, info: HcChunkInfo) => void): () => void {
    this.dataListeners.add(listener);
    this.flow();
    return () => this.dataListeners.delete(listener);
  }

  onResize(listener: (size: CellSize) => void): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  writeAutomatic(bytes: string | Uint8Array): boolean {
    return !this.observe && this.input(FRAME_AUTOMATIC_INPUT, toBytes(bytes));
  }

  writeHuman(bytes: string | Uint8Array): boolean {
    return !this.observe && this.input(FRAME_DATA, toBytes(bytes));
  }

  resize(cols: number, rows: number): boolean {
    return this.control(FRAME_RESIZE, encodeResize(cols, rows));
  }

  focus(focused: boolean): boolean {
    return this.control(FRAME_FOCUS, Uint8Array.of(focused ? 1 : 0));
  }

  facts(display: HcDisplay): boolean {
    return this.control(FRAME_FACTS, Buffer.from(JSON.stringify(display), 'utf8'));
  }

  override end(info: HcChannelClose): void {
    if (!this.closed && info.kind !== 'detached') this.enqueue({ kind: 'flush' });
    super.end(info);
  }

  protected handle(item: StreamItem): void {
    switch (item.kind) {
      case 'resize':
        for (const listener of [...this.resizeListeners]) safely(() => listener(item.size));
        return;
      case 'flush':
        this.deliver(this.paints.flush());
        return;
      case 'data':
        this.deliver(this.paints.push(item.payload));
        this.link.credit(this.channel, item.payload.length);
    }
  }

  private deliver(segments: StreamSegment[]): void {
    for (const segment of segments) {
      const info: HcChunkInfo = { paint: segment.paint, firstPaint: segment.firstPaint, paintDone: segment.paintDone };
      for (const listener of [...this.dataListeners]) safely(() => listener(segment.bytes, info));
    }
  }

  protected override stopped(): void {
    this.dataListeners.clear();
    this.resizeListeners.clear();
  }

  /** The core ignores sizes, focus and display facts from observers. */
  private control(kind: number, payload: Uint8Array): boolean {
    if (this.observe || this.closed || !this.link.alive) return false;
    return this.link.send(this.channel, kind, payload);
  }

  private input(kind: number, bytes: Uint8Array): boolean {
    if (this.closed || !this.link.alive) return false;
    if (bytes.length === 0) return true;
    for (let at = 0; at < bytes.length; at += MAX_FRAME_PAYLOAD) {
      if (!this.link.send(this.channel, kind, bytes.subarray(at, at + MAX_FRAME_PAYLOAD))) return false;
    }
    return true;
  }
}

function closeReason(payload: Buffer): HcEnd {
  let json: unknown = null;
  try {
    json = JSON.parse(payload.toString('utf8'));
  } catch { /* an unreadable reason still ends the stream */ }
  const end = parseHcEnd(json);
  if (end) return end;
  const reason = json && typeof (json as { reason?: unknown }).reason === 'string' ? (json as { reason: string }).reason : 'unknown';
  return { reason, exit_code: null, signal: null, finished_ms: null };
}

type EventLine =
  | { method: 'event'; params: HcEvent }
  | { method: 'missed'; params: HcSnapshot }
  | { method: 'heartbeat'; params: { seq: number } };

class EventChannel extends Delivery<EventLine> implements HcSubscription {
  private partial: Buffer[] = [];
  private current: HcSnapshot;
  private applied: number;
  private readonly eventListeners = new Set<(event: HcEvent) => void>();
  private readonly missedListeners = new Set<(snapshot: HcSnapshot) => void>();
  private readonly heartbeatListeners = new Set<(seq: number) => void>();
  private readonly silence: number | undefined;
  private watchdog: NodeJS.Timeout | null = null;

  constructor(link: Link, channel: number, snapshot: HcSnapshot, heartbeatTimeoutMs: number | undefined) {
    super(link, channel);
    this.current = snapshot;
    this.applied = snapshot.seq;
    this.silence = heartbeatTimeoutMs !== undefined && Number.isFinite(heartbeatTimeoutMs) ? heartbeatTimeoutMs : undefined;
    this.arm();
  }

  get snapshot(): HcSnapshot {
    return this.current;
  }

  get seq(): number {
    return this.applied;
  }

  receive(frame: Frame): void {
    if (frame.kind === FRAME_CLOSE) {
      this.link.forget(this.channel);
      this.end(frame.payload.length === 0 ? { kind: 'detached' } : { kind: 'ended', end: closeReason(frame.payload) });
      return;
    }
    if (frame.kind !== FRAME_DATA) return;
    this.arm();
    this.link.credit(this.channel, frame.payload.length);
    let at = 0;
    for (;;) {
      const nl = frame.payload.indexOf(0x0a, at);
      if (nl < 0) break;
      const piece = frame.payload.subarray(at, nl);
      const text = this.partial.length > 0 ? Buffer.concat([...this.partial, piece]).toString('utf8') : piece.toString('utf8');
      this.partial = [];
      at = nl + 1;
      const line = parseEventLine(text);
      if (line === undefined) {
        this.link.fail(new HcError('protocol', `unreadable event line from hc: ${text.slice(0, 200)}`));
        return;
      }
      if (line) this.enqueue(line);
    }
    if (at < frame.payload.length) this.partial.push(frame.payload.subarray(at));
  }

  onEvent(listener: (event: HcEvent) => void): () => void {
    this.eventListeners.add(listener);
    this.flow();
    return () => this.eventListeners.delete(listener);
  }

  onMissed(listener: (snapshot: HcSnapshot) => void): () => void {
    this.missedListeners.add(listener);
    return () => this.missedListeners.delete(listener);
  }

  onHeartbeat(listener: (seq: number) => void): () => void {
    this.heartbeatListeners.add(listener);
    return () => this.heartbeatListeners.delete(listener);
  }

  protected handle(line: EventLine): void {
    switch (line.method) {
      case 'event':
        if (line.params.seq <= this.applied) return;
        this.applied = line.params.seq;
        for (const listener of [...this.eventListeners]) safely(() => listener(line.params));
        return;
      case 'missed':
        this.current = line.params;
        this.applied = line.params.seq;
        for (const listener of [...this.missedListeners]) safely(() => listener(line.params));
        return;
      case 'heartbeat':
        for (const listener of [...this.heartbeatListeners]) safely(() => listener(line.params.seq));
    }
  }

  protected override stopped(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    this.eventListeners.clear();
    this.missedListeners.clear();
    this.heartbeatListeners.clear();
  }

  override end(info: HcChannelClose): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    super.end(info);
  }

  private arm(): void {
    if (this.silence === undefined || this.closed) return;
    if (this.watchdog) clearTimeout(this.watchdog);
    const ms = this.silence;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      this.link.fail(new HcError('timeout', `hc event stream ${this.channel} silent for ${ms}ms`));
    }, ms);
    this.watchdog.unref();
  }
}

/** undefined: not JSON-RPC at all; null: a notification this client does not use. */
function parseEventLine(text: string): EventLine | null | undefined {
  let message: { method?: unknown; params?: Record<string, unknown> };
  try {
    message = JSON.parse(text);
  } catch {
    return undefined;
  }
  const params = message.params;
  if (!params || typeof params !== 'object') return null;
  const seq = typeof params.seq === 'number' ? params.seq : 0;
  switch (message.method) {
    case 'event':
      return {
        method: 'event',
        params: {
          type: String(params.type ?? ''),
          ...(typeof params.terminal === 'string' ? { terminal: params.terminal } : {}),
          data: params.data && typeof params.data === 'object' ? params.data as Record<string, unknown> : null,
          seq,
        },
      };
    case 'missed':
      return { method: 'missed', params: { seq, terminals: Array.isArray(params.terminals) ? params.terminals as HcTerminalRecord[] : [] } };
    case 'heartbeat':
      return { method: 'heartbeat', params: { seq } };
    default:
      return null;
  }
}
