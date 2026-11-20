import './helpers/require-fenced-data-dir.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const probe = vi.hoisted(() => ({ deadCloses: [] as Array<{ fd: number; code: string }> }));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Record any attempt to close a descriptor that is already dead. The bug
    // being pinned: pipeline() destroys the staging WriteStream on error and
    // closes its fd (even with autoClose:false), then writeViaRename's finally
    // closeSync() closes that recycled number a second time.
    closeSync(fd: number) {
      try {
        actual.fstatSync(fd);
      } catch (error) {
        probe.deadCloses.push({ fd, code: (error as NodeJS.ErrnoException).code });
      }
      return (actual.closeSync as any)(fd);
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

let root = '';
beforeEach(() => {
  vi.resetAllMocks();
  probe.deadCloses = [];
  root = fs.mkdtempSync(join(tmpdir(), 'botmux-fd-ownership-'));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('download staging descriptor has a single owner', () => {
  it('never closeSync a descriptor the stream already closed on error', async () => {
    const dir = join(root, 'attachments', 'cli_test', 'om_fd');
    fs.mkdirSync(dir, { recursive: true });
    const savePath = join(dir, 'a.bin');
    mocks.request.mockResolvedValueOnce({
      getReadableStream: () => Readable.from((async function* () {
        yield Buffer.from('partial');
        throw new Error('stream reset mid-download');
      })()),
    });

    await expect(downloadMessageResource(
      'cli_test', 'om_fd', 'file_k', 'file', savePath, undefined,
      { withinRoot: join(root, 'attachments') },
    )).rejects.toThrow();

    expect(probe.deadCloses).toEqual([]);
    // The failed staging file is cleaned up, no .part left behind.
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.part'))).toEqual([]);
  });
});
