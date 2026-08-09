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
  // Mirror the real SDK's separable http instance so the upload-timeout path is
  // exercised (create() → own instance + copyable interceptor registry) instead
  // of only hitting the fail-safe fallback.
  const makeInstance = (): any => ({
    defaults: { timeout: 0 },
    create: (cfg: { timeout?: number }) => {
      const inst = makeInstance();
      if (cfg?.timeout !== undefined) inst.defaults.timeout = cfg.timeout;
      return inst;
    },
    interceptors: {
      request: { handlers: [], use(this: any, f: any, r: any) { this.handlers.push({ fulfilled: f, rejected: r }); } },
      response: { handlers: [], use(this: any, f: any, r: any) { this.handlers.push({ fulfilled: f, rejected: r }); } },
    },
  });
  return { Client: FakeClient, LoggerLevel: { error: 0 }, defaultHttpInstance: makeInstance() };
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

  it('binds the upload client to a dedicated http instance with the 120s upload timeout', async () => {
    const { uploadImageBuffer } = await fresh();
    await uploadImageBuffer('app', 'sec', Buffer.from('x'));
    const httpInstance = constructed[0]?.httpInstance as { defaults?: { timeout?: number } } | undefined;
    expect(httpInstance).toBeDefined();
    expect(httpInstance?.defaults?.timeout).toBe(120_000);
  });

  it('falls back to the plain Client (no throw) when the SDK omits defaultHttpInstance', async () => {
    // Regression for the fail-safe bug codex caught: a stripped/mocked SDK without
    // `defaultHttpInstance` must NOT crash the upload path. This deliberately
    // re-mocks the module WITHOUT that export so the mock fix above does not erase
    // the original bug's trigger condition.
    vi.resetModules();
    constructed.length = 0;
    vi.doMock('@larksuiteoapi/node-sdk', () => {
      class FakeClient {
        opts: Record<string, unknown>;
        im = { v1: { image: { create: async () => ({ image_key: 'img_fallback' }) } } };
        constructor(opts: Record<string, unknown>) {
          this.opts = opts;
          constructed.push(opts);
        }
      }
      return { Client: FakeClient, LoggerLevel: { error: 0 } }; // no defaultHttpInstance
    });
    try {
      const { uploadImageBuffer } = await import('../src/utils/lark-upload.js');
      const key = await uploadImageBuffer('app', 'sec', Buffer.from('x'));
      expect(key).toBe('img_fallback');
      // Fell back to a plain Client: no injected upload httpInstance.
      expect(constructed[0]?.httpInstance).toBeUndefined();
    } finally {
      vi.doUnmock('@larksuiteoapi/node-sdk');
      vi.resetModules();
    }
  });
});
