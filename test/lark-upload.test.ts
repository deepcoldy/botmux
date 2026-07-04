/**
 * Worker screenshot upload must target the tenant's brand domain (Codex review
 * F1): a Lark bot's image upload has to hit larksuite.com, not feishu.cn.
 *
 * Run:  pnpm vitest run test/lark-upload.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SDK Client constructed by lark-upload + stub the upload call.
const constructed: Array<Record<string, unknown>> = [];

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient {
    opts: Record<string, unknown>;
    im = { v1: { image: { create: async () => ({ image_key: 'img_xyz' }) } } };
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      constructed.push(opts);
    }
  }
  return { Client: FakeClient, LoggerLevel: { error: 0 } };
});

async function fresh() {
  vi.resetModules();
  constructed.length = 0;
  return await import('../src/utils/lark-upload.js');
}

describe('uploadImageBuffer — brand domain', () => {
  beforeEach(() => { constructed.length = 0; });

  it('defaults to the feishu domain', async () => {
    const { uploadImageBuffer } = await fresh();
    const key = await uploadImageBuffer('app', 'sec', Buffer.from('x'));
    expect(key).toBe('img_xyz');
    expect(constructed[0]?.domain).toBe('https://open.feishu.cn');
  });

  it('uploads to the larksuite domain for a lark bot', async () => {
    const { uploadImageBuffer } = await fresh();
    await uploadImageBuffer('app', 'sec', Buffer.from('x'), 'lark');
    expect(constructed[0]?.domain).toBe('https://open.larksuite.com');
  });

  it('does not reuse a cached client across brands (cache key includes brand)', async () => {
    const { uploadImageBuffer } = await fresh();
    await uploadImageBuffer('app', 'sec', Buffer.from('x'), 'feishu');
    await uploadImageBuffer('app', 'sec', Buffer.from('x'), 'lark');
    expect(constructed.map(c => c.domain)).toEqual([
      'https://open.feishu.cn',
      'https://open.larksuite.com',
    ]);
  });
});
