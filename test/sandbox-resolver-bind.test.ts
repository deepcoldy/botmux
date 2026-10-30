/**
 * Every Linux sandbox mounts a fresh tmpfs on /run. systemd-resolved,
 * resolvconf and NetworkManager make /etc/resolv.conf a symlink into /run, so
 * inside the sandbox that link dangles and every lookup fails with EAI_AGAIN
 * while the host terminal resolves fine. The sandbox re-exposes the single
 * resolver file read-only at the hop the in-sandbox lookup stops at.
 *
 * The chain walker takes the link and the shadowed roots as parameters, so the
 * shapes are built under a temp dir. The end-to-end cases run real bwrap (oncall)
 * and the real scratch container inside a private mount namespace (root only).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostResolverBindArgs, resolverPathDenied, shadowedResolverPath } from '../src/adapters/backend/sandbox.js';
import { accessForPath, type FsRule } from '../src/adapters/cli/fs-policy.js';
import { lastJsonLine, privateMountNsAvailable, runInPrivateMountNs } from './helpers/private-mount-ns.js';
import { isBunRuntime } from './helpers/ts-runner.js';

const roots: string[] = [];
function layout() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-resolv-')));
  roots.push(root);
  const etc = join(root, 'etc');
  const run = join(root, 'run');
  mkdirSync(etc, { recursive: true });
  mkdirSync(join(run, 'systemd', 'resolve'), { recursive: true });
  return { root, etc, run, link: join(etc, 'resolv.conf') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('shadowedResolverPath / hostResolverBindArgs', () => {
  it('binds the systemd-resolved stub file at its /run path (relative link)', () => {
    const l = layout();
    const stub = join(l.run, 'systemd', 'resolve', 'stub-resolv.conf');
    writeFileSync(stub, 'nameserver 127.0.0.53\n');
    symlinkSync('../run/systemd/resolve/stub-resolv.conf', l.link);
    expect(shadowedResolverPath(l.link, [l.run])).toBe(stub);
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual(['--dir', join(l.run, 'systemd', 'resolve'), '--ro-bind', stub, stub]);
  });

  it('stops at the first shadowed hop of a multi-hop chain and binds the final file there', () => {
    const l = layout();
    const real = join(l.run, 'systemd', 'resolve', 'resolv.conf');
    writeFileSync(real, 'nameserver 10.0.0.1\n');
    mkdirSync(join(l.run, 'resolvconf'));
    const first = join(l.run, 'resolvconf', 'resolv.conf');
    symlinkSync(real, first);
    symlinkSync(join(l.etc, 'resolv.target'), l.link);
    symlinkSync(first, join(l.etc, 'resolv.target'));
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual(['--dir', join(l.run, 'resolvconf'), '--ro-bind', real, first]);
  });

  it('follows a symlinked parent directory (/var/run → /run)', () => {
    const l = layout();
    const stub = join(l.run, 'systemd', 'resolve', 'stub-resolv.conf');
    writeFileSync(stub, 'nameserver 127.0.0.53\n');
    mkdirSync(join(l.root, 'var'));
    symlinkSync(l.run, join(l.root, 'var', 'run'));
    symlinkSync(join(l.root, 'var', 'run', 'systemd', 'resolve', 'stub-resolv.conf'), l.link);
    expect(shadowedResolverPath(l.link, [l.run])).toBe(stub);
  });

  it('adds nothing for a plain file, a chain outside the shadowed roots, a dangling link or a loop', () => {
    const l = layout();
    writeFileSync(l.link, 'nameserver 10.0.0.1\n');
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual([]);
    rmSync(l.link);
    writeFileSync(join(l.etc, 'resolv.real'), 'nameserver 10.0.0.1\n');
    symlinkSync('resolv.real', l.link);
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual([]);
    rmSync(l.link);
    symlinkSync('../run/systemd/resolve/missing.conf', l.link);
    // The hop is still known (the network-policy path binds its own file there),
    // but there is no host file to expose.
    expect(shadowedResolverPath(l.link, [l.run])).toBe(join(l.run, 'systemd', 'resolve', 'missing.conf'));
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual([]);
    rmSync(l.link);
    symlinkSync('resolv.loop', l.link);
    symlinkSync('resolv.conf', join(l.etc, 'resolv.loop'));
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual([]);
  });

  it('adds nothing when any name of the resolver file is denied', () => {
    const l = layout();
    const real = join(l.run, 'systemd', 'resolve', 'resolv.conf');
    writeFileSync(real, 'nameserver 10.0.0.1\n');
    const first = join(l.run, 'stub.conf');
    symlinkSync(real, first);
    symlinkSync(first, l.link);
    for (const name of [l.link, first, real]) {
      expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: p => p === name })).toEqual([]);
    }
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual(['--dir', l.run, '--ro-bind', real, first]);
  });

  it('does not treat a sibling prefix (/runtime) as /run', () => {
    const l = layout();
    const sibling = join(l.root, 'runtime');
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'resolv.conf'), 'nameserver 10.0.0.1\n');
    symlinkSync(join(sibling, 'resolv.conf'), l.link);
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false })).toEqual([]);
  });

  it('keeps the literal hop when a directory INSIDE the shadowed root is itself a symlink', () => {
    // /etc/resolv.conf → /run/dnsproxy/resolv.conf, /run/dnsproxy → /run/sub/dnsproxy.
    // The sandbox's fresh /run tmpfs has neither name, so the kernel stops at
    // the LITERAL /run/dnsproxy/resolv.conf; resolving the parent on the host
    // would bind at /run/sub/... where the in-sandbox lookup never arrives.
    const l = layout();
    const real = join(l.run, 'sub', 'dnsproxy', 'resolv.conf');
    mkdirSync(join(l.run, 'sub', 'dnsproxy'), { recursive: true });
    writeFileSync(real, 'nameserver 10.0.0.1\n');
    symlinkSync(join(l.run, 'sub', 'dnsproxy'), join(l.run, 'dnsproxy'));
    symlinkSync(join(l.run, 'dnsproxy', 'resolv.conf'), l.link);
    const hop = join(l.run, 'dnsproxy', 'resolv.conf');
    expect(shadowedResolverPath(l.link, [l.run])).toBe(hop);
    expect(hostResolverBindArgs({ link: l.link, shadowedRoots: [l.run], denied: () => false }))
      .toEqual(['--dir', join(l.run, 'dnsproxy'), '--ro-bind', real, hop]);
  });
});

describe('resolverPathDenied (input policy ∪ relocated compiled rules)', () => {
  // /etc is a symlinked baseline dir (/etc → /data00/etc): relocate moves the
  // baseline allow and every rule below it to the real path.
  const lexicalDeny: FsRule = { path: '/etc/resolv.conf', access: 'deny', source: 'user' };
  const pre: FsRule[] = [
    { path: '/etc', access: 'readOnly', source: 'baseline' },
    lexicalDeny,
  ];
  const compiled: FsRule[] = [
    { path: '/data00/etc', access: 'readOnly', source: 'baseline' },
    { path: '/data00/etc/resolv.conf', access: 'deny', source: 'user' },
  ];

  it('still suppresses a lexical deny that relocation moved off the name', () => {
    const denied = resolverPathDenied(pre, compiled);
    // Judging by compiled rules alone this name is not denied (the bind would
    // come back); the input-policy branch of the union must keep it suppressed.
    expect(accessForPath(compiled, '/etc/resolv.conf')).not.toBe('deny');
    expect(denied('/etc/resolv.conf')).toBe(true);
    // The relocated name is denied by the compiled set.
    expect(denied('/data00/etc/resolv.conf')).toBe(true);
  });

  it('does not suppress when neither rule set denies the resolver', () => {
    const denied = resolverPathDenied(
      [{ path: '/etc', access: 'readOnly', source: 'baseline' }],
      [{ path: '/data00/etc', access: 'readOnly', source: 'baseline' }],
    );
    expect(denied('/etc/resolv.conf')).toBe(false);
    expect(denied('/run/systemd/resolve/stub-resolv.conf')).toBe(false);
  });

  it('suppresses on a canonical deny present in both sets', () => {
    const target = '/run/systemd/resolve/stub-resolv.conf';
    const rule: FsRule = { path: target, access: 'deny', source: 'user' };
    expect(resolverPathDenied([rule], [rule])(target)).toBe(true);
  });
});

// Real bwrap, real mounts: a private mount + PID namespace recreates the
// systemd-resolved shape (/etc/resolv.conf → ../run/systemd/resolve/
// stub-resolv.conf) on copy-on-write overlays of /etc and /run, so the host's
// own files are never touched and every mount dies with the namespace.
const runtime = privateMountNsAvailable();
const networkPolicyTools = spawnSync('sh', ['-c', 'command -v slirp4netns && command -v nft && command -v ip'], { stdio: 'ignore' }).status === 0;
// Under node the network runner's --inside self-reexec resolves a fixed .js
// entry, so the policy e2e additionally needs a built dist/ tree (bun runs the
// .ts source natively).
const builtNetworkRunner = fileURLToPath(new URL('../dist/sandbox-network-runner.js', import.meta.url));
const networkPolicyRuntime = runtime && networkPolicyTools && (isBunRuntime() || existsSync(builtNetworkRunner));
const bases: string[] = [];
afterEach(() => { for (const base of bases.splice(0)) rmdirSync(base); });

describe.skipIf(!runtime)('sandboxes on a host whose /etc/resolv.conf points into /run (private namespace)', () => {
  function run(mode: 'oncall' | 'oncall-policy' | 'scratch', deny?: string, shape: 'stub' | 'linkdir' = 'stub') {
    // Outside /tmp: scratch never overlays submounts under it.
    const base = mkdtempSync(join(resolve('.'), '.resolv-mounts-'));
    bases.push(base);
    // The network-policy path needs the built tree under node; every other
    // mode exercises the TS source directly on both engines.
    const directSandboxEntry = mode === 'oncall-policy' && !isBunRuntime()
      ? './dist/adapters/backend/sandbox.js'
      : './src/adapters/backend/sandbox.js';
    const result = runInPrivateMountNs(`
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { spawnSyncTsScript } from './test/helpers/ts-runner.js';
// The network runner re-execs itself through resolveEntrySpawn (a fixed .js
// entry), so under node the policy path needs the BUILT dist tree; bun maps
// the .js specifier to the .ts source. Non-policy modes are src-only on both.
const directEntry = ${JSON.stringify(directSandboxEntry)};
const { prepareDirectSandbox } = await import(directEntry);
const { prepareScratchSandbox } = await import('./src/adapters/backend/scratch-sandbox.js');
const base = ${JSON.stringify(base)};
const sh = (cmd) => { const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(cmd + ': ' + r.stderr); };
for (const d of ['etc', 'run']) mkdirSync(join(base, d, 'u'), { recursive: true }), mkdirSync(join(base, d, 'w'));
sh(\`mount -t overlay overlay -o lowerdir=/etc,upperdir=\${base}/etc/u,workdir=\${base}/etc/w /etc\`);
sh(\`mount -t overlay overlay -o lowerdir=/run,upperdir=\${base}/run/u,workdir=\${base}/run/w /run\`);
const content = 'nameserver 192.0.2.53\\noptions edns0\\n';
if (${JSON.stringify(shape)} === 'linkdir') {
  // A symlinked DIRECTORY under /run: the fresh tmpfs has neither name, so
  // the bind must land at the literal /run/dnsproxy/resolv.conf hop.
  mkdirSync('/run/sub/dnsproxy', { recursive: true });
  symlinkSync('/run/sub/dnsproxy', '/run/dnsproxy');
  writeFileSync('/run/sub/dnsproxy/resolv.conf', content);
  rmSync('/etc/resolv.conf', { force: true });
  symlinkSync('/run/dnsproxy/resolv.conf', '/etc/resolv.conf');
} else {
  mkdirSync('/run/systemd/resolve', { recursive: true });
  writeFileSync('/run/systemd/resolve/stub-resolv.conf', content);
  rmSync('/etc/resolv.conf', { force: true });
  symlinkSync('../run/systemd/resolve/stub-resolv.conf', '/etc/resolv.conf');
}
const work = join(base, 'work');
mkdirSync(work);
const dataDir = join(base, 'data');
const cli = { cliBin: '/bin/sh', cliArgs: ['-c', 'cat /etc/resolv.conf'] };
const withPolicy = ${JSON.stringify(mode)} === 'oncall-policy';
const sbx = ${JSON.stringify(mode)} === 'scratch'
  ? prepareScratchSandbox({ sessionId: 'resolv', dataDir, storage: 'tmpfs', chdir: work, home: work, ...cli,
    ...(${JSON.stringify(deny ?? null)} ? { denyPaths: [${JSON.stringify(deny ?? '')}] } : {}) })
  : prepareDirectSandbox({
    sessionId: 'resolv', dataDir, chdir: work, home: work, ...cli,
    ...(withPolicy ? { networkPolicy: { version: 1, public: { mode: 'allow' }, private: { mode: 'allow' }, dnsServers: ['10.9.9.9'] } } : {}),
    policy: { rules: [
      { path: '/etc', access: 'readOnly', source: 'internal' },
      { path: '/usr', access: 'readOnly', source: 'internal' },
      ...(${JSON.stringify(deny ?? null)} ? [{ path: ${JSON.stringify(deny ?? '')}, access: 'deny', source: 'user' }] : []),
      { path: work, access: 'readWrite', source: 'internal' },
    ], net: true, writeRegexes: [] },
  });
if (!sbx) throw new Error('prepare failed');
// The network-policy runner entry is src/sandbox-network-runner.js, which
// exists only in a built tree; point the TS-source run at the .ts sibling
// (both engines run it: node via the tsx loader, bun natively).
const spawnOpts = { env: { ...process.env, ...sbx.env }, encoding: 'utf8', timeout: 60_000 };
let runnerScript = sbx.args[0];
if (withPolicy && !existsSync(runnerScript) && runnerScript.endsWith('.js')) {
  const tsEntry = runnerScript.slice(0, -3) + '.ts';
  if (existsSync(tsEntry)) runnerScript = tsEntry;
}
const r = withPolicy
  ? spawnSyncTsScript(runnerScript, sbx.args.slice(1), spawnOpts)
  : spawnSync(sbx.bin, sbx.args, spawnOpts);
const empty = join(dataDir, 'sandboxes', 'resolv', 'empties');
if (existsSync(empty)) chmodSync(empty, 0o700);
console.log(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, content }));
`, { tmpfs: [base] });
    return lastJsonLine<{ status: number; stdout: string; stderr: string; content: string }>(result);
  }

  it('oncall reads the host resolver file', () => {
    const r = run('oncall');
    expect(r.stdout, r.stderr).toBe(r.content);
  });

  // The worker canonicalizes policy rules, so a deny of /etc/resolv.conf
  // reaches the sandbox as its /run target; both spellings must win.
  it.each(['/etc/resolv.conf', '/run/systemd/resolve/stub-resolv.conf'])('oncall keeps an operator deny of %s', deny => {
    expect(run('oncall', deny).stdout).toBe('');
  });

  it('oncall follows a symlinked directory under /run to the host resolver file', () => {
    const r = run('oncall', undefined, 'linkdir');
    expect(r.stdout, r.stderr).toBe(r.content);
  });

  it.skipIf(!networkPolicyRuntime)('oncall with a network policy binds the explicit DNS file at the literal hop', () => {
    const r = run('oncall-policy', undefined, 'linkdir');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('nameserver 10.9.9.9\n');
  });

  it('scratch reads the host resolver file', () => {
    const r = run('scratch');
    expect(r.stdout, r.stderr).toBe(r.content);
  });

  it('scratch follows a symlinked directory under /run to the host resolver file', () => {
    const r = run('scratch', undefined, 'linkdir');
    expect(r.stdout, r.stderr).toBe(r.content);
  });

  it('scratch keeps an operator deny of /etc/resolv.conf', () => {
    expect(run('scratch', '/etc/resolv.conf').stdout).toBe('');
  });
});
