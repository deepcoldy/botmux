import { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { logger } from '../utils/logger.js';

type ClaudeState = Record<string, any>;

export interface StateUpdateMeta {
  /** True when the target existed but held no usable JSON object and was
   *  rebuilt from scratch (raw bytes preserved in a `.corrupt.<ts>.bak`
   *  sibling). Lets the seeder force a write even when its own diff is empty. */
  rebuilt: boolean;
}

export interface UpdateClaudeStateOptions {
  /** Opt in to rebuilding an unparseable / non-object target instead of
   *  leaving it untouched. Only the isolated-profile seed path uses this: a
   *  per-bot `.claude.json` stuck as malformed JSON or `projects:null` leaves
   *  Claude on its Configuration error / first-launch theme screen, and the
   *  seed is the only writer that owns that file. The raw bytes are backed up
   *  next to the target first; if the backup cannot be written, the original
   *  is left alone (fail closed). Shared-user state callers must not opt in —
   *  destroying a user's unreadable file is never the generic updater's call. */
  repairCorruptTarget?: boolean;
}

/** Preserve unparseable state bytes before an atomic rebuild. Throws (aborting
 *  the repair) when the backup sibling cannot be exclusively created. The
 *  bytes are written verbatim: decoding them as UTF-8 first would replace
 *  invalid sequences with U+FFFD and make the backup unrecoverable. */
function backupCorruptState(stateJsonPath: string, raw: Buffer): void {
  const backup = `${stateJsonPath}.corrupt.${Date.now()}.bak`;
  writeFileSync(backup, raw, { mode: 0o600, flag: 'wx' });
  logger.debug(`[claude-trust] corrupt state backed up to ${backup}`);
}

/** Claude takes a mkdir lock next to its state file. The entire read/modify/
 * write must hold that same lock. Separate symlink leaves can name one file
 * but use different locks, so leave those updates to Claude itself. */
export function updateClaudeStateFile(
  stateJsonPath: string,
  update: (current: ClaudeState | undefined, meta: StateUpdateMeta) => ClaudeState | undefined,
  options: UpdateClaudeStateOptions = {},
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
      let current: ClaudeState | undefined;
      let rebuilt = false;
      if (stat) {
        // Keep the raw Buffer for the backup and decode only for parsing:
        // readFileSync(..., 'utf8') silently substitutes U+FFFD for invalid
        // UTF-8, so a string backup could not restore the original bytes.
        const raw = readFileSync(stateJsonPath);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch (error) {
          if (!options.repairCorruptTarget) {
            logger.debug(`[claude-trust] state update skipped: ${error}`);
            return;
          }
          backupCorruptState(stateJsonPath, raw);
          rebuilt = true;
        }
        if (!rebuilt && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
          if (!options.repairCorruptTarget) return;
          backupCorruptState(stateJsonPath, raw);
          rebuilt = true;
        }
        if (!rebuilt) current = parsed as ClaudeState;
      }
      const next = update(current, { rebuilt });
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
