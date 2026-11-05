/** Real Linux namespace coverage for the protected provider bridge.
 *
 * Run after build:
 *   BOTMUX_PROTECTED_LOOPBACK_INTEGRATION=1 bun run test test/protected-provider-loopback-linux.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
} from '../src/core/protected-http-egress-loopback.js';
import { verifyProtectedLoopbackProxyAttestation } from '../src/core/protected-loopback-attestation.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import type { SandboxNetworkPolicy } from '../src/core/sandbox-network-policy.js';
import { protectedHttpEgressAuthTokenPath } from '../src/core/protected-http-egress-host.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { spawnNodeTsScript } from './helpers/ts-runner.js';

const enabled = process.platform === 'linux'
  && process.env.BOTMUX_PROTECTED_LOOPBACK_INTEGRATION === '1'
  && existsSync(new URL('../dist/sandbox-network-runner.js', import.meta.url));

describe.skipIf(!enabled)('protected provider loopback in a real network namespace', () => {
  let root: string;
  let socketPath: string;
  let guard: ReturnType<typeof createServer>;
  const observed: Array<{ method?: string; url?: string; auth?: string; policy?: string; target?: string; service?: string; session?: string }> = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-provider-loopback-linux-'));
    chmodSync(root, 0o700);
    socketPath = join(root, 'e.sock');
    const tokenPath = protectedHttpEgressAuthTokenPath(socketPath);
    mkdirSync(dirname(tokenPath), { mode: 0o700 });
    writeFileSync(tokenPath, 'namespace-auth-fixture\n', { mode: 0o600 });
    guard = createServer((request, response) => {
      const service = request.headers['x-botmux-loopback-service'] as string | undefined;
      const session = request.headers['x-botmux-lark-session'] as string | undefined;
      observed.push({
        method: request.method,
        url: request.url,
        auth: request.headers['x-botmux-egress-auth'] as string | undefined,
        policy: request.headers['x-botmux-egress-policy'] as string | undefined,
        target: request.headers['x-botmux-egress-target'] as string | undefined,
        ...(service ? { service } : {}),
        ...(session ? { session } : {}),
      });
      request.resume();
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: namespace-first\n\n');
      setTimeout(() => response.end('data: namespace-second\n\n'), 20);
    });
    await new Promise<void>((resolve, reject) => {
      guard.once('error', reject);
      guard.listen(socketPath, resolve);
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => guard.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it('materializes the dynamic origin and reaches the Unix guard with trusted routing', async () => {
    observed.length = 0;
    const script = join(root, 'probe.mjs');
    writeFileSync(script, [
      'const baseUrl = process.argv[3].slice("model_providers.fixture.base_url=".length);',
      'const response = await fetch(baseUrl, { method: "POST", body: "{}" });',
      'const body = await response.text();',
      'console.log(JSON.stringify({ status: response.status, body }));',
    ].join('\n'));
    const policy: SandboxNetworkPolicy = {
      version: 1,
      public: { mode: 'allow' },
      private: { mode: 'allow' },
    };
    const { sandboxNetworkLaunch } = await import('../dist/core/sandbox-network-launch.js');
    const launch = sandboxNetworkLaunch(
      policy,
      process.execPath,
      [script, '-c', `model_providers.fixture.base_url=${PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN}/model/responses`],
      {
        socketPath,
        policyId: 'fixture.items.write.v1',
        targetIndex: 0,
        placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
      },
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.bin, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[sandbox-network]');
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: 200,
      body: 'data: namespace-first\n\ndata: namespace-second\n\n',
    });
    expect(observed).toEqual([{
      method: 'POST',
      url: '/model/responses',
      auth: 'namespace-auth-fixture',
      policy: 'fixture.items.write.v1',
      target: '0',
    }]);
  });

  it.each(['node', 'bun'] as const)('starts the production file-sandbox launch and routes the model through the protected bridge (%s)', async runtime => {
    observed.length = 0;
    const script = join(root, 'sandbox-provider-probe.mjs');
    const prompt = 'Do not rewrite http://127.0.0.1:0 in this prompt';
    writeFileSync(script, [
      'import { existsSync } from "node:fs";',
      'const baseUrl = JSON.parse(process.argv[3].slice("model_providers.fixture.base_url=".length));',
      'const response = await fetch(baseUrl, { method: "POST", body: "{}", signal: AbortSignal.timeout(5000) });',
      'const body = await response.text();',
      `const authPaths = ${JSON.stringify([protectedHttpEgressAuthTokenPath(socketPath), protectedHttpEgressAuthTokenPath('/run/botmux-mcp/e.sock')])};`,
      'console.log(JSON.stringify({ status: response.status, body, prompt: process.argv[4], authReadable: authPaths.map(existsSync) }));',
    ].join('\n'));
    const gateway = createServer((_request, response) => response.end('fixture'));
    const gatewayPath = join(root, 'g.sock');
    const { prepareDirectSandbox } = await import('../dist/adapters/backend/sandbox.js');
    const paths = ['/usr', '/etc', dirname(realpathSync(process.execPath)),
      ...(process.env.LD_LIBRARY_PATH ?? '').split(':').filter(path => path.startsWith('/')), root];
    let sandbox: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(gatewayPath, resolve); });
      sandbox = prepareDirectSandbox({
        sessionId: 'production-provider-argv', dataDir: root,
        policy: { net: true, writeRegexes: [], rules: [...new Set(paths)].map(path => ({
          path, access: path === root ? 'readWrite' : 'readOnly', source: 'baseline',
        })) },
        networkPolicy: { version: 1, public: { mode: 'allow' }, private: { mode: 'allow' } },
        chdir: root, home: root, cliBin: process.execPath,
        cliArgs: [script, '-c', 'model_providers.fixture.base_url="http://127.0.0.1:0/model/responses"', prompt],
        mcpGatewaySocketPath: gatewayPath, protectedEgressSocketPath: socketPath,
        protectedHttpBridge: {
          socketPath, policyId: 'fixture.items.write.v1', targetIndex: 0,
          placeholderOrigin: PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
        },
      });
      expect(sandbox).not.toBeNull();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = runtime === 'bun'
          ? spawn(spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim(), sandbox!.args, {
            env: { ...process.env, ...sandbox!.env }, stdio: ['ignore', 'pipe', 'pipe'],
          })
          : spawnNodeTsScript(sandbox!.args[0]!, sandbox!.args.slice(1), {
            env: { ...process.env, ...sandbox!.env }, stdio: ['ignore', 'pipe', 'pipe'],
          });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('sandbox provider probe timed out')); }, 15000);
        child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.on('data', chunk => stderr += chunk);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        status: 200, body: 'data: namespace-first\n\ndata: namespace-second\n\n', prompt,
        authReadable: [false, false],
      });
      expect(observed).toEqual([{
        method: 'POST', url: '/model/responses', auth: 'namespace-auth-fixture',
        policy: 'fixture.items.write.v1', target: '0',
      }]);
    } finally {
      sandbox?.cleanup();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      rmSandboxScratch(join(root, 'sandboxes'));
    }
  });

  it('re-exposes only the declared daemon route on private loopback', async () => {
    observed.length = 0;
    const script = join(root, 'local-service-probe.mjs');
    writeFileSync(script, [
      'import { request } from "node:http";',
      'const target = new URL(process.argv[2]);',
      'const payload = JSON.stringify({ mode: "bot" });',
      'const result = await new Promise((resolve, reject) => {',
      '  const req = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",',
      '    headers: { "content-type": "application/json", "x-botmux-lark-session": "session-access-key", "content-length": String(Buffer.byteLength(payload)) } }, response => {',
      '    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);',
      '    response.once("end", () => resolve({ status: response.statusCode, body }));',
      '  });',
      '  req.once("error", reject); req.end(payload);',
      '});',
      'console.log(JSON.stringify(result));',
    ].join('\n'));
    const policy: SandboxNetworkPolicy = {
      version: 1,
      public: { mode: 'allow' },
      private: { mode: 'allow' },
    };
    const { sandboxNetworkLaunch } = await import('../dist/core/sandbox-network-launch.js');
    const path = '/api/sessions/session-a/lark-tool-identity';
    const launch = sandboxNetworkLaunch(
      policy,
      process.execPath,
      [script, `http://127.0.0.1:17950${path}`],
      undefined,
      [{
        socketPath,
        serviceId: 'lark-tool-identity',
        listenPort: 17950,
        method: 'POST',
        path,
        forwardHeaders: ['content-type', 'x-botmux-lark-session'],
        attestProcessPeer: true,
      }],
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.bin, launch.args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[sandbox-network]');
    expect(JSON.parse(result.stdout.trim())).toEqual({
      status: 200,
      body: 'data: namespace-first\n\ndata: namespace-second\n\n',
    });
    expect(observed).toEqual([{
      method: 'POST',
      url: path,
      auth: 'namespace-auth-fixture',
      policy: undefined,
      target: undefined,
      service: 'lark-tool-identity',
      session: 'session-access-key',
    }]);
  });

  it('forwards the isolated lark identity route when Bun owns the network runner and bwrap nests the task PID namespace', async () => {
    const path = '/api/sessions/session-a/lark-tool-identity';
    const secret = 'cd'.repeat(32);
    const daemonRequests: Array<{
      method?: string;
      url?: string;
      session?: string;
      attestation?: string;
      body: string;
      hostPeerVerified: boolean;
    }> = [];
    const daemon = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.once('end', () => {
        const body = Buffer.concat(chunks);
        const attestation = request.headers['x-botmux-loopback-attestation'] as string | undefined;
        const peer = attestation ? verifyProtectedLoopbackProxyAttestation(secret, attestation, {
          sessionId: 'session-a', serviceId: 'lark-tool-identity', workerGeneration: 7,
          turnId: 'turn-fixture', method: 'POST', path,
          headers: {
            'content-type': 'application/json',
            'x-botmux-lark-session': 'session-access-key',
          },
          body,
        }) : null;
        daemonRequests.push({
          method: request.method,
          url: request.url,
          session: request.headers['x-botmux-lark-session'] as string | undefined,
          attestation,
          body: body.toString('utf8'),
          hostPeerVerified: !!peer && readProcessStartIdentity(peer.pid) === peer.procStart,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"ok":true,"credential":"fixture"}');
      });
    });
    await new Promise<void>((resolve, reject) => {
      daemon.once('error', reject);
      daemon.listen(0, '127.0.0.1', resolve);
    });
    const daemonAddress = daemon.address();
    if (!daemonAddress || typeof daemonAddress === 'string') throw new Error('fixture daemon did not bind TCP');
    const socketDir = join(root, 'full-chain');
    mkdirSync(socketDir, { mode: 0o700 });
    const { normalizeProtectedHttpEgressPolicy, protectedHttpEgressPolicyDigest } = await import('../dist/core/protected-http-egress.js');
    const { startSessionProtectedHttpEgressHost } = await import('../dist/core/protected-http-egress-host.js');
    const fixturePolicy = normalizeProtectedHttpEgressPolicy({
      id: 'fixture.items.write.v1',
      targets: [{
        scheme: 'https',
        host: 'fixture.internal.example',
        port: 443,
        denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
      }],
    })!;
    const host = await startSessionProtectedHttpEgressHost({
      socketDir,
      policy: fixturePolicy,
      policyDigest: protectedHttpEgressPolicyDigest(fixturePolicy),
      forward: async () => ({ status: 502, headers: {}, body: Buffer.alloc(0) }),
      loopbackServices: [{
        id: 'lark-tool-identity',
        listenPort: daemonAddress.port,
        upstreamPort: daemonAddress.port,
        method: 'POST',
        path,
        forwardHeaders: ['content-type', 'x-botmux-lark-session'],
        attestProcessPeer: true,
      }],
      loopbackProxyAttestation: {
        secret,
        workerGeneration: 7,
        sessionId: 'session-a',
        currentTurn: () => ({ turnId: 'turn-fixture' }),
      },
    });
    try {
      const script = join(root, 'full-chain-probe.mjs');
      writeFileSync(script, [
        'import { request } from "node:http";',
        'const target = new URL(process.argv[2]);',
        'const payload = JSON.stringify({ mode: "bot" });',
        'const result = await new Promise((resolve, reject) => {',
        '  const req = request({ hostname: target.hostname, port: target.port, path: target.pathname, method: "POST",',
        '    headers: { "content-type": "application/json", "x-botmux-lark-session": "session-access-key", "content-length": String(Buffer.byteLength(payload)) } }, response => {',
        '    let body = ""; response.setEncoding("utf8"); response.on("data", chunk => body += chunk);',
        '    response.once("end", () => resolve({ status: response.statusCode, body }));',
        '  });',
        '  req.once("error", reject); req.end(payload);',
        '});',
        'console.log(JSON.stringify(result));',
      ].join('\n'));
      const { sandboxNetworkLaunch } = await import('../dist/core/sandbox-network-launch.js');
      const bwrap = spawnSync('/bin/sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).stdout.trim();
      const launch = sandboxNetworkLaunch(
        { version: 1, public: { mode: 'allow' }, private: { mode: 'allow' } },
        bwrap,
        [
          '--ro-bind', '/', '/', '--proc', '/proc', '--unshare-user', '--unshare-pid', '--die-with-parent',
          '/bin/sh', '-c',
          'if test -e /proc/self/fd/7 || test -e /proc/self/fd/8; then exit 91; fi; exec "$@"',
          'botmux-broker-fd-probe',
          process.execPath,
          script,
          `http://127.0.0.1:${daemonAddress.port}${path}`,
        ],
        undefined,
        host.loopbackServices.map(service => ({
          socketPath: host.socketPath,
          serviceId: service.id,
          listenPort: service.listenPort,
          method: service.method,
          path: service.path,
          forwardHeaders: [...service.forwardHeaders],
          ...(service.attestProcessPeer ? { attestProcessPeer: true } : {}),
        })),
      );
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const bun = spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
        const networkRunner = fileURLToPath(new URL('../dist/sandbox-network-runner.js', import.meta.url));
        const child = spawn(bun, [networkRunner, launch.args.at(-1)!], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', code => resolve({ code, stdout, stderr }));
      });
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('[sandbox-network]');
      expect(JSON.parse(result.stdout.trim())).toEqual({
        status: 200,
        body: '{"ok":true,"credential":"fixture"}',
      });
      expect(daemonRequests).toEqual([{
        method: 'POST',
        url: path,
        session: 'session-access-key',
        attestation: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
        body: '{"mode":"bot"}',
        hostPeerVerified: true,
      }]);
    } finally {
      await host.close();
      await new Promise<void>(resolve => daemon.close(() => resolve()));
    }
  });
});
