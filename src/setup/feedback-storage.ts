import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readFeedbackStorageConfig } from '../services/feedback-storage-config.js';
import { configureFeedbackStorageFile, initializeFeedbackStorage } from '../services/feedback-storage-management.js';
import { t } from '../i18n/index.js';

export async function configureFeedbackStorage(dataDir: string): Promise<void> {
  if (process.env.BOTMUX_FEEDBACK_CONFIG_FILE) {
    const config = await configureFeedbackStorageFile(dataDir, process.env.BOTMUX_FEEDBACK_CONFIG_FILE);
    if (config.candidate) await initializeFeedbackStorage(dataDir, config.generation);
    return;
  }
  if (existsSync(join(dataDir, 'feedback-storage.json')) || existsSync(join(dataDir, 'botmux-feedback.sqlite'))) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const choice = (await prompt.question(t('feedback.storage.choose'))).trim().toLowerCase();
    if (choice && choice !== 'sqlite' && choice !== 'postgresql') throw new Error('feedback_storage_target_invalid');
    if (choice === 'postgresql') {
      const file = (await prompt.question(t('feedback.storage.configPath'))).trim();
      const config = await configureFeedbackStorageFile(dataDir, file);
      await initializeFeedbackStorage(dataDir, config.generation);
    } else await readFeedbackStorageConfig(dataDir);
  } finally { prompt.close(); }
}
