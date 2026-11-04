import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleFeedbackStorageApi } from '../src/dashboard/feedback-storage-api.js';
import { readFeedbackStorageConfig } from '../src/services/feedback-storage-config.js';
import { saveFeedbackStorageCandidate } from '../src/services/feedback-storage-config.js';
import { prepareFeedbackMigration, getFeedbackMigration } from '../src/services/feedback-migration.js';
import { beginFeedbackMaintenance, assertFeedbackAdmission } from '../src/services/feedback-maintenance.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function request(path: string, method = 'GET', body?: unknown, admin = true, csrf = true) {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-api-'));
  directories.push(directory);
  let status = 0, result: any;
  const response = { writeHead: (value: number) => { status = value; }, end: (value: string) => { result = JSON.parse(value); } };
  const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method });
  await handleFeedbackStorageApi(req as any, response as any, new URL(`http://localhost${path}`), { dataDir: directory, isHostAdmin: admin, csrfValid: csrf });
  return { status, result, directory };
}
describe('feedback storage administration', () => {
  it('accepts structured doas identity without persisting a token or command string', async () => {
    const response = await request('/api/feedback/storage/configure', 'POST', {
      expectedGeneration: 0, candidate: { backend: 'postgresql', postgres: {
        host: '::1', port: 4432, database: 'aidb', schema: 'feedback', tls: { mode: 'verify-full' }, connectTimeoutMs: 3000,
        bytepg: { computeId: 'cp-test', doas: { psm: 'data.example.service', environment: 'boe' } },
      } },
    });
    expect(response.status).toBe(200);
    expect(response.result.candidate.postgres.bytepg).toMatchObject({ computeId: 'cp-test', doas: { psm: 'data.example.service', environment: 'boe' } });
    const stored = await readFeedbackStorageConfig(response.directory);
    if (stored.candidate?.backend !== 'postgresql') throw new Error();
    expect(stored.candidate.postgres.bytepg?.tokenRef).toBeUndefined();
  });
  it('stores BytePG token privately and returns only configured status', async () => {
    const response = await request('/api/feedback/storage/configure', 'POST', {
      expectedGeneration: 0, token: 'synthetic-api-token',
      candidate: { backend: 'postgresql', postgres: {
        host: '::1', port: 4432, database: 'aidb', schema: 'feedback', tls: { mode: 'verify-full' }, connectTimeoutMs: 3000,
        bytepg: { computeId: 'cp-api-test', tokenRef: '' },
      } },
    });
    expect(response.status).toBe(200);
    expect(response.result.candidate.postgres.bytepg).toEqual({ computeId: 'cp-api-test', hasToken: true });
    expect(JSON.stringify(response.result)).not.toContain('synthetic-api-token');
    expect(response.result.candidate.postgres.hasPassword).toBe(false);
  });
  it('cancels through the authenticated API and ignores a forged audit actor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feedback-api-cancel-'));
    directories.push(directory);
    const store = await SkillFeedbackStore.open(directory); store.close();
    const config = await readFeedbackStorageConfig(directory);
    const saved = await saveFeedbackStorageCandidate(directory, config.generation, { backend: 'postgresql', postgres: {
      host: 'invalid', port: 5432, database: 'invalid', user: 'invalid', schema: 'feedback', passwordRef: 'env:UNSET',
      tls: { mode: 'disable' }, connectTimeoutMs: 100,
    } });
    const job = await prepareFeedbackMigration(directory, { requestId: 'cancel', expectedGeneration: saved.generation, maintenanceConfirmed: true });
    await beginFeedbackMaintenance(directory, job.migrationId);
    const response = { writeHead: (_status: number) => {}, end: (_body: string) => {} };
    const body = { confirmed: true, actor: 'forged-user', reason: 'incorrect config', evidence: 'ticket:approved-cancel' };
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: 'POST' });
    await handleFeedbackStorageApi(req as any, response as any, new URL(`http://localhost/api/feedback/storage/migrations/${job.migrationId}/cancel`), { dataDir: directory, isHostAdmin: true, csrfValid: true });
    expect((await getFeedbackMigration(directory, job.migrationId)).cancellation?.actor).toBe('dashboard:host-admin');
    expect(() => assertFeedbackAdmission(directory)).not.toThrow();
  });
  it('enforces host administrator and CSRF authorization', async () => {
    expect((await request('/api/feedback/storage', 'GET', undefined, false)).status).toBe(403);
    expect((await request('/api/feedback/storage/configure', 'POST', {}, true, false)).status).toBe(403);
    expect((await request('/api/feedback/storage/recovery/acknowledge', 'POST', {}, false)).status).toBe(403);
    expect((await request('/api/feedback/storage/migrations/test/cancel', 'POST', {}, true, false)).status).toBe(403);
  });
  it('saves a PostgreSQL candidate without activating it or exposing a password', async () => {
    const response = await request('/api/feedback/storage/configure', 'POST', {
      expectedGeneration: 0, password: 'private-password',
      candidate: { backend: 'postgresql', postgres: { host: 'localhost', port: 5432, user: 'user', database: 'feedback', schema: 'feedback_test', tls: { mode: 'verify-full' }, connectTimeoutMs: 3000 } },
    });
    expect(response.status).toBe(200);
    expect(response.result.active.backend).toBe('sqlite');
    expect(response.result.candidate.backend).toBe('postgresql');
    expect(JSON.stringify(response.result)).not.toContain('private-password');
    expect((await readFeedbackStorageConfig(response.directory)).active.backend).toBe('sqlite');
  });
});
