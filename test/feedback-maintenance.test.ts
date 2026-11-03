import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import {
  beginFeedbackMaintenance, freezeFeedbackSource, inspectFeedbackMaintenance,
  assertFeedbackAdmission, restoreFeedbackSource, retireFeedbackSource,
  withFeedbackSendLease,
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
  it('waits for a sending process before freezing', async () => {
    const { directory } = await fixture();
    let finish!: () => void;
    const sending = withFeedbackSendLease(directory, () => new Promise<void>(resolve => { finish = resolve; }));
    await beginFeedbackMaintenance(directory, 'migration-one');
    await expect(freezeFeedbackSource(directory, 'migration-one')).rejects.toThrow('send_in_progress');
    finish();
    await sending;
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
