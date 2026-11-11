import { join } from 'node:path';

/** Host-only project authority, not model-readable project metadata. Keep the
 * whole directories masked, including files created after a worker launches.
 * Callers supply the daemon-frozen data directory and preserve lexical paths
 * when creating credential-only masks (never resolve an agent-made symlink). */
export function projectAuthorityPaths(dataDir: string): [string, string, string] {
  return [
    join(dataDir, '.dashboard-secret.project-attachments'),
    join(dataDir, '.dashboard-secret.project-source-grants'),
    join(dataDir, '.dashboard-secret.project-imports'),
  ];
}
