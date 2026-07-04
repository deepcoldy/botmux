/**
 * Per-anchor serialization for Lark event handlers.
 *
 * botmux invokes handleThreadReply / handleNewTopic fire-and-forget, so two
 * messages to the SAME thread are otherwise processed concurrently — and a fast
 * second message (e.g. `botmux dispatch`'s brief kickoff right after its /repo
 * prime) interleaves with the first's async session-spawn and gets dropped.
 * These tests pin the serializer that orders same-anchor work while keeping
 * different anchors concurrent.
 *
 * Run: pnpm vitest run test/anchor-serializer.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { serializeByAnchor, __resetAnchorQueues } from '../src/utils/anchor-serializer.js';

const delayPush = (order: string[], label: string, ms: number) => () =>
  new Promise<void>(resolve => {
    order.push(`start:${label}`);
    setTimeout(() => {
      order.push(`end:${label}`);
      resolve();
    }, ms);
  });

describe('serializeByAnchor', () => {
  beforeEach(() => __resetAnchorQueues());

  it('runs same-anchor work sequentially in call order (slow first, fast second)', async () => {
    const order: string[] = [];
    const p1 = serializeByAnchor('A', delayPush(order, '1', 30));
    const p2 = serializeByAnchor('A', delayPush(order, '2', 1));
    await Promise.all([p1, p2]);
    // The fast second task must NOT overtake the slow first one.
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('runs different-anchor work concurrently', async () => {
    const order: string[] = [];
    const p1 = serializeByAnchor('A', delayPush(order, 'A', 30));
    const p2 = serializeByAnchor('B', delayPush(order, 'B', 1));
    await Promise.all([p1, p2]);
    // B (different anchor) starts and finishes before A ends.
    expect(order.indexOf('end:B')).toBeLessThan(order.indexOf('end:A'));
  });

  it('does not let one rejection block the next same-anchor work', async () => {
    const ran: string[] = [];
    const p1 = serializeByAnchor('A', async () => { ran.push('1'); throw new Error('boom'); });
    const p2 = serializeByAnchor('A', async () => { ran.push('2'); });
    await p1.catch(() => { /* expected */ });
    await p2;
    expect(ran).toEqual(['1', '2']);
  });

  it('rejects the returned promise when the work rejects (so callers can log)', async () => {
    await expect(serializeByAnchor('A', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
  });
});

describe('serializeByAnchor — wait cap (head-of-line-blocking guard)', () => {
  beforeEach(() => __resetAnchorQueues());

  it('does NOT let a slow/hung handler block the next same-anchor work past the cap', async () => {
    const order: string[] = [];
    // First work hangs well past the cap; with a 30ms cap the second must start
    // without waiting for the first to finish (else a hung handler = missed @s).
    const p1 = serializeByAnchor('A', () => new Promise<void>(res => {
      order.push('start:1');
      setTimeout(() => { order.push('end:1'); res(); }, 300);
    }), 30);
    const p2 = serializeByAnchor('A', async () => { order.push('start:2'); }, 30);
    await p2;
    // p2 ran before p1 finished (cap kicked in) — no indefinite block.
    expect(order).toContain('start:2');
    expect(order.indexOf('start:2')).toBeLessThan(order.indexOf('end:1') === -1 ? Infinity : order.indexOf('end:1'));
    await p1;
  });

  it('still orders fast handlers (cap not reached → strict order preserved)', async () => {
    const order: string[] = [];
    const mk = (l: string, ms: number) => () => new Promise<void>(res => { order.push('s:'+l); setTimeout(() => { order.push('e:'+l); res(); }, ms); });
    const p1 = serializeByAnchor('A', mk('1', 20), 1000);
    const p2 = serializeByAnchor('A', mk('2', 1), 1000);
    await Promise.all([p1, p2]);
    expect(order).toEqual(['s:1', 'e:1', 's:2', 'e:2']);
  });
});
