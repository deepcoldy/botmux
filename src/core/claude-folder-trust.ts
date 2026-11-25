import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

type ClaudeState = Record<string, any>;

/** Claude takes a mkdir lock next to its state file. The entire read/modify/
 * write must hold that same lock. Separate symlink leaves can name one file
 * but use different locks, so leave those updates to Claude itself. */
export function updateClaudeStateFile(
  stateJsonPath: string, update: (current: ClaudeState | undefined) => ClaudeState | undefined,
): 'locked' | void {
  const lock = stateJsonPath + '.lock';
  try {
    try {
      mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'locked';
      throw error;
    }
    try {
      const stat = lstatSync(stateJsonPath, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) return;
      const current = stat ? JSON.parse(readFileSync(stateJsonPath, 'utf8')) : undefined;
      if (stat && (!current || typeof current !== 'object' || Array.isArray(current))) return;
      const next = update(current);
      if (next) atomicWriteFileSync(stateJsonPath, JSON.stringify(next, null, 2), {
        mode: stat ? stat.mode & 0o777 : 0o600, followTargetSymlink: false,
      });
    } finally {
      rmdirSync(lock);
    }
  } catch (error) {
    logger.debug(`[claude-trust] state update skipped: ${error}`);
  }
}

/** Only add a missing project decision. Claude identifies projects by real cwd. */
export function ensureClaudeFolderTrust(workingDir: string, stateJsonPath = join(homedir(), '.claude.json')): 'locked' | void {
  let canonical: string;
  try { canonical = realpathSync(workingDir); } catch { return; }
  return updateClaudeStateFile(stateJsonPath, (data = {}) => {
    if (data.projects === undefined) data.projects = {};
    if (!data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) return;
    const entry = data.projects[canonical] ?? {};
    if (typeof entry !== 'object' || Array.isArray(entry) || 'hasTrustDialogAccepted' in entry) return;
    data.projects[canonical] = { ...entry, hasTrustDialogAccepted: true };
    return data;
  });
}

/** Cold workflow nodes may start together against one profile. Yield briefly
 * to a competing writer; a longer-lived lock leaves the CLI in charge. */
export async function prepareWorkflowClaudeTrust(workingDir: string, stateJsonPath: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 6 && !signal?.aborted; attempt++) {
    if (ensureClaudeFolderTrust(workingDir, stateJsonPath) !== 'locked') return;
    if (attempt < 5) await delay(25);
  }
}
