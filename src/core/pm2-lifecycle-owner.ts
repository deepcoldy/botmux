import { readdirSync, readFileSync, statSync } from 'node:fs';

export const BOTMUX_SYSTEMD_SERVICE = 'botmux.service';
export const BOTMUX_SYSTEMD_SERVICE_ENV = 'BOTMUX_SYSTEMD_SERVICE';

export interface LinuxPm2GodProcess {
  pid: number;
  cgroup: string;
  /** /proc/<pid>/stat starttime, bound while cmdline+cgroup were stable. */
  startIdentity?: string;
}

export type LinuxPm2GodOwnership =
  | { kind: 'absent' }
  | { kind: 'owned'; processes: LinuxPm2GodProcess[] }
  | { kind: 'external'; processes: LinuxPm2GodProcess[] };

type ExternalLinuxPm2GodOwnership = Extract<LinuxPm2GodOwnership, { kind: 'external' }>;

/** A stable CLI-facing refusal: never reuse or signal a God owned by another cgroup. */
export class ExternalPm2GodOwnershipError extends Error {
  readonly code = 'BOTMUX_PM2_EXTERNAL_OWNER';
  readonly exitCode = 2;

  constructor(ownership: ExternalLinuxPm2GodOwnership) {
    const owner = serviceOwnerFromCgroup(ownership.processes[0]?.cgroup ?? 'unknown');
    super([
      `检测到 PM2 God Daemon 归属于其它 supervisor (${owner}): ${describeExternalPm2Owner(ownership)}。`,
      '为避免复用外部 cgroup，本次操作已拒绝。',
      '迁移建议：',
      '1. 先确认所有 Botmux Session/Riff workload 已空闲；',
      '2. 由当前 owner 安全停止该 PM2 God generation（不要直接运行 `pm2 kill`，它会绕过 Botmux shutdown 校验）；',
      '3. 确认旧 God 已退出后，运行 `botmux restart`，由 botmux.service 建立新的 owner。',
    ].join('\n'));
    this.name = 'ExternalPm2GodOwnershipError';
  }
}

export type LinuxPm2Command = 'start' | 'restart' | 'status' | 'logs' | 'stop' | 'start-bot' | 'plugin';

export type LinuxPm2CommandPlan =
  | { kind: 'direct' }
  | { kind: 'handoff'; service: typeof BOTMUX_SYSTEMD_SERVICE }
  | { kind: 'absent' }
  | { kind: 'reject'; owner: string };

export interface LinuxPm2InspectionDeps {
  procEntries?: () => string[];
  readText?: (path: string) => string;
  currentUid?: number;
  statUid?: (path: string) => number;
}

function processDisappeared(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ESRCH' || code === 'ENOTDIR';
}

function procReadError(path: string, error: unknown): Error {
  return new Error(
    `cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function normalizedCgroupPath(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('/')) return trimmed;

  let unified: string | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    const first = line.indexOf(':');
    const second = first < 0 ? -1 : line.indexOf(':', first + 1);
    if (second < 0) continue;
    const hierarchy = line.slice(0, first);
    const controllers = line.slice(first + 1, second);
    const path = line.slice(second + 1).trim();
    if (!path) continue;
    if (controllers.split(',').includes('name=systemd')) return path;
    if (hierarchy === '0' && controllers === '') unified = path;
  }
  return unified;
}

function cgroupHasService(path: string | undefined, service = BOTMUX_SYSTEMD_SERVICE): boolean {
  return path?.split('/').includes(service) === true;
}

export function classifyLinuxPm2GodOwnership(
  entries: ReadonlyArray<LinuxPm2GodProcess>,
  service = BOTMUX_SYSTEMD_SERVICE,
): LinuxPm2GodOwnership {
  if (entries.length === 0) return { kind: 'absent' };
  const processes = entries.map(entry => ({
    pid: entry.pid,
    cgroup: normalizedCgroupPath(entry.cgroup) ?? '(unreadable)',
    ...(entry.startIdentity ? { startIdentity: entry.startIdentity } : {}),
  }));
  const external = processes.filter(entry => !cgroupHasService(entry.cgroup, service));
  return external.length === 0
    ? { kind: 'owned', processes }
    : { kind: 'external', processes: external };
}

export function linuxSystemdCgroupForPid(
  pid: number,
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): string {
  return normalizedCgroupPath(readText(`/proc/${pid}/cgroup`)) ?? '(unreadable)';
}

export function currentLinuxSystemdCgroup(
  readText: (path: string) => string = path => readFileSync(path, 'utf8'),
): string {
  return linuxSystemdCgroupForPid(process.pid, readText);
}

export function scanLinuxPm2GodPids(
  home: string,
  deps: LinuxPm2InspectionDeps = {},
): number[] {
  const procEntries = deps.procEntries ?? (() => readdirSync('/proc'));
  const readText = deps.readText ?? (path => readFileSync(path, 'utf8'));
  const marker = `God Daemon (${home})`;
  const currentUid = deps.currentUid ?? process.getuid?.();
  const statUid = deps.statUid ?? (path => statSync(path).uid);
  const pids: number[] = [];
  let entries: string[];
  try {
    entries = procEntries();
  } catch (error) {
    throw new Error(
      `cannot inspect /proc for PM2 God daemons: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (currentUid !== undefined) {
      try {
        // hidepid=1 deliberately makes another user's cmdline unreadable. It
        // cannot be our PM2_HOME owner, so exclude it before the fail-closed
        // candidate inspection below.
        if (statUid(`/proc/${pid}`) !== currentUid) continue;
      } catch (error) {
        if (processDisappeared(error)) continue;
        throw procReadError(`/proc/${pid}`, error);
      }
    }
    try {
      const cmdline = readText(`/proc/${pid}/cmdline`).replace(/\u0000/g, ' ').trim();
      if (cmdline.includes('PM2 v') && cmdline.includes(marker)) pids.push(pid);
    } catch (error) {
      // ENOENT/ESRCH is the normal process-table race. Permission and I/O
      // failures are unknown ownership, never evidence that no God exists.
      if (!processDisappeared(error)) throw procReadError(`/proc/${pid}/cmdline`, error);
    }
  }
  return [...new Set(pids)].sort((a, b) => a - b);
}

export function inspectLinuxPm2GodOwnership(
  home: string,
  deps: LinuxPm2InspectionDeps = {},
): LinuxPm2GodOwnership {
  const readText = deps.readText ?? (path => readFileSync(path, 'utf8'));
  const pids = scanLinuxPm2GodPids(home, deps);
  const processes: LinuxPm2GodProcess[] = [];
  for (const pid of pids) {
    try {
      const startBefore = linuxProcStartIdentity(readText(`/proc/${pid}/stat`));
      const cmdline = readText(`/proc/${pid}/cmdline`).replace(/\u0000/g, ' ').trim();
      if (!cmdline.includes('PM2 v') || !cmdline.includes(`God Daemon (${home})`)) continue;
      const cgroup = readText(`/proc/${pid}/cgroup`);
      const startAfter = linuxProcStartIdentity(readText(`/proc/${pid}/stat`));
      if (!startBefore || startBefore !== startAfter) {
        throw new Error(`PM2 God pid ${pid} changed generation during ownership inspection`);
      }
      processes.push({ pid, cgroup, startIdentity: startBefore });
    } catch (error) {
      // A God that exited after the cmdline scan is absent. Any other failure
      // leaves ownership unknown and must stop the lifecycle operation.
      if (!processDisappeared(error)) throw procReadError(`/proc/${pid}/cgroup`, error);
    }
  }
  return classifyLinuxPm2GodOwnership(processes);
}

function linuxProcStartIdentity(raw: string): string | undefined {
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return undefined;
  const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
  return fields[19] || undefined;
}

/** Rebind cmdline, cgroup and birth immediately before a PID-addressed signal. */
export function revalidateLinuxPm2GodProcess(
  expected: LinuxPm2GodProcess,
  home: string,
  deps: Pick<LinuxPm2InspectionDeps, 'readText'> = {},
): boolean {
  if (!expected.startIdentity) return false;
  const readText = deps.readText ?? (path => readFileSync(path, 'utf8'));
  try {
    const startBefore = linuxProcStartIdentity(readText(`/proc/${expected.pid}/stat`));
    const cmdline = readText(`/proc/${expected.pid}/cmdline`).replace(/\u0000/g, ' ').trim();
    const cgroup = normalizedCgroupPath(readText(`/proc/${expected.pid}/cgroup`));
    const startAfter = linuxProcStartIdentity(readText(`/proc/${expected.pid}/stat`));
    return startBefore === expected.startIdentity
      && startAfter === expected.startIdentity
      && cmdline.includes('PM2 v')
      && cmdline.includes(`God Daemon (${home})`)
      && cgroup === normalizedCgroupPath(expected.cgroup);
  } catch (error) {
    if (processDisappeared(error)) return false;
    throw procReadError(`/proc/${expected.pid}`, error);
  }
}

function serviceOwnerFromCgroup(path: string): string {
  const owner = path.split('/').reverse().find(
    part => part.endsWith('.service') || part.endsWith('.scope'),
  );
  return owner ?? path;
}

export function planLinuxPm2Command(input: {
  command: LinuxPm2Command;
  ownership: LinuxPm2GodOwnership;
  callerCgroup: string;
}): LinuxPm2CommandPlan {
  if (input.ownership.kind === 'external') {
    return {
      kind: 'reject',
      owner: serviceOwnerFromCgroup(input.ownership.processes[0]?.cgroup ?? 'unknown'),
    };
  }
  if (input.ownership.kind === 'owned') return { kind: 'direct' };
  if (input.command === 'start' || input.command === 'restart' || input.command === 'plugin') {
    if (cgroupHasService(normalizedCgroupPath(input.callerCgroup))) return { kind: 'direct' };
    if (input.command === 'plugin') return { kind: 'absent' };
    return { kind: 'handoff', service: BOTMUX_SYSTEMD_SERVICE };
  }
  return { kind: 'absent' };
}

export interface LinuxPm2CommandInspection {
  ownership: LinuxPm2GodOwnership;
  plan: LinuxPm2CommandPlan;
}

/** Bind one ownership snapshot and caller cgroup to one lifecycle decision. */
export function inspectLinuxPm2Command(input: {
  command: LinuxPm2Command;
  home: string;
  callerCgroup?: string;
}, deps: LinuxPm2InspectionDeps = {}): LinuxPm2CommandInspection {
  const ownership = inspectLinuxPm2GodOwnership(input.home, deps);
  return {
    ownership,
    plan: planLinuxPm2Command({
      command: input.command,
      ownership,
      callerCgroup: input.callerCgroup ?? currentLinuxSystemdCgroup(deps.readText),
    }),
  };
}

/** Project a status/logs request without ever creating a missing PM2 God. */
export function inspectLinuxPm2ReadonlyTarget(
  home: string,
  deps: LinuxPm2InspectionDeps = {},
): false | true | LinuxPm2GodProcess {
  const { ownership, plan } = inspectLinuxPm2Command({ command: 'status', home }, deps);
  if (plan.kind === 'absent') return false;
  if (plan.kind === 'reject') {
    if (ownership.kind !== 'external') {
      throw new Error('PM2 ownership plan rejected a non-external God');
    }
    throw new ExternalPm2GodOwnershipError(ownership);
  }
  if (plan.kind !== 'direct' || ownership.kind !== 'owned') return true;
  if (ownership.processes.length !== 1) {
    throw new Error(
      `PM2 read-only query found multiple Gods: ${ownership.processes.map(process => process.pid).join(', ')}`,
    );
  }
  return ownership.processes[0]!;
}

export function describeExternalPm2Owner(ownership: LinuxPm2GodOwnership): string {
  if (ownership.kind !== 'external') return '';
  return ownership.processes
    .map(entry => `${entry.pid}@${entry.cgroup}`)
    .join(', ');
}
