import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serveMissingDashboardChunk } from '../src/dashboard/stale-chunk-http.js';

describe('dashboard missing chunk HTTP response', () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (serveMissingDashboardChunk(req, res, pathname)) return;
      res.writeHead(418);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  it('rejects missing chunk imports with an uncacheable 404 for GET and HEAD', async () => {
    const get = await fetch(`${origin}/chunks/chunk-KXPFRRWM.js`);
    const body = await get.text();
    expect(get.status).toBe(404);
    expect(get.headers.get('cache-control')).toBe('no-store');
    expect(get.headers.get('content-type')).toMatch(/^text\/plain\b/);
    expect(body.length).toBeGreaterThan(0);

    const head = await fetch(`${origin}/chunks/chunk-KXPFRRWM.js`, { method: 'HEAD' });
    expect(head.status).toBe(404);
    expect(head.headers.get('cache-control')).toBe('no-store');
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(await head.text()).toBe('');
  });

  it.each([
    '/app.js',
    '/chunks/page.css',
    '/chunks/nested/page.js',
    '/chunks/../app.js',
  ])('leaves non-chunk path %s to the next handler', async (pathname) => {
    const response = await fetch(`${origin}${pathname}`);
    expect(response.status).toBe(418);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
