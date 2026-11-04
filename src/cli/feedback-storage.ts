import { feedbackStorageStatus, feedbackStorageView, configureFeedbackStorageFile, initializeFeedbackStorage, testFeedbackStorageConnection } from '../services/feedback-storage-management.js';
import { readFeedbackStorageConfig } from '../services/feedback-storage-config.js';
import { startFeedbackMigration, resumeFeedbackMigration, cancelFeedbackMigration } from '../services/feedback-migration.js';
import { inspectFeedbackRecovery, acknowledgeFeedbackRecovery } from '../services/feedback-recovery.js';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';

export async function runFeedbackStorageCommand(args: string[], io: {
  input: NodeJS.ReadableStream; output: NodeJS.WritableStream; error: NodeJS.WritableStream;
}, dataDir: string): Promise<number> {
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    if (args.some(value => value === '--password' || value.startsWith('--password=') || value === '--token' || value.startsWith('--token='))) throw new Error('feedback_storage_use_secret_reference');
    let result: unknown;
    switch (args[0] ?? 'status') {
      case 'cancel': {
        if (!args[1]) throw new Error('feedback_migration_id_required');
        const job = await cancelFeedbackMigration(dataDir, args[1], {
          confirmed: args.includes('--yes') as true, actor: `local:${userInfo().username}`,
          reason: option('--reason') ?? '', evidence: option('--evidence') ?? '',
        });
        result = { migrationId: job.migrationId, phase: job.phase, blockers: job.blockers };
        break;
      }
      case 'recovery': {
        if (args[1] === 'acknowledge') {
          const kind = option('--kind');
          if (kind !== 'send' && kind !== 'webhook') throw new Error('feedback_recovery_kind_invalid');
          await acknowledgeFeedbackRecovery(dataDir, {
            kind, id: option('--id') ?? '', fingerprint: option('--fingerprint') ?? '',
            confirmed: args.includes('--yes') as true, actor: `local:${userInfo().username}`,
            reason: option('--reason') ?? '', evidence: option('--evidence') ?? '',
          });
          result = { acknowledged: true };
        } else if (!args[1] || args[1] === 'list') result = { items: await inspectFeedbackRecovery(dataDir) };
        else throw new Error('feedback_storage_unknown_command');
        break;
      }
      case 'status': result = await feedbackStorageStatus(dataDir); break;
      case 'configure': {
        const file = option('--config-file');
        if (!file) throw new Error('feedback_storage_config_file_required');
        const config = await configureFeedbackStorageFile(dataDir, file);
        result = feedbackStorageView(config);
        break;
      }
      case 'test': result = await testFeedbackStorageConnection(dataDir); break;
      case 'enable-empty': {
        if (!args.includes('--yes')) throw new Error('feedback_storage_confirmation_required');
        const config = await readFeedbackStorageConfig(dataDir);
        result = feedbackStorageView(await initializeFeedbackStorage(dataDir, config.generation));
        break;
      }
      case 'migrate': {
        if (!args.includes('--yes')) throw new Error('feedback_maintenance_confirmation_required');
        if (option('--to') !== 'postgresql') throw new Error('feedback_migration_target_required');
        const config = await readFeedbackStorageConfig(dataDir);
        const job = await startFeedbackMigration(dataDir, { requestId: option('--request-id') ?? randomUUID(), expectedGeneration: config.generation, maintenanceConfirmed: true });
        result = { migrationId: job.migrationId, phase: job.phase, blockers: job.blockers };
        io.output.write(JSON.stringify(result) + '\n');
        return job.phase === 'complete' ? 0 : 1;
      }
      case 'resume': {
        if (!args[1]) throw new Error('feedback_migration_id_required');
        const job = await resumeFeedbackMigration(dataDir, args[1]);
        result = { migrationId: job.migrationId, phase: job.phase, blockers: job.blockers };
        io.output.write(JSON.stringify(result) + '\n');
        return job.phase === 'complete' ? 0 : 1;
      }
      default: throw new Error('feedback_storage_unknown_command');
    }
    io.output.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    io.error.write(JSON.stringify({ error: /^feedback_[a-z_]+$/.test(message) ? message : 'feedback_storage_operation_failed' }) + '\n');
    return 1;
  }
}
