import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLinuxIsolationLauncher, linuxIsolationDetected, linuxIsolationLaunch } from '../src/core/linux-isolation.js';
import { prepareCredentialOnlySandbox } from '../src/adapters/backend/sandbox.js';
import { tsEvalArgs, tsRunnerPrefix } from './helpers/ts-runner.js';
import { readPersistedSessionRows, seedPersistedSessionRows } from './helpers/session-store-disk.js';

const supported = ['x64', 'arm64', 'ia32', 'arm'].includes(process.arch);
const linux = process.platform === 'linux';
const canRunBwrap = linux && spawnSync('bwrap', [
  '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--proc', '/proc',
  '--', '/bin/true',
], { stdio: 'ignore', timeout: 5_000 }).status === 0;
const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const bwrapArgs = ['--ro-bind', '/', '/', '--unshare-user', '--unshare-pid',
  '--unshare-net', '--proc', '/proc', '--dev', '/dev', '--'];

type Launch = ReturnType<typeof linuxIsolationLaunch>;

// Inspect the exact bytes supplied to bwrap, not a second filter generator.
function filterBytes(launch: Launch): Buffer {
  const encoded = launch.args[1]!.match(/printf '((?:\\[0-7]{3})+)'/)![1]!;
  return Buffer.from(encoded.match(/\\[0-7]{3}/g)!.map(byte => parseInt(byte.slice(1), 8)));
}

function replaceFilter(launch: Launch, bytes: Buffer): Launch {
  const octal = [...bytes].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
  const args = [...launch.args];
  args[1] = args[1]!.replace(/printf '(?:\\[0-7]{3})+'/, () => `printf '${octal}'`);
  return { bin: launch.bin, args };
}

function evaluate(bytes: Buffer, arch: number, nr: number, which = 0, who = 1): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr >>> 0, 0);
  data.writeUInt32LE(arch, 4);
  data.writeUInt32LE(which >>> 0, 16);
  data.writeUInt32LE(who >>> 0, 24);
  // Linux ignores these upper argument bits even in the 64-bit ABI.
  data.writeUInt32LE(0xffffffff, 20);
  data.writeUInt32LE(0xffffffff, 28);
  let accumulator = 0;
  for (let pc = 0; pc < bytes.length / 8; pc++) {
    const offset = pc * 8;
    const code = bytes.readUInt16LE(offset);
    const k = bytes.readUInt32LE(offset + 4);
    if (code === 0x20) accumulator = data.readUInt32LE(k);
    else if (code === 0x54) accumulator = (accumulator & k) >>> 0;
    else if (code === 0x15) pc += bytes[offset + (accumulator === k ? 2 : 3)]!;
    else if (code === 0x06) return k;
    else throw new Error(`unexpected BPF instruction ${code}`);
  }
  throw new Error('filter did not return');
}

describe.skipIf(!supported)('Linux isolation filter', () => {
  it('recognizes only the fixed noninteractive launcher, never a bare shell or copied label', () => {
    const launch = linuxIsolationLaunch('/usr/bin/bwrap', ['--', '/bin/true']);
    const commandLine = [launch.bin, ...launch.args];
    expect(isLinuxIsolationLauncher(commandLine)).toBe(true);
    expect(isLinuxIsolationLauncher(['/bin/sh', '-i'])).toBe(false);
    expect(isLinuxIsolationLauncher(['/bin/sh', '-c', 'exec /bin/sh -i', 'botmux-isolation'])).toBe(false);
    const replacedScript = [...commandLine];
    replacedScript[2] = 'read input; eval "$input"';
    expect(isLinuxIsolationLauncher(replacedScript)).toBe(false);
    const missingFilter = [...commandLine];
    missingFilter[5] = '--ro-bind';
    expect(isLinuxIsolationLauncher(missingFilter)).toBe(false);
  });

  it.each([
    [0xc000003e, 140, 0], [0xc000003e, 140, 0x40000000],
    [0xc00000b7, 141, 0], [0x40000003, 96, 0], [0x40000028, 96, 0],
  ])('denies only the probe in ABI %s (syscall %s, bit %s)', (arch, syscall, bit) => {
    const bytes = filterBytes(linuxIsolationLaunch('bwrap', []));
    for (let nr = 0; nr < 600; nr++) {
      expect(evaluate(bytes, arch!, nr | bit!)).toBe(nr === syscall ? 0x00050001 : 0x7fff0000);
    }
    for (const [which, who] of [[0, 0], [0, 2], [0, -1], [1, 1], [2, 1]]) {
      expect(evaluate(bytes, arch!, syscall! | bit!, which, who)).toBe(0x7fff0000);
    }
  });

  it('fails closed for unknown or opposite-endian ABIs', () => {
    const bytes = filterBytes(linuxIsolationLaunch('bwrap', []));
    for (const arch of [0, 0x800000b7, 0xdeadbeef]) {
      expect(evaluate(bytes, arch, 141)).toBe(0x80000000);
    }
  });
});

describe.skipIf(!canRunBwrap || !supported)('Linux isolation kernel probe', () => {
  const snippet = tsEvalArgs(`
    import { getPriority } from 'node:os';
    import { readFileSync } from 'node:fs';
    import { linuxIsolationDetected } from './src/core/linux-isolation.js';
    import { isIsolatedCliProcess } from './src/core/managed-origin-capability.js';
    console.log(JSON.stringify({
      isolated: linuxIsolationDetected(), offline: isIsolatedCliProcess({}, ''),
      ownPriority: getPriority(), input: readFileSync(0, 'utf8'),
    }));
  `);
  const { command, prefixArgs } = tsRunnerPrefix();
  const cli = [command, ...prefixArgs, ...snippet.args];
  const cleanCli = ['/usr/bin/env', '-i', ...cli];

  function run(launch: Launch) {
    const result = spawnSync(launch.bin, launch.args, {
      cwd: repoRoot, encoding: 'utf8', input: 'interactive stdin', timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it('keeps an ordinary host unmarked, including a bare HOME', () => {
    expect(linuxIsolationDetected()).toBe(false);
    expect(run({ bin: cleanCli[0]!, args: cleanCli.slice(1) })).toMatchObject({
      isolated: false, offline: false, input: 'interactive stdin',
    });
  });

  it('survives a cleared environment and preserves stdin/current priority', () => {
    expect(run(linuxIsolationLaunch('bwrap', [...bwrapArgs, ...cleanCli]))).toEqual({
      isolated: true, offline: true, input: 'interactive stdin', ownPriority: expect.any(Number),
    });
  }, 20_000);

  it('survives another user/PID/mount namespace with no environment markers', () => {
    expect(run(linuxIsolationLaunch('bwrap', [
      ...bwrapArgs, 'bwrap', ...bwrapArgs, ...cleanCli,
    ]))).toMatchObject({ isolated: true, offline: true });
  });

  it.each([0, 3, 38])('does not trust an overlaid seccomp errno %s', errno => {
    const inner = linuxIsolationLaunch('bwrap', [...bwrapArgs, ...cleanCli]);
    const bytes = filterBytes(inner);
    let replaced = 0;
    for (let offset = 0; offset < bytes.length; offset += 8) {
      if (bytes.readUInt16LE(offset) === 0x06 && bytes.readUInt32LE(offset + 4) === 0x00050001) {
        bytes.writeUInt32LE(0x00050000 | errno, offset + 4);
        replaced++;
      }
    }
    expect(replaced).toBe(1);
    const stacked = replaceFilter(inner, bytes);
    expect(run(linuxIsolationLaunch('bwrap', [
      ...bwrapArgs, stacked.bin, ...stacked.args,
    ]))).toMatchObject({ isolated: true, offline: true });
  });

  it('never executes the CLI if bwrap cannot install the filter', () => {
    const launch = replaceFilter(linuxIsolationLaunch('bwrap', [
      ...bwrapArgs, '/bin/sh', '-c', 'printf should-not-run',
    ]), Buffer.from([0]));
    const result = spawnSync(launch.bin, launch.args, { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('should-not-run');
    expect(result.stderr).toContain('seccomp');
  });

  it('marks credential-only bwrap as isolated even after all BOTMUX env is removed', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-kernel-marker-')));
    const hidden = join(root, 'authority');
    mkdirSync(hidden);
    try {
      const launch = prepareCredentialOnlySandbox({
        hideDirectories: [hidden], hideFiles: [], workingDir: repoRoot,
        cliBin: cleanCli[0]!, cliArgs: cleanCli.slice(1),
      });
      expect(launch).not.toBeNull();
      // A private /dev makes the runtime fixture independent of the host's
      // container device mounts (Bun can abort on those even without seccomp).
      launch!.args.splice(launch!.args.indexOf('--'), 0, '--dev', '/dev');
      expect(run(launch!)).toMatchObject({ isolated: true, offline: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses offline session mutation in credential-only mode with a writable store', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'botmux-kernel-offline-')));
    const hidden = join(root, 'authority');
    const dataDir = join(root, 'data');
    mkdirSync(hidden);
    mkdirSync(dataDir);
    const row = { sessionId: 'session', chatId: 'oc_test', rootMessageId: 'om_test',
      title: 'fixture', status: 'active', createdAt: new Date(0).toISOString(), larkAppId: 'app-test' };
    seedPersistedSessionRows(dataDir, 'app-test', { session: row });
    try {
      const launch = prepareCredentialOnlySandbox({
        hideDirectories: [hidden], hideFiles: [], workingDir: repoRoot,
        cliBin: '/usr/bin/env', cliArgs: ['-i', `HOME=${root}`, `SESSION_DATA_DIR=${dataDir}`,
          `BOTS_CONFIG=${join(root, 'bots.json')}`, command, ...prefixArgs,
          join(repoRoot, 'src/cli.ts'), 'delete', 'session'],
      });
      expect(launch).not.toBeNull();
      launch!.args.splice(launch!.args.indexOf('--'), 0, '--dev', '/dev', '--unshare-net');
      const result = spawnSync(launch!.bin, launch!.args, {
        cwd: repoRoot, encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('隔离会话内不能离线修改会话');
      expect(readPersistedSessionRows(dataDir, 'app-test').session).toEqual(row);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
