import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';

const failNextWrite = vi.hoisted(() => ({ armed: false }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Inject ENOSPC on the next payload write (fdWriteAll → fs.write callback).
    write(fd: number, buffer: unknown, offset: number, length: number, position: number,
      callback: (err: NodeJS.ErrnoException | null, written?: number) => void) {
      if (failNextWrite.armed) {
        failNextWrite.armed = false;
        callback(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
        return;
      }
      return (actual.write as any)(fd, buffer, offset, length, position, callback);
    },
  };
});

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }),
  getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-only', brand: 'feishu' } }),
  formatLarkError: String,
  LarkTransportDisabledError: class extends Error {},
}));

import * as fs from 'node:fs';
import { downloadMessageResource } from '../src/im/lark/client.js';

/** Pipe-only v1 readable: pipe/on/emit, no async iterator. destroy() honours the
 *  real-stream contract — it stops production and drops its listeners. */
function pipeOnlySource(opts: { destroyThrows?: boolean } = {}) {
  const s = new EventEmitter() as EventEmitter & {
    readable: boolean;
    pipe: (dest: any) => unknown;
    destroy: (err?: Error) => unknown;
  };
  s.readable = true;
  const timer = setInterval(() => s.emit('data', Buffer.from('chunk')), 5);
  let destroyCalls = 0;
  s.pipe = (dest: any) => {
    s.on('data', (d: Buffer) => dest.write(d));
    s.on('end', () => dest.end());
    return dest;
  };
  s.destroy = () => {
    destroyCalls++;
    clearInterval(timer);
    if (opts.destroyThrows) throw new Error('socket already closed');
    s.removeAllListeners();
    s.emit('close');
    return s;
  };
  return {
    stream: s,
    destroyed: () => destroyCalls > 0,
    dataListeners: () => s.listenerCount('data'),
  };
}

let root = '';
beforeEach(() => {
  vi.resetAllMocks();
  failNextWrite.armed = false;
  root = fs.mkdtempSync(join(tmpdir(), 'botmux-legacy-cancel-'));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('a failed legacy download cancels its source stream', () => {
  it('destroys the pipe-only source and releases its listeners', async () => {
    const dir = join(root, 'attachments', 'cli_test', 'om_cancel');
    fs.mkdirSync(dir, { recursive: true });
    const savePath = join(dir, 'a.bin');
    const source = pipeOnlySource();
    expect(Symbol.asyncIterator in source.stream).toBe(false);
    mocks.request.mockResolvedValueOnce({ getReadableStream: () => source.stream });
    failNextWrite.armed = true;

    await expect(downloadMessageResource(
      'cli_test', 'om_cancel', 'file_k', 'file', savePath, undefined,
      { withinRoot: join(root, 'attachments') },
    )).rejects.toThrow();

    // Give the teardown microtasks a chance to run.
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(source.destroyed()).toBe(true);
    expect(source.dataListeners()).toBe(0);
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.part'))).toEqual([]);
  });

  it('keeps the original download error when source destroy also fails', async () => {
    const dir = join(root, 'attachments', 'cli_test', 'om_teardown');
    fs.mkdirSync(dir, { recursive: true });
    const savePath = join(dir, 'b.bin');
    const source = pipeOnlySource({ destroyThrows: true });
    mocks.request.mockResolvedValueOnce({ getReadableStream: () => source.stream });
    failNextWrite.armed = true;

    // allowUserTokenFallback:false makes the app-token error propagate instead
    // of being re-wrapped by the user-token fallback, so the exact reason the
    // caller classifies on is observable.
    await expect(downloadMessageResource(
      'cli_test', 'om_teardown', 'file_k', 'file', savePath, undefined,
      { withinRoot: join(root, 'attachments'), allowUserTokenFallback: false },
    )).rejects.toMatchObject({ code: 'ENOSPC' });

    // Cancellation was still attempted even though it threw.
    expect(source.destroyed()).toBe(true);
  });
});
