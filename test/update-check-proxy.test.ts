import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { fetchConfiguredPackageArtifact, fetchLatestVersion } from '../src/core/update-check.js';
import { getReleaseStream, proxyForUrl, stripHostBrackets } from '../src/core/release-download.js';

vi.mock('../src/global-config.js', () => ({ readGlobalConfig: () => ({}) }));
const servers: Array<Server | HttpsServer> = [];
const sockets = new Set<Socket>();
// 宿主机端口扫描器可能向假服务器发 GET / 之类的请求。非目标路径一律回 404，
// 不进入断言用的请求记录，也不在 listener 里同步抛错（会变成未捕获异常）；
// 非目标的 POST（被测代码从不 POST）记入 strayRequests，afterEach 清理完后断言为空。
const strayRequests: string[] = [];
function rejectStray(req: IncomingMessage, res: ServerResponse, isTarget: (url: string) => boolean): boolean {
  if (isTarget(req.url ?? '')) return false;
  if (req.method === 'POST') strayRequests.push(`${req.method} ${req.url}`);
  res.writeHead(404); res.end();
  return true;
}
const isAbsoluteHttpUrl = (url: string) => url.startsWith('http://');
beforeEach(() => {
  strayRequests.length = 0;
  for (const key of Object.keys(process.env)) {
    if (/proxy$/i.test(key)) vi.stubEnv(key, '');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  expect(strayRequests).toEqual([]);
});
async function listen(server: Server | HttpsServer): Promise<string> {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function tryListenIpv6(server: Server | HttpsServer): Promise<string | null> {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return await new Promise<string | null>(resolve => {
    server.once('error', () => resolve(null));
    server.listen(0, '::1', () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? `http://[::1]:${addr.port}` : null);
    });
  });
}

const canBindIpv6 = await (async () => {
  const probe = createServer();
  const ok = await new Promise<boolean>(resolve => {
    probe.once('error', () => resolve(false));
    probe.listen(0, '::1', () => probe.close(() => resolve(true)));
  });
  return ok;
})();

const ipCertPath = join(process.cwd(), 'test/fixtures/release-download-ip-cert.pem');
const ipKeyPath = join(process.cwd(), 'test/fixtures/release-download-ip-key.pem');

async function listenLoopback(server: Server | HttpsServer, host: '127.0.0.1' | '::1'): Promise<string> {
  if (host === '127.0.0.1') return listen(server);
  const url = await tryListenIpv6(server);
  if (!url) throw new Error('failed to bind IPv6 loopback test server');
  return url;
}

async function expectSuccessfulIpTunnel(host: '127.0.0.1' | '::1'): Promise<void> {
  const targetRequests: Array<{ url?: string; host?: string }> = [];
  const target = createHttpsServer({
    key: readFileSync(ipKeyPath),
    cert: readFileSync(ipCertPath),
  }, (req, res) => {
    if (rejectStray(req, res, url => url === '/ip-target')) return;
    targetRequests.push({ url: req.url, host: req.headers.host });
    res.end('ip-target-ok');
  });
  const targetBase = await listenLoopback(target, host);
  const targetUrl = new URL(targetBase.replace(/^http:/, 'https:'));
  targetUrl.pathname = '/ip-target';

  const connects: Array<{ url?: string; host?: string }> = [];
  const proxy = createServer();
  proxy.on('connect', (req, client) => {
    connects.push({ url: req.url, host: req.headers.host });
    const authority = new URL(`http://${req.url}`);
    const upstream = netConnect({
      host: stripHostBrackets(authority.hostname),
      port: Number(authority.port),
    }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    upstream.on('error', error => client.destroy(error));
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  const proxyUrl = await listenLoopback(proxy, host);

  const env: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: ipCertPath };
  for (const key of Object.keys(env)) {
    if (/proxy$/i.test(key)) delete env[key];
  }
  const child = spawnTsEvalWithRepoImports(`
    import { getReleaseStream } from './src/core/release-download.js';
    const response = await getReleaseStream(${JSON.stringify(targetUrl.toString())}, ${JSON.stringify(proxyUrl)}, 'botmux', 0, {
      signal: AbortSignal.timeout(5000),
    });
    let body = '';
    for await (const chunk of response) body += chunk;
    console.log(JSON.stringify({
      body,
      authorized: response.socket.authorized,
      authorizationError: response.socket.authorizationError ?? null,
    }));
    response.destroy();
  `, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout!.on('data', data => { stdout += data; });
  child.stderr!.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(stdout)).toEqual({ body: 'ip-target-ok', authorized: true, authorizationError: null });
  expect(connects).toEqual([{ url: targetUrl.host, host: targetUrl.host }]);
  expect(targetRequests).toEqual([{ url: '/ip-target', host: targetUrl.host }]);
}

describe('registry metadata proxy transport', () => {
  it.each(['NO_PROXY', 'no_proxy', 'config', 'env'])('routes metadata and tarball correctly with %s proxy settings', async (mode) => {
    const requests: string[] = [];
    const proxyRequests: string[] = [];
    const archive = Buffer.from('test platform archive');
    const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
    const registry = await listen(createServer((req, res) => {
      if (rejectStray(req, res, url => url === '/pkg.tgz' || url.endsWith('/latest') || url.startsWith('/botmux-darwin-arm64/'))) return;
      requests.push(req.url!);
      if (req.url === '/pkg.tgz') { res.end(archive); return; }
      res.end(JSON.stringify(req.url!.endsWith('/latest') ? { version: '3.48.0' } : {
        name: 'botmux-darwin-arm64', version: '3.48.0',
        dist: { tarball: `${registry}/pkg.tgz`, integrity },
      }));
    }));
    const proxy = await listen(createServer((req, res) => {
      if (rejectStray(req, res, isAbsoluteHttpUrl)) return;
      proxyRequests.push(req.url!);
      if (mode === 'env') {
        const forwarded = httpRequest(req.url!, reply => {
          res.writeHead(reply.statusCode ?? 500, reply.headers);
          reply.pipe(res);
        });
        forwarded.on('error', () => { res.writeHead(502); res.end(); });
        forwarded.end();
        return;
      }
      res.writeHead(403); res.end('internal hosts are forbidden');
    }));
    const dir = mkdtempSync(join(tmpdir(), 'botmux-no-proxy-'));
    const configPath = join(dir, 'global.json');
    writeFileSync(configPath, JSON.stringify(mode === 'config' ? { httpProxy: proxy } : {}));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, BOTMUX_GLOBAL_CONFIG_FILE: configPath };
      for (const key of Object.keys(env)) {
        if (/proxy$/i.test(key)) delete env[key];
      }
      if (mode !== 'config') Object.assign(env, {
        HTTPS_PROXY: proxy, HTTP_PROXY: proxy,
        NO_PROXY: mode === 'env' ? '' : mode === 'no_proxy' ? 'unmatched.invalid' : '127.0.0.1',
        no_proxy: mode === 'no_proxy' ? '127.0.0.1' : '',
      });
      const child = spawnTsEvalWithRepoImports(`
        import { fetchLatestVersion, fetchConfiguredPackageArtifact } from './src/core/update-check.js';
        import { replaceStandaloneBinary } from './src/core/binary-self-update.js';
        import { getReleaseStream, resolveHttpProxy } from './src/core/release-download.js';
        import { join } from 'node:path';
        import { writeFileSync, readFileSync } from 'node:fs';
        const opts = { registry: ${JSON.stringify(registry)}, timeoutMs: 2000 };
        const version = await fetchLatestVersion(opts);
        const artifact = await fetchConfiguredPackageArtifact('botmux-darwin-arm64', '3.48.0', opts);
        const target = ${JSON.stringify(join(dir, 'botmux'))};
        const update = await replaceStandaloneBinary('3.48.0', target, {
          resolveRegistryArtifact: async () => artifact,
          fetchStream: async () => { throw new Error('unexpected GitHub fallback'); },
          extractRegistryBinary: (_archive, dest) => {
            const candidate = join(dest, 'botmux');
            writeFileSync(candidate, Buffer.alloc(1_100_000, 65));
            return candidate;
          },
          probeBinary: () => ({ status: 0, stdout: '3.48.0', stderr: '' }),
        });
        let githubError = '';
        if (${mode === 'config'}) {
          try {
            await getReleaseStream('http://github.invalid/release', resolveHttpProxy(), 'botmux', 5, {
              signal: AbortSignal.timeout(2000),
            });
          } catch (error) { githubError = error.message; }
        }
        console.log(JSON.stringify({ version, artifact, source: update.source, bytes: readFileSync(target).length, githubError }));
      `, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout!.on('data', data => { stdout += data; });
      child.stderr!.on('data', data => { stderr += data; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject); child.on('close', resolve);
      });
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(JSON.parse(stdout)).toMatchObject({ version: '3.48.0', artifact: { version: '3.48.0', integrity },
        source: 'registry-package', bytes: 1_100_000 });
      expect(JSON.parse(stdout).githubError).toBe(mode === 'config' ? 'HTTP 403' : '');
      expect(proxyRequests).toEqual(mode === 'config' ? ['http://github.invalid/release'] : mode === 'env'
        ? [`${registry}/botmux/latest`, `${registry}/botmux-darwin-arm64/3.48.0`, `${registry}/pkg.tgz`] : []);
      expect(requests).toEqual(['/botmux/latest', '/botmux-darwin-arm64/3.48.0', '/pkg.tgz']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('re-evaluates NO_PROXY across external-to-internal and internal-to-external redirects', async () => {
    const proxyRequests: string[] = [];
    const directRequests: string[] = [];
    const registry = await listen(createServer((req, res) => {
      if (rejectStray(req, res, url => url === '/mirror')) return;
      directRequests.push(req.url!);
      res.writeHead(302, { location: 'http://registry.invalid/final' }); res.end();
    }));
    const proxy = await listen(createServer((req, res) => {
      if (rejectStray(req, res, isAbsoluteHttpUrl)) return;
      proxyRequests.push(req.url!);
      if (req.url === 'http://registry.invalid/botmux/latest') {
        res.writeHead(302, { location: `${registry}/mirror` }); res.end();
      } else if (req.url === 'http://registry.invalid/final') {
        res.end(JSON.stringify({ version: '3.48.0' }));
      } else { res.writeHead(403); res.end(); }
    }));
    vi.stubEnv('HTTPS_PROXY', proxy);
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    await expect(fetchLatestVersion({ registry: 'http://registry.invalid/', timeoutMs: 2000 })).resolves.toBe('3.48.0');
    expect(directRequests).toEqual(['/mirror']);
    expect(proxyRequests).toEqual(['http://registry.invalid/botmux/latest', 'http://registry.invalid/final']);
  });

  it('queries version and exact package metadata through the configured proxy', async () => {
    const seen: string[] = [];
    const integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
    const proxy = await listen(createServer((req, res) => {
      if (rejectStray(req, res, isAbsoluteHttpUrl)) return;
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
      if (rejectStray(req, res, isAbsoluteHttpUrl)) return;
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

  it('strips WHATWG brackets from IPv6 proxy hostnames before dialing', () => {
    expect(stripHostBrackets(new URL('http://[::1]:3128').hostname)).toBe('::1');
    expect(stripHostBrackets(new URL('http://[2001:db8::1]:3128').hostname)).toBe('2001:db8::1');
    expect(stripHostBrackets(new URL('http://proxy.invalid:3128').hostname)).toBe('proxy.invalid');
    expect(stripHostBrackets(new URL('http://127.0.0.1:3128').hostname)).toBe('127.0.0.1');
  });

  it.skipIf(!canBindIpv6)('routes HTTP requests through a bracketed IPv6 proxy (with credentials)', async () => {
    const seen: Array<{ url: string; auth?: string }> = [];
    const proxy = await tryListenIpv6(createServer((req, res) => {
      if (rejectStray(req, res, isAbsoluteHttpUrl)) return;
      seen.push({ url: req.url!, auth: req.headers['proxy-authorization'] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version: '3.59.32' }));
    }));
    expect(proxy).not.toBeNull();
    const proxyWithAuth = proxy!.replace('http://', 'http://alice:s%40cret@');
    vi.stubEnv('HTTPS_PROXY', proxyWithAuth);
    await expect(fetchLatestVersion({ registry: 'http://registry.invalid/', timeoutMs: 2_000 }))
      .resolves.toBe('3.59.32');
    expect(seen).toEqual([{
      url: 'http://registry.invalid/botmux/latest',
      auth: `Basic ${Buffer.from('alice:s@cret').toString('base64')}`,
    }]);
  });

  it.skipIf(!canBindIpv6)('opens HTTPS CONNECT tunnels through a bracketed IPv6 proxy', async () => {
    const server = createServer();
    const proxy = await tryListenIpv6(server);
    expect(proxy).not.toBeNull();
    const connects: Array<{ url?: string; host?: string; auth?: string }> = [];
    server.on('connect', (req, socket) => {
      connects.push({
        url: req.url,
        host: req.headers.host,
        auth: req.headers['proxy-authorization'],
      });
      // Reject with 407/403 after proving the TCP dial and CONNECT request reached the IPv6 proxy.
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    const proxyWithAuth = proxy!.replace('http://', 'http://bob:p%40ss@');
    await expect(getReleaseStream('https://registry.invalid/botmux/latest', proxyWithAuth, 'botmux', 5, {
      signal: AbortSignal.timeout(2_000),
    })).rejects.toThrow('代理 CONNECT 失败: HTTP 403');
    expect(connects).toEqual([{
      url: 'registry.invalid:443',
      host: 'registry.invalid:443',
      auth: `Basic ${Buffer.from('bob:p@ss').toString('base64')}`,
    }]);
  });

  // The fixture deliberately has IP-only SANs: DNS:localhost would mask Node's
  // fallback certificate identity when tls.connect receives neither host nor SNI.
  it('validates an IPv4 target certificate after CONNECT', async () => {
    await expectSuccessfulIpTunnel('127.0.0.1');
  });

  it.skipIf(!canBindIpv6)('validates an IPv6 target certificate after CONNECT', async () => {
    await expectSuccessfulIpTunnel('::1');
  });
});

describe('per-URL proxy exclusions', () => {
  it.each([
    ['mirror.corp.internal', 'http://mirror.corp.internal/pkg', true],
    ['mirror.corp.internal', 'http://other.corp.internal/pkg', false],
    ['.corp.internal', 'https://mirror.corp.internal/pkg', true],
    ['.corp.internal', 'https://corp.internal/pkg', false],
    ['*.corp.internal', 'https://mirror.corp.internal/pkg', true],
    ['.corp.internal', 'https://corp.internal.attacker.invalid/pkg', false],
    ['*', 'https://registry.invalid/pkg', true],
    ['mirror.corp.internal:443', 'https://mirror.corp.internal/pkg', true],
    ['mirror.corp.internal:443', 'http://mirror.corp.internal/pkg', false],
    ['mirror.corp.internal:8080', 'http://mirror.corp.internal:8080/pkg', true],
    ['[::1]:8080', 'http://[::1]:8080/pkg', true],
    ['[::1]:8080', 'http://[::1]:9090/pkg', false],
    ['LOCALHOST, .CORP.INTERNAL', 'https://mirror.corp.internal/pkg', true],
    ['', 'https://mirror.corp.internal/pkg', false],
  ])('NO_PROXY=%s for %s bypasses=%s', (noProxy, url, bypass) => {
    vi.stubEnv('NO_PROXY', noProxy);
    expect(proxyForUrl(url, 'http://proxy.invalid')).toBe(bypass ? undefined : 'http://proxy.invalid');
  });
});
