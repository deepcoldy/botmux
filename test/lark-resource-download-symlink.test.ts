/**
 * The attachment bucket is writable from inside the file sandbox, so a host
 * download (incoming message, or a `quoted` relayed to the host) must never
 * write through a planted symlink.
 *
 * Run: npx vitest run --project unit test/lark-resource-download-symlink.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
