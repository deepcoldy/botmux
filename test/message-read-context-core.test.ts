import { describe, it, expect, vi } from 'vitest';
import { readMessageWithinContext, withMessageReadContext } from '../src/im/lark/message-read-context.js';

describe('message read context isolation and concurrency', () => {
  it('coalesces pending and completed reads, with independent returned objects', async () => {
    const read = vi.fn(async () => ({ body: { content: 'original' } }));
    await withMessageReadContext(async () => {
      const [first, second] = await Promise.all([readMessageWithinContext('key', read), readMessageWithinContext('key', read)]);
      first.body.content = 'modified';
      expect(second.body.content).toBe('original');
      expect((await readMessageWithinContext('key', read)).body.content).toBe('original');
    });
    expect(read).toHaveBeenCalledTimes(1);
    await withMessageReadContext(() => readMessageWithinContext('key', read));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('does not retain failed reads and releases the slot for a retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ ok: true });
    await withMessageReadContext(async () => {
      await expect(readMessageWithinContext('key', read)).rejects.toThrow('temporary');
      expect(await readMessageWithinContext('key', read)).toEqual({ ok: true });
    }, 1);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('bounds simultaneous reads while completing every queued request', async () => {
    let active = 0; let peak = 0;
    const read = vi.fn(async () => { peak = Math.max(peak, ++active); await Promise.resolve(); active--; return { ok: true }; });
    const result = await withMessageReadContext(() => Promise.all(Array.from({ length: 20 }, (_, index) => readMessageWithinContext(String(index), read))), 2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(result).toHaveLength(20);
    expect(read).toHaveBeenCalledTimes(20);
  });
});
