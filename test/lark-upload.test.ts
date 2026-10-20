/**
 * Worker screenshot upload must target the tenant's brand domain (Codex review
 * F1): a Lark bot's image upload has to hit larksuite.com, not feishu.cn.
 *
 * Run:  pnpm vitest run test/lark-upload.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SDK Client constructed by lark-upload + stub the upload call.
const H = vi.hoisted(() => {
  const constructed: Array<Record<string, unknown>> = [];
  const createdAgents: Array<{ kind: string; destroys: number; cfg: Record<string, unknown> }> = [];
  let uploadCreate: ((...args: unknown[]) => Promise<unknown>) | undefined;
  class FakeAgent {
    private rec: { kind: string; destroys: number; cfg: Record<string, unknown> };
    constructor(kind: string, cfg: Record<string, unknown>) {
      this.rec = { kind, destroys: 0, cfg };
      createdAgents.push(this.rec);
    }
    destroy() {
      this.rec.destroys++;
    }
  }
  return {
    constructed,
    createdAgents,
    FakeAgent,
    setUploadCreate: (fn: typeof uploadCreate) => {
      uploadCreate = fn;
    },
    getUploadCreate: () => uploadCreate,
    // Factory for the default (with-http-instance) SDK mock. Reusable from both
    // the static vi.mock and the fallback test's doMock/restore so an earlier
    // doUnmock cannot leak the real SDK into later describe blocks.
    sdkMock: () => {
      class FakeClient {
        opts: Record<string, unknown>;
        im = {
          v1: {
            image: {
              create: (...args: unknown[]) => {
                const fn = uploadCreate;
                return fn ? fn(...args) : Promise.resolve({ image_key: 'img_xyz' });
              },
            },
          },
        };
        constructor(opts: Record<string, unknown>) {
          this.opts = opts;
          constructed.push(opts);
        }
      }
      const makeInstance = (): any => ({
        defaults: { timeout: 0 },
        create: (cfg: { timeout?: number; httpAgent?: any; httpsAgent?: any }) => {
          const inst = makeInstance();
          if (cfg?.timeout !== undefined) inst.defaults.timeout = cfg.timeout;
          if (cfg?.httpAgent) inst.httpAgent = cfg.httpAgent;
          if (cfg?.httpsAgent) inst.httpsAgent = cfg.httpsAgent;
          return inst;
        },
        interceptors: {
          request: { handlers: [], use(this: any, f: any, r: any) { this.handlers.push({ fulfilled: f, rejected: r }); } },
          response: { handlers: [], use(this: any, f: any, r: any) { this.handlers.push({ fulfilled: f, rejected: r }); } },
        },
      });
      return { Client: FakeClient, LoggerLevel: { error: 0 }, defaultHttpInstance: makeInstance() };
    },
  };
});
const { constructed, createdAgents, setUploadCreate } = H;

vi.mock('node:http', () => ({
  Agent: class extends H.FakeAgent {
    constructor(cfg: Record<string, unknown>) {
      super('http', cfg);
    }
  },
}));
vi.mock('node:https', () => ({
  Agent: class extends H.FakeAgent {
    constructor(cfg: Record<string, unknown>) {
      super('https', cfg);
    }
  },
}));

vi.mock('@larksuiteoapi/node-sdk', () => H.sdkMock());

async function fresh() {
  vi.resetModules();
  constructed.length = 0;
  createdAgents.length = 0;
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

  it('binds the upload client to a dedicated http instance with the 30s upload timeout', async () => {
    const { uploadImageBuffer } = await fresh();
    await uploadImageBuffer('app', 'sec', Buffer.from('x'));
    const httpInstance = constructed[0]?.httpInstance as { defaults?: { timeout?: number } } | undefined;
    expect(httpInstance).toBeDefined();
    expect(httpInstance?.defaults?.timeout).toBe(30_000);
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
      // Restore the default mock so later describe blocks don't fall through to
      // the real SDK (static vi.mock is not re-armed after doUnmock).
      vi.doMock('@larksuiteoapi/node-sdk', () => H.sdkMock());
      vi.resetModules();
    }
  });
});

describe('uploadImageBuffer — keep-alive pool resilience', () => {
  beforeEach(() => {
    constructed.length = 0;
    createdAgents.length = 0;
    setUploadCreate(undefined);
  });

  it('provisions a dedicated keep-alive https agent with a short idle TTL', async () => {
    const { uploadImageBuffer } = await fresh();
    await uploadImageBuffer('app', 'sec', Buffer.from('x'));
    const httpInstance = constructed[0]?.httpInstance as { httpsAgent?: any } | undefined;
    expect(httpInstance?.httpsAgent).toBeDefined();
    const httpsAgentRec = createdAgents.find((a) => a.kind === 'https');
    expect(httpsAgentRec).toBeDefined();
    expect(httpsAgentRec?.cfg.keepAlive).toBe(true);
    // Idle TTL must be finite and short so pooled sockets are reaped before an
    // intermediary can silently reclaim them.
    expect(httpsAgentRec?.cfg.timeout as number).toBeGreaterThan(0);
    expect(httpsAgentRec?.cfg.timeout as number).toBeLessThanOrEqual(30_000);
  });

  it('destroys pooled agents and rebuilds the client after a transport failure', async () => {
    const { uploadImageBuffer } = await fresh();
    // A network/timeout error has no HTTP response attached.
    setUploadCreate(async () => {
      const e: any = new Error('socket hang up');
      e.code = 'ECONNRESET';
      throw e;
    });
    await expect(uploadImageBuffer('app', 'sec', Buffer.from('x'))).rejects.toThrow(/hang up/);
    const firstAgents = createdAgents.filter((a) => a.kind === 'https');
    expect(firstAgents.length).toBe(1);
    expect(firstAgents[0].destroys).toBe(1);
    expect(constructed.length).toBe(1);

    // Next upload rebuilds a clean pool and client instead of reusing the dead one.
    setUploadCreate(undefined);
    const key = await uploadImageBuffer('app', 'sec', Buffer.from('x'));
    expect(key).toBe('img_xyz');
    expect(constructed.length).toBe(2);
    const httpsAgents = createdAgents.filter((a) => a.kind === 'https');
    expect(httpsAgents.length).toBe(2);
  });

  it('keeps the pool intact after a normal HTTP status error (has response)', async () => {
    const { uploadImageBuffer } = await fresh();
    setUploadCreate(async () => {
      const e: any = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { code: 1 } };
      throw e;
    });
    await expect(uploadImageBuffer('app', 'sec', Buffer.from('x'))).rejects.toThrow(/400/);
    const httpsAgents = createdAgents.filter((a) => a.kind === 'https');
    expect(httpsAgents.length).toBe(1);
    expect(httpsAgents[0].destroys).toBe(0);
    expect(constructed.length).toBe(1);
  });
});
