/**
 * Where an older Dashboard recorded the WeCom gateways it spawned itself
 * (`dashboard-jobs/<configId>.json`). Kept apart from the migration that reads
 * them (legacy-gateway-migration.ts) so the CLI can ask "is there anything to
 * migrate?" — one existence check — without loading the migration.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { wecomRoot } from '../../im/wecom/config/discovery.js';

export function legacyDashboardJobsDir(root: string = wecomRoot()): string {
  return join(root, 'dashboard-jobs');
}

export function hasLegacyDashboardJobs(root: string = wecomRoot(), exists: (path: string) => boolean = existsSync): boolean {
  return exists(legacyDashboardJobsDir(root));
}
