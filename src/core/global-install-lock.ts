import { join } from 'node:path';

/**
 * Shared lock filename for every process that updates the global installation or
 * rewrites its launcher. Keep the historical name so old/new daemon-dashboard
 * processes still serialize correctly during a rolling upgrade.
 *
 * This lightweight module is also importable from the Bun-run `use:here` script;
 * keep heavier config/maintenance dependencies out of it.
 */
export function globalInstallUpdateLockTargetIn(dataDir: string): string {
  return join(dataDir, 'npm-global-update');
}
