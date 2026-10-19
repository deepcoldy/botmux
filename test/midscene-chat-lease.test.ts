import { describe, expect, it } from 'vitest';
import { acquireLease } from './e2e-browser/chat-lease.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Feishu E2E chat leases', () => {
  it('lets shared holders overlap and gives an exclusive holder the key alone', async () => {
    const order: string[] = [];
    const a = await acquireLease('dm:test-1', 'shared');
    const b = await acquireLease('dm:test-1', 'shared');
    const writer = acquireLease('dm:test-1', 'exclusive').then((release) => {
      order.push('writer');
      return release;
    });
    // Writer-preferring: a shared request behind the waiting writer waits too.
    const late = acquireLease('dm:test-1', 'shared').then((release) => {
      order.push('late');
      return release;
    });
    await tick();
    expect(order).toEqual([]);
    a();
    await tick();
    expect(order).toEqual([]);
    b();
    const releaseWriter = await writer;
    await tick();
    expect(order).toEqual(['writer']);
    releaseWriter();
    (await late)();
    expect(order).toEqual(['writer', 'late']);
  });

  it('keeps keys independent and times out a leaked holder', async () => {
    const held = await acquireLease('chat:test-2', 'exclusive');
    const other = await acquireLease('chat:test-3', 'exclusive');
    other();
    await expect(acquireLease('chat:test-2', 'shared', 20)).rejects.toThrow(/Timed out/);
    held();
    (await acquireLease('chat:test-2', 'shared', 20))();
  });
});
