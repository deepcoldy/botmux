import { createHash } from 'node:crypto';

/** Node-only sibling of the browser-safe session-title-content helpers. */
export function titleBootstrapDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
