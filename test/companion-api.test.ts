import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  companionSignature,
  createCompanionApi,
  isCompanionLoopback,
  loadCompanionSecret,
  type CompanionRole,
  type CompanionRuntime,
} from '../src/dashboard/companion-api.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  let role: CompanionRole = { role: 'reviewer', injectMode: 'every', revision: null };
  let runtime: CompanionRuntime = { provider: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' };
  const calls = { roleWrites: 0, runtimeWrites: 0, failRoleOnce: false };
  const secret = 'companion-test-secret';
  const api = createCompanionApi({ secret, operations: {
    readRole: () => role,
    writeRole: value => {
      calls.roleWrites += 1;
      if (calls.failRoleOnce) { calls.failRoleOnce = false; throw new Error('transient'); }
      return role = { ...value, role: value.role.trim(), revision: null };
    },
    readRuntime: () => runtime,
    writeRuntime: value => { calls.runtimeWrites += 1; return runtime = value; },
  } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = url.search ? `${url.pathname}${url.search}` : url.pathname;
    if (!await api(req, res, target)) { res.statusCode = 404; res.end(); }
  });
  return { secret, server, calls, api };
}

async function request(port: number, secret: string, method: string, pathname: string, bodyRaw = '', nonce = Math.random().toString(36).slice(2), timestamp = String(Date.now())) {
  const signature = companionSignature(secret, { timestamp, nonce, method, pathname, bodyRaw });
  return fetch(`http://127.0.0.1:${port}${pathname}`, { method, body: bodyRaw || undefined, headers: {
    'content-type': 'application/json',
    'x-botmux-companion-timestamp': timestamp,
    'x-botmux-companion-nonce': nonce,
    'x-botmux-companion-signature': signature,
  } });
}

async function listening<T>(run: (port: number, secret: string, calls: { roleWrites: number; runtimeWrites: number; failRoleOnce: boolean }) => Promise<T>): Promise<T> {
  const f = fixture();
  await new Promise<void>(resolve => f.server.listen(0, '127.0.0.1', resolve));
  const port = (f.server.address() as { port: number }).port;
  try { return await run(port, f.secret, f.calls); } finally { await new Promise<void>(resolve => f.server.close(() => resolve())); }
}

describe('closed companion API', () => {
  it('accepts only loopback peer addresses', () => {
    expect(isCompanionLoopback('127.0.0.1')).toBe(true);
    expect(isCompanionLoopback('::1')).toBe(true);
    expect(isCompanionLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isCompanionLoopback('10.0.0.1')).toBe(false);
    expect(isCompanionLoopback(undefined)).toBe(false);
  });

  it('rejects a non-loopback peer at the handler boundary', async () => {
    const f = fixture();
    let status = 0;
    let body = '';
    const req = Object.assign(Readable.from([]), {
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    });
    const res = {
      writeHead: (nextStatus: number) => { status = nextStatus; },
      end: (value?: string) => { body = value ?? ''; },
    };
    await f.api(req as any, res as any, '/__companion/v1/health');
    expect(status).toBe(403);
    expect(body).toBe(JSON.stringify({ ok: false, error: 'forbidden' }));
  });

  it('returns only versioned capabilities from authenticated health', () => listening(async (port, secret) => {
    const response = await request(port, secret, 'GET', '/__companion/v1/health');
    expect(await response.json()).toEqual({ ok: true, version: 'botmux.companion.v1', capabilities: ['role.read', 'role.write', 'runtime.read', 'runtime.write'] });
  }));

  it('returns bounded team role text and sanitized write readback without identifiers', () => listening(async (port, secret) => {
    const read = await request(port, secret, 'GET', '/__companion/v1/role');
    expect(await read.json()).toEqual({ ok: true, value: { role: 'reviewer', injectMode: 'every', revision: null } });
    const raw = JSON.stringify({ requestId: 'request_123', role: '  builder  ', injectMode: 'once' });
    const write = await request(port, secret, 'PUT', '/__companion/v1/role', raw);
    expect(await write.json()).toEqual({ ok: true, requestId: 'request_123', value: { role: 'builder', injectMode: 'once', revision: null } });
  }));

  it('deduplicates concurrent writes by requestId before performing the side effect', () => listening(async (port, secret, calls) => {
    const raw = JSON.stringify({ requestId: 'same_request', role: 'builder', injectMode: 'once' });
    const responses = await Promise.all([
      request(port, secret, 'PUT', '/__companion/v1/role', raw),
      request(port, secret, 'PUT', '/__companion/v1/role', raw),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(calls.roleWrites).toBe(1);
  }));

  it('rejects extra write fields instead of widening the closed schema', () => listening(async (port, secret) => {
    const raw = JSON.stringify({ requestId: 'extra_field', role: 'builder', injectMode: 'once', settings: 'nope' });
    expect((await request(port, secret, 'PUT', '/__companion/v1/role', raw)).status).toBe(400);
  }));

  it('does not permanently cache failed writes under the requestId', () => listening(async (port, secret, calls) => {
    calls.failRoleOnce = true;
    const raw = JSON.stringify({ requestId: 'retry_request', role: 'builder', injectMode: 'once' });
    expect((await request(port, secret, 'PUT', '/__companion/v1/role', raw)).status).toBe(500);
    expect((await request(port, secret, 'PUT', '/__companion/v1/role', raw)).status).toBe(200);
    expect(calls.roleWrites).toBe(2);
  }));

  it('enforces the runtime allowlist and provider-specific reasoning', () => listening(async (port, secret) => {
    const valid = JSON.stringify({ requestId: 'runtime_123', provider: 'traecli', model: 'DeepSeek-V4-Pro', reasoning: 'high' });
    expect((await request(port, secret, 'PUT', '/__companion/v1/runtime', valid)).status).toBe(200);
    const invalid = JSON.stringify({ requestId: 'runtime_456', provider: 'traecli', model: 'DeepSeek-V4-Pro', reasoning: 'xhigh' });
    expect((await request(port, secret, 'PUT', '/__companion/v1/runtime', invalid)).status).toBe(400);
  }));

  it('rejects stale timestamps, replay, and signatures bound to a different body/path', () => listening(async (port, secret) => {
    expect((await request(port, secret, 'GET', '/__companion/v1/role', '', 'stale_nonce', String(Date.now() - 61_000))).status).toBe(401);
    const nonce = 'one_time_nonce';
    expect((await request(port, secret, 'GET', '/__companion/v1/role', '', nonce)).status).toBe(200);
    expect((await request(port, secret, 'GET', '/__companion/v1/role', '', nonce)).status).toBe(409);
    expect((await request(port, 'wrong-secret', 'GET', '/__companion/v1/role')).status).toBe(401);

    const timestamp = String(Date.now());
    const bodyRaw = JSON.stringify({ requestId: 'request_789', role: 'x', injectMode: 'once' });
    const signature = companionSignature(secret, { timestamp, nonce: 'bound_nonce', method: 'PUT', pathname: '/__companion/v1/runtime', bodyRaw });
    const mismatch = await fetch(`http://127.0.0.1:${port}/__companion/v1/role`, { method: 'PUT', body: bodyRaw, headers: {
      'x-botmux-companion-timestamp': timestamp,
      'x-botmux-companion-nonce': 'bound_nonce',
      'x-botmux-companion-signature': signature,
    } });
    expect(mismatch.status).toBe(401);
  }));

  it('rejects bodies above the fixed limit before parsing or operation', () => listening(async (port, secret) => {
    const raw = 'x'.repeat(64 * 1024 + 1);
    expect((await request(port, secret, 'PUT', '/__companion/v1/role', raw)).status).toBe(413);
  }));

  it('does not expose arbitrary dashboard routes or query variants through the companion prefix', () => listening(async (port, secret) => {
    expect((await request(port, secret, 'GET', '/__companion/v1/settings')).status).toBe(404);
    expect((await request(port, secret, 'GET', '/__companion/v1/health?scope=all')).status).toBe(404);
  }));
});

describe('companion secret file validation', () => {
  it('accepts only a canonical nonempty 0600 regular file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-companion-')); dirs.push(dir); chmodSync(dir, 0o700);
    const path = join(dir, 'secret'); writeFileSync(path, ' dedicated-secret\n', { mode: 0o600 });
    const canonical = realpathSync(path);
    expect(loadCompanionSecret(canonical)).toBe('dedicated-secret');
    chmodSync(path, 0o644);
    expect(() => loadCompanionSecret(canonical)).toThrow('companion_secret_invalid');
    chmodSync(path, 0o600); writeFileSync(path, ' \n');
    expect(() => loadCompanionSecret(canonical)).toThrow('companion_secret_invalid');
  });

  it('rejects relative paths and symlink leaves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-companion-')); dirs.push(dir); mkdirSync(join(dir, 'private'), { mode: 0o700 });
    const target = join(dir, 'private', 'target'); const link = join(dir, 'private', 'link');
    writeFileSync(target, 'secret', { mode: 0o600 }); symlinkSync(target, link);
    expect(() => loadCompanionSecret('relative-secret')).toThrow('companion_secret_invalid');
    expect(() => loadCompanionSecret(link)).toThrow('companion_secret_invalid');
  });
});
