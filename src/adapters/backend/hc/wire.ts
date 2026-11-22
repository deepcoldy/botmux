/**
 * herdr-core framed mode (crates/herdr-core/src/wire.rs, protocol generation 1):
 * `[channel u32 LE][kind u8][len u32 LE][payload]`. Channel 0 carries JSON-RPC;
 * attach and event streams get their own channels.
 */

export const HC_PROTOCOL_GENERATION = 1;

export const FRAME_HEADER_BYTES = 9;
export const MAX_FRAME_PAYLOAD = 16 << 20;

export const FRAME_DATA = 0;
export const FRAME_CREDIT = 1;
export const FRAME_CLOSE = 2;
export const FRAME_RESIZE = 3;
export const FRAME_FOCUS = 4;
export const FRAME_FACTS = 5;
export const FRAME_AUTOMATIC_INPUT = 6;

/** Credit every stream starts with; the core stops sending until it is returned. */
export const STREAM_WINDOW = 256 * 1024;
/** Largest DATA payload the core puts on a stream. */
export const STREAM_CHUNK = 16 * 1024;
/** Backlog past which the core drops a viewer's output (repaint) or an event stream's (`missed`). */
export const STREAM_MAX_PENDING = 4 << 20;

export const RPC_CHANNEL = 0;

const U32_MAX = 0xffff_ffff;
const U16_MAX = 0xffff;

export interface Frame {
  channel: number;
  kind: number;
  payload: Buffer;
}

export class HcWireError extends Error {
  override name = 'HcWireError';
}

export function encodeFrame(channel: number, kind: number, payload: Uint8Array = EMPTY): Buffer {
  if (!Number.isInteger(channel) || channel < 0 || channel > U32_MAX) {
    throw new HcWireError(`channel ${channel} is not a u32`);
  }
  if (!Number.isInteger(kind) || kind < 0 || kind > 0xff) throw new HcWireError(`kind ${kind} is not a u8`);
  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw new HcWireError(`frame of ${payload.length} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
  }
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  out.writeUInt32LE(channel, 0);
  out.writeUInt8(kind, 4);
  out.writeUInt32LE(payload.length, 5);
  out.set(payload, FRAME_HEADER_BYTES);
  return out;
}

const EMPTY = new Uint8Array(0);

/**
 * Streaming decoder: accepts the byte stream in arbitrary pieces and returns
 * whole frames. A payload is copied at most once, so a large frame arriving in
 * many small reads costs O(size). Payloads that fit inside one read are views
 * into that read's buffer.
 */
export class FrameDecoder {
  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerFill = 0;
  private payload: Buffer | null = null;
  private payloadFill = 0;
  private channel = 0;
  private kind = 0;
  private failed: HcWireError | null = null;

  /** Bytes of an unfinished frame held since the last complete one. */
  get buffered(): number {
    return this.payload ? FRAME_HEADER_BYTES + this.payloadFill : this.headerFill;
  }

  /** Throws HcWireError on an oversized frame; the decoder stays failed afterwards. */
  push(chunk: Uint8Array): Frame[] {
    if (this.failed) throw this.failed;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: Frame[] = [];
    let at = 0;
    while (at < bytes.length) {
      if (!this.payload) {
        if (this.headerFill === 0 && bytes.length - at >= FRAME_HEADER_BYTES) {
          const len = this.readHeader(bytes, at);
          at += FRAME_HEADER_BYTES;
          if (bytes.length - at >= len) {
            frames.push({ channel: this.channel, kind: this.kind, payload: bytes.subarray(at, at + len) });
            at += len;
            continue;
          }
          this.payload = Buffer.allocUnsafe(len);
          this.payloadFill = 0;
          continue;
        }
        const take = Math.min(FRAME_HEADER_BYTES - this.headerFill, bytes.length - at);
        bytes.copy(this.header, this.headerFill, at, at + take);
        this.headerFill += take;
        at += take;
        if (this.headerFill < FRAME_HEADER_BYTES) break;
        this.headerFill = 0;
        const len = this.readHeader(this.header, 0);
        if (len === 0) {
          frames.push({ channel: this.channel, kind: this.kind, payload: Buffer.alloc(0) });
          continue;
        }
        this.payload = Buffer.allocUnsafe(len);
        this.payloadFill = 0;
        continue;
      }
      const take = Math.min(this.payload.length - this.payloadFill, bytes.length - at);
      bytes.copy(this.payload, this.payloadFill, at, at + take);
      this.payloadFill += take;
      at += take;
      if (this.payloadFill === this.payload.length) {
        frames.push({ channel: this.channel, kind: this.kind, payload: this.payload });
        this.payload = null;
        this.payloadFill = 0;
      }
    }
    return frames;
  }

  private readHeader(source: Buffer, at: number): number {
    const len = source.readUInt32LE(at + 5);
    if (len > MAX_FRAME_PAYLOAD) {
      this.failed = new HcWireError(`frame of ${len} bytes exceeds ${MAX_FRAME_PAYLOAD}`);
      throw this.failed;
    }
    this.channel = source.readUInt32LE(at);
    this.kind = source.readUInt8(at + 4);
    return len;
  }
}

export function encodeCredit(bytes: number): Buffer {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > U32_MAX) throw new HcWireError(`credit ${bytes} is not a u32`);
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(bytes, 0);
  return out;
}

/** The core ignores CREDIT frames whose payload is not exactly 4 bytes. */
export function decodeCredit(payload: Uint8Array): number | null {
  if (payload.length !== 4) return null;
  return Buffer.from(payload.buffer, payload.byteOffset, 4).readUInt32LE(0);
}

/** CREDIT frames for `bytes` on `channel`, split so each fits a u32. */
export function creditFrames(channel: number, bytes: number): Buffer[] {
  const frames: Buffer[] = [];
  let left = bytes;
  while (left > 0) {
    const n = Math.min(left, U32_MAX);
    frames.push(encodeFrame(channel, FRAME_CREDIT, encodeCredit(n)));
    left -= n;
  }
  return frames;
}

export interface CellSize {
  cols: number;
  rows: number;
}

export function encodeResize(cols: number, rows: number): Buffer {
  for (const [name, v] of [['cols', cols], ['rows', rows]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > U16_MAX) throw new HcWireError(`${name} ${v} is not a u16`);
  }
  const out = Buffer.allocUnsafe(4);
  out.writeUInt16LE(cols, 0);
  out.writeUInt16LE(rows, 2);
  return out;
}

/** The core ignores RESIZE frames whose payload is not exactly 4 bytes. */
export function decodeResize(payload: Uint8Array): CellSize | null {
  if (payload.length !== 4) return null;
  const view = Buffer.from(payload.buffer, payload.byteOffset, 4);
  return { cols: view.readUInt16LE(0), rows: view.readUInt16LE(2) };
}
