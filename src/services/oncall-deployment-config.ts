import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { readSecureHostFileSync } from '../platform/secure-host-file.js';

/** Read at the start of each Oncall operation, so all host processes use saved
 * settings without restarting or copying credentials into worker environments. */
export function readOncallDeploymentEnv(
  envFile = join(homedir(), '.botmux', '.env'), env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const saved = parse(readSecureHostFileSync(envFile) ?? '');
  return Object.fromEntries(['ONCALL_GROUP_ENDPOINT', 'ONCALL_EMAIL_DOMAIN', 'ONCALL_SERVICE_SECRET']
    .map(key => [key, saved[key] ?? env[key]]));
}
