import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

export async function assertFeedbackMigrationSlotAvailable(dataDir: string, except?: string): Promise<void> {
  const root = await realpath(dataDir);
  for (const name of ['feedback-migrations', 'feedback-supabase-migrations']) {
    const directory = join(root, name);
    let files: string[];
    try {
      if (await realpath(directory) !== directory) throw new Error('feedback_migration_directory_invalid');
      files = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const file of files.filter(value => value.endsWith('.json'))) {
      const handle = await open(join(directory, file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error('feedback_migration_state_invalid');
        const job = JSON.parse(await handle.readFile('utf8'));
        if (job.migrationId !== file.slice(0, -5) || typeof job.phase !== 'string') throw new Error('feedback_migration_state_invalid');
        if (job.migrationId !== except && !['complete', 'cancelled'].includes(job.phase)) throw new Error('feedback_migration_conflict');
      } finally { await handle.close(); }
    }
  }
}
