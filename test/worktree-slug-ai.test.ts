import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { worktreeSlugFromContextAI } from '../src/services/worktree-slug-ai.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('worktreeSlugFromContextAI', () => {
  const original = { ...config.worktreeSlugAI };
  const originalDescriptor = Object.getOwnPropertyDescriptor(config, 'worktreeSlugAI');
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    Object.assign(config.worktreeSlugAI, {
      enabled: true,
      baseUrl: 'https://ai.example/v1',
      apiKey: 'test-key',
      model: 'test-model',
      timeoutMs: 1000,
      extraHeaders: {},
      extraBody: {},
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    const currentConfig = config.worktreeSlugAI;
    if (currentConfig) {
      Object.assign(currentConfig, original);
    } else if (originalDescriptor) {
      Object.defineProperty(config, 'worktreeSlugAI', { ...originalDescriptor, value: { ...original } });
    }
    vi.restoreAllMocks();
  });

  it('uses the AI generated English slug for Chinese input', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'worktree-naming-logic' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree-naming-logic');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('sanitizes invalid model output', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: ' Worktree Naming Logic!!! ' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;

    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree-naming-logic');
  });

  it('falls back locally when AI is disabled or fails', async () => {
    config.worktreeSlugAI.enabled = false;
    globalThis.fetch = vi.fn() as any;
    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree');
    expect(globalThis.fetch).not.toHaveBeenCalled();

    config.worktreeSlugAI.enabled = true;
    globalThis.fetch = vi.fn(async () => new Response('bad gateway', { status: 502 })) as any;
    await expect(worktreeSlugFromContextAI('看下新开 worktree 的时候，命名逻辑是啥？')).resolves.toBe('worktree');
  });

  it('falls back locally when the deployed config has no worktree slug AI section', async () => {
    Reflect.deleteProperty(config, 'worktreeSlugAI');
    globalThis.fetch = vi.fn();

    await expect(worktreeSlugFromContextAI('repo test')).resolves.toBe('repo-test');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

/**
 * A LOCAL slug model must not have its API key handed to an HTTP proxy.
 *
 * `baseUrl` is user-configured and may point at a local model, while the request
 * carries `Authorization: Bearer <apiKey>`. Under Bun the global `fetch` routes
 * 127.0.0.1 through `$http_proxy` unless `no_proxy` names that literal address —
 * CIDR does not count. Reproduced with a canary token:
 *
 *   PRE  → PROXY … auth=Bearer SLUG_SECRET_CANARY   (then a silent local fallback)
 *   POST → LOCAL /v1/chat/completions                (the model's answer is used)
 *
 * The silent fallback is what made this invisible: the caller just gets a slightly
 * worse slug and never learns the key went to the proxy.
 *
 * Must run in a REAL Bun process — Bun snapshots proxy config at startup, and
 * vitest's worker is Node, whose fetch ignores proxy env entirely.
 */
describe('worktreeSlugFromContextAI — a local model bypasses the proxy', () => {
  function resolveBun(): string | undefined {
    if (process.env.BUN_PATH && existsSync(process.env.BUN_PATH)) return process.env.BUN_PATH;
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir) continue;
      const candidate = join(dir, 'bun');
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  it('does not send the Bearer token to $http_proxy', async () => {
    const bun = resolveBun();
    if (!bun) {
      if (process.env.CI) throw new Error('bun not found on PATH; this test must not be skipped in CI');
      return;
    }

    const { createServer } = await import('node:http');
    const servers: import('node:http').Server[] = [];
    const listen = async (h: import('node:http').RequestListener) => {
      const s = createServer(h); servers.push(s);
      await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
      return (s.address() as { port: number }).port;
    };
    try {
      let proxyHits = 0;
      let leakedAuth = '';
      let localHits = 0;
      const proxyPort = await listen((req, res) => {
        proxyHits++;
        leakedAuth = String(req.headers.authorization ?? '');
        res.writeHead(403); res.end('PROXY');
      });
      const modelPort = await listen((_req, res) => {
        localHits++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'my-slug' } }] }));
      });

      // Note the `.js` specifier for config: the module under test imports it that
      // way, and a `.ts` import would be a DIFFERENT instance whose mutation the
      // module never sees (measured — the probe silently exercised nothing).
      const snippet = `
        const m = await import(${JSON.stringify(join(__dirname, '..', 'src', 'services', 'worktree-slug-ai.ts'))});
        const { config } = await import(${JSON.stringify(join(__dirname, '..', 'src', 'config.js'))});
        config.worktreeSlugAI = {
          enabled: true, baseUrl: 'http://127.0.0.1:${modelPort}/v1', model: 'm',
          apiKey: 'SLUG_SECRET_CANARY', timeoutMs: 5000, extraHeaders: {}, extraBody: {},
        };
        const slug = await m.worktreeSlugFromContextAI('Some Feature Title', 'do the thing');
        process.stdout.write(JSON.stringify({ runtime: typeof Bun !== 'undefined' ? 'bun' : 'node', slug }));
      `;
      const { spawn } = await import('node:child_process');
      const proxyUrl = `http://127.0.0.1:${proxyPort}`;
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(bun, ['-e', snippet], {
          env: {
            ...process.env,
            http_proxy: proxyUrl, HTTP_PROXY: proxyUrl,
            https_proxy: proxyUrl, HTTPS_PROXY: proxyUrl,
            no_proxy: '127.0.0.0/8', NO_PROXY: '127.0.0.0/8',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '', err = '';
        child.stdout.on('data', d => { out += String(d); });
        child.stderr.on('data', d => { err += String(d); });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('bun child timed out')); }, 25_000);
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`bun child exited ${code}: ${err.slice(0, 400)}`));
          else resolve(out);
        });
      });

      const parsed = JSON.parse(stdout || '{}');
      expect(parsed.runtime).toBe('bun');
      expect(leakedAuth).toBe('');
      expect(proxyHits).toBe(0);
      expect(localHits).toBe(1);
      // The model's answer, not the local fallback ('some-feature-title').
      expect(parsed.slug).toBe('my-slug');
    } finally {
      await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
    }
  }, 40_000);
});
