import { describe, expect, it } from 'vitest';
import { MAX_PAINT_BYTES, PAINT_START, REPORT_OPEN, PaintTracker, type StreamSegment } from '../src/adapters/backend/hc/paint.js';

const SCREEN = Buffer.from('\x1b[?9l\x1b[?1000l\x1b[H\x1b[2J\x1b[1;1Hready\x1b[2;1H$ \x1b]2;sh\x1b\\', 'latin1');
const MODE = Buffer.from('\x1b[?9001l', 'latin1');
const REPORT = Buffer.from('\x1b]7501;agent=claude;state=idle\x1b\\', 'latin1');
const LIVE = Buffer.from('\x1b[32mgot:hello\x1b[0m\r\n', 'latin1');

function paintOf(...reports: Buffer[]): Buffer {
  return Buffer.concat([PAINT_START, SCREEN, MODE, ...reports]);
}

function feed(tracker: PaintTracker, stream: Buffer, cuts: number[]): StreamSegment[] {
  const out: StreamSegment[] = [];
  let at = 0;
  for (const cut of [...cuts, stream.length]) {
    out.push(...tracker.push(stream.subarray(at, cut)));
    at = cut;
  }
  return out;
}

function split(segments: StreamSegment[]): { paint: Buffer; live: Buffer; done: number } {
  return {
    paint: Buffer.concat(segments.filter(s => s.paint).map(s => s.bytes)),
    live: Buffer.concat(segments.filter(s => !s.paint).map(s => s.bytes)),
    done: segments.filter(s => s.paintDone).length,
  };
}

describe('PaintTracker', () => {
  it('separates the first paint from live output at any pair of read boundaries', () => {
    const paint = paintOf(REPORT, REPORT);
    const stream = Buffer.concat([paint, LIVE]);
    const reportOpens = [paint.indexOf(REPORT), paint.lastIndexOf(REPORT)];
    // A read that ends where a status report starts is indistinguishable from
    // live output that begins with one.
    const ambiguous = (cut: number) => reportOpens.some(open => cut >= open && cut < open + 7);
    for (let a = 0; a <= stream.length; a++) {
      if (ambiguous(a)) continue;
      for (let b = a; b <= stream.length; b += 3) {
        if (ambiguous(b)) continue;
        const segments = feed(new PaintTracker(), stream, [a, b]);
        const { paint: painted, live, done } = split(segments);
        expect(painted.equals(paint)).toBe(true);
        expect(live.equals(LIVE)).toBe(true);
        expect(done).toBe(1);
        expect(segments.filter(s => s.paint).every(s => s.firstPaint)).toBe(true);
        const last = segments.filter(s => s.paint).at(-1)!;
        expect(last.paintDone).toBe(true);
      }
    }
  });

  it('holds back a possible paint start at the end of a read until the next read settles it', () => {
    const live = (segments: StreamSegment[]) => segments.map(s => [s.bytes.toString('latin1'), s.paint]);
    const split = new PaintTracker();
    expect(live(split.push(Buffer.from('abc\x18\x1b[', 'latin1')))).toEqual([['abc', false]]);
    const rest = split.push(Buffer.concat([paintOf().subarray(3), LIVE]));
    expect(rest.map(s => [s.bytes.length, s.paint, s.firstPaint, s.paintDone])).toEqual([
      [paintOf().length, true, true, true],
      [LIVE.length, false, false, false],
    ]);

    const notPaint = new PaintTracker();
    expect(live(notPaint.push(Buffer.from('abc\x18', 'latin1')))).toEqual([['abc', false]]);
    expect(live(notPaint.push(Buffer.from('x', 'latin1')))).toEqual([['\x18x', false]]);

    const ending = new PaintTracker();
    expect(live(ending.push(Buffer.from('end\x18\x1b', 'latin1')))).toEqual([['end', false]]);
    expect(live(ending.flush())).toEqual([['\x18\x1b', false]]);
    expect(ending.flush()).toEqual([]);
  });

  it('finishes the paint at the end of a read even when no live output follows', () => {
    const tracker = new PaintTracker();
    const segments = tracker.push(paintOf());
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ paint: true, firstPaint: true, paintDone: true });
    expect(tracker.inPaint).toBe(false);
  });

  it('marks a later replacement paint as a paint but not the first one', () => {
    const tracker = new PaintTracker();
    tracker.push(Buffer.concat([paintOf(), LIVE]));
    const segments = tracker.push(Buffer.concat([LIVE, paintOf(REPORT), LIVE]));
    expect(segments.map(s => [s.bytes.length, s.paint, s.firstPaint, s.paintDone])).toEqual([
      [LIVE.length, false, false, false],
      [paintOf(REPORT).length, true, false, true],
      [LIVE.length, false, false, false],
    ]);
  });

  it('gives up on a paint that never closes once it passes the size bound', () => {
    const tracker = new PaintTracker();
    const filler = Buffer.alloc(4 << 20, 0x41);
    tracker.push(Buffer.concat([PAINT_START, filler]));
    let seen = PAINT_START.length + filler.length;
    let done: StreamSegment | undefined;
    while (seen <= MAX_PAINT_BYTES + filler.length && !done) {
      done = tracker.push(filler).find(s => s.paintDone);
      seen += filler.length;
    }
    expect(done).toMatchObject({ paint: true, firstPaint: true });
    expect(seen).toBeGreaterThan(MAX_PAINT_BYTES);
    expect(tracker.inPaint).toBe(false);
    expect(tracker.push(LIVE)).toEqual([{ bytes: LIVE, paint: false, firstPaint: false, paintDone: false }]);
  });

  it('keeps a report whose REPORT_OPEN prefix is split across reads inside the paint', () => {
    // hc cuts frames at a fixed 16 KiB, so a paint's trailing status report can
    // be split at any byte. A proper prefix of ESC ] 7 5 0 1 ; held at a read
    // boundary must not end the paint early and tear that report into live text.
    const paint = paintOf(REPORT);
    const stream = Buffer.concat([paint, LIVE]);
    const reportStart = paint.indexOf(REPORT);
    for (let k = 1; k < REPORT_OPEN.length; k++) {
      const splitAt = reportStart + k; // split inside ESC ] 7 5 0 1 ;
      const segments = feed(new PaintTracker(), stream, [splitAt]);
      const { paint: painted, live, done } = split(segments);
      expect(painted.equals(paint), `REPORT_OPEN split after ${k} bytes: paint bytes`).toBe(true);
      expect(live.equals(LIVE), `REPORT_OPEN split after ${k} bytes: live bytes`).toBe(true);
      expect(done, `REPORT_OPEN split after ${k} bytes: one paintDone`).toBe(1);
      expect(segments.filter(s => s.paint).every(s => s.firstPaint)).toBe(true);
    }
  });

  it('still closes the paint with paintDone when a held prefix turns out to be live output', () => {
    // LIVE begins with ESC (the first byte of REPORT_OPEN). Held across a read
    // and disproven by the next byte, the paint before it must still get its
    // single paintDone, and the ESC stays with the live output.
    const paint = paintOf();
    const stream = Buffer.concat([paint, LIVE]);
    const cut = paint.length; // the ESC opening LIVE is the held byte
    const segments = feed(new PaintTracker(), stream, [cut]);
    const { paint: painted, live, done } = split(segments);
    expect(painted.equals(paint)).toBe(true);
    expect(live.equals(LIVE)).toBe(true);
    expect(done).toBe(1);
    const doneSegment = segments.filter(s => s.paintDone);
    expect(doneSegment).toHaveLength(1);
    expect(doneSegment[0]!.paint).toBe(true);
  });
});
