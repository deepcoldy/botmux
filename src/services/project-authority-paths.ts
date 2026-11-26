import { join } from 'node:path';
import { crossChatFollowThreadDir } from './cross-chat-follow-thread-store.js';

export const dispatchTaskDecisionDirectory = (dataDir: string) => join(dataDir, '.dashboard-secret.dispatch-task-decisions');

/** Host-only task and project authority, not model-readable project metadata. Keep the
 * whole directories masked, including files created after a worker launches.
 * Callers supply the daemon-frozen data directory and preserve lexical paths
 * when creating credential-only masks (never resolve an agent-made symlink). */
export function hostAuthorityPaths(dataDir: string): string[] {
  return [
    join(dataDir, '.dashboard-secret.project-attachments'),
    join(dataDir, '.dashboard-secret.project-source-grants'),
    join(dataDir, '.dashboard-secret.project-imports'),
    dispatchTaskDecisionDirectory(dataDir),
    crossChatFollowThreadDir(dataDir),
    join(dataDir, 'session-turns'),
  ];
}
