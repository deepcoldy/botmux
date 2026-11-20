import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const slow = vi.hoisted(() => ({ enabled: false, syncW: 0, asyncW: 0 }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync(fd: number, ...args: any[]) {
      slow.syncW++;
      // Deterministic stand-in for a slow disk on the pre-fix synchronous path.
      if (slow.enabled) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      return (actual.writeSync as any)(fd, ...args);
    },
    write(fd: number, ...args: any[]) {
      slow.asyncW++;
      // The fixed path uses callback writes on the same already-open fd. Give
      // the event loop a chance to run before completing the disk operation.
      if (!slow.enabled) return (actual.write as any)(fd, ...args);
      setTimeout(() => (actual.write as any)(fd, ...args), 60);
    },
  };
});

import * as fs from 'node:fs';
import { downloadResourceWithRange, type ResourceStream } from '../src/im/lark/resource-range-download.js';

let root = '';
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'botmux-range-async-write-'));
  slow.enabled = false;
  slow.syncW = 0;
  slow.asyncW = 0;
});
afterEach(() => { slow.enabled = false; fs.rmSync(root, { recursive: true, force: true }); });

function partial(start: number, end: number, total: number): ResourceStream {
  return Object.assign(Readable.from([Buffer.alloc(end - start + 1, 7)]), {
    statusCode: 206,
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
  });
}

describe('Range data writes stay asynchronous on the pinned descriptor', () => {
  it('lets the event loop run while a disk write is pending', async () => {
    slow.enabled = true;
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 5);
    try {
      await downloadResourceWithRange(async (start, end) => partial(start, end, 3), join(root, 'a.bin'));
      // The timer view alone is load-sensitive: fdStat/stream close can let an
      // overdue timer run even after a blocking write. Pin the syscall used for
      // payload bytes as well, so a writeSync mutation cannot survive it.
      expect(slow.asyncW).toBeGreaterThan(0);
      expect(slow.syncW).toBe(0);
      expect(timerRan).toBe(true);
    } finally { clearTimeout(timer); }
  });
});
