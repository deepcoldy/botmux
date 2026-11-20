/**
 * The attachment bucket is writable from inside the file sandbox, so a host
 * download (incoming message, or a `quoted` relayed to the host) must never
 * write through a planted symlink.
 *
 * Run: npx vitest run --project unit test/lark-resource-download-symlink.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }),
  getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-only', brand: 'feishu' } }),
  formatLarkError: String,
  LarkTransportDisabledError: class extends Error {},
}));

import { downloadMessageResource } from '../src/im/lark/client.js';
import { downloadResourceWithRange, type ResourceStream } from '../src/im/lark/resource-range-download.js';

let root = '';
beforeEach(() => { vi.resetAllMocks(); root = mkdtempSync(join(tmpdir(), 'botmux-dl-symlink-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('downloadMessageResource symlink safety', () => {
  it.each([
    ['buffer', () => Buffer.from('NEW')],
    ['stream', () => Readable.from([Buffer.from('NEW')])],
  ])('replaces a symlinked file name (%s body)', async (_kind, body) => {
    const victim = join(root, 'victim.js');
    writeFileSync(victim, 'HOST');
    const dir = join(root, 'om_x');
    mkdirSync(dir);
    symlinkSync(victim, join(dir, 'a.js'));
    mocks.request.mockResolvedValueOnce(body());
    await downloadMessageResource('cli_test', 'om_x', 'file_k', 'file', join(dir, 'a.js'));
    expect(readFileSync(victim, 'utf8')).toBe('HOST');
    expect(lstatSync(join(dir, 'a.js')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'a.js'), 'utf8')).toBe('NEW');
  });

  it('does not rename into a directory swapped for a symlink after the pre-check (SDK writeFile body)', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(hostDir);
    writeFileSync(join(hostDir, 'cli.js'), 'HOST');
    const dir = join(root, 'om_z');
    mkdirSync(dir);
    // The Lark SDK hands back an object whose writeFile() opens the path itself.
    // Swapping the directory right before that open is the exact window the
    // network wait leaves open to another process.
    mocks.request.mockResolvedValueOnce({
      writeFile: async (tmp: string) => {
        renameSync(dir, `${dir}.moved`);
        symlinkSync(hostDir, dir);
        writeFileSync(tmp, 'EVIL', { flag: 'wx' });
      },
    });
    await expect(downloadMessageResource('cli_test', 'om_z', 'file_k', 'file', join(dir, 'cli.js'))).rejects.toThrow();
    expect(readFileSync(join(hostDir, 'cli.js'), 'utf8')).toBe('HOST');
    expect(readdirSync(hostDir)).toEqual(['cli.js']);
  });

  it('range download: does not rename into a directory swapped during the probe', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(hostDir);
    writeFileSync(join(hostDir, 'cli.js'), 'HOST');
    const dir = join(root, 'om_r');
    mkdirSync(dir);
    const data = Buffer.from('EVIL');
    let swapped = false;
    const request = async (start: number, end: number): Promise<ResourceStream> => {
      if (!swapped) { swapped = true; renameSync(dir, `${dir}.moved`); symlinkSync(hostDir, dir); }
      return Object.assign(Readable.from([data.subarray(start, end + 1)]), {
        statusCode: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}` },
      });
    };
    await expect(downloadResourceWithRange(request, join(dir, 'cli.js'))).rejects.toThrow();
    expect(readFileSync(join(hostDir, 'cli.js'), 'utf8')).toBe('HOST');
    expect(readdirSync(hostDir)).toEqual(['cli.js']);
  });

  it('withinRoot: refuses a message directory reached through a swapped ancestor', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(join(hostDir, 'om_a'), { recursive: true });
    const attachments = join(root, 'attachments');
    mkdirSync(attachments);
    symlinkSync(hostDir, join(attachments, 'app'));
    mocks.request.mockResolvedValueOnce(Buffer.from('EVIL'));
    await expect(downloadMessageResource('cli_test', 'om_a', 'file_k', 'file', join(attachments, 'app', 'om_a', 'cli.js'), undefined, { withinRoot: attachments }))
      .rejects.toThrow(/outside/);
    expect(readdirSync(join(hostDir, 'om_a'))).toEqual([]);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('refuses a symlinked message directory', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(hostDir);
    symlinkSync(hostDir, join(root, 'om_y'));
    mocks.request.mockResolvedValueOnce(Buffer.from('NEW'));
    await expect(downloadMessageResource('cli_test', 'om_y', 'file_k', 'file', join(root, 'om_y', 'cli.js'))).rejects.toThrow();
    expect(() => lstatSync(join(hostDir, 'cli.js'))).toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
