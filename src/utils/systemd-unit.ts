import { readFileSync } from 'node:fs';

/**
 * Read a process's systemd unit: the leaf of its `name=systemd` cgroup on
 * cgroup v1, or of the unified `0::` entry on v2. Linux only.
 */
export function readProcessSystemdUnit(
  pid: number,
  readFile: (path: string) => string = path => readFileSync(path, 'utf8'),
): string | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let raw: string;
  try { raw = readFile(`/proc/${pid}/cgroup`); } catch { return undefined; }
  const entries = raw.split('\n').map(line => /^(\d+):([^:]*):(.*)$/.exec(line.trim())).filter(m => m !== null);
  const entry = entries.find(m => m![2] === 'name=systemd') ?? entries.find(m => m![1] === '0' && m![2] === '');
  return entry?.[3].split('/').filter(Boolean).pop() || undefined;
}
