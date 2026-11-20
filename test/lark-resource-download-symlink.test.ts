/**
 * The attachment bucket is writable from inside the file sandbox, so a host
 * download (incoming message, or a `quoted` relayed to the host) must never
 * write through a planted symlink.
 *
 * Run: npx vitest run --project unit test/lark-resource-download-symlink.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';

const mocks = vi.hoisted(() => ({ request: vi.fn(), userToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }),
  getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_test', larkAppSecret: 'test-only', brand: 'feishu' } }),
  formatLarkError: String,
  LarkTransportDisabledError: class extends Error {},
}));

vi.mock('../src/utils/user-token.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/user-token.js')>(),
  resolveUserToken: mocks.userToken,
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

  it('range download: a directory swapped during the probe and restored before the data cannot host the staging file', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(hostDir);
    const dir = join(root, 'om_s');
    mkdirSync(dir);
    const data = Buffer.from('DATA');
    let calls = 0;
    const request = async (start: number, end: number): Promise<ResourceStream> => {
      calls++;
      if (calls === 1) { renameSync(dir, `${dir}.moved`); symlinkSync(hostDir, dir); }   // during the probe
      if (calls === 2) { unlinkSync(dir); renameSync(`${dir}.moved`, dir); }              // restored before the data
      return Object.assign(Readable.from([data.subarray(start, end + 1)]), {
        statusCode: 206, headers: { 'content-range': `bytes ${start}-${end}/${data.length}` },
      });
    };
    await downloadResourceWithRange(request, join(dir, 'a.bin'));
    expect(readFileSync(join(dir, 'a.bin'))).toEqual(data);
    expect(readdirSync(hostDir)).toEqual([]);
    expect(readdirSync(dir)).toEqual(['a.bin']);
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

  it('withinRoot: an ancestor swapped during the network wait cannot redirect the final rename', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(join(hostDir, 'om_b'), { recursive: true });
    const attachments = join(root, 'attachments');
    mkdirSync(join(attachments, 'app', 'om_b'), { recursive: true });
    mocks.request.mockImplementationOnce(async () => {
      renameSync(join(attachments, 'app'), join(attachments, 'app.moved'));
      symlinkSync(hostDir, join(attachments, 'app'));
      return Buffer.from('EVIL');
    });
    await expect(downloadMessageResource('cli_test', 'om_b', 'file_k', 'file', join(attachments, 'app', 'om_b', 'cli.js'), undefined, { withinRoot: attachments }))
      .rejects.toThrow();
    expect(readdirSync(join(hostDir, 'om_b'))).toEqual([]);
    expect(readdirSync(join(attachments, 'app.moved', 'om_b'))).toEqual([]);
  });

  it('withinRoot: the user-token path carries the same directory guard across the network wait', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(join(hostDir, 'om_u'), { recursive: true });
    const attachments = join(root, 'attachments');
    mkdirSync(join(attachments, 'app', 'om_u'), { recursive: true });
    // app token: 403 → user-token fallback; the fetch body arrives after the swap
    mocks.request.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { response: { status: 403, data: {} } }));
    mocks.userToken.mockResolvedValueOnce('u-token');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        renameSync(join(attachments, 'app'), join(attachments, 'app.moved'));
        symlinkSync(hostDir, join(attachments, 'app'));
        return new TextEncoder().encode('EVIL').buffer;
      },
    }) as unknown as Response);
    try {
      await expect(downloadMessageResource('cli_test', 'om_u', 'file_k', 'file', join(attachments, 'app', 'om_u', 'cli.js'), 'ou_x', { withinRoot: attachments }))
        .rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(readdirSync(join(hostDir, 'om_u'))).toEqual([]);
      expect(readdirSync(join(attachments, 'app.moved', 'om_u'))).toEqual([]);
    } finally { fetchSpy.mockRestore(); }
  });

  it('withinRoot: does not mkdir the message directory through a planted ancestor', async () => {
    const hostDir = join(root, 'host-dist');
    mkdirSync(hostDir);
    const attachments = join(root, 'attachments');
    mkdirSync(attachments);
    symlinkSync(hostDir, join(attachments, 'app'));
    await expect(downloadMessageResource('cli_test', 'om_c', 'file_k', 'file', join(attachments, 'app', 'om_c', 'x.bin'), undefined, { withinRoot: attachments }))
      .rejects.toThrow(/outside/);
    expect(readdirSync(hostDir)).toEqual([]);
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
