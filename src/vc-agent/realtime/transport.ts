import WebSocket, { type RawData } from 'ws';
import type { RealtimeVoiceTransport } from './types.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

interface ReceiveWaiter {
  resolve: (data: Buffer | undefined) => void;
  reject: (err: Error) => void;
}

export interface ConnectRealtimeVoiceTransportOptions {
  maxPayloadBytes?: number;
}

export class WebSocketRealtimeVoiceTransport implements RealtimeVoiceTransport {
  private readonly ws: WebSocket;
  private readonly incoming: Buffer[] = [];
  private readonly waiters: ReceiveWaiter[] = [];
  private readonly openPromise: Promise<void>;
  private closed = false;
  private closeError?: Error;

  constructor(websocketUrl: string, opts: ConnectRealtimeVoiceTransportOptions = {}) {
    this.ws = new WebSocket(websocketUrl, {
      maxPayload: opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.closeError = error;
        this.rejectWaiters(error);
        reject(error);
      });
    });
    this.ws.on('message', (data) => this.enqueue(rawDataToBuffer(data)));
    this.ws.once('close', () => {
      this.closed = true;
      this.resolveWaiters(undefined);
    });
  }

  async open(): Promise<void> {
    await this.openPromise;
  }

  async send(data: Buffer): Promise<void> {
    await this.openPromise;
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`VC realtime WebSocket is not open (readyState=${this.ws.readyState})`);
    }
    await new Promise<void>((resolve, reject) => {
      this.ws.send(data, { binary: true }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  receive(): Promise<Buffer | undefined> {
    const next = this.incoming.shift();
    if (next) return Promise.resolve(next);
    if (this.closeError) return Promise.reject(this.closeError);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.closed || this.ws.readyState === WebSocket.CLOSED) {
      this.closed = true;
      this.resolveWaiters(undefined);
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      this.ws.once('close', done);
      if (this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.terminate();
      } else if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    });
  }

  bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  private enqueue(data: Buffer): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(data);
      return;
    }
    this.incoming.push(data);
  }

  private resolveWaiters(data: Buffer | undefined): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve(data);
    }
  }

  private rejectWaiters(err: Error): void {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(err);
    }
  }
}

export async function connectRealtimeVoiceTransport(
  websocketUrl: string,
  opts: ConnectRealtimeVoiceTransportOptions = {},
): Promise<WebSocketRealtimeVoiceTransport> {
  const transport = new WebSocketRealtimeVoiceTransport(websocketUrl, opts);
  await transport.open();
  return transport;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as unknown as ArrayBuffer);
}
