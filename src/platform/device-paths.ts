import { join } from 'node:path';

/** Dedicated host-authority subtree. Linux credential-only isolation masks this
 * directory wholesale, so refresh/enrollment may create arbitrary future
 * atomic sidecars without freezing unrelated BOTMUX_HOME state. */
export const DEVICE_AUTHORITY_DIRECTORY = 'device-auth';
export const DEVICE_CREDENTIAL_FILE = 'device.json';
export const DEVICE_ENROLLMENT_JOURNAL_FILE = 'device-enroll-pending.json';

export function deviceAuthorityDirectory(botmuxHome: string): string {
  return join(botmuxHome, DEVICE_AUTHORITY_DIRECTORY);
}

export function deviceCredentialFile(botmuxHome: string): string {
  return join(deviceAuthorityDirectory(botmuxHome), DEVICE_CREDENTIAL_FILE);
}
