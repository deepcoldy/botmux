import { spawnSync } from 'node:child_process';
import { isBotmuxSessionScopeUnit, userSystemdBusEnv } from './session-scope.js';
import { readProcessSystemdUnit } from '../utils/systemd-unit.js';

/**
 * Give the fleet its own systemd unit.
 *
 * `botmux start/restart` spawns the supervisor `detached`, which starts a new
 * session and process group but keeps the CALLER's cgroup. Run from inside a
 * bot session (an agent deploying botmux) the whole fleet — supervisor, every
 * daemon, every worker — therefore lived in that session's
 * `botmux-session-<sid>.scope`, and the session's own close / suspend / CLI
 * restart stops that scope (worker.ts `stopSessionScope`), which SIGKILLs the
 * fleet with it. A login scope (an SSH `session-N.scope`, cron, the operator's
 * own unit) has the same inheritance, but that cgroup was chosen by whoever
 * launched botmux and must not be taken over — see the move rule below.
 *
 * So before the supervisor forks anything it moves itself into a fresh
 * transient `botmux-fleet-*.scope`; members it forks afterwards inherit that
 * cgroup. Units that already exist for the fleet (the autostart service, the
 * crash watchdog, an earlier fleet scope) are kept as they are.
 *
 * The move is allowed ONLY while the supervisor runs in a botmux-created
 * per-session scope (`botmux-session-*.scope`). Those scopes are stopped on
 * session close, so a fleet launched from inside a bot session would otherwise
 * die with the session. Any other unit — an operator's own `.service` or
 * `.scope` chosen to supervise botmux, a logind login scope, cron, a container
 * — stays exactly where it was: moving out would steal the process from the
 * unit its owner started it under, after which their `systemctl stop/restart`
 * no longer reaches it. Failing to move is reported and the supervisor starts
 * where it is — never a reason to stay down.
 */

export type FleetScopeOutcome =
  | { action: 'kept'; unit: string }
  | { action: 'moved'; from: string; to: string }
  | { action: 'unsupported'; reason: string }
  | { action: 'failed'; unit: string; reason: string };

export interface FleetScopeRuntime {
  platform: NodeJS.Platform;
  pid: number;
  readUnit(pid: number): string | undefined;
  busEnv(): Record<string, string> | undefined;
  run(command: string, args: readonly string[], env: Record<string, string>): { status: number | null; stderr: string };
  now(): number;
  sleepMs(ms: number): void;
}

const DEDICATED_FLEET_UNIT_RE = /^(?:botmux\.service|botmux-watchdog\.service|botmux-fleet-[A-Za-z0-9_.-]+\.scope)$/;

export function isDedicatedFleetUnit(unit: string): boolean {
  return DEDICATED_FLEET_UNIT_RE.test(unit);
}

export function fleetScopeUnitName(pid: number, nowMs: number): string {
  return `botmux-fleet-${nowMs.toString(36)}-${pid}.scope`;
}

const defaultRuntime: FleetScopeRuntime = {
  platform: process.platform,
  pid: process.pid,
  readUnit: pid => readProcessSystemdUnit(pid),
  busEnv: () => userSystemdBusEnv(),
  run: (command, args, env) => {
    const r = spawnSync(command, [...args], {
      encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', ...env },
    });
    return { status: r.status, stderr: r.error?.message ?? r.stderr ?? '' };
  },
  now: () => Date.now(),
  sleepMs: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
};

export function moveSupervisorIntoFleetScope(
  over: Partial<FleetScopeRuntime> = {},
): FleetScopeOutcome {
  const rt: FleetScopeRuntime = { ...defaultRuntime, ...over };
  if (rt.platform !== 'linux') return { action: 'unsupported', reason: 'systemd scopes are Linux-only' };
  const unit = rt.readUnit(rt.pid);
  if (!unit) return { action: 'unsupported', reason: 'not in a systemd-managed cgroup' };
  // Defense in depth: today none of these matches the botmux-session-*.scope
  // rule below, so this branch has no observable effect of its own — but the
  // fleet's own units are an explicit allow-list that must keep the supervisor
  // even if the session-scope rule is ever broadened.
  if (isDedicatedFleetUnit(unit)) return { action: 'kept', unit };
  // Leave every non-botmux unit alone (an operator-owned .service/.scope, a
  // logind login scope, cron, a container): botmux did not create it and moving
  // the supervisor out would orphan it from the unit managing its lifecycle.
  if (!isBotmuxSessionScopeUnit(unit)) return { action: 'kept', unit };
  const busEnv = rt.busEnv();
  if (!busEnv) return { action: 'unsupported', reason: `no user systemd bus (staying in ${unit})` };
  const target = fleetScopeUnitName(rt.pid, rt.now());
  const r = rt.run('busctl', [
    '--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1',
    'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))',
    target, 'fail', '2', 'PIDs', 'au', '1', String(rt.pid), 'Description', 's', 'botmux fleet', '0',
  ], busEnv);
  if (r.status !== 0) {
    return { action: 'failed', unit, reason: r.stderr.trim() || `busctl exit ${r.status ?? 'unknown'}` };
  }
  // The call returns once the job is queued; the move lands when it runs.
  for (let i = 0; i < 40; i++) {
    if (rt.readUnit(rt.pid) === target) return { action: 'moved', from: unit, to: target };
    rt.sleepMs(25);
  }
  return { action: 'failed', unit, reason: `still in ${rt.readUnit(rt.pid) ?? 'an unknown cgroup'} after StartTransientUnit` };
}
