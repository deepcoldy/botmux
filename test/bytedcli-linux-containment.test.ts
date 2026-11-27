import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, existsSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { buildFsPolicy } from '../src/adapters/cli/fs-policy.js';
import { prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import { observeBytedcliLinuxContainment, assertBytedcliLaunchSupported, createBytedcliContainmentReport } from '../src/core/bytedcli-linux-containment.js';
import { rememberBytedcliContainment, bytedcliContainmentAvailable, acceptBytedcliWorkerContainment } from '../src/core/bytedcli-broker-containment.js';
import { createBytedcliHostOperationPolicyReader } from '../src/core/bytedcli-host-operation-policy.js';

const usable = process.platform === 'linux' && spawnSync('bwrap', ['--unshare-user', '--unshare-pid', '--tmpfs', '/',
  '--proc', '/proc', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '/usr/bin/true']).status === 0;

describe('strict launch support', () => {
  const valid = { platform: 'linux', backendType: 'pty', cliId: 'claude-code', sandbox: 'oncall', identityModel: 'proven', loopbackShared: true };
  it.each([{ platform: 'darwin' }, { backendType: 'remote' }, { sandbox: 'scratch' }, { cliId: 'seed' }, { cliId: 'relay' }, { cliId: 'pi' },
    { adopt: true }, { reattach: true }, { sharedAuthentication: true }, { loopbackShared: false }, { identityModel: 'single' },
    { hostMcpEntries: 1 }, { rpc: true }, { externalAppServer: 'host' }, { launchMode: 'shell' }, { wrapperCli: 'host-wrapper' }])('rejects unsupported launch %j', delta => {
    expect(() => assertBytedcliLaunchSupported({ ...valid, ...delta })).toThrow();
  });
  it.each(['claude-code', 'codex'])('keeps independently isolated %s model execution supported', cliId => {
    expect(() => assertBytedcliLaunchSupported({ ...valid, cliId })).not.toThrow();
  });
});

it.skipIf(!usable).each([false, true])('real direct sandbox (tmux args file=%s) hides credentials/future profiles, blocks writes and host process metadata, and binds a report to its cold generation', async useBwrapArgsFile => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'strict-kernel-')));
  const credential = join(root, 'credentials'), trusted = join(root, 'install/tree');
  const data = join(root, 'data');
  for (const dir of [credential, trusted, data, join(credential, 'profile'), join(trusted, 'bin'), join(trusted, 'src/core'), join(trusted, 'src/private')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(credential, 'profile/token'), 'private-fixture');
  writeFileSync(join(trusted, 'bin/cli'), 'trusted-fixture');
  writeFileSync(join(trusted, 'src/worker.ts'), 'trusted-worker');
  writeFileSync(join(trusted, 'src/core/bytedcli-broker-client.ts'), 'trusted-client');
  writeFileSync(join(trusted, 'src/private/token'), 'install-secret');
  writeFileSync(join(root, 'model-login'), 'model-fixture');
  const alias = join(root, 'credential-alias');
  // Existing directory profiles are supported; a symlink leaf is explicitly refused below.
  mkdirSync(alias);
  const absent = join(root, 'future-store');
  const hostAuthority = join(root, '.botmux', 'host-authority');
  const hostPolicyRoot = join(hostAuthority, 'bytedcli-broker');
  const hostPolicyFile = join(hostPolicyRoot, 'policy', 'operation-policy.json');
  const context = { platform: 'linux' as const, homeDir: root, botmuxHome: join(root, '.botmux'), sessionDataDir: data,
    workingDir: trusted, botmuxInstallRoot: trusted, botmuxInstallRootMaskPaths: [join(trusted, 'src/private')],
    botHome: join(root, '.botmux/bots/app'), sessionId: 's', currentAppId: 'app', redirectedCliData: true,
    protectedDenyPaths: [credential, alias, absent, hostAuthority], protectedReadOnlyPaths: [trusted],
    authPaths: [join(credential, 'profile')], mandatoryReadOnlyPaths: [join(credential, 'profile/token'), join(trusted, 'src/private/token')],
    userPaths: { readWrite: [root, join(credential, 'profile'), trusted, join(trusted, 'bin'), join(trusted, 'src')] } };
  const policy = buildFsPolicy(context);
  policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
  let sandbox: ReturnType<typeof prepareDirectSandbox> = null;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    sandbox = prepareDirectSandbox({ sessionId: 's', dataDir: data, policy, home: root, chdir: trusted,
      bytedcliBroker: true, useBwrapArgsFile, cliBin: '/bin/sh', cliArgs: ['-c', `echo READY; read answer; test ! -r '${credential}/profile/token' || exit 21; test ! -r '${credential}/future' || exit 22; test ! -r '${alias}/profile/token' || exit 25; test ! -r '${absent}/token' || exit 26; test ! -r '${hostPolicyFile}' || exit 31; echo changed > '${hostPolicyFile}' 2>/dev/null && exit 32; test ! -r '${trusted}/src/private/token' || exit 29; test ! -r /proc/${process.pid}/environ || exit 23; echo changed > '${trusted}/bin/cli' 2>/dev/null && exit 24; echo changed > '${trusted}/src/worker.ts' 2>/dev/null && exit 27; echo changed > '${trusted}/src/core/bytedcli-broker-client.ts' 2>/dev/null && exit 28; mv '${root}/install' '${root}/install-replaced' 2>/dev/null && exit 30; cat '${root}/model-login'; echo PASS` ] });
    expect(sandbox).not.toBeNull();
    child = spawn(sandbox!.bin, sandbox!.args, { env: { PATH: '/usr/bin:/bin', HOME: root, ...sandbox!.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 5_000;
    while (!stdout.includes('READY') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(stdout, stderr).toContain('READY');
    const descendants = (pid: number): number[] => {
      let children: number[] = [];
      try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* exited */ }
      return children.flatMap(id => [id, ...descendants(id)]);
    };
    const contract = { workerGeneration: 1, credentialRoots: [credential, alias, absent, hostAuthority], executableReadOnlyRoots: [trusted] };
    const pid = descendants(child.pid!).find(id => observeBytedcliLinuxContainment(id, contract));
    expect(pid, stderr).toBeDefined();
    const observed = observeBytedcliLinuxContainment(pid!, contract)!;
    expect(observed.pidNamespace).not.toBe(readlinkSync('/proc/self/ns/pid'));
    const ds = { session: { sessionId: 's', status: 'active', backendType: 'pty', workerGeneration: 1 }, worker: { pid: process.pid },
      workerGeneration: 1, initConfig: { bytedcliContainment: contract }, localProcessAttestation: { cliPid: pid, cliProcStart: observed.cliProcStart, cliSpawnGeneration: 1 } } as any;
    const input = { sessionId: 's', contract, cliPid: pid!, cliProcStart: observed.cliProcStart!, cliSpawnGeneration: 1 };
    expect(createBytedcliContainmentReport(input)).toBeUndefined();
    expect(createBytedcliContainmentReport({ ...input, coldSandboxGeneration: 2 })).toBeUndefined();
    const report = createBytedcliContainmentReport({ ...input, coldSandboxGeneration: 1 })!;
    expect(report).toBeDefined();
    expect(acceptBytedcliWorkerContainment(ds, { pid: process.pid } as any, 1, report)).toBe(false);
    expect(acceptBytedcliWorkerContainment(ds, ds.worker, 2, report)).toBe(false);
    expect(acceptBytedcliWorkerContainment(ds, ds.worker, 1, report)).toBe(true);
    expect(rememberBytedcliContainment(ds, report)).toBe(true);
    expect(bytedcliContainmentAvailable(ds, [credential, trusted])).toBe(true);
    ds.workerGeneration = 2;
    expect(rememberBytedcliContainment(ds, report)).toBe(false);
    expect(bytedcliContainmentAvailable(ds, [credential])).toBe(false);
    writeFileSync(join(credential, 'future'), 'late-fixture');
    mkdirSync(absent, { recursive: true });
    writeFileSync(join(absent, 'token'), 'late-store-fixture');
    const hostReader = createBytedcliHostOperationPolicyReader(hostPolicyRoot); expect(hostReader().errorCode).toBeUndefined();
    const hostPolicy = JSON.stringify({schema:'botmux.bytedcli-operation-policy.v1',cliVersion:'0.199.0',catalogVersion:'2026-11-26.1',rules:{'codebase.mr.list':'actor'}});
    writeFileSync(hostPolicyFile, hostPolicy, { mode:0o600 });expect(hostReader().policy?.rules['codebase.mr.list']).toBe('actor');
    child.stdin!.end('go\n');
    const [status] = await exited;
    expect(status, stderr).toBe(0);
    expect(stdout).toContain('model-fixturePASS');
    expect(readFileSync(join(trusted, 'bin/cli'), 'utf8')).toBe('trusted-fixture');
    expect(readFileSync(join(trusted, 'src/worker.ts'), 'utf8')).toBe('trusted-worker');
    expect(readFileSync(join(trusted, 'src/core/bytedcli-broker-client.ts'), 'utf8')).toBe('trusted-client');
    expect(readFileSync(hostPolicyFile, 'utf8')).toBe(hostPolicy);
  } finally {
    child?.kill('SIGKILL');
    sandbox?.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);


it.skipIf(!usable)('refuses a credential-root symlink instead of claiming it is masked', () => {
  const root = mkdtempSync(join(tmpdir(), 'strict-symlink-'));
  try {
    const target = join(root, 'target'), alias = join(root, 'alias');
    mkdirSync(target); symlinkSync(target, alias);
    expect(() => prepareDirectSandbox({ sessionId: 'symlink', dataDir: join(root, 'data'),
      policy: { rules: [], net: true, writeRegexes: [], protectedDenyPaths: [alias] },
      bytedcliBroker: true, chdir: root, home: root, cliBin: '/bin/true', cliArgs: [] })).toThrow(/protected credential root/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(!usable).each([
  { useBwrapArgsFile: false, relative: 'gitconfig' },
  { useBwrapArgsFile: true, relative: 'gitconfig' },
  { useBwrapArgsFile: false, relative: 'custom/tenant/token' },
  { useBwrapArgsFile: true, relative: 'custom/tenant/token' },
])('masks absent protected $relative under an unwritable host parent without creating it (args file=$useBwrapArgsFile)', async ({ useBwrapArgsFile, relative }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'strict-absent-mask-')));
  const parent = join(root, 'readonly-etc'), absent = join(parent, relative), trusted = join(root, 'runtime');
  mkdirSync(parent); mkdirSync(trusted);
  writeFileSync(join(parent, 'readable'), 'public-fixture');
  symlinkSync('readable', join(parent, 'readable-link'));
  writeFileSync(join(trusted, 'cli'), 'trusted-fixture');
  chmodSync(parent, 0o555);
  let sandbox: ReturnType<typeof prepareDirectSandbox> = null;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const contract = { workerGeneration: 1, credentialRoots: [absent], executableReadOnlyRoots: [trusted] };
    sandbox = prepareDirectSandbox({ sessionId: 'absent', dataDir: join(root, 'data'), home: root, chdir: '/',
      bytedcliBroker: true, useBwrapArgsFile, policy: { rules: [
        { path: '/usr', access: 'readOnly', source: 'baseline' },
        { path: parent, access: 'readOnly', source: 'baseline' },
        { path: trusted, access: 'readOnly', source: 'mandatory' },
        { path: absent, access: 'deny', source: 'mandatory' },
      ], net: true, writeRegexes: [], protectedDenyPaths: [absent], protectedReadOnlyPaths: [trusted] },
      cliBin: '/usr/bin/sh', cliArgs: ['-c', `echo READY; read answer; test ! -f '${absent}' || exit 41; cat '${parent}/readable' '${parent}/readable-link'; echo changed > '${trusted}/cli' 2>/dev/null && exit 42; echo PASS`] });
    expect(sandbox).not.toBeNull();
    expect(!!sandbox!.argsFile).toBe(useBwrapArgsFile);
    expect(existsSync(absent)).toBe(false);
    child = spawn(sandbox!.bin, sandbox!.args, { env: { PATH: '/usr/bin:/bin', HOME: root, ...sandbox!.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data; }); child.stderr!.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    const deadline = Date.now() + 5_000;
    while (!stdout.includes('READY') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(stdout, stderr).toContain('READY');
    expect(existsSync(absent)).toBe(false);
    const descendants = (pid: number): number[] => {
      let children: number[] = [];
      try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { /* exited */ }
      return children.flatMap(id => [id, ...descendants(id)]);
    };
    const cliPid = descendants(child.pid!).find(pid => observeBytedcliLinuxContainment(pid, contract));
    expect(cliPid, stderr).toBeDefined();
    // The trusted host may create this optional credential after launch. It
    // remains hidden, without having to reserve a directory on the host first.
    chmodSync(parent, 0o755);
    mkdirSync(dirname(absent), { recursive: true });
    writeFileSync(absent, 'future-host-secret');
    chmodSync(parent, 0o555);
    expect(observeBytedcliLinuxContainment(cliPid!, contract)).toBeDefined();
    child.stdin!.end('go\n');
    const [status] = await exited;
    expect(status, stderr).toBe(0);
    expect(stdout).toContain('public-fixturepublic-fixturePASS');
    sandbox!.cleanup(); sandbox = null;
    expect(readFileSync(absent, 'utf8')).toBe('future-host-secret');
    expect(readFileSync(join(trusted, 'cli'), 'utf8')).toBe('trusted-fixture');
  } finally {
    child?.kill('SIGKILL'); sandbox?.cleanup();
    chmodSync(parent, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
