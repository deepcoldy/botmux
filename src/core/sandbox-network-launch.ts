import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEntrySpawn } from './self-spawn.js';
import { compileNetworkNft, parseSandboxNetworkPolicy, type SandboxNetworkPolicy } from './sandbox-network-policy.js';

export interface NetworkLaunchPlan { nft: string; ip: string; unshare: string; slirp: string; nftRules: string; command: string; args: string[] }
function executable(name: string): string {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const path = found.stdout?.trim();
  if (found.status !== 0 || !path?.startsWith('/')) throw new Error(`sandboxNetworkPolicy requires ${name} on PATH (no automatic installation)`);
  return path;
}
export function sandboxNetworkLaunch(policy: SandboxNetworkPolicy, command: string, args: string[]): { bin: string; args: string[] } {
  if (process.platform !== 'linux') throw new Error('sandboxNetworkPolicy requires Linux');
  parseSandboxNetworkPolicy(policy);
  const slirp = executable('slirp4netns'), nft = executable('nft'), ip = executable('ip'), unshare = executable('unshare');
  const help = spawnSync(slirp, ['--help'], { encoding: 'utf8' });
  if (!help.stdout?.includes('--disable-host-loopback') || !help.stdout.includes('--disable-dns')) throw new Error('sandboxNetworkPolicy requires slirp4netns with --disable-host-loopback and --disable-dns');
  const bwrapHelp = spawnSync('bwrap', ['--help'], { encoding: 'utf8' });
  if (!bwrapHelp.stdout?.includes('--add-seccomp-fd') || !bwrapHelp.stdout.includes('--disable-userns')) throw new Error('sandboxNetworkPolicy requires bwrap with --add-seccomp-fd and --disable-userns');
  const unshareHelp = spawnSync(unshare, ['--help'], { encoding: 'utf8' });
  if (!unshareHelp.stdout?.includes('--kill-child') || !unshareHelp.stdout.includes('--mount-proc')) throw new Error('sandboxNetworkPolicy requires unshare with --kill-child and --mount-proc');
  const entry = resolveEntrySpawn('sandbox-network-runner', join(dirname(fileURLToPath(import.meta.url)), '..'));
  const plan: NetworkLaunchPlan = { nft, ip, unshare, slirp, nftRules: compileNetworkNft(policy), command, args };
  const encoded = Buffer.from(JSON.stringify(plan)).toString('base64');
  if (Buffer.byteLength(encoded) > 98304) throw new Error('sandboxNetworkPolicy launch plan exceeds the supported 96 KiB limit');
  return { bin: entry.command, args: [...entry.args, encoded] };
}

/** The sandbox may create only Internet sockets. No host Unix sockets, compat
 * syscall ABI, namespace escape or io_uring socket operations. socketpair is
 * intentionally preserved for process-local IPC. Installed after bwrap setup. */
export function networkSocketFilter(arch = process.arch): Buffer {
  const abi = arch === 'x64' ? { audit: 0xc000003e, socket: 41, blocked: [272, 308, 425, 426, 427] }
    : arch === 'arm64' ? { audit: 0xc00000b7, socket: 198, blocked: [97, 268, 425, 426, 427] } : null;
  if (!abi) throw new Error(`sandboxNetworkPolicy supports only Linux x64/arm64 (got ${arch})`);
  const LD = 0x20, JEQ = 0x15, RET = 0x06, ALLOW = 0x7fff0000, DENY = 0x00050001;
  const ins: Array<[number, number, number, number]> = [
    [LD, 0, 0, 4], [JEQ, 1, 0, abi.audit], [RET, 0, 0, 0x80000000], [LD, 0, 0, 0],
  ];
  // x32 shares AUDIT_ARCH_X86_64 but has different syscall numbers.
  if (arch === 'x64') ins.push([0x45, 0, 1, 0x40000000], [RET, 0, 0, DENY]);
  for (const syscall of abi.blocked) ins.push([JEQ, 0, 1, syscall], [RET, 0, 0, DENY]);
  ins.push([JEQ, 1, 0, abi.socket], [RET, 0, 0, ALLOW], [LD, 0, 0, 16],
    [JEQ, 2, 0, 2], [JEQ, 1, 0, 10], [RET, 0, 0, DENY], [RET, 0, 0, ALLOW]);
  const buffer = Buffer.alloc(ins.length * 8);
  ins.forEach(([code, jt, jf, value], i) => { buffer.writeUInt16LE(code, i * 8); buffer[i * 8 + 2] = jt; buffer[i * 8 + 3] = jf; buffer.writeUInt32LE(value, i * 8 + 4); });
  return buffer;
}
