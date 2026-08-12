/** Single source for the machine-local dashboard/daemon HMAC key path. */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function dashboardSecretPath(homeDir = homedir()): string {
  return join(homeDir, '.botmux', '.dashboard-secret');
}
