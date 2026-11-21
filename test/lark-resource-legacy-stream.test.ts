import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

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

/** A legacy v1 readable: pipe/on/emit only, deliberately NO async iterator.
 *  pipeline() consumed this shape; the fd-ownership refactor must still do so. */
function pipeOnlyReadable(chunks: string[]) {
  const s = new EventEmitter() as EventEmitter & { readable: boolean; pipe: (dest: unknown) => unknown };
  s.readable = true;
  s.pipe = (dest: any) => {
    s.on('data', (d: Buffer) => dest.write(d));
    s.on('end', () => dest.end());
    s.on('error', (e: Error) => dest.destroy(e));
    return dest;
  };
  process.nextTick(() => {
    for (const c of chunks) s.emit('data', Buffer.from(c));
    s.emit('end');
  });
  return s;
}

let root = '';
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.mkdtempSync(join(tmpdir(), 'botmux-legacy-stream-'));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('download accepts a pipe-only legacy readable', () => {
  it('drains it onto the pinned descriptor without an async iterator', async () => {
    const dir = join(root, 'attachments', 'cli_test', 'om_legacy');
    fs.mkdirSync(dir, { recursive: true });
    const savePath = join(dir, 'a.bin');
    const legacy = pipeOnlyReadable(['LE', 'GA', 'CY']);
    expect(Symbol.asyncIterator in legacy).toBe(false);
    mocks.request.mockResolvedValueOnce({ getReadableStream: () => legacy });

    await downloadMessageResource(
      'cli_test', 'om_legacy', 'file_k', 'file', savePath, undefined,
      { withinRoot: join(root, 'attachments') },
    );

    expect(fs.readFileSync(savePath, 'utf8')).toBe('LEGACY');
  });

  it('still consumes a modern async-iterable readable', async () => {
    const dir = join(root, 'attachments', 'cli_test', 'om_modern');
    fs.mkdirSync(dir, { recursive: true });
    const savePath = join(dir, 'b.bin');
    mocks.request.mockResolvedValueOnce({
      getReadableStream: () => Readable.from([Buffer.from('MODERN')]),
    });

    await downloadMessageResource(
      'cli_test', 'om_modern', 'file_k', 'file', savePath, undefined,
      { withinRoot: join(root, 'attachments') },
    );

    expect(fs.readFileSync(savePath, 'utf8')).toBe('MODERN');
  });
});
