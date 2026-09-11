import { getPriority } from 'node:os';

/**
 * A Linux isolation stamp that survives env -i, exec and nested namespaces.
 * Reserve getpriority(PRIO_PROCESS, 1) as a read-only kernel probe: bwrap's
 * inherited seccomp filter denies only this query, not priority changes or
 * queries for the current process. PID 1 exists in every live PID namespace.
 *
 * Do NOT match a particular errno. A child can stack another RET_ERRNO filter
 * and replace EPERM with ESRCH or even errno 0. Linux returns raw priorities
 * in [1, 40]; libc maps raw 0 to nice 20, outside the valid [-20, 19] range.
 * Only a successful, in-range answer establishes the ordinary host path.
 * Additional seccomp filters cannot turn our denial into a real syscall.
 *
 * This is a trusted-CLI confused-deputy guard, not a replacement for the
 * filesystem/credential boundary or protection against modified CLI code.
 * A host policy that independently denies this query also fails closed.
 */
export function linuxIsolationDetected(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const priority = getPriority(1);
    return !Number.isInteger(priority) || priority < -20 || priority > 19;
  } catch {
    return true;
  }
}

/** Classic BPF, using Linux's seccomp_data offsets and audit architecture IDs.
 * Cover both native and compat ABIs on the supported little-endian hosts.
 * Unknown ABIs fail closed instead of interpreting a foreign syscall number.
 */
function isolationFilter(): Buffer {
  if (!['x64', 'arm64', 'ia32', 'arm'].includes(process.arch)) {
    throw new Error(`Linux isolation marker unsupported on ${process.arch}`);
  }
  const LD = 0x20; // BPF_LD | BPF_W | BPF_ABS
  const JEQ = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
  const RET = 0x06; // BPF_RET | BPF_K
  const ALLOW = 0x7fff0000;
  const instructions: Array<[number, number, number, number]> = [[LD, 0, 0, 4]];
  const probeJumps: number[] = [];
  for (const [arch, syscall, x32] of [
    [0xc000003e, 140, true], // x86-64 / x32
    [0xc00000b7, 141, false], // AArch64
    [0x40000003, 96, false], // i386
    [0x40000028, 96, false], // ARM EABI
  ] as const) {
    instructions.push([JEQ, 0, x32 ? 4 : 3, arch], [LD, 0, 0, 0]);
    if (x32) instructions.push([0x54, 0, 0, 0xbfffffff]); // clear __X32_SYSCALL_BIT
    probeJumps.push(instructions.length);
    instructions.push([JEQ, 0, 0, syscall], [RET, 0, 0, ALLOW]);
  }
  instructions.push([RET, 0, 0, 0x80000000]); // SECCOMP_RET_KILL_PROCESS
  for (const index of probeJumps) instructions[index]![1] = instructions.length - index - 1;
  // The kernel takes int / id_t arguments: compare the low 32 bits, including
  // compat calls and calls with arbitrary unused upper argument bits.
  instructions.push(
    [LD, 0, 0, 16], [JEQ, 0, 3, 0], // which == PRIO_PROCESS
    [LD, 0, 0, 24], [JEQ, 0, 1, 1], // who == 1
    [RET, 0, 0, 0x00050001], // SECCOMP_RET_ERRNO | EPERM
    [RET, 0, 0, ALLOW],
  );
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * 8;
    bytes.writeUInt16LE(code, offset);
    bytes[offset + 2] = jt;
    bytes[offset + 3] = jf;
    bytes.writeUInt32LE(k, offset + 4);
  });
  return bytes;
}

/** Feed bwrap a private anonymous filter pipe without consuming PTY stdin.
 * No mutable profile file, inherited descriptor requirement, native addon or
 * installed helper is needed (including in the standalone binary). The tiny
 * POSIX shell adapter works with both PTY and persistent terminal backends.
 * bwrap must install the filter before exec; failure never runs the CLI bare.
 */
export function linuxIsolationLaunch(bin: string, args: string[]): { bin: string; args: string[] } {
  const octal = [...isolationFilter()].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
  return {
    bin: '/bin/sh',
    args: [
      '-c',
      `exec 4<&0 || exit; printf '${octal}' | { exec "$@" 3<&0 0<&4 4<&-; }`,
      'botmux-isolation', bin, '--seccomp', '3', ...args,
    ],
  };
}

/** Lifecycle hint only, never isolation authority. The pipe adapter remains
 * as a noninteractive shell while bwrap runs. Its fixed script never evaluates
 * terminal input, so the worker must not mistake it for a failed interactive
 * launch. Match the entire script, not just a forgeable argv[0] label; an rcfile
 * trampoline or an unrelated shell must still hit the bare-shell input guard.
 */
export function isLinuxIsolationLauncher(commandLine: readonly string[]): boolean {
  const launch = linuxIsolationLaunch('bwrap', []);
  return commandLine[0] === launch.bin
    && launch.args.slice(0, 3).every((arg, index) => commandLine[index + 1] === arg)
    && !!commandLine[4]
    && commandLine[5] === '--seccomp'
    && commandLine[6] === '3';
}
