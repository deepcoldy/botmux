/**
 * The 127.0.0.1:9768 loopback listener on a person's own computer receives
 * callbacks for logins started by a BotMux on ANOTHER machine. Those must be
 * recognized as not ours (not "expired"), left unconsumed, and the page must
 * hand the URL back for pasting into the topic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const realTmp = () => process.env.TMPDIR || '/tmp';

let tempDir: string;
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return tempDir; } } } }));
// Pending-login files live under HOME/.botmux/data: keep them in the temp dir.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tempDir };
});
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  tempDir = mkdtempSync(join(realTmp(), 'oauth-loopback-origin-'));
  vi.resetModules();
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

const callback = (state: string) => `http://127.0.0.1:9768/callback?code=abc&state=${state}`;

describe('callbackOrigin', () => {
  it('own: a login this machine started (also from another process via the pending file)', async () => {
    const a = await import('../src/utils/user-token.js');
    const { state } = a.generateAuthUrl('cli_app', 'secret', 'feishu');
    expect(a.callbackOrigin(callback(state))).toBe('own');
    vi.resetModules();
    const b = await import('../src/utils/user-token.js');
    expect(b.callbackOrigin(callback(state))).toBe('own');
  });

  it('unknown: a state this machine never issued (the link came from another BotMux)', async () => {
    const { callbackOrigin } = await import('../src/utils/user-token.js');
    expect(callbackOrigin(callback('f'.repeat(64)))).toBe('unknown');
    expect(callbackOrigin('http://127.0.0.1:9768/callback?code=abc')).toBe('unknown');
  });

  it('expired: started here but past its lifetime', async () => {
    const a = await import('../src/utils/user-token.js');
    const { state } = a.generateAuthUrl('cli_app', 'secret', 'feishu');
    vi.resetModules();
    const b = await import('../src/utils/user-token.js');
    const dir = findPendingDir(tempDir, state);
    const file = join(dir, `${state}.json`);
    const pending = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...pending, createdAt: Date.now() - 60 * 60_000 }));
    expect(b.callbackOrigin(callback(state))).toBe('expired');
  });
});

describe('renderOAuthLoopbackPage', () => {
  it('foreign: explains it, and shows the escaped URL to paste back', async () => {
    const { renderOAuthLoopbackPage } = await import('../src/utils/oauth-loopback-page.js');
    const page = renderOAuthLoopbackPage('foreign', 'http://127.0.0.1:9768/callback?code=a&state=<x>');
    expect(page.status).toBe(409);
    expect(page.html).toContain('state=&lt;x&gt;');
    expect(page.html).not.toContain('<x>');
    expect(page.html).not.toContain('授权链接无效或已过期');
  });

  it('ok and failed keep their meaning', async () => {
    const { renderOAuthLoopbackPage } = await import('../src/utils/oauth-loopback-page.js');
    expect(renderOAuthLoopbackPage('ok', 'u').status).toBe(200);
    const failed = renderOAuthLoopbackPage('failed', 'u');
    expect(failed.status).toBe(400);
    expect(failed.html).toContain('授权链接无效或已过期');
  });
});

function findPendingDir(root: string, state: string): string {
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) stack.push(join(d, e.name));
      else if (e.name === `${state}.json`) return d;
    }
  }
  throw new Error('pending file not found');
}

describe('answerOAuthLoopbackCallback', () => {
  const url = 'http://127.0.0.1:9768/callback?code=c&state=s';
  it('never consumes a callback this machine did not start', async () => {
    const { answerOAuthLoopbackCallback } = await import('../src/utils/oauth-loopback-page.js');
    const consume = vi.fn(async () => ({ message: '✅' }));
    for (const origin of ['unknown', 'expired'] as const) {
      const page = await answerOAuthLoopbackCallback(url, { origin: () => origin, consume });
      expect(page.status).toBe(origin === 'unknown' ? 409 : 400);
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('consumes its own login and reports the result', async () => {
    const { answerOAuthLoopbackCallback } = await import('../src/utils/oauth-loopback-page.js');
    expect((await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => ({ message: '✅ done' }) })).status).toBe(200);
    expect((await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => ({ message: '❌ no' }) })).status).toBe(400);
    const onError = vi.fn();
    expect((await answerOAuthLoopbackCallback(url, {
      origin: () => 'own', consume: async () => { throw new Error('boom'); }, onError,
    })).status).toBe(400);
    expect(onError).toHaveBeenCalled();
  });
});

// 自动回调页（回环 127.0.0.1:9768 / Dashboard /oauth/callback）成功时原本只显示固定文案：
// 授权已保存、但飞书没给全申请的权限（如卡在应用新版本的企业审核）时，补充说明必须显示出来。
describe('callback pages show what the saved grant is missing', () => {
  const url = 'http://127.0.0.1:9768/callback?code=c&state=s';
  const warning = '⚠️ 但飞书没有授予本次申请的以下权限：im:feed.flag:read。应用新版本 1.0.11 正在企业审核 <b>';

  it('loopback page: shows the escaped warning on success, nothing extra otherwise', async () => {
    const { answerOAuthLoopbackCallback } = await import('../src/utils/oauth-loopback-page.js');
    const page = await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => ({ message: '✅ ok', warning }) });
    expect(page.status).toBe(200);
    expect(page.html).toContain('im:feed.flag:read');
    expect(page.html).toContain('1.0.11');
    expect(page.html).toContain('&lt;b&gt;');
    expect(page.html).not.toContain('<b>');
    const plain = await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => ({ message: '✅ ok' }) });
    expect(plain.html).not.toContain('⚠️');
    // 失败时不把（不该出现的）warning 当成功补充说明显示。
    const failed = await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => ({ message: '❌ no', warning }) });
    expect(failed.status).toBe(400);
    expect(failed.html).not.toContain('im:feed.flag:read');
  });

  it('dashboard /oauth/callback body: warning shown on success, failure text escaped', async () => {
    const { dashboardOAuthCallbackBody } = await import('../src/utils/oauth-loopback-page.js');
    const ok = dashboardOAuthCallbackBody({ ok: true, message: '✅ 授权成功', warning });
    expect(ok).toContain('im:feed.flag:read');
    expect(ok).toContain('&lt;b&gt;');
    expect(ok).not.toContain('<b>');
    expect(dashboardOAuthCallbackBody({ ok: true, message: '✅ 授权成功' })).not.toContain('⚠️');
    const failed = dashboardOAuthCallbackBody({ ok: false, message: '❌ 授权失败：<script>x</script>' });
    expect(failed).toContain('&lt;script&gt;');
    expect(failed).not.toContain('<script>');
  });
});
