/**
 * Groups created by `/group` (`/g`) with a bound working directory on this machine,
 * keyed by chat id.
 *
 * Shared by every bot daemon (one file, not per bot): a group's default working
 * directory must apply to whichever local bot in that group starts a session,
 * and per-bot `bots.json` entries are start-time snapshots in other daemons.
 * Read fresh on every lookup; writes are serialized with a file lock.
 */
import { join } from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';

export interface CreatedGroup {
  chatId: string;
  creatorAppId: string;
  ownerOpenId: string;
  /** Absolute directory every new session in this group starts in. */
  workingDir?: string;
  repository?: string;
  branch?: string;
  createdAt: string;
}

type CreatedGroups = Record<string, CreatedGroup>;

const filePath = (): string => join(config.session.dataDir, 'created-groups.json');

function readAll(): CreatedGroups {
  return readJsonFileSoft<CreatedGroups>(filePath(), {
    label: 'created-groups-store',
    fallback: () => ({}),
    validate: (raw): raw is CreatedGroups => isJsonObject(raw),
  });
}

export function recordCreatedGroup(group: Omit<CreatedGroup, 'createdAt'>): void {
  const path = filePath();
  withFileLockSync(path, () => {
    const next: CreatedGroups = { ...readAll(), [group.chatId]: { ...group, createdAt: new Date().toISOString() } };
    atomicWriteFileSync(path, JSON.stringify(next, null, 2));
  });
}

export function getCreatedGroup(chatId: string): CreatedGroup | undefined {
  const entry = readAll()[chatId];
  return entry && entry.chatId === chatId ? entry : undefined;
}

/** Preserve the binding when its directory disappears; normal missing-directory recovery must handle it. */
export function createdGroupWorkingDir(chatId: string): string | undefined {
  return getCreatedGroup(chatId)?.workingDir;
}
