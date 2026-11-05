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
    const consume = vi.fn(async () => '✅');
    for (const origin of ['unknown', 'expired'] as const) {
      const page = await answerOAuthLoopbackCallback(url, { origin: () => origin, consume });
      expect(page.status).toBe(origin === 'unknown' ? 409 : 400);
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it('consumes its own login and reports the result', async () => {
    const { answerOAuthLoopbackCallback } = await import('../src/utils/oauth-loopback-page.js');
    expect((await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => '✅ done' })).status).toBe(200);
    expect((await answerOAuthLoopbackCallback(url, { origin: () => 'own', consume: async () => '❌ no' })).status).toBe(400);
    const onError = vi.fn();
    expect((await answerOAuthLoopbackCallback(url, {
      origin: () => 'own', consume: async () => { throw new Error('boom'); }, onError,
    })).status).toBe(400);
    expect(onError).toHaveBeenCalled();
  });
});
