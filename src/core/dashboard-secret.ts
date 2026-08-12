/** Single source for the machine-local dashboard/daemon HMAC key path. */

import { join } from 'node:path';
import { resolveCredentialsDir } from './credentials-dir.js';

export function dashboardSecretPath(homeDir?: string): string {
  return join(resolveCredentialsDir({ homeDir }), '.dashboard-secret');
}
