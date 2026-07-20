import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

function systemPsBin(): string | undefined {
  for (const candidate of ['/usr/bin/ps', '/bin/ps']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Stable process-birth identity used by supervisor mutation authority. */
export function readSupervisorProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (process.platform === 'linux') {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      if (closeParen >= 0) {
        const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
        if (fields[19]) return fields[19];
      }
    } catch { /* exited or unreadable */ }
    return undefined;
  }
  if (process.platform === 'win32') {
    try {
      const value = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; `
        + 'if ($p) { $p.CreationDate.ToUniversalTime().Ticks }',
      ], {
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return value || undefined;
    } catch { return undefined; }
  }
  const ps = systemPsBin();
  if (!ps) return undefined;
  try {
    const value = execFileSync(ps, ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    }).trim();
    return value || undefined;
  } catch { return undefined; }
}
