/**
 * Whether this host's Dashboard has a usable Feishu H5 passwordless login —
 * the one fact a card builder needs to choose the「工作流 ›」link (design
 * 2026-11-03 §11.2, 15.5):
 *   - with H5 login, the Feishu sidebar AppLink: the sidebar is its own browser
 *     context, and H5 login is what lets a person in it sign in;
 *   - without it, the sidebar can only ever land on a login page, so the entry
 *     opens the Dashboard's run page in the browser instead (like the progress
 *     card's「Web 详情」), where an admin's existing login applies.
 *
 * The H5 configuration itself lives only in the Dashboard process (daemons and
 * session CLIs strip the whole `BOTMUX_DASHBOARD_FEISHU_H5_*` family because it
 * carries the H5 app secret). So the Dashboard publishes this single boolean
 * next to `.dashboard-port` when it starts; readers treat a missing or
 * unreadable file as "no H5 login" — the browser link, which works for admins.
 */

import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFileSync } from '../utils/atomic-write.js';

export function dashboardH5PresencePath(home: string = homedir()): string {
  return join(home, '.botmux', '.dashboard-h5-login');
}

/** Dashboard boot: record whether H5 login is usable (removes the marker otherwise). */
export function publishDashboardH5Presence(usable: boolean, path: string = dashboardH5PresencePath()): void {
  if (usable) atomicWriteFileSync(path, '1\n');
  else rmSync(path, { force: true });
}

export function dashboardH5LoginAvailable(path: string = dashboardH5PresencePath()): boolean {
  try {
    return readFileSync(path, 'utf8').trim() === '1';
  } catch {
    return false;
  }
}
