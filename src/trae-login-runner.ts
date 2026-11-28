/** Supervise native login; native holds a kernel lock across supervisor death. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '__trae-login-runner') args.shift();
const [bin, rootArg, deadlineArg] = args;
const deadline = Number(deadlineArg);
if (!bin || !rootArg || !Number.isSafeInteger(deadline) || deadline <= Date.now()) process.exit(1);
let native: ChildProcess | undefined;
let cancelled = false;
const stop = () => { cancelled = true; native?.kill('SIGKILL'); };
process.stdin.on('end', stop); process.stdin.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.stdout.on('error', stop); process.stderr.on('error', stop);
process.stdin.on('data', data => { if (!cancelled) native?.stdin?.write(data); });
process.stdin.resume();
const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
const root = realpathSync(rootArg!);
const lock = join(root, '.botmux-enterprise-login-' + createHash('sha256').update(root).digest('hex').slice(0, 12));
// Linux native login receives both the lock FD and the kernel parent-death
// signal. The shell checks PPID after the signal is armed, closing the race
// where the supervisor dies before setpriv initializes. Positional argv keeps
// paths and all native arguments literal; no caller content is shell code.
if (process.platform !== 'linux') { clearTimeout(timer); process.stdin.destroy(); process.exit(1); }
try {
  await new Promise<void>(resolveExit => {
    if (cancelled) { resolveExit(); return; }
    native = spawn('flock', ['-x', '-n', '--no-fork', lock,
      'setpriv', '--pdeathsig', 'KILL', '/bin/sh', '-c',
      'test "$PPID" = "$1" || exit 1; shift; exec "$@"',
      'botmux-trae-login', String(process.pid), bin!, 'login', '--enterprise'], {
      cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    native.stdout?.pipe(process.stdout, { end: false }); native.stderr?.pipe(process.stderr, { end: false });
    native.stdin?.on('error', stop);
    native.once('error', () => { process.exitCode = 1; resolveExit(); });
    native.once('exit', code => { process.exitCode = cancelled ? 1 : code ?? 1; resolveExit(); });
  });
} finally { clearTimeout(timer); process.stdin.destroy(); }
