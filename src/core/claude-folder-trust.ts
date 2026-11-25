import { mkdirSync, readFileSync, realpathSync, rmdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

/** Set a missing project decision under the same mkdir lock that Claude uses
 * for its .claude.json. A competing writer owns both its lock and its data. */
export function ensureClaudeFolderTrust(workingDir: string, stateJsonPath = join(homedir(), '.claude.json')): 'locked' | void {
  const lock = stateJsonPath + '.lock';
  try {
    const canonical = realpathSync(workingDir);
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'locked';
      throw error;
    }
    try {
      const stat = statSync(stateJsonPath, { throwIfNoEntry: false });
      const data = stat ? JSON.parse(readFileSync(stateJsonPath, 'utf8')) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      if (data.projects === undefined) data.projects = {};
      if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) return;
      const entry = data.projects[canonical] ?? {};
      if (typeof entry !== 'object' || Array.isArray(entry) || 'hasTrustDialogAccepted' in entry) return;
      data.projects[canonical] = { ...entry, hasTrustDialogAccepted: true };
      atomicWriteFileSync(stateJsonPath, JSON.stringify(data, null, 2), { mode: stat ? stat.mode & 0o777 : 0o600 });
      logger.info(`[claude-trust] Pre-accepted folder trust for ${canonical}`);
    } finally {
      rmdirSync(lock);
    }
  } catch (error) {
    logger.debug(`[claude-trust] seed failed (ignored): ${error}`);
  }
}

/** Cold workflow nodes may start together against one profile. Yield briefly
 * to a competing writer; a longer-lived lock leaves the CLI in charge. */
export async function prepareWorkflowClaudeTrust(workingDir: string, stateJsonPath: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 6 && !signal?.aborted; attempt++) {
    if (ensureClaudeFolderTrust(workingDir, stateJsonPath) !== 'locked') return;
    if (attempt < 5) await delay(25);
  }
}
