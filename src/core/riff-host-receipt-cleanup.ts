import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LiveReferenceProbe } from '../utils/dir-process-probe.js';

/** Closed/crashed sessions must not retain message bodies and attachments.
 * Active sessions of every bot, fresh directories and live references win over
 * cleanup. The caller skips the round if its cross-bot protection set is unknown. */
export async function sweepOrphanRiffHostReceiptDirs(
  dataDir: string,
  protectedSessionIds: ReadonlySet<string>,
  options: { liveReferences: LiveReferenceProbe; now?: number; graceMs?: number },
): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined) return [];
  const root = join(dataDir, 'sessions');
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? 60_000;
  let names: string[];
  try { names = readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates: Array<{ path: string; inode: number; parentInode: number }> = [];
  for (const name of names) {
    if (protectedSessionIds.has(name)) continue;
    const session = join(root, name), path = join(session, 'riff-host-operations');
    try {
      // sessions/ also holds per-session files (e.g. <id>.env-stamp); only directories can own receipts.
      const parent = lstatSync(session);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid) continue;
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
        || now - stat.mtimeMs <= graceMs) continue;
      candidates.push({ path, inode: stat.ino, parentInode: parent.ino });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  if (!candidates.length) return [];
  const live = await options.liveReferences(candidates.map(c => c.path));
  if (!live) return [];
  const removed: string[] = [];
  for (const candidate of candidates) {
    if (live.has(candidate.path)) continue;
    try {
      const parent = lstatSync(dirname(candidate.path)), stat = lstatSync(candidate.path);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || parent.ino !== candidate.parentInode
        || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid
        || stat.ino !== candidate.inode || now - stat.mtimeMs <= graceMs) continue;
      rmSync(candidate.path, { recursive: true, force: true });
      removed.push(candidate.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  return removed;
}
