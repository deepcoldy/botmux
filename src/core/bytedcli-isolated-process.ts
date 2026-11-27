import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { systemBwrapPath } from './system-bwrap.js';
import { BytedcliBrokerError, type BytedcliChildInvocation, type BytedcliTrustedCli } from './bytedcli-broker-process.js';

const libraries = ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib/aarch64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/lib64', '/usr/lib64'];
const networkFiles = ['/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/ssl/certs', '/etc/pki/tls/certs'];
const contains = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); };
function fail(): never { throw new BytedcliBrokerError('executor_unavailable'); }

/** Only the runtime, frozen installation/dependency trees, fixed system
 * libraries/CA/DNS and this request enter a new root. In particular, neither
 * the host root, HOME, privateRoot, nor the host PID view is mounted. A missing
 * kernel feature is an execution failure, never permission to run natively. */
export function isolateBytedcliInvocation(invocation: BytedcliChildInvocation, cli: BytedcliTrustedCli, requestRoot: string): BytedcliChildInvocation {
  if (process.platform !== 'linux') fail();
  const bwrap = systemBwrapPath(); if (!bwrap) fail();
  const tool = statSync(bwrap);
  if (tool.uid !== 0 || tool.mode & 0o022 || !cli.stillCurrent()) fail();
  const home = invocation.env.HOME;
  if (!home || !isAbsolute(requestRoot) || resolve(requestRoot) !== requestRoot || requestRoot === '/'
    || dirname(home) !== requestRoot || dirname(invocation.cwd) !== requestRoot) fail();
  const requestStat = lstatSync(requestRoot);
  if (!requestStat.isDirectory() || requestStat.isSymbolicLink() || requestStat.mode & 0o077
    || process.getuid && requestStat.uid !== process.getuid()) fail();
  const args = ['--die-with-parent', '--new-session', '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--cap-drop', 'ALL', '--clearenv', '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  const bound = new Set<string>();
  const bind = (source: string, system = false) => {
    if (!isAbsolute(source) || resolve(source) !== source || source === '/' || source === process.env.HOME
      || contains(source, requestRoot) || contains(requestRoot, source)) fail();
    if (!existsSync(source)) return; // absent Node ancestor search roots remain frozen by cli.stillCurrent()
    const real = realpathSync(source); const stat = statSync(real);
    if ((!stat.isDirectory() && !stat.isFile()) || stat.mode & 0o022 || system && stat.uid !== 0) fail();
    if (bound.has(source)) return;
    bound.add(source); args.push('--ro-bind', real, source);
  };
  for (const path of libraries) bind(path, true);
  for (const path of networkFiles) bind(path, true);
  // The discovery descriptor also protects dirname(runtime), but mounting an
  // entire bin directory is unnecessary. Bind only the executable itself.
  for (const path of cli.protectedPaths ?? []) if (path !== dirname(cli.executable)) bind(path);
  bind(cli.executable);
  if (cli.dbRuntime) {
    if (!cli.dbRuntime.stillCurrent()) fail();
    // Source aliases are protected host paths, but only the independent code
    // executable is needed inside the request namespace.
    bind(cli.dbRuntime.executable);
  }
  if (cli.prefixArgs?.[0] && ![...bound].some(root => contains(root, cli.prefixArgs![0]!))) fail();
  for (const key of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const path = invocation.env[key]; if (path) { if (!existsSync(path)) fail(); bind(path); }
  }
  args.push('--ro-bind', requestRoot, requestRoot, '--bind', home, home, '--bind', invocation.cwd, invocation.cwd,
    '--chdir', invocation.cwd, '--remount-ro', '/tmp', '--remount-ro', '/');
  for (const [key, value] of Object.entries(invocation.env)) if (value !== undefined) args.push('--setenv', key, value);
  args.push('--', invocation.executable, ...invocation.argv);
  return { ...invocation, executable: bwrap, argv: args };
}
