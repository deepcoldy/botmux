import { existsSync, readlinkSync } from 'node:fs';

export interface Pm2ExecutableProbeRuntime {
  readlink(path: string): string;
  exists(path: string): boolean;
}

/** Fail closed when a live Linux PM2 God is executing a deleted Node binary.
 * Failure to inspect /proc remains non-authoritative and is skipped, but a
 * successful read is evaluated outside that catch so the safety refusal can
 * never be swallowed as an inspection error. */
export function assertLinuxPm2GodExecutableUsable(
  pm2Pid: number,
  runtime: Pm2ExecutableProbeRuntime = {
    readlink: path => readlinkSync(path),
    exists: path => existsSync(path),
  },
): void {
  let executable: string;
  try { executable = runtime.readlink(`/proc/${pm2Pid}/exe`); }
  catch { return; }

  const cleanPath = executable.replace(/ \(deleted\)$/, '');
  if (!executable.endsWith(' (deleted)') && runtime.exists(cleanPath)) return;
  throw new Error(
    `pm2 god daemon (pid ${pm2Pid}) 使用的 Node 二进制已失效: ${cleanPath}; `
    + '为避免强杀未完成 Riff 交接的 daemon，拒绝自动清理，请先人工核对进程归属',
  );
}
