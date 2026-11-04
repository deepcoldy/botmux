/** Real Linux namespace coverage for the protected provider bridge.
 *
 * Run after build:
 *   BOTMUX_PROTECTED_LOOPBACK_INTEGRATION=1 bun run test test/protected-provider-loopback-linux.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN,
} from '../src/core/protected-http-egress-loopback.js';
import type { SandboxNetworkPolicy } from '../src/core/sandbox-network-policy.js';

const enabled = process.platform === 'linux'
  && process.env.BOTMUX_PROTECTED_LOOPBACK_INTEGRATION === '1'
  && existsSync(new URL('../dist/sandbox-network-runner.js', import.meta.url));

describe.skipIf(!enabled)('protected provider loopback in a real network namespace', () => {
  let root: string;
  let socketPath: string;
  let guard: ReturnType<typeof createServer>;
  const observed: Array<{ method?: string; url?: string; auth?: string; policy?: string; target?: string }> = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'botmux-provider-loopback-linux-'));
    chmodSync(root, 0o700);
    socketPath = join(root, 'e.sock');
    writeFileSync(join(root, 'egress-auth'), 'namespace-auth-fixture\n', { mode: 0o600 });
    guard = createServer((request, response) => {
      observed.push({
        method: request.method,
        url: request.url,
        auth: request.headers['x-botmux-egress-auth'] as string | undefined,
        policy: request.headers['x-botmux-egress-policy'] as string | undefined,
        target: request.headers['x-botmux-egress-target'] as string | undefined,
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
    const script = join(root, 'probe.mjs');
    writeFileSync(script, [
      'const response = await fetch(process.argv[2], { method: "POST", body: "{}" });',
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
      [script, `${PROTECTED_HTTP_LOOPBACK_PLACEHOLDER_ORIGIN}/model/responses`],
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
});
