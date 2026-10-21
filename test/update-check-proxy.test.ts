import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { fetchConfiguredPackageArtifact, fetchLatestVersion } from '../src/core/update-check.js';
import { getReleaseStream } from '../src/core/release-download.js';

vi.mock('../src/global-config.js', () => ({ readGlobalConfig: () => ({}) }));
const servers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('registry metadata proxy transport', () => {
  it('queries version and exact package metadata through the configured proxy', async () => {
    const seen: string[] = [];
    const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
    const proxy = await listen(createServer((req, res) => {
      seen.push(req.url!);
      expect(req.headers.accept).toBe('application/json');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url!.endsWith('/latest') ? { version: '3.48.0' } : {
        name: 'botmux-darwin-arm64', version: '3.48.0',
        dist: { tarball: 'https://registry.invalid/pkg.tgz', integrity },
      }));
    }));
    vi.stubEnv('HTTPS_PROXY', proxy);
    const opts = { registry: 'http://registry.invalid/', timeoutMs: 2_000 };
    await expect(fetchLatestVersion(opts)).resolves.toBe('3.48.0');
    await expect(fetchConfiguredPackageArtifact('botmux-darwin-arm64', '3.48.0', opts))
      .resolves.toMatchObject({ version: '3.48.0', integrity });
    expect(seen).toEqual([
      'http://registry.invalid/botmux/latest',
      'http://registry.invalid/botmux-darwin-arm64/3.48.0',
    ]);
  });

  it('follows metadata redirects through the same proxy', async () => {
    const seen: string[] = [];
    const proxy = await listen(createServer((req, res) => {
      seen.push(req.url!);
      if (seen.length === 1) { res.writeHead(302, { location: '/redirected' }); res.end(); }
      else res.end(JSON.stringify({ version: '3.48.0' }));
    }));
    vi.stubEnv('HTTPS_PROXY', proxy);
    await expect(fetchLatestVersion({ registry: 'http://registry.invalid/' })).resolves.toBe('3.48.0');
    expect(seen).toEqual(['http://registry.invalid/botmux/latest', 'http://registry.invalid/redirected']);
  });

  it.each(['headers', 'body'])('times out a stalled metadata %s read', async (phase) => {
    const proxy = await listen(createServer((_req, res) => {
      if (phase === 'body') { res.writeHead(200); res.write('{'); }
    }));
    vi.stubEnv('HTTPS_PROXY', proxy);
    await expect(fetchLatestVersion({ registry: 'http://registry.invalid/', timeoutMs: 100 })).resolves.toBeNull();
  });

  it.each(['connect', 'tls'])('cancels a stalled HTTPS proxy %s handshake', async (phase) => {
    const server = createServer();
    const proxy = await listen(server);
    let connected = false;
    server.on('connect', (_req, socket) => {
      connected = true;
      if (phase === 'tls') socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    });
    await expect(getReleaseStream('https://registry.invalid/botmux/latest', proxy, 'botmux', 5, {
      signal: AbortSignal.timeout(200),
    })).rejects.toThrow();
    expect(connected).toBe(true);
  });
});
