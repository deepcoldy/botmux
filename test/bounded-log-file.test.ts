import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BoundedLogFile } from '../src/utils/bounded-log-file.js';

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bounded-attempt-'));
  path = join(dir, 'pty.log');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('appends raw bytes through the exact disk limit and refuses later writes once', async () => {
  const prefix = '\x1b[2J';
  writeFileSync(path, prefix);
  const data = Buffer.from('你好\r\n');
  const onLimit = vi.fn();
  const file = new BoundedLogFile(path, { onLimit, maxBytes: Buffer.byteLength(prefix) + data.length });
  file.write(data.subarray(0, 1));
  file.write(data.subarray(1));
  file.write('!');
  file.write('ignored');
  await file.end();
  expect(readFileSync(path)).toEqual(Buffer.concat([Buffer.from(prefix), data]));
  expect(onLimit.mock.calls).toEqual([['disk']]);
});

it('counts UTF-8 bytes already queued when admitting the next chunk', async () => {
  const onLimit = vi.fn();
  const file = new BoundedLogFile(path, { onLimit, maxBufferedBytes: 6 });
  file.write('中');
  file.write('文');
  file.write('a');
  file.write('ignored');
  await file.end();
  expect(readFileSync(path, 'utf8')).toBe('中文');
  expect(onLimit.mock.calls).toEqual([['buffer']]);
});

it('keeps unused logs lazy and write errors best effort', async () => {
  const onLimit = vi.fn();
  await new BoundedLogFile(path, { onLimit }).end();
  expect(existsSync(path)).toBe(false);
  const onError = vi.fn();
  const file = new BoundedLogFile(join(path, 'missing'), { onLimit, onError });
  file.write('first');
  await file.end();
  file.write('ignored');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onLimit).not.toHaveBeenCalled();
});

it('releases shutdown when a diagnostic stream never finishes ending', async () => {
  vi.useFakeTimers();
  const stalled = vi.spyOn(WriteStream.prototype, 'end').mockReturnThis();
  try {
    const file = new BoundedLogFile(path, { onLimit: vi.fn() });
    file.write('pending');
    const closed = file.end();
    expect(stalled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    await closed;
  } finally {
    stalled.mockRestore();
    vi.useRealTimers();
  }
});
