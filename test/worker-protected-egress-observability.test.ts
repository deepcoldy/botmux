import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { buildSessionChildEnv } from '../src/core/env-policy.js';
import { protectedHttpEgressPolicyDigest } from '../src/core/protected-http-egress.js';
import { protectedHttpEgressAuthTokenPath, startSessionProtectedHttpEgressHost,
  type SessionProtectedHttpEgressHost } from '../src/core/protected-http-egress-host.js';

describe('worker protected egress observability', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

  it('clears ambient egress protocols including the retired required flag before sandbox injection', () => {
    // Execute the actual CLI env construction without starting a live session.
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const start = source.indexOf('  const childEnv = buildSessionChildEnv(process.env');
    const end = source.indexOf("  if (cfg.promptInjection === 'none')", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const env = runInNewContext(`${source.slice(start, end)}; childEnv`, {
      process: { env: { BOTMUX_PROTECTED_EGRESS_SOCKET: '/stale/e.sock',
        BOTMUX_PROTECTED_EGRESS_PROTOCOL: 'stale-protocol', BOTMUX_PROTECTED_EGRESS_REQUIRED: '1', MIX_AUTH_TOKEN: 'local-business-fixture' } },
      cfg: {}, buildSessionChildEnv, PROTECTED_HTTP_EGRESS_SOCKET_ENV: 'BOTMUX_PROTECTED_EGRESS_SOCKET',
      PROTECTED_HTTP_EGRESS_PROTOCOL_ENV: 'BOTMUX_PROTECTED_EGRESS_PROTOCOL',
    });
    expect(env.MIX_AUTH_TOKEN).toBe('local-business-fixture');
    for (const key of ['BOTMUX_PROTECTED_EGRESS_SOCKET', 'BOTMUX_PROTECTED_EGRESS_PROTOCOL', 'BOTMUX_PROTECTED_EGRESS_REQUIRED']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('reports unregistered POST and request decisions without credentials or query contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-egress-log-'));
    let host: SessionProtectedHttpEgressHost | undefined;
    cleanups.push(async () => {
      await host?.close();
      rmSync(root, { recursive: true, force: true });
    });
    const policy = { id: 'fixture.write.v1', targets: [{ scheme: 'https' as const,
      host: 'fixture.example', port: 443, denyRoutes: [{ methods: ['POST'], path: '/write' }] }] };
    const lines: string[] = [];
    const run = loadWorkerFunction<(cfg: unknown, adapter: unknown) => Promise<unknown>>(
      'prepareCliPluginGenerationAndGateway', {
        config: { session: { dataDir: root } }, process: { env: {} },
        refreshCliPluginGeneration: () => {}, readSessionMcpRuntimeManifest: () => null,
        stopSessionMcpGatewayHost: () => {}, parseDaemonIpcPort: () => undefined,
        clearMcpGatewayLaunchRecord: () => {}, log: (line: string) => lines.push(line),
        startSessionProtectedHttpEgressHost: async (options: Parameters<typeof startSessionProtectedHttpEgressHost>[0]) => {
          host = await startSessionProtectedHttpEgressHost({ ...options, socketDir: root,
            forward: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }) });
          return host;
        },
      },
    );
    await run({ sessionId: 'fixture', protectedHttpEgressPolicy: {
      pluginId: 'fixture', policy, policyDigest: protectedHttpEgressPolicyDigest(policy),
      frozenAddresses: [['10.20.30.40']],
    } }, {});
    const auth = readFileSync(protectedHttpEgressAuthTokenPath(host!.socketPath), 'utf8').trim();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: host!.socketPath, method: 'POST',
        path: '/query?token=query-sensitive-fixture', headers: {
          'x-botmux-egress-client': 'shared-read-v1', 'x-botmux-egress-policy': policy.id,
          'x-botmux-egress-target': '0', authorization: 'Bearer credential-sensitive-fixture',
        } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
      req.once('error', reject); req.end('body-sensitive-fixture');
    });
    expect(status).toBe(200);
    const entries = lines.filter(line => line.includes('{')).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    expect(entries).toContainEqual(expect.objectContaining({
      type: 'unregistered_mutating_candidate', method: 'POST', path: '/query', status: 200,
    }));
    expect(entries).toContainEqual(expect.objectContaining({ decision: 'allow', method: 'POST', path: '/query' }));
    for (const sensitive of [auth, 'query-sensitive-fixture', 'credential-sensitive-fixture', 'body-sensitive-fixture']) {
      expect(lines.join('\n')).not.toContain(sensitive);
    }
  });
});
