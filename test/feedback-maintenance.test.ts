import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawnTsScript } from './helpers/ts-runner.js';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import {
  beginFeedbackMaintenance, freezeFeedbackSource, inspectFeedbackMaintenance,
  assertFeedbackAdmission, restoreFeedbackSource, retireFeedbackSource,
  acquireFeedbackSendLease,
} from '../src/services/feedback-maintenance.js';

const directories: string[] = [];
const stores: SkillFeedbackStore[] = [];
afterEach(async () => {
  stores.splice(0).forEach(store => store.close());
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-maintenance-'));
  directories.push(directory);
  const store = await SkillFeedbackStore.open(directory);
  stores.push(store);
  return { directory, store };
}
describe('feedback maintenance', () => {
  it('rejects unknown business tables before freezing known tables', async () => {
    const { directory, store } = await fixture();
    const { openDatabaseSync } = await import('../src/services/sqlite-compat.js');
    const database = await openDatabaseSync(join(directory, 'botmux-feedback.sqlite'));
    database.exec('CREATE TABLE extension_history(value TEXT); INSERT INTO extension_history VALUES(\'keep\')');
    database.close();
    await beginFeedbackMaintenance(directory, 'unknown-table');
    await expect(freezeFeedbackSource(directory, 'unknown-table')).rejects.toThrow('feedback_source_schema_unsupported');
    expect(store.createResponse({ interactionId: 'not-frozen', content: 'safe' })).toHaveProperty('responseId');
  });
  it('rejects reusing a restored migration snapshot identity after accepting new source writes', async () => {
    const { directory, store } = await fixture();
    await beginFeedbackMaintenance(directory, 'old-migration');
    await freezeFeedbackSource(directory, 'old-migration');
    await restoreFeedbackSource(directory, 'old-migration');
    store.createResponse({ interactionId: 'new-source-write', content: 'retain' });
    await beginFeedbackMaintenance(directory, 'old-migration');
    await expect(freezeFeedbackSource(directory, 'old-migration')).rejects.toThrow('feedback_migration_source_restored');
  });
  it('blocks live named daemons that have not acknowledged maintenance', async () => {
    const { directory } = await fixture();
    const { mkdir, writeFile } = await import('node:fs/promises');
    const home = process.env.HOME!;
    await mkdir(join(home, '.botmux'), { recursive: true });
    await writeFile(join(home, '.botmux', 'fleet-state.json'), JSON.stringify({ procs: [{ name: 'botmux-production', pid: process.pid, entry: 'daemon' }] }));
    try {
      await beginFeedbackMaintenance(directory, 'named-daemon');
      expect((await inspectFeedbackMaintenance(directory, 'named-daemon')).blockers).toContain(`unsupported_daemon:${process.pid}`);
    } finally { await rm(join(home, '.botmux', 'fleet-state.json')); }
  });
  it('fences a connection already open in another process', async () => {
    const { directory } = await fixture();
    const child = spawnTsScript('test/helpers/feedback-maintenance-child.ts', [directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    try {
      await once(child, 'message');
      await beginFeedbackMaintenance(directory, 'child-freeze');
      await freezeFeedbackSource(directory, 'child-freeze');
      const result = once(child, 'message');
      child.send('write');
      expect((await result)[0]).toMatchObject({ error: 'feedback_source_frozen' });
    } finally { child.kill(); }
  });
  it('waits for a sending process before freezing', async () => {
    const { directory } = await fixture();
    const finish = acquireFeedbackSendLease(directory);
    await beginFeedbackMaintenance(directory, 'migration-one');
    await expect(freezeFeedbackSource(directory, 'migration-one')).rejects.toThrow('send_in_progress');
    finish();
    await freezeFeedbackSource(directory, 'migration-one');
    expect((await inspectFeedbackMaintenance(directory, 'migration-one')).state).toBe('frozen');
  });
  it('freezes pre-existing SQLite connections and only the original task can restore writes', async () => {
    const { directory, store } = await fixture();
    store.createResponse({ interactionId: 'before', content: 'before' });
    await beginFeedbackMaintenance(directory, 'migration-one');
    expect(() => assertFeedbackAdmission(directory)).toThrow('feedback_storage_maintenance');
    await freezeFeedbackSource(directory, 'migration-one');
    expect(() => store.createResponse({ interactionId: 'after', content: 'after' })).toThrow('feedback_source_frozen');
    await expect(restoreFeedbackSource(directory, 'wrong-task')).rejects.toThrow();
    await restoreFeedbackSource(directory, 'migration-one');
    expect(store.createResponse({ interactionId: 'restored', content: 'after' })).toHaveProperty('responseId');
  });
  it('keeps a retired source read-only and rejects concurrent migration identity', async () => {
    const { directory, store } = await fixture();
    const response = store.createResponse({ interactionId: 'before', content: 'before' });
    await beginFeedbackMaintenance(directory, 'migration-one');
    await expect(beginFeedbackMaintenance(directory, 'migration-two')).rejects.toThrow('feedback_migration_conflict');
    await freezeFeedbackSource(directory, 'migration-one');
    await retireFeedbackSource(directory, 'migration-one');
    await expect(restoreFeedbackSource(directory, 'migration-one')).rejects.toThrow('feedback_source_retired');
    expect(store.getResponse(response.responseId)).toHaveProperty('responseId', response.responseId);
    expect((await inspectFeedbackMaintenance(directory, 'migration-one')).state).toBe('frozen');
  });
});
