import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { userSystemdBusEnv } from './session-scope.js';

/** detached/setsid does not escape a systemd cgroup. A restart from a session
 * must be launched by the user manager, outside the session's cleanup scope. */
export function needsSupervisorIsolation(): boolean {
  if (process.platform !== 'linux') return false;
  let cgroup: string;
  try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); }
  catch {
    if (process.env.BOTMUX_SESSION_ID) {
      throw new Error('[supervisor] Cannot verify session cgroup; start from the host service instead.');
    }
    return false;
  }
  return cgroup.split('\n').some(line => {
    const path = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1);
    return /(?:^|\/)botmux-(?:session-[^/]+\.scope|supervisor-[^/]+\.service)(?:\/|$)/.test(path);
  });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(command, args, {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ...userSystemdBusEnv() },
  });
}

/** Call before stopping an existing fleet. Never silently fall back to a child
 * of the caller's scope when the manager is unavailable. */
export function preflightSupervisorIsolation(): void {
  if (!needsSupervisorIsolation()) return;
  for (const [command, args] of [
    ['systemctl', ['--user', 'show', '--property=Version', '--value']],
    ['systemd-run', ['--version']],
  ] as const) {
    if (run(command, [...args], process.env).status !== 0) {
      throw new Error('[supervisor] Independent user service is unavailable; the existing fleet was not stopped.');
    }
  }
}

export interface IsolatedSupervisorCommand {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  env: NodeJS.ProcessEnv;
}

export function startIsolatedSupervisor(spec: IsolatedSupervisorCommand): number {
  const unit = `botmux-supervisor-${randomUUID()}.service`;
  const propertyPath = (path: string) => path.replaceAll('%', '%%');
  const args = [
    '--user', '--quiet', '--collect', '--service-type=exec', `--unit=${unit}`,
    '--slice=app.slice',
    // stopAll() owns daemon teardown. control-group would also kill an in-flight
    // restart driver when its old supervisor exits, before it starts a successor.
    '--property=KillMode=process',
    `--property=WorkingDirectory=${propertyPath(spec.cwd)}`,
    `--property=StandardOutput=append:${propertyPath(spec.stdout)}`,
    `--property=StandardError=append:${propertyPath(spec.stderr)}`,
    // Copy by name from systemd-run's environment. Values (including secrets)
    // must never be interpolated into command-line arguments or unit names.
    ...Object.keys(spec.env).filter(key => spec.env[key] !== undefined).map(key => `--setenv=${key}`),
    '--', spec.command, ...spec.args.map(arg => arg.replaceAll('$', () => '$$')),
  ];
  const started = run('systemd-run', args, spec.env);
  if (started.status !== 0) {
    // A timeout may still have created a service. Stop this unique attempted
    // generation; do not launch a duplicate via the unsafe detached path.
    run('systemctl', ['--user', 'stop', unit], spec.env);
    throw new Error(`[supervisor] Independent service launch failed (${unit}); inspect its user journal.`);
  }
  const shown = run('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], spec.env);
  const pid = Number(shown.stdout.trim());
  if (shown.status !== 0 || !Number.isSafeInteger(pid) || pid <= 1) {
    run('systemctl', ['--user', 'stop', unit], spec.env);
    throw new Error(`[supervisor] Independent service has no live MainPID (${unit}).`);
  }
  return pid;
}
