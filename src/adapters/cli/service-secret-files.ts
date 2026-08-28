import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

/** Resolve exact service-credential files for read-only sandbox exposure.
 * Missing paths, symlink leaves, and non-regular files fail closed. */
export function resolveServiceSecretReadonlyFiles(
  paths: readonly string[],
  homeDir = homedir(),
): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    const path = raw.replace(/^~(?=\/|$)/, homeDir);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(path);
    } catch {
      throw new Error('[sandbox] a required service credential file is unavailable');
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('[sandbox] every service credential path must be an exact regular file');
    }
    try {
      out.push(realpathSync(path));
    } catch {
      throw new Error('[sandbox] a required service credential file is unavailable');
    }
  }
  return out;
}
