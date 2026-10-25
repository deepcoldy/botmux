import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrcaRuntimeClient } from '../src/services/orca-runtime-client.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runtime(reply: (request: any) => string | null) {
  const root = mkdtempSync(join(tmpdir(), 'oc-')); roots.push(root);
  const endpoint = join(root, 's');
  const server = createServer(socket => {
    socket.setEncoding('utf8'); let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.trim());
      expect(request.authToken).toBe('test-token');
      const result = reply(request);
      if (result === null) socket.end(); else socket.end(result);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  writeFileSync(join(root, 'orca-runtime.json'), JSON.stringify({ runtimeId: 'runtime', authToken: 'test-token',
    transports: [{ kind: 'unix', endpoint }] }));
  return new OrcaRuntimeClient(root, 1000);
}

describe('Orca authenticated local RPC', () => {
  it('accepts a correlated response after keepalive without leaking transport credentials', async () => {
    const client = await runtime(request => JSON.stringify({ _keepalive: true }) + '\n'
      + JSON.stringify({ id: request.id, ok: true, result: { ready: true }, _meta: { runtimeId: 'runtime' } }) + '\n');
    await expect(client.call('status.get')).resolves.toEqual({ ready: true });
  });
  it.each(['wrong-id', 'wrong-runtime', 'invalid-json', 'closed'] as const)('rejects %s', async variant => {
    const client = await runtime(request => variant === 'closed' ? null : variant === 'invalid-json' ? 'invalid\n'
      : JSON.stringify({ id: variant === 'wrong-id' ? 'other' : request.id, ok: true, result: {},
        _meta: { runtimeId: variant === 'wrong-runtime' ? 'other' : 'runtime' } }) + '\n');
    await expect(client.call('status.get')).rejects.toThrow(/Orca/);
  });
});
