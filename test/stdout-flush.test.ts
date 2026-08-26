import { describe, expect, it } from 'vitest';
import { writeAndFlush } from '../src/cli/stdout-flush.js';

describe('writeAndFlush', () => {
  it('waits for a backpressured stream completion callback', async () => {
    let complete: ((error?: Error | null) => void) | undefined;
    const stream = {
      write(_chunk: string, callback: (error?: Error | null) => void) {
        complete = callback;
        return false;
      },
    };

    let settled = false;
    const pending = writeAndFlush(stream, 'large PM2 registry').then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    complete?.();
    await pending;
    expect(settled).toBe(true);
  });
});
