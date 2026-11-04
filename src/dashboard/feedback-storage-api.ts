import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import { feedbackStorageStatus, feedbackStorageView, configureFeedbackStorageCandidate, testFeedbackStorageConnection, initializeFeedbackStorage } from '../services/feedback-storage-management.js';
import { getFeedbackMigration, prepareFeedbackMigration, resumeFeedbackMigration, cancelFeedbackMigration } from '../services/feedback-migration.js';
import { inspectFeedbackRecovery, acknowledgeFeedbackRecovery } from '../services/feedback-recovery.js';

const running = new Map<string, Promise<unknown>>();
function execute(dataDir: string, migrationId: string): void {
  const key = `${dataDir}:${migrationId}`;
  if (running.has(key)) return;
  const work = resumeFeedbackMigration(dataDir, migrationId).finally(() => running.delete(key));
  running.set(key, work);
  void work.catch(() => {});
}
export async function handleFeedbackStorageApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  dataDir: string; isHostAdmin: boolean; csrfValid: boolean;
}): Promise<boolean> {
  if (!url.pathname.startsWith('/api/feedback/storage')) return false;
  if (!deps.isHostAdmin) { jsonRes(res, 403, { error: 'feedback_storage_admin_required' }); return true; }
  if (req.method !== 'GET' && !deps.csrfValid) { jsonRes(res, 403, { error: 'control_csrf_invalid' }); return true; }
  try {
    const migration = url.pathname.match(/^\/api\/feedback\/storage\/migrations\/([a-zA-Z0-9_-]+)(\/resume|\/cancel)?$/);
    if (req.method === 'GET') {
      if (url.pathname === '/api/feedback/storage') jsonRes(res, 200, await feedbackStorageStatus(deps.dataDir));
      else if (url.pathname === '/api/feedback/storage/recovery') jsonRes(res, 200, { items: await inspectFeedbackRecovery(deps.dataDir) });
      else if (migration && !migration[2]) {
        const job = await getFeedbackMigration(deps.dataDir, migration[1]);
        jsonRes(res, 200, { migrationId: job.migrationId, phase: job.phase, blockers: job.blockers });
      } else jsonRes(res, 404, { error: 'not_found' });
      return true;
    }
    if (req.method !== 'POST') { jsonRes(res, 405, { error: 'method_not_allowed' }); return true; }
    let raw = '';
    for await (const chunk of req) {
      raw += String(chunk);
      if (Buffer.byteLength(raw) > 65536) throw new Error('feedback_storage_request_too_large');
    }
    const body = raw ? JSON.parse(raw) : {};
    switch (url.pathname) {
      case '/api/feedback/storage/recovery/acknowledge':
        await acknowledgeFeedbackRecovery(deps.dataDir, { ...body, actor: 'dashboard:host-admin' });
        jsonRes(res, 200, { acknowledged: true }); break;
      case '/api/feedback/storage/configure':
        jsonRes(res, 200, feedbackStorageView(await configureFeedbackStorageCandidate(deps.dataDir, body))); break;
      case '/api/feedback/storage/test':
        jsonRes(res, 200, await testFeedbackStorageConnection(deps.dataDir)); break;
      case '/api/feedback/storage/enable-empty':
        if (body.confirmed !== true) throw new Error('feedback_storage_confirmation_required');
        jsonRes(res, 200, feedbackStorageView(await initializeFeedbackStorage(deps.dataDir, body.expectedGeneration))); break;
      case '/api/feedback/storage/migrate': {
        const job = await prepareFeedbackMigration(deps.dataDir, body);
        execute(deps.dataDir, job.migrationId);
        jsonRes(res, 202, { migrationId: job.migrationId, phase: job.phase, blockers: job.blockers }); break;
      }
      default:
        if (migration?.[2] === '/cancel') {
          const job = await cancelFeedbackMigration(deps.dataDir, migration[1], { ...body, actor: 'dashboard:host-admin' });
          jsonRes(res, 200, { migrationId: job.migrationId, phase: job.phase, blockers: job.blockers });
        } else if (migration?.[2] === '/resume') {
          const job = await getFeedbackMigration(deps.dataDir, migration[1]);
          execute(deps.dataDir, job.migrationId);
          jsonRes(res, 202, { migrationId: job.migrationId, phase: job.phase });
        } else jsonRes(res, 404, { error: 'not_found' });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    jsonRes(res, message.includes('conflict') || message === 'feedback_migration_busy_retry' ? 409 : 400, { error: /^feedback_[a-z_]+$/.test(message) ? message : 'feedback_storage_operation_failed' });
  }
  return true;
}
