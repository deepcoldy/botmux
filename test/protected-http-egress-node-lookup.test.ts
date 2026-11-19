import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:https', async () => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  return {
    request: (options: {
      lookup: (
        hostname: string,
        options: { all: true; hints: number },
        callback: (error: Error | null, addresses?: unknown, family?: number) => void,
      ) => void;
    }, onResponse: (response: Readable & {
      statusCode?: number;
      headers: Record<string, string>;
    }) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        end: (body?: Buffer) => void;
        destroy: (error?: Error) => void;
      };
      request.destroy = error => {
        if (error) request.emit('error', error);
      };
      request.end = () => {
        options.lookup('fixture.internal.example', { all: true, hints: 32 }, (error, addresses) => {
          if (error) {
            request.emit('error', error);
            return;
          }
          if (!Array.isArray(addresses)
            || addresses.length !== 1
            || addresses[0]?.address !== '203.0.113.10'
            || addresses[0]?.family !== 4) {
            const invalid = new TypeError('Invalid IP address: undefined') as TypeError & { code?: string };
            invalid.code = 'ERR_INVALID_IP_ADDRESS';
            request.emit('error', invalid);
            return;
          }
          const response = Readable.from(['{"ok":true}']) as Readable & {
            statusCode?: number;
            headers: Record<string, string>;
          };
          response.statusCode = 200;
          response.headers = { 'content-type': 'application/json' };
          onResponse(response);
        });
      };
      return request;
    },
  };
});

import { protectedHttpEgressAuthTokenPath, startSessionProtectedHttpEgressHost } from '../src/core/protected-http-egress-host.js';
import {
  normalizeProtectedHttpEgressPolicy,
  protectedHttpEgressPolicyDigest,
} from '../src/core/protected-http-egress.js';

const policy = normalizeProtectedHttpEgressPolicy({
  id: 'fixture.items.write.v1',
  targets: [{
    scheme: 'https',
    host: 'fixture.internal.example',
    port: 443,
    denyRoutes: [{ methods: ['POST'], path: '/v1/items/update' }],
  }],
})!;

describe('protected HTTP egress pinned DNS lookup', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  });

  it('returns the pinned address list when Node requests lookup all results', async () => {
    const socketDir = mkdtempSync(join(tmpdir(), 'botmux-egress-node-lookup-'));
    chmodSync(socketDir, 0o700);
    const host = await startSessionProtectedHttpEgressHost({
      socketDir,
      policy,
      policyDigest: protectedHttpEgressPolicyDigest(policy),
      frozenAddresses: [['203.0.113.10']],
    });
    cleanups.push(async () => {
      await host.close();
      rmSync(socketDir, { recursive: true, force: true });
    });
    const auth = readFileSync(protectedHttpEgressAuthTokenPath(host.socketPath), 'utf8').trim();

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        socketPath: host.socketPath,
        method: 'GET',
        path: '/v1/items/list',
        headers: {
          'x-botmux-egress-auth': auth,
          'x-botmux-egress-policy': policy.id,
          'x-botmux-egress-target': '0',
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.once('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      request.once('error', reject);
      request.end();
    });

    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
  });
});
