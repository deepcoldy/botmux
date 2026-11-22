import { describe, expect, it } from 'vitest';
import {
  FRAME_AUTOMATIC_INPUT,
  FRAME_CLOSE,
  FRAME_CREDIT,
  FRAME_DATA,
  FRAME_FACTS,
  FRAME_FOCUS,
  FRAME_RESIZE,
  FrameDecoder,
  HcWireError,
  MAX_FRAME_PAYLOAD,
  creditFrames,
  decodeCredit,
  decodeResize,
  encodeCredit,
  encodeFrame,
  encodeResize,
  type Frame,
} from '../src/adapters/backend/hc/wire.js';

function frameBytes(frames: Frame[]): Buffer {
  return Buffer.concat(frames.map(f => encodeFrame(f.channel, f.kind, f.payload)));
}

function decodeInPieces(stream: Buffer, cuts: number[]): Frame[] {
  const decoder = new FrameDecoder();
  const out: Frame[] = [];
  let at = 0;
  for (const cut of [...cuts, stream.length]) {
    out.push(...decoder.push(stream.subarray(at, cut)));
    at = cut;
  }
  expect(decoder.buffered).toBe(0);
  return out.map(f => ({ ...f, payload: Buffer.from(f.payload) }));
}

describe('hc wire format', () => {
  it('lays a frame out as channel u32 LE, kind u8, length u32 LE, payload', () => {
    expect([...encodeFrame(7, FRAME_DATA, Buffer.from('hi'))]).toEqual([7, 0, 0, 0, 0, 2, 0, 0, 0, 0x68, 0x69]);
    expect([...encodeFrame(0x01020304, FRAME_CLOSE)]).toEqual([4, 3, 2, 1, 2, 0, 0, 0, 0]);
  });

  it('uses the frame kinds herdr-core 0.1.19 defines', () => {
    expect([FRAME_DATA, FRAME_CREDIT, FRAME_CLOSE, FRAME_RESIZE, FRAME_FOCUS, FRAME_FACTS, FRAME_AUTOMATIC_INPUT])
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('encodes CREDIT as u32 LE and RESIZE as cols then rows, u16 LE each', () => {
    expect([...encodeCredit(256 * 1024)]).toEqual([0, 0, 4, 0]);
    expect(decodeCredit(encodeCredit(0xffff_ffff))).toBe(0xffff_ffff);
    expect([...encodeResize(80, 24)]).toEqual([80, 0, 24, 0]);
    expect(decodeResize(encodeResize(300, 65535))).toEqual({ cols: 300, rows: 65535 });
  });

  it('refuses payloads the core would ignore or values that do not fit', () => {
    expect(decodeCredit(Buffer.from([1, 0, 0]))).toBeNull();
    expect(decodeResize(Buffer.from([1, 0, 0, 0, 0]))).toBeNull();
    expect(() => encodeResize(70000, 24)).toThrow(HcWireError);
    expect(() => encodeResize(80, -1)).toThrow(HcWireError);
    expect(() => encodeCredit(2 ** 32)).toThrow(HcWireError);
    expect(() => encodeFrame(-1, FRAME_DATA)).toThrow(HcWireError);
    expect(() => encodeFrame(1, FRAME_DATA, Buffer.alloc(MAX_FRAME_PAYLOAD + 1))).toThrow(HcWireError);
  });

  it('splits credit larger than a u32 into several frames', () => {
    const frames = creditFrames(3, 2 ** 32 + 5);
    const decoded = new FrameDecoder().push(Buffer.concat(frames));
    expect(decoded.map(f => [f.channel, f.kind, decodeCredit(f.payload)])).toEqual([
      [3, FRAME_CREDIT, 0xffff_ffff],
      [3, FRAME_CREDIT, 6],
    ]);
    expect(creditFrames(3, 0)).toEqual([]);
  });

  it('decodes the same frames whatever the read boundaries', () => {
    const frames: Frame[] = [
      { channel: 0, kind: FRAME_DATA, payload: Buffer.from('{"id":1}') },
      { channel: 2, kind: FRAME_CLOSE, payload: Buffer.alloc(0) },
      { channel: 9, kind: FRAME_RESIZE, payload: encodeResize(80, 24) },
      { channel: 1, kind: FRAME_DATA, payload: Buffer.from('x') },
    ];
    const stream = frameBytes(frames);
    for (let a = 0; a <= stream.length; a++) {
      for (let b = a; b <= stream.length; b++) {
        expect(decodeInPieces(stream, [a, b])).toEqual(frames);
      }
    }
  });

  it('reassembles large payloads fed in small reads', () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const frames: Frame[] = [
      { channel: 1, kind: FRAME_DATA, payload: big },
      { channel: 1, kind: FRAME_DATA, payload: Buffer.from('tail') },
    ];
    const stream = frameBytes(frames);
    const cuts: number[] = [];
    for (let at = 4093; at < stream.length; at += 4093) cuts.push(at);
    const decoded = decodeInPieces(stream, cuts);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.payload.equals(big)).toBe(true);
    expect(decoded[1]!.payload.toString()).toBe('tail');
  });

  it('rejects a frame over 16 MiB from its header alone, and stays failed', () => {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(1, 0);
    header.writeUInt32LE(MAX_FRAME_PAYLOAD + 1, 5);
    const decoder = new FrameDecoder();
    expect(decoder.push(header.subarray(0, 6))).toEqual([]);
    expect(() => decoder.push(header.subarray(6))).toThrow(HcWireError);
    expect(() => decoder.push(encodeFrame(0, FRAME_DATA, Buffer.from('{}')))).toThrow(HcWireError);

    const atLimit = Buffer.alloc(9);
    atLimit.writeUInt32LE(MAX_FRAME_PAYLOAD, 5);
    expect(new FrameDecoder().push(atLimit)).toEqual([]);
  });
});
