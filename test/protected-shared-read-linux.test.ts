/** Cross-repository regression using MIX's compiled transport, the real guard,
 * and the production Linux file/network sandbox. Build both repositories first:
 * BOTMUX_PROTECTED_LOOPBACK_INTEGRATION=1 BOTMUX_MIX_CLI_INTEGRATION_ROOT=/path/to/packages/mix-cli
 * bun run test test/protected-shared-read-linux.test.ts
 * Only the business upstream is a fixture; no credentials or live writes. */
import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { normalizeProtectedHttpEgressPolicy, protectedHttpEgressPolicyDigest } from '../src/core/protected-http-egress.js';
import type { ProtectedHttpEgressForwardRequest } from '../src/core/protected-http-egress-host.js';
import { rmSandboxScratch } from './helpers/rm-sandbox-scratch.js';
import { nodeTsRunnerPrefix, spawnNodeTsScript } from './helpers/ts-runner.js';

const enabled = process.platform === 'linux'
  && process.env.BOTMUX_PROTECTED_LOOPBACK_INTEGRATION === '1'
  && process.env.BOTMUX_MIX_CLI_INTEGRATION_ROOT !== undefined;

describe.skipIf(!enabled)('MIX shared reads in the production Linux sandbox', () => {
  it.each(['node', 'bun'] as const)('keeps local business identity, hides tokens and blocks writes/internal services (%s)', async runtime => {
    const mixRoot = process.env.BOTMUX_MIX_CLI_INTEGRATION_ROOT!;
    expect(isAbsolute(mixRoot)).toBe(true);
    const modulePath = join(mixRoot, 'dist/src/utils/botmux-egress-request.js');
    expect(existsSync(modulePath), 'build MIX CLI before this integration test').toBe(true);
    const packageRequire = createRequire(join(mixRoot, 'package.json'));
    // pnpm's transitive packages may live outside the package's node_modules.
    const dependencyPaths: string[] = [realpathSync(join(mixRoot, 'node_modules'))];
    for (let ancestor = dirname(realpathSync(packageRequire.resolve('axios'))); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
      if (basename(ancestor) === 'node_modules') dependencyPaths.push(ancestor);
    }
    const cliBin = runtime === 'node' ? nodeTsRunnerPrefix().command
      : spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8' }).stdout.trim();
    expect(isAbsolute(cliBin), `${runtime} must be installed`).toBe(true);
    const { prepareDirectSandbox } = await import('../dist/adapters/backend/sandbox.js');
    const { startSessionProtectedHttpEgressHost, protectedHttpEgressAuthTokenPath } = await import('../dist/core/protected-http-egress-host.js');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-shared-read-linux-')));
    const socketDir = join(root, 'sockets');
    mkdirSync(socketDir, { mode: 0o700 });
    const policy = normalizeProtectedHttpEgressPolicy({
      id: 'fixture.items.write.v1', targets: [{ scheme: 'https', host: 'fixture.internal.example', port: 443,
        denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }] }],
    })!;
    const forwarded: ProtectedHttpEgressForwardRequest[] = [];
    let internalCalls = 0;
    const host = await startSessionProtectedHttpEgressHost({
      socketDir, policy, policyDigest: protectedHttpEgressPolicyDigest(policy), sharedRead: true,
      forward: async incoming => {
        forwarded.push(incoming);
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
      },
      loopbackServices: [{ id: 'identity', listenPort: 17950, upstreamPort: 17950, method: 'POST', path: '/internal/identity', forwardHeaders: [] }],
      forwardLoopbackService: async () => {
        internalCalls++;
        return { status: 200, headers: {}, body: Buffer.from('internal') };
      },
    });
    const tokenPath = protectedHttpEgressAuthTokenPath(host.socketPath);
    const gateway = createServer((_request, response) => response.end('fixture'));
    const gatewayPath = join(socketDir, 'g.sock');
    let sandbox: ReturnType<typeof prepareDirectSandbox> = null;
    try {
      await new Promise<void>((resolve, reject) => { gateway.once('error', reject); gateway.listen(gatewayPath, resolve); });
      const script = join(root, 'mix-probe.mjs');
      writeFileSync(script, [
        'import { createRequire } from "node:module";',
        'import { readFileSync } from "node:fs";',
        'import { request } from "node:http";',
        `const require = createRequire(${JSON.stringify(join(mixRoot, 'package.json'))});`,
        'const axios = require("axios").default;',
        `const { installBotmuxProtectedEgress } = require(${JSON.stringify(modulePath)});`,
        'const client = axios.create({ baseURL: "https://fixture.internal.example", proxy: false, timeout: 5000 });',
        `installBotmuxProtectedEgress(client, [{ policyId: ${JSON.stringify(policy.id)}, targetIndex: 0, origin: "https://fixture.internal.example" }]);`,
        'const headers = { authorization: "Bearer local-user-fixture", "x-jwt-token": "local-jwt-fixture", "x-botmux-egress-auth": "forged-auth", "x-botmux-loopback-service": "identity" };',
        'const activity = await client.get("/v1/items/query?keyword=activity", { headers });',
        'const tracker = await client.post("/v1/tracker/query", { logId: "fixture-log-id" }, { headers });',
        'let write; try { await client.post("/v1/items/update", {}, { headers }); write = { status: 200 }; } catch (error) { write = { status: error.response?.status, code: error.response?.data?.code, configExposed: error.config !== undefined }; }',
        'const internal = await new Promise((resolve, reject) => {',
        ' const req = request({ socketPath: process.env.BOTMUX_PROTECTED_EGRESS_SOCKET, path: "/internal/identity", method: "POST", headers: { "x-botmux-egress-client": "shared-read-v1", "x-botmux-loopback-service": "identity" } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });',
        ' req.once("error", reject); req.end();',
        '});',
        `const tokens = ${JSON.stringify([tokenPath, protectedHttpEgressAuthTokenPath('/run/botmux-mcp/e.sock')])};`,
        'const authReadable = tokens.map(path => { try { readFileSync(path); return true; } catch { return false; } });',
        'console.log(JSON.stringify({ protocol: process.env.BOTMUX_PROTECTED_EGRESS_PROTOCOL, activity: activity.status, tracker: tracker.status, write, internal, authReadable }));',
      ].join('\n'));
      const paths = ['/usr', '/etc', dirname(realpathSync(cliBin)), mixRoot, ...dependencyPaths,
        ...(process.env.LD_LIBRARY_PATH ?? '').split(':').filter(path => isAbsolute(path)), root];
      sandbox = prepareDirectSandbox({
        sessionId: `shared-read-${runtime}`, dataDir: join(root, 'data'), chdir: root, home: root,
        policy: { net: true, writeRegexes: [], rules: [...new Set(paths)].map(path => ({
          path, access: path === root ? 'readWrite' : 'readOnly', source: 'baseline',
        })) },
        networkPolicy: { version: 1, public: { mode: 'allow' }, private: { mode: 'allow' } },
        cliBin, cliArgs: [script], mcpGatewaySocketPath: gatewayPath, protectedEgressSocketPath: host.socketPath,
      });
      expect(sandbox).not.toBeNull();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const options = { env: { ...process.env, ...sandbox!.env, BOTMUX: '1' }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
        const child = runtime === 'node' ? spawnNodeTsScript(sandbox!.args[0]!, sandbox!.args.slice(1), options) : spawn(cliBin, sandbox!.args, options);
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('MIX sandbox probe timed out')); }, 15000);
        child.stdout!.on('data', chunk => stdout += chunk); child.stderr!.on('data', chunk => stderr += chunk);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        protocol: 'shared-read-v1', activity: 200, tracker: 200,
        write: { status: 403, code: 'botmux_protected_write_required', configExposed: false }, internal: 403, authReadable: [false, false],
      });
      expect(internalCalls).toBe(0);
      expect(forwarded.map(entry => [entry.method, entry.path])).toEqual([
        ['GET', '/v1/items/query?keyword=activity'], ['POST', '/v1/tracker/query'],
      ]);
      for (const incoming of forwarded) {
        expect(incoming.headers).toMatchObject({ authorization: 'Bearer local-user-fixture', 'x-jwt-token': 'local-jwt-fixture' });
        expect(Object.keys(incoming.headers).some(name => name.startsWith('x-botmux-'))).toBe(false);
      }
      expect(readFileSync(tokenPath, 'utf8').trim().length).toBeGreaterThan(0);
    } finally {
      sandbox?.cleanup();
      await host.close();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      rmSandboxScratch(root);
    }
  }, 30000);
});
