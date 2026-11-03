import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleFeedbackStorageApi } from '../src/dashboard/feedback-storage-api.js';
import { readFeedbackStorageConfig } from '../src/services/feedback-storage-config.js';

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
  it('enforces host administrator and CSRF authorization', async () => {
    expect((await request('/api/feedback/storage', 'GET', undefined, false)).status).toBe(403);
    expect((await request('/api/feedback/storage/configure', 'POST', {}, true, false)).status).toBe(403);
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
