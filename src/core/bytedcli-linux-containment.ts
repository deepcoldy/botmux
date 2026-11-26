import { readFileSync, readlinkSync, statSync, realpathSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { readProcessStartIdentity } from './session-marker.js';
import type { BytedcliContainmentReport, BytedcliWorkerContainment } from './bytedcli-broker-containment.js';

const covers = (root: string, path: string) => path === root || path.startsWith(root + '/');
function canonical(path: string): string {
  const suffix: string[] = [];
  while (!existsSync(path) && dirname(path) !== path) { suffix.unshift(basename(path)); path = dirname(path); }
  return join(realpathSync(path), ...suffix);
}
/** Read only kernel metadata, never credential contents. A distinct namespace
 * alone is insufficient: the actual root must be an allowlist tmpfs and every
 * protected subtree must resolve to a read-only mount with no deeper reopen. */
export function observeBytedcliLinuxContainment(cliPid: number, contract: BytedcliWorkerContainment):
  Pick<BytedcliContainmentReport, 'pidNamespace' | 'hostPidNamespace' | 'cliProcStart'> | undefined {
  if (process.platform !== 'linux' || !Number.isSafeInteger(cliPid) || cliPid <= 0) return undefined;
  try {
    const before = readProcessStartIdentity(cliPid);
    if (!before) return undefined;
    const hostPidNamespace = readlinkSync('/proc/self/ns/pid');
    const pidNamespace = readlinkSync(`/proc/${cliPid}/ns/pid`);
    if (hostPidNamespace === pidNamespace) return undefined;
    const mounts = readFileSync(`/proc/${cliPid}/mountinfo`, 'utf8').trim().split('\n').map(line => {
      const [left, right] = line.split(' - ');
      const fields = left!.split(' ');
      return { path: fields[4]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))),
        ro: fields[5]!.split(',').includes('ro'), filesystem: right?.split(' ')[0] };
    });
    if (mounts.find(mount => mount.path === '/')?.filesystem !== 'tmpfs') return undefined;
    const privateScaffold = (mount: typeof mounts[number]): boolean => {
      if (mount.filesystem !== 'tmpfs') return false;
      const child = statSync(`/proc/${cliPid}/root${mount.path}`);
      try {
        const host = statSync(mount.path);
        return host.dev !== child.dev || host.ino !== child.ino;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return true;
      }
    };
    for (const [roots, denied] of [[contract.credentialRoots, true], [contract.executableReadOnlyRoots, false]] as const) {
      for (const raw of roots) {
        const path = canonical(raw);
        const covering = mounts.filter(mount => mount.path === '/' || covers(mount.path, path))
          .sort((a, b) => b.path.length - a.path.length)[0];
        if (!covering) return undefined;
        // A writable host ancestor permits rename + replacement of the trusted
        // pathname even though the current leaf bind itself is read-only.
        if (mounts.some(mount => (mount.path === '/' || covers(mount.path, path)) && !mount.ro && !privateScaffold(mount))
          || mounts.some(mount => covers(path, mount.path) && !mount.ro)) return undefined;
        if (denied) {
          // A credential masked with a read-only bind of itself still leaks.
          try {
            const host = statSync(path), child = statSync(`/proc/${cliPid}/root${path}`);
            if (host.dev === child.dev && host.ino === child.ino) return undefined;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EACCES') return undefined;
          }
          // A deeper RO bind can reopen credentials too. Only the root mask is permitted.
          if (mounts.some(mount => mount.path !== path && covers(path, mount.path))) return undefined;
        }
      }
    }
    if (before !== readProcessStartIdentity(cliPid)) return undefined;
    return { hostPidNamespace, pidNamespace, cliProcStart: before };
  } catch { return undefined; }
}

export function assertBytedcliLaunchSupported(input: {
  platform: string; backendType: string; cliId: string; sandbox: string;
  adopt?: boolean; reattach?: boolean; wrapperCli?: string; sharedAuthentication?: boolean;
  loopbackShared?: boolean; identityModel?: string; hostMcpEntries?: number; rpc?: boolean; externalAppServer?: string; launchMode?: string;
}): void {
  if (input.platform !== 'linux' || !['pty', 'tmux'].includes(input.backendType)
    || !['claude-code', 'codex'].includes(input.cliId) || input.sandbox !== 'oncall'
    || input.adopt || input.reattach || input.wrapperCli || input.sharedAuthentication || input.rpc || input.externalAppServer || input.launchMode
    || input.loopbackShared === false || input.identityModel && input.identityModel !== 'proven'
    || (input.hostMcpEntries ?? 0) > 0) {
    throw new Error('ByteCloud broker requires a cold Linux PTY/Tmux allowlist launch with private model authentication, proven identity and host loopback; host MCP downstreams are unsupported');
  }
}

/** Worker producer. Called after the real CLI leaf is discovered, and only a
 * freshly prepared strict sandbox in this exact CLI generation can report. */
export function createBytedcliContainmentReport(input: {
  sessionId: string; contract: BytedcliWorkerContainment; cliPid: number; cliProcStart: string;
  cliSpawnGeneration: number; coldSandboxGeneration?: number;
}): BytedcliContainmentReport | undefined {
  if (input.cliSpawnGeneration !== input.coldSandboxGeneration || input.cliSpawnGeneration < 1) return undefined;
  const observed = observeBytedcliLinuxContainment(input.cliPid, input.contract);
  const workerProcStart = readProcessStartIdentity(process.pid);
  if (!observed || observed.cliProcStart !== input.cliProcStart || !workerProcStart) return undefined;
  return {
    protocol: 'botmux.bytedcli-containment.v1', sessionId: input.sessionId,
    workerGeneration: input.contract.workerGeneration, workerPid: process.pid, workerProcStart,
    cliPid: input.cliPid, cliSpawnGeneration: input.cliSpawnGeneration, ...observed,
    filesystem: 'allowlist', protectedRoots: [...input.contract.credentialRoots, ...input.contract.executableReadOnlyRoots],
    protectedRootsEnforced: true, freshCredentialFreeLaunch: true,
  };
}
