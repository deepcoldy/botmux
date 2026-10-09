import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const mocks = vi.hoisted(() => ({ request: vi.fn(), userToken: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: () => ({ request: mocks.request }), getAllBots: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_app', larkAppSecret: 'test-only', apiOnly: false } }),
  formatLarkError: String,
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: mocks.userToken }));
import { downloadMessageResource } from '../src/im/lark/client.js';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('automatic historical attachment access', () => {
  it('never borrows any human token when the app cannot read a historical resource', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-resource-')); dirs.push(dir);
    const denied = Object.assign(new Error('app forbidden'), { status: 403 });
    mocks.request.mockRejectedValue(denied);
    await expect(downloadMessageResource('cli_app', 'om_old', 'img_key', 'image', join(dir, 'image.png'), undefined, { allowUserTokenFallback: false })).rejects.toBe(denied);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
});
