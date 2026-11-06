import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const raceProbe = vi.hoisted(() => ({
  attackers: [] as Array<{
    socket: { destroy(): void };
    chunks: Buffer[];
  }>,
}));

vi.mock('node:net', async importOriginal => {
  const actual = await importOriginal<typeof import('node:net')>();
  return {
    ...actual,
    createConnection: (...args: Parameters<typeof actual.createConnection>) => {
      const expected = new actual.Socket();
      const chunks: Buffer[] = [];
      const attacker = actual.createConnection(...args);
      attacker.on('data', chunk => chunks.push(Buffer.from(chunk)));
      attacker.on('error', () => undefined);
      expected.on('error', () => undefined);
      raceProbe.attackers.push({ socket: attacker, chunks });
      attacker.once('connect', () => {
        attacker.write('KEY\n');
        setTimeout(() => {
          (expected.connect as (...connectArgs: Parameters<typeof actual.createConnection>) => unknown)(...args);
        }, 10).unref();
      });
      return expected;
    },
  };
});

import { serveProtectedMcpSecrets } from '../src/core/protected-mcp-capabilities.js';

describe('protected MCP secret channel peer authentication', () => {
  it('rejects a same-host connector that reaches the listener before the expected peer', async () => {
    const secret = 'peer-auth-secret-must-not-leak';
    const worker = spawn(process.env.NODE_BINARY ?? 'node', [
      resolve('test/fixtures/protected-secret-concurrency-worker.mjs'),
      '1',
      'fixture.secret.v1',
    ], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    serveProtectedMcpSecrets(worker, new Map([['fixture.secret.v1', secret]]));
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    worker.stdout.on('data', chunk => { stdout += chunk; });
    worker.stderr.on('data', chunk => { stderr += chunk; });

    const [code] = await once(worker, 'close');
    const attackerOutput = raceProbe.attackers
      .map(entry => Buffer.concat(entry.chunks).toString('utf8'))
      .join('');
    for (const entry of raceProbe.attackers) entry.socket.destroy();

    expect(raceProbe.attackers).toHaveLength(1);
    expect(attackerOutput).not.toContain(secret);
    expect(code, stderr).toBe(0);
    const results = JSON.parse(stdout) as Array<{ code: number; result?: { secret: string } }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ code: 0, result: { secret } });
  }, 10_000);
});
