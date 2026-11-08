// Runtime probe against the BUILT dist: default SQLite storage must fully work
// (open + real write + readback + status) when `pg` cannot be resolved.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = process.env.BOTMUX_DIST_DIR;
if (!dist) throw new Error('BOTMUX_DIST_DIR required');

// Import the dashboard storage API too, so the probe covers its whole static
// graph (it used to pull in pg via the migration runner).
await import(join(dist, 'dashboard', 'feedback-storage-api.js'));

const dir = await mkdtemp(join(tmpdir(), 'feedback-pg-optional-'));
try {
  const { getFeedbackStorage } = await import(join(dist, 'services', 'feedback-storage.js'));
  const storage = await getFeedbackStorage(dir);
  await storage.store.recordTurnDelivery({
    botAppId: 'app', sessionId: 'session', turnId: 'turn-1', nativeSessionId: 'ns', dispatchAttempt: 0,
    platform: 'lark', platformAppId: 'app', platformMessageId: 'om-1', content: 'answer',
    cardMode: 'card', status: 'delivered',
  });
  const payload = await storage.store.recordTurnTerminal({
    botAppId: 'app', sessionId: 'session', turnId: 'turn-1', status: 'completed',
  });
  if (!payload || payload.deliveryId === undefined) throw new Error('terminal did not reconcile (write lost)');
  const events = await storage.store.listTurnCompletionEvents();
  if (events.length !== 1) throw new Error(`expected 1 completion event, got ${events.length}`);

  const { feedbackStorageStatus } = await import(join(dist, 'services', 'feedback-storage-management.js'));
  const status = await feedbackStorageStatus(dir);
  if (status.active.backend !== 'sqlite') throw new Error(`expected sqlite backend, got ${status.active.backend}`);

  console.log('dist sqlite hot path reads and writes without pg');
} finally {
  await rm(dir, { recursive: true, force: true });
}
