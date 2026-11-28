/**
 * Pure path classification shared by backend and Dashboard web UI (zero Node
 * built-in imports so it stays browser-bundle safe).
 *
 * Detects paths inside a versioned CLI plugin cache such as:
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>
 *
 * Registering these paths as `local-link` is fragile because plugin upgrades or
 * cache pruning remove older version directories.
 */
export function isVersionedPluginCachePath(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'plugins' && parts[i + 1] === 'cache') return true;
  }
  return false;
}
