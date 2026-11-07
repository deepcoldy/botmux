import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { botmuxHome, pluginRegistryPath } from './paths.js';
const schema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  packageName: z.string().min(1),
  version: z.string().min(1),
  expectedState: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  integrity: z.string().optional(),
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type PluginMutationGuard = z.infer<typeof schema>;
export function parsePluginMutationGuard(raw: string | undefined): PluginMutationGuard | undefined {
  return raw === undefined ? undefined : schema.parse(JSON.parse(raw));
}
export function pluginRecordHash(record: unknown): string | null {
  return record == null ? null : createHash('sha256').update(JSON.stringify(record)).digest('hex');
}
/**
 * Registry revision digest from the persisted monotonic counter. A stat digest
 * (dev/inode/size/mtime/ctime) is forgeable by ordinary operation on ext4:
 * atomic rewrites reuse the freed inode, and equal-size rewrites inside one
 * timestamp tick produce the identical tuple, so install/uninstall A→B→A was
 * indistinguishable from the original empty slot. The on-disk counter is bumped
 * on every rewrite by the registry store and cannot return to a past value.
 */
export function pluginRegistryRevision(): string {
  let revision = 0;
  try {
    const raw = JSON.parse(readFileSync(pluginRegistryPath(), 'utf8')) as { revision?: unknown };
    if (typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision > 0) {
      revision = raw.revision;
    }
  } catch (error) {
    // ENOENT (never written) and an unreadable/corrupt file both read as
    // revision 0 — the same fail-operational rule readPluginRegistry() uses.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return createHash('sha256').update(`plugin-registry-revision:${revision}`).digest('hex');
}
export function assertPluginMutationGuard(
  guard: PluginMutationGuard,
  current: unknown,
  target?: { id: string; packageName: string; version: string },
): void {
  if (guard.authorityDigest) {
    const token = readFileSync(join(botmuxHome(), '.dashboard-token'), 'utf8').trim();
    if (createHash('sha256').update(token).digest('hex') !== guard.authorityDigest) throw new Error('plugin_authority_revoked');
  }
  if (guard.expectedRevision && pluginRegistryRevision() !== guard.expectedRevision) throw new Error('plugin_registry_confirmation_superseded');
  if (pluginRecordHash(current) !== guard.expectedState) throw new Error('plugin_confirmation_superseded');
  if (target && (target.id !== guard.id || target.packageName !== guard.packageName || target.version !== guard.version)) {
    throw new Error('plugin_confirmed_manifest_mismatch');
  }
}
