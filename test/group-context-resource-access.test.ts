import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('automatic historical attachment access', () => {
  it('never borrows any human token when the app cannot read a historical resource', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'group-resource-')); dirs.push(dir);
    const denied = Object.assign(new Error('app forbidden'), { status: 403 });
    mocks.request.mockRejectedValue(denied);
    await expect(downloadMessageResource('cli_app', 'om_old', 'img_key', 'image', join(dir, 'image.png'), undefined, { allowUserTokenFallback: false })).rejects.toBe(denied);
    expect(mocks.userToken).not.toHaveBeenCalled();
  });
});


describe('video body download transport', () => {
  it.each(['video', 'file', 'image'] as const)('uses the correct app-token endpoint for %s', async (type) => {
    const dir = mkdtempSync(join(tmpdir(), 'video-resource-')); dirs.push(dir);
    mocks.request.mockResolvedValue(Buffer.from('attachment bytes'));
    const file = join(dir, 'attachment');
    await downloadMessageResource('cli_app', 'om_video', 'body_key', type, file);
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET', params: { type: type === 'image' ? 'image' : 'file' },
      url: '/open-apis/im/v1/messages/om_video/resources/body_key',
    }));
    expect(readFileSync(file).toString()).toBe('attachment bytes');
    expect(mocks.userToken).not.toHaveBeenCalled();
  });

  it('also maps video bodies to file for the user-token fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'video-fallback-')); dirs.push(dir);
    mocks.request.mockRejectedValue(Object.assign(new Error('app forbidden'), { status: 403 }));
    mocks.userToken.mockResolvedValue('test-only-token');
    const fetchMock = vi.fn(async () => new Response('video bytes'));
    vi.stubGlobal('fetch', fetchMock);
    const file = join(dir, 'clip.mp4');
    await downloadMessageResource('cli_app', 'om_video', 'body_key', 'video', file, 'ou_sender');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_video/resources/body_key?type=file',
      expect.any(Object),
    );
    expect(readFileSync(file).toString()).toBe('video bytes');
  });
});
