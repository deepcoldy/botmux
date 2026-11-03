import { Client } from 'pg';
import { resumeFeedbackMigration } from '../../src/services/feedback-migration.js';

const query = Client.prototype.query;
let importing = false;
Client.prototype.query = function (...args: any[]) {
  const result = (query as any).apply(this, args);
  if (typeof args[0] === 'string' && args[0].startsWith('UPDATE feedback_storage_meta SET source_fingerprint=')) importing = true;
  if (typeof args[0] === 'string' && (process.argv[4] === 'import'
    ? importing && args[0] === 'COMMIT'
    : args[0].startsWith("UPDATE feedback_storage_meta SET state='active'"))) {
    return Promise.resolve(result).then(value => {
      process.kill(process.pid, 'SIGKILL');
      return value;
    });
  }
  return result;
} as any;
await resumeFeedbackMigration(process.argv[2], process.argv[3]);
