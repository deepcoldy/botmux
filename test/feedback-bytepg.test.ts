import { createServer, type Socket } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { feedbackPostgresPool } from '../src/services/feedback-postgres-schema.js';
import { configureFeedbackStorageCandidate, feedbackStorageView, testFeedbackStorageConnection } from '../src/services/feedback-storage-management.js';
import { readFeedbackStorageConfig, readPostgresCredential } from '../src/services/feedback-storage-config.js';
import type { PostgresTarget } from '../src/services/feedback-storage-types.js';
import type { PoolClient } from 'pg';
import { prepareFeedbackMigration, resumeFeedbackMigration } from '../src/services/feedback-migration.js';
import { getFeedbackStorage, closeAllFeedbackStorage } from '../src/services/feedback-storage.js';
import { writeFile } from 'node:fs/promises';

const directories: string[] = [];
afterEach(async () => {
  await closeAllFeedbackStorage();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  delete process.env.BYTEPG_TEST_TOKEN;
  vi.unstubAllEnvs();
});
function message(type: string, payload: Buffer) {
  const header = Buffer.alloc(5); header.write(type); header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}
async function gateway(reject: boolean | 'query' | 'query-auth' | 'expired' | 'network' = false, host = '127.0.0.1') {
  const startups: Record<string, string>[] = [];
  const queries: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0), started = false;
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      if (!started) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        const length = buffer.readInt32BE(0);
        const fields = buffer.subarray(8, length).toString().split('\0');
        const values: Record<string, string> = {};
        for (let index = 0; index < fields.length - 1 && fields[index]; index += 2) values[fields[index]] = fields[index + 1];
        startups.push(values); buffer = buffer.subarray(length); started = true;
        if (reject === 'network') { socket.destroy(); return; }
        if (reject === true || (reject === 'expired' && values.options.includes('bytepg_auth_token=old-token '))) {
          const text = `SERROR\0C28000\0Mrejected ${values.options}\0D${values.options}\0\0`;
          socket.end(message('E', Buffer.from(text))); return;
        }
        socket.write(Buffer.concat([message('R', Buffer.alloc(4)), message('Z', Buffer.from('I'))]));
      }
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const type = String.fromCharCode(buffer[0]), length = buffer.readInt32BE(1);
        const payload = buffer.subarray(5, 1 + length).toString().replace(/\0$/, '');
        buffer = buffer.subarray(1 + length);
        if (type === 'X') { socket.end(); return; }
        if (type === 'Q') {
          queries.push(payload);
          if (reject === 'query' || reject === 'query-auth') {
            const code = reject === 'query-auth' ? '28000' : 'XX000';
            const text = `SERROR\0C${code}\0Mfailed ${startups[0].options}\0D${startups[0].options}\0\0`;
            socket.write(Buffer.concat([message('N', Buffer.from(text)), message('E', Buffer.from(text)), message('Z', Buffer.from('I'))]));
          } else socket.write(Buffer.concat([message('C', Buffer.from('SELECT 1\0')), message('Z', Buffer.from('I'))]));
        }
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const port = (server.address() as { port: number }).port;
  return { port, startups, queries, close: async () => { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const target = (port: number): PostgresTarget => ({
  host: '127.0.0.1', port, database: 'aidb', schema: 'feedback',
  bytepg: { computeId: 'cp-test-compute', tokenRef: 'env:BYTEPG_TEST_TOKEN' },
  tls: { mode: 'disable' }, connectTimeoutMs: 1000,
});
describe('BytePG feedback authentication', () => {
  it('refreshes once after authentication rejection and sends the SQL only on the successful connection', async () => {
    const server = await gateway('expired');
    let refreshes = 0;
    let current = { value: 'old-token', generation: 0 };
    const pool = feedbackPostgresPool(target(server.port), {
      get: async () => current,
      refresh: async generation => { expect(generation).toBe(0); refreshes++; return current = { value: 'new-token', generation: 1 }; },
    });
    try {
      await pool.query('SELECT 1');
      expect(refreshes).toBe(1);
      expect(server.startups).toHaveLength(2);
      expect(server.queries).toEqual(['SELECT 1']);
      expect(server.startups[1].options).toContain('bytepg_auth_token=new-token ');
    } finally { await pool.end(); await server.close(); }
  });
  it.each(['network', 'query', 'query-auth'] as const)('never cleans or retries SQL on %s failure', async failure => {
    const server = await gateway(failure);
    let refreshes = 0;
    const pool = feedbackPostgresPool(target(server.port), {
      get: async () => ({ value: 'new-token', generation: 0 }),
      refresh: async () => { refreshes++; return { value: 'other-token', generation: 1 }; },
    });
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow();
      expect(refreshes).toBe(0);
      expect(server.startups).toHaveLength(1);
      expect(server.queries).toHaveLength(failure === 'network' ? 0 : 1);
    } finally { await pool.end(); await server.close(); }
  });
  it('bounds authentication recovery to one reconnect', async () => {
    const server = await gateway(true);
    let refreshes = 0;
    const pool = feedbackPostgresPool(target(server.port), {
      get: async () => ({ value: 'old-token', generation: 0 }),
      refresh: async () => { refreshes++; return { value: 'new-token', generation: 1 }; },
    });
    try {
      await expect(pool.connect()).rejects.toThrow();
      expect(refreshes).toBe(1);
      expect(server.startups).toHaveLength(2);
    } finally { await pool.end(); await server.close(); }
  });
  it('uses the same token credential for connection tests, runtime and migration, without persisting its value', async () => {
    const server = await gateway(true);
    const token = 'synthetic-all-paths-token';
    const directory = await mkdtemp(join(tmpdir(), 'bytepg-paths-')); directories.push(directory);
    process.env.BYTEPG_TEST_TOKEN = token;
    const initial = await readFeedbackStorageConfig(directory);
    const configured = await configureFeedbackStorageCandidate(directory, { expectedGeneration: initial.generation, candidate: { backend: 'postgresql', postgres: target(server.port) } });
    try {
      await expect(testFeedbackStorageConnection(directory)).rejects.toThrow('feedback_bytepg_connection_or_query_failed');
      const job = await prepareFeedbackMigration(directory, { requestId: 'synthetic-request', expectedGeneration: configured.generation, maintenanceConfirmed: true });
      const stopped = await resumeFeedbackMigration(directory, job.migrationId);
      expect(stopped.phase).toBe('blocked');
      expect(JSON.stringify(stopped)).not.toContain(token);
      expect(await readFile(join(directory, 'feedback-migrations', `${job.migrationId}.json`), 'utf8')).not.toContain(token);
      await writeFile(join(directory, 'feedback-storage.json'), JSON.stringify({ ...configured, active: configured.candidate, candidate: undefined }));
      await expect(getFeedbackStorage(directory)).rejects.toThrow('feedback_bytepg_connection_or_query_failed');
      expect(server.startups).toHaveLength(3);
      for (const startup of server.startups) expect(startup.options).toContain(`bytepg_auth_token=${token}`);
    } finally { await server.close(); }
  });
  it('supports IPv6 hosts and redacts query errors and notices echoed by a gateway', async () => {
    const server = await gateway('query', '::1'), token = 'synthetic-ipv6-query-token';
    const pool = feedbackPostgresPool({ ...target(server.port), host: '::1' }, token);
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      const notices: unknown[] = [];
      const rawMessages: unknown[] = [];
      client.on('notice', notice => notices.push(notice));
      (client as any).connection.on('message', (value: unknown) => rawMessages.push(value));
      let error: unknown;
      try { await client.query('SELECT 1'); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(notices).toHaveLength(1);
      expect(inspect([error, notices], { depth: 10 })).not.toContain(token);
      expect(inspect(rawMessages, { depth: 10 })).not.toContain(token);
      expect(server.startups[0].options).toContain('bytepg_compute_id=cp-test-compute');
    } finally { client?.release(); await pool.end(); await server.close(); }
  });
  it('resolves a nonempty operating-system username when all username environment variables are absent', async () => {
    vi.stubEnv('PGUSER', undefined); vi.stubEnv('USER', undefined); vi.stubEnv('USERNAME', undefined);
    const server = await gateway();
    const pool = feedbackPostgresPool(target(server.port), 'synthetic-user-token');
    try {
      const client = await pool.connect(); client.release();
      expect(server.startups[0].user).toBeTruthy();
    } finally { await pool.end(); await server.close(); }
  });
  it('escapes whitespace and backslashes as one startup option value', async () => {
    const server = await gateway();
    const pool = feedbackPostgresPool(target(server.port), 'token\\segment -c injected=1');
    try {
      const client = await pool.connect(); client.release();
      expect(server.startups[0].options).toBe('bytepg_compute_id=cp-test-compute bytepg_auth_token=token\\\\segment\\ -c\\ injected=1 -c search_path=feedback,pg_catalog');
    } finally { await pool.end(); await server.close(); }
  });
  it('sends BytePG startup options together with the schema and never puts the token in inspectable client options', async () => {
    const server = await gateway();
    const token = 'synthetic+token/with=padding';
    const pool = feedbackPostgresPool(target(server.port), token);
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      expect(server.startups[0].options).toBe(`bytepg_compute_id=cp-test-compute bytepg_auth_token=${token} -c search_path=feedback,pg_catalog`);
      expect(inspect(pool, { depth: 5 })).not.toContain(token);
      expect(inspect(client, { depth: 5 })).not.toContain(token);
      expect(JSON.stringify((client as any).connectionParameters)).not.toContain(token);
      // The pool must never hold the token itself: the password slot is a thunk
      // returning the empty string, so a gateway that unexpectedly issues a
      // password challenge gets '', and pool introspection cannot reveal it.
      const passwordSlot = (pool as unknown as { options: { password: unknown } }).options.password;
      expect(typeof passwordSlot === 'function' ? (passwordSlot as () => unknown)() : passwordSlot).toBe('');
    } finally { client?.release(); await pool.end(); await server.close(); }
  });
  it('does not leak tokens when a gateway echoes startup options in connection errors', async () => {
    const server = await gateway(true), token = 'synthetic-secret-rejected';
    const pool = feedbackPostgresPool(target(server.port), token);
    try {
      let error: unknown;
      try { await pool.connect(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain('bytepg');
      expect(inspect(error, { depth: 10 })).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    } finally { await pool.end(); await server.close(); }
  });
  it('stores token references without requiring password or username and redacts configuration views', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bytepg-config-')); directories.push(directory);
    const initial = await readFeedbackStorageConfig(directory);
    const saved = await configureFeedbackStorageCandidate(directory, {
      expectedGeneration: initial.generation, candidate: { backend: 'postgresql', postgres: target(4432) }, token: 'synthetic-token-input',
    });
    const configured = saved.candidate!;
    expect(configured.backend).toBe('postgresql');
    if (configured.backend !== 'postgresql') throw new Error();
    expect(await readPostgresCredential(directory, configured.postgres)).toBe('synthetic-token-input');
    expect(configured.postgres.passwordRef).toBeUndefined();
    expect(JSON.stringify(feedbackStorageView(saved))).not.toContain('synthetic-token-input');
    expect(await readFile(join(directory, 'feedback-storage.json'), 'utf8')).not.toContain('synthetic-token-input');
    const retained = await configureFeedbackStorageCandidate(directory, {
      expectedGeneration: saved.generation, candidate: { backend: 'postgresql', postgres: { ...configured.postgres, bytepg: { computeId: 'cp-test-compute', tokenRef: '' } } }, token: '',
    });
    expect(retained.candidate).toEqual(saved.candidate);
  });
  it('rejects injected compute IDs and control characters in tokens before opening a connection', () => {
    expect(() => feedbackPostgresPool({ ...target(1), bytepg: { computeId: 'cp-x bytepg_auth_token=other', tokenRef: 'env:TOKEN' } }, 'secret')).toThrow();
    expect(() => feedbackPostgresPool(target(1), 'bad\0token')).toThrow();
  });
  it('rejects mixed credentials and reads only the selected protected token reference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bytepg-reference-')); directories.push(directory);
    process.env.BYTEPG_TEST_TOKEN = 'rotated-token';
    expect(await readPostgresCredential(directory, target(4432))).toBe('rotated-token');
    const current = await readFeedbackStorageConfig(directory);
    await expect(configureFeedbackStorageCandidate(directory, {
      expectedGeneration: current.generation, candidate: { backend: 'postgresql', postgres: { ...target(4432), passwordRef: 'env:PASSWORD' } },
    })).rejects.toThrow('feedback_storage_auth_invalid');
    // A token supplied alongside a password-mode candidate is rejected too,
    // even when the candidate already carries a usable password reference.
    await expect(configureFeedbackStorageCandidate(directory, {
      expectedGeneration: current.generation,
      candidate: { backend: 'postgresql', postgres: { host: '127.0.0.1', port: 4432, database: 'aidb', user: 'botmux', schema: 'feedback',
        passwordRef: 'env:PASSWORD', tls: { mode: 'disable' }, connectTimeoutMs: 1000 } },
      token: 'mixed-mode-token',
    })).rejects.toThrow('feedback_storage_auth_invalid');
    // A doas candidate must reject both an inline token and a static reference,
    // so the persisted source can never address two credential mechanisms.
    const doasCandidate = { backend: 'postgresql' as const, postgres: { ...target(4432),
      bytepg: { computeId: 'cp-test-compute', doas: { psm: 'data.example.service', environment: 'boe' as const } } } };
    await expect(configureFeedbackStorageCandidate(directory, {
      expectedGeneration: current.generation, candidate: doasCandidate, token: 'doas-inline-token',
    })).rejects.toThrow('feedback_storage_auth_invalid');
    await expect(configureFeedbackStorageCandidate(directory, {
      expectedGeneration: current.generation,
      candidate: { backend: 'postgresql', postgres: { ...target(4432), bytepg: {
        computeId: 'cp-test-compute', doas: { psm: 'data.example.service', environment: 'boe' }, tokenRef: 'env:BYTEPG_TEST_TOKEN',
      } } },
    })).rejects.toThrow('feedback_storage_auth_invalid');
  });
});
