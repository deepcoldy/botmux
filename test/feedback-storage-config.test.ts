import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readFeedbackStorageConfig,
  saveFeedbackStorageCandidate,
  putFeedbackStorageSecret,
  readFeedbackStorageSecret,
} from '../src/services/feedback-storage-config.js';
import { closeAllFeedbackStorage, getFeedbackStorage } from '../src/services/feedback-storage.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'feedback-config-'));
  directories.push(path);
  return path;
}
const target = {
  backend: 'postgresql' as const,
  postgres: {
    host: 'localhost', port: 5432, database: 'feedback', user: 'feedback',
    schema: 'feedback_test', passwordRef: 'env:BOTMUX_TEST_PG_PASSWORD',
    tls: { mode: 'verify-full' as const }, connectTimeoutMs: 5000,
  },
};
afterEach(async () => {
  await closeAllFeedbackStorage();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
  delete process.env.BOTMUX_TEST_PG_PASSWORD;
});
describe('feedback storage configuration', () => {
  it('keeps captured stores live when only the candidate configuration changes', async () => {
    const path = await directory();
    const first = await getFeedbackStorage(path);
    const response = await first.store.createResponse({ interactionId: 'interaction', content: 'answer' });
    await first.store.createDelivery({ responseId: response.responseId, platform: 'lark', platformAppId: 'app', platformMessageId: 'message' });
    expect(await first.analytics.summary({ from: '2020-01-01', to: '2020-02-01' })).toMatchObject({ delivered: 0 });
    const config = await readFeedbackStorageConfig(path);
    await saveFeedbackStorageCandidate(path, config.generation, target);
    const second = await getFeedbackStorage(path);
    expect((await second.store.findDeliveryByPlatformMessage('lark', 'app', 'message'))?.responseId).toBe(response.responseId);
    expect(await first.store.getResponse(response.responseId)).toMatchObject({ responseId: response.responseId });
    expect(second.store).toBe(first.store);
    expect(second.generation).toBe(config.generation + 1);
  });
  it('keeps one durable instance identity and defaults to SQLite', async () => {
    const path = await directory();
    const configs = await Promise.all([readFeedbackStorageConfig(path), readFeedbackStorageConfig(path)]);
    expect(configs[0].active).toEqual({ backend: 'sqlite' });
    expect(configs[0].instanceId).toBe(configs[1].instanceId);
    expect((await readFeedbackStorageConfig(path)).instanceId).toBe(configs[0].instanceId);
  });
  it('saves a candidate without changing the active database', async () => {
    const path = await directory();
    const current = await readFeedbackStorageConfig(path);
    const result = await saveFeedbackStorageCandidate(path, current.generation, target);
    expect(result.active).toEqual({ backend: 'sqlite' });
    expect(result.candidate).toEqual(target);
    expect(result.generation).toBe(current.generation + 1);
  });
  it('rejects one of two concurrent saves using the same generation', async () => {
    const path = await directory();
    const current = await readFeedbackStorageConfig(path);
    const results = await Promise.allSettled([
      saveFeedbackStorageCandidate(path, current.generation, target),
      saveFeedbackStorageCandidate(path, current.generation, { backend: 'sqlite' }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('does not turn corrupted configuration into an empty SQLite installation', async () => {
    const path = await directory();
    await writeFile(join(path, 'feedback-storage.json'), '{"password":"never-log-this",');
    await expect(readFeedbackStorageConfig(path)).rejects.toThrow('feedback_storage_config_invalid');
  });
  it.each([
    { passwordRef: 'env:P', bytepg: { computeId: 'cp', tokenRef: 'env:T' }, user: 'botmux' },
    { user: 'botmux' },
    { passwordRef: 'env:P' },
  ])('rejects persisted postgres targets with contradictory or missing auth fields', async auth => {
    const path = await directory();
    const persisted = {
      version: 1, generation: 1, instanceId: randomUUID(),
      active: { backend: 'postgresql', postgres: {
        host: 'localhost', port: 5432, database: 'feedback', schema: 'feedback_test',
        tls: { mode: 'disable' }, connectTimeoutMs: 5000, ...auth,
      } },
    };
    await writeFile(join(path, 'feedback-storage.json'), JSON.stringify(persisted), 'utf8');
    await expect(readFeedbackStorageConfig(path)).rejects.toThrow('feedback_storage_config_invalid');
  });
  it('accepts a persisted BytePG target without password reference or explicit user', async () => {
    const path = await directory();
    const persisted = {
      version: 1, generation: 1, instanceId: randomUUID(),
      active: { backend: 'postgresql', postgres: {
        host: 'localhost', port: 5432, database: 'feedback', schema: 'feedback_test',
        bytepg: { computeId: 'cp', tokenRef: 'env:BOTMUX_TEST_PG_TOKEN' },
        tls: { mode: 'verify-full' }, connectTimeoutMs: 5000,
      } },
    };
    await writeFile(join(path, 'feedback-storage.json'), JSON.stringify(persisted), 'utf8');
    const reread = await readFeedbackStorageConfig(path);
    expect(reread.active.backend).toBe('postgresql');
  });
  it.each([
    { bytepg: { computeId: 'cp', tokenRef: 'env:BOTMUX_TEST_PG_TOKEN', doas: { psm: 'p.s', environment: 'boe' } } },
    { bytepg: { computeId: 'cp' } },
  ])('rejects a persisted BytePG target carrying both or neither credential source', async auth => {
    const path = await directory();
    const persisted = {
      version: 1, generation: 1, instanceId: randomUUID(),
      active: { backend: 'postgresql', postgres: {
        host: 'localhost', port: 5432, database: 'feedback', schema: 'feedback_test',
        tls: { mode: 'disable' }, connectTimeoutMs: 5000, ...auth,
      } },
    };
    await writeFile(join(path, 'feedback-storage.json'), JSON.stringify(persisted), 'utf8');
    await expect(readFeedbackStorageConfig(path)).rejects.toThrow('feedback_storage_config_invalid');
  });
  it('accepts a persisted doas-only BytePG target without any token reference', async () => {
    const path = await directory();
    const persisted = {
      version: 1, generation: 1, instanceId: randomUUID(),
      active: { backend: 'postgresql', postgres: {
        host: 'localhost', port: 5432, database: 'feedback', schema: 'feedback_test',
        bytepg: { computeId: 'cp', doas: { psm: 'data.example.service', environment: 'boe' } },
        tls: { mode: 'verify-full' }, connectTimeoutMs: 5000,
      } },
    };
    await writeFile(join(path, 'feedback-storage.json'), JSON.stringify(persisted), 'utf8');
    const reread = await readFeedbackStorageConfig(path);
    if (reread.active.backend !== 'postgresql') throw new Error();
    expect(reread.active.postgres.bytepg?.doas).toEqual({ psm: 'data.example.service', environment: 'boe' });
    expect(reread.active.postgres.bytepg?.tokenRef).toBeUndefined();
  });
  it.each([
    { ...target, postgres: { ...target.postgres, schema: 'x;DROP SCHEMA public' } },
    { ...target, postgres: { ...target.postgres, password: 'not-a-reference' } },
    { ...target, postgres: { ...target.postgres, tls: { mode: 'ignore-errors' } } },
    { backend: 'sqlite', postgres: target.postgres },
  ])('rejects unsafe or contradictory targets without modifying configuration', async candidate => {
    const path = await directory();
    const current = await readFeedbackStorageConfig(path);
    await expect(saveFeedbackStorageCandidate(path, current.generation, candidate as typeof target)).rejects.toThrow();
    expect(await readFeedbackStorageConfig(path)).toEqual(current);
  });
  it('stores immutable credentials privately and supports environment references', async () => {
    const path = await directory();
    const reference = await putFeedbackStorageSecret(path, 'private-test-password');
    expect(reference).not.toContain('private-test-password');
    expect(await readFeedbackStorageSecret(path, reference)).toBe('private-test-password');
    const secretPath = join(path, 'feedback-storage-secrets', reference.slice('file:'.length));
    expect((await stat(secretPath)).mode & 0o777).toBe(0o600);
    await expect(readFeedbackStorageSecret(path, 'env:BOTMUX_TEST_PG_PASSWORD')).rejects.toThrow('feedback_storage_secret_missing');
    process.env.BOTMUX_TEST_PG_PASSWORD = 'environment-password';
    expect(await readFeedbackStorageSecret(path, 'env:BOTMUX_TEST_PG_PASSWORD')).toBe('environment-password');
    await expect(readFeedbackStorageSecret(path, 'file:../../outside')).rejects.toThrow();
    await readFeedbackStorageConfig(path);
    expect(await readFile(join(path, 'feedback-storage.json'), 'utf8')).not.toContain('private-test-password');
  });
});
