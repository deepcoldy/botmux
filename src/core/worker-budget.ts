import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { posix } from 'node:path';
import type { WorkerConfig } from '../global-config.js';

export const DEFAULT_MIN_AVAILABLE_MEMORY_BYTES = 4 * 1024 ** 3;
export const DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION = 0.25;
export const DEFAULT_MAX_MEMORY_FULL_AVG10 = 20;

export type MemoryMetricSource = 'host' | 'cgroup-v2' | 'unavailable';

export interface CgroupMemoryBoundary {
  totalMemoryBytes: number;
  availableMemoryBytes?: number;
  memoryFullAvg10?: number;
  cgroupPath: string;
}

export interface HostMemoryPressure {
  totalMemoryBytes: number;
  availableMemoryBytes?: number;
  memoryFullAvg10?: number;
  totalMemorySource: Exclude<MemoryMetricSource, 'unavailable'>;
  availableMemorySource: MemoryMetricSource;
  memoryFullAvg10Source: MemoryMetricSource;
  cgroupPath?: string;
  cgroupBoundaries?: CgroupMemoryBoundary[];
  warnings: string[];
}

export interface ResolvedWorkerPressurePolicy {
  memoryAdmissionEnabled: boolean;
  minAvailableMemoryBytes: number;
  maxMemoryFullAvg10: number;
  sessionMemoryMaxBytes?: number;
  memoryAdmissionEnabledSource: 'default' | 'config';
  minAvailableMemorySource: 'default' | 'config';
  maxMemoryFullAvg10Source: 'default' | 'config';
}

export interface WorkerAdmissionDecision {
  allowed: boolean;
  reasons: string[];
  pressure: HostMemoryPressure;
  policy: ResolvedWorkerPressurePolicy;
}

interface MemoryPressureReadOptions {
  platform?: NodeJS.Platform;
  totalMemoryBytes?: number;
  readFile?: (path: string) => string;
  procRoot?: string;
  cgroupRoot?: string;
}

interface CgroupMount {
  root: string;
  mountPoint: string;
}

type CgroupMemoryResult =
  | { kind: 'none' | 'unlimited' }
  | { kind: 'unavailable'; warnings: string[] }
  | { kind: 'finite'; boundaries: CgroupMemoryBoundary[]; warnings: string[] };

function parseMemAvailable(raw: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(raw);
  if (!match) return undefined;
  const kib = Number(match[1]);
  return Number.isSafeInteger(kib) ? kib * 1024 : undefined;
}

function parseMemoryFullAvg10(raw: string): number | undefined {
  const full = raw.split('\n').find(line => line.startsWith('full '));
  const match = full && /(?:^|\s)avg10=([0-9.]+)/.exec(full);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function parseCgroupValue(raw: string): number | 'max' | undefined {
  const value = raw.trim();
  if (value === 'max') return 'max';
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseInactiveFile(raw: string): number | undefined {
  const match = /^inactive_file\s+(\d+)$/m.exec(raw);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseUnifiedCgroupPath(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    const match = /^0::(\/.*)$/.exec(line.trim());
    if (!match) continue;
    return posix.normalize(match[1]);
  }
  return undefined;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, code: string) => {
    if (code === '040') return ' ';
    if (code === '011') return '\t';
    if (code === '012') return '\n';
    return '\\';
  });
}

function parseCgroupMounts(raw: string): CgroupMount[] {
  const mounts: CgroupMount[] = [];
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 5 || after[0] !== 'cgroup2') continue;
    mounts.push({
      root: posix.normalize(decodeMountInfoPath(before[3])),
      mountPoint: posix.normalize(decodeMountInfoPath(before[4])),
    });
  }
  return mounts;
}

function cgroupCandidates(
  membershipPath: string,
  mounts: CgroupMount[],
  fallbackRoot: string,
): Array<{ directory: string; mountPoint: string; hierarchyComplete: boolean }> {
  if (mounts.length === 0) {
    return [{
      directory: posix.join(fallbackRoot, membershipPath),
      mountPoint: fallbackRoot,
      hierarchyComplete: false,
    }];
  }
  return mounts.map(mount => {
    const membershipWithinRoot = membershipPath === mount.root || membershipPath.startsWith(`${mount.root}/`);
    const relative = membershipWithinRoot
      ? posix.relative(mount.root, membershipPath)
      : membershipPath.slice(1);
    return {
      directory: posix.join(mount.mountPoint, relative),
      mountPoint: mount.mountPoint,
      hierarchyComplete: mount.root === '/',
    };
  }).sort((a, b) => Number(b.hierarchyComplete) - Number(a.hierarchyComplete));
}

function readBoundary(
  directory: string,
  memoryMax: number,
  hostTotalMemoryBytes: number,
  readFile: (path: string) => string,
  warnings: string[],
): CgroupMemoryBoundary | undefined {
  if (memoryMax > hostTotalMemoryBytes) return undefined;
  let availableMemoryBytes: number | undefined;
  try {
    const current = parseCgroupValue(readFile(posix.join(directory, 'memory.current')));
    if (typeof current === 'number') {
      let inactiveFile = 0;
      try {
        inactiveFile = parseInactiveFile(readFile(posix.join(directory, 'memory.stat'))) ?? 0;
      } catch {}
      const workingSet = Math.max(0, current - Math.min(inactiveFile, current));
      availableMemoryBytes = Math.max(0, Math.min(memoryMax, memoryMax - workingSet));
    } else {
      warnings.push(`${directory}/memory.current has no valid byte value`);
    }
  } catch (error) {
    warnings.push(`cannot read ${directory}/memory.current: ${error instanceof Error ? error.message : String(error)}`);
  }

  let memoryFullAvg10: number | undefined;
  try {
    memoryFullAvg10 = parseMemoryFullAvg10(readFile(posix.join(directory, 'memory.pressure')));
    if (memoryFullAvg10 === undefined) warnings.push(`${directory}/memory.pressure has no valid full avg10 value`);
  } catch (error) {
    warnings.push(`cannot read ${directory}/memory.pressure: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    totalMemoryBytes: memoryMax,
    ...(availableMemoryBytes !== undefined ? { availableMemoryBytes } : {}),
    ...(memoryFullAvg10 !== undefined ? { memoryFullAvg10 } : {}),
    cgroupPath: directory,
  };
}

function readCgroupMemoryPressure(
  hostTotalMemoryBytes: number,
  readFile: (path: string) => string,
  procRoot: string,
  cgroupRoot: string,
): CgroupMemoryResult {
  let membershipRaw: string;
  try {
    membershipRaw = readFile(posix.join(procRoot, 'self/cgroup'));
  } catch (error) {
    return {
      kind: 'unavailable',
      warnings: [`cannot read ${posix.join(procRoot, 'self/cgroup')}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const membershipPath = parseUnifiedCgroupPath(membershipRaw);
  if (!membershipPath) return { kind: 'none' };

  let mounts: CgroupMount[] = [];
  try {
    mounts = parseCgroupMounts(readFile(posix.join(procRoot, 'self/mountinfo')));
  } catch {}

  const unavailableWarnings: string[] = [];
  for (const candidate of cgroupCandidates(membershipPath, mounts, cgroupRoot)) {
    const boundaries: CgroupMemoryBoundary[] = [];
    const warnings: string[] = [];
    let directory = candidate.directory;
    let complete = true;
    while (directory === candidate.mountPoint || directory.startsWith(`${candidate.mountPoint}/`)) {
      let memoryMax: number | 'max' | undefined;
      try {
        memoryMax = parseCgroupValue(readFile(posix.join(directory, 'memory.max')));
      } catch (error) {
        complete = false;
        warnings.push(`cannot read ${directory}/memory.max: ${error instanceof Error ? error.message : String(error)}`);
        if (directory === candidate.mountPoint) break;
        directory = posix.dirname(directory);
        continue;
      }
      if (memoryMax === undefined) {
        complete = false;
        warnings.push(`${directory}/memory.max has no valid byte value or max token`);
      } else if (typeof memoryMax === 'number') {
        const boundary = readBoundary(directory, memoryMax, hostTotalMemoryBytes, readFile, warnings);
        if (boundary) boundaries.push(boundary);
      }
      if (directory === candidate.mountPoint) break;
      directory = posix.dirname(directory);
    }
    if (boundaries.length > 0 && candidate.hierarchyComplete) return { kind: 'finite', boundaries, warnings };
    if (boundaries.length > 0) warnings.push(`${candidate.mountPoint} does not expose finite ancestor limits`);
    if (complete && candidate.hierarchyComplete) return { kind: 'unlimited' };
    if (complete) warnings.push(`${candidate.mountPoint} does not expose the full cgroup-v2 hierarchy`);
    unavailableWarnings.push(...warnings);
  }
  return {
    kind: 'unavailable',
    warnings: unavailableWarnings.length > 0
      ? unavailableWarnings
      : ['cgroup-v2 memory hierarchy could not be resolved'],
  };
}

function pressureFromBoundary(
  boundary: CgroupMemoryBoundary,
  boundaries: CgroupMemoryBoundary[],
  warnings: string[],
): HostMemoryPressure {
  return {
    totalMemoryBytes: boundary.totalMemoryBytes,
    ...(boundary.availableMemoryBytes !== undefined ? { availableMemoryBytes: boundary.availableMemoryBytes } : {}),
    ...(boundary.memoryFullAvg10 !== undefined ? { memoryFullAvg10: boundary.memoryFullAvg10 } : {}),
    totalMemorySource: 'cgroup-v2',
    availableMemorySource: boundary.availableMemoryBytes === undefined ? 'unavailable' : 'cgroup-v2',
    memoryFullAvg10Source: boundary.memoryFullAvg10 === undefined ? 'unavailable' : 'cgroup-v2',
    cgroupPath: boundary.cgroupPath,
    cgroupBoundaries: boundaries,
    warnings,
  };
}

export function readHostMemoryPressure(options: MemoryPressureReadOptions = {}): HostMemoryPressure {
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'));
  if ((options.platform ?? process.platform) !== 'linux') {
    return {
      totalMemoryBytes,
      totalMemorySource: 'host',
      availableMemorySource: 'unavailable',
      memoryFullAvg10Source: 'unavailable',
      warnings: ['memory pressure inspection is unavailable on this platform'],
    };
  }

  const procRoot = options.procRoot ?? '/proc';
  const cgroup = readCgroupMemoryPressure(
    totalMemoryBytes,
    readFile,
    procRoot,
    options.cgroupRoot ?? '/sys/fs/cgroup',
  );
  if (cgroup.kind === 'finite') {
    const initial = cgroup.boundaries.reduce((selected, boundary) => (
      boundary.totalMemoryBytes < selected.totalMemoryBytes ? boundary : selected
    ));
    return pressureFromBoundary(initial, cgroup.boundaries, cgroup.warnings);
  }
  if (cgroup.kind === 'unavailable') {
    return {
      totalMemoryBytes,
      totalMemorySource: 'host',
      availableMemorySource: 'unavailable',
      memoryFullAvg10Source: 'unavailable',
      warnings: cgroup.warnings,
    };
  }

  const warnings: string[] = [];
  let availableMemoryBytes: number | undefined;
  let memoryFullAvg10: number | undefined;
  const meminfoPath = posix.join(procRoot, 'meminfo');
  const pressurePath = posix.join(procRoot, 'pressure/memory');
  try {
    availableMemoryBytes = parseMemAvailable(readFile(meminfoPath));
    if (availableMemoryBytes === undefined) warnings.push(`${meminfoPath} has no valid MemAvailable value`);
  } catch (error) {
    warnings.push(`cannot read ${meminfoPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    memoryFullAvg10 = parseMemoryFullAvg10(readFile(pressurePath));
    if (memoryFullAvg10 === undefined) warnings.push(`${pressurePath} has no valid full avg10 value`);
  } catch (error) {
    warnings.push(`cannot read ${pressurePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    totalMemoryBytes,
    ...(availableMemoryBytes !== undefined ? { availableMemoryBytes } : {}),
    ...(memoryFullAvg10 !== undefined ? { memoryFullAvg10 } : {}),
    totalMemorySource: 'host',
    availableMemorySource: availableMemoryBytes === undefined ? 'unavailable' : 'host',
    memoryFullAvg10Source: memoryFullAvg10 === undefined ? 'unavailable' : 'host',
    warnings,
  };
}

export function resolveWorkerPressurePolicy(
  config: WorkerConfig | undefined,
  totalMemoryBytes: number,
  totalMemorySource: HostMemoryPressure['totalMemorySource'] = 'host',
): ResolvedWorkerPressurePolicy {
  const defaultReserve = totalMemorySource === 'cgroup-v2'
    ? Math.max(1, Math.ceil(totalMemoryBytes * DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION))
    : Math.max(DEFAULT_MIN_AVAILABLE_MEMORY_BYTES, Math.ceil(totalMemoryBytes * DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION));
  return {
    memoryAdmissionEnabled: config?.memoryAdmissionEnabled !== false,
    minAvailableMemoryBytes: config?.minAvailableMemoryBytes ?? defaultReserve,
    maxMemoryFullAvg10: config?.maxMemoryFullAvg10 ?? DEFAULT_MAX_MEMORY_FULL_AVG10,
    ...(config?.sessionMemoryMaxBytes !== undefined
      ? { sessionMemoryMaxBytes: config.sessionMemoryMaxBytes }
      : {}),
    memoryAdmissionEnabledSource: config?.memoryAdmissionEnabled === undefined ? 'default' : 'config',
    minAvailableMemorySource: config?.minAvailableMemoryBytes === undefined ? 'default' : 'config',
    maxMemoryFullAvg10Source: config?.maxMemoryFullAvg10 === undefined ? 'default' : 'config',
  };
}

export function evaluateWorkerAdmission(
  pressure: HostMemoryPressure,
  config?: WorkerConfig,
): WorkerAdmissionDecision {
  const boundaries = pressure.cgroupBoundaries;
  if (!boundaries || boundaries.length === 0) {
    const policy = resolveWorkerPressurePolicy(config, pressure.totalMemoryBytes, pressure.totalMemorySource);
    const reasons = evaluatePressureReasons(pressure, policy);
    return { allowed: reasons.length === 0, reasons, pressure, policy };
  }

  const evaluated = boundaries.map(boundary => {
    const candidate = pressureFromBoundary(boundary, boundaries, pressure.warnings);
    const policy = resolveWorkerPressurePolicy(config, boundary.totalMemoryBytes, 'cgroup-v2');
    const availableScore = boundary.availableMemoryBytes === undefined
      ? Number.POSITIVE_INFINITY
      : (boundary.availableMemoryBytes - policy.minAvailableMemoryBytes) / Math.max(1, policy.minAvailableMemoryBytes);
    const psiScore = boundary.memoryFullAvg10 === undefined
      ? Number.NEGATIVE_INFINITY
      : boundary.memoryFullAvg10 - policy.maxMemoryFullAvg10;
    return { candidate, policy, availableScore, psiScore };
  });
  const available = evaluated.reduce((selected, value) => (
    value.availableScore < selected.availableScore ? value : selected
  ));
  const psi = evaluated.reduce((selected, value) => value.psiScore > selected.psiScore ? value : selected);
  const reasons = [
    ...evaluateAvailableReason(available.candidate, available.policy),
    ...evaluatePsiReason(psi.candidate, psi.policy),
  ];
  const selected = available;
  const effectivePressure: HostMemoryPressure = {
    ...selected.candidate,
    ...(available.candidate.availableMemoryBytes !== undefined
      ? { availableMemoryBytes: available.candidate.availableMemoryBytes, availableMemorySource: 'cgroup-v2' as const }
      : { availableMemoryBytes: undefined, availableMemorySource: 'unavailable' as const }),
    ...(psi.candidate.memoryFullAvg10 !== undefined
      ? { memoryFullAvg10: psi.candidate.memoryFullAvg10, memoryFullAvg10Source: 'cgroup-v2' as const }
      : { memoryFullAvg10: undefined, memoryFullAvg10Source: 'unavailable' as const }),
  };
  return {
    allowed: reasons.length === 0,
    reasons,
    pressure: effectivePressure,
    policy: selected.policy,
  };
}

function evaluateAvailableReason(
  pressure: HostMemoryPressure,
  policy: ResolvedWorkerPressurePolicy,
): string[] {
  if (!policy.memoryAdmissionEnabled
    || pressure.availableMemoryBytes === undefined
    || pressure.availableMemoryBytes >= policy.minAvailableMemoryBytes) return [];
  return [
    `available memory ${formatMemoryBytes(pressure.availableMemoryBytes)} is below the reserved `
    + `${formatMemoryBytes(policy.minAvailableMemoryBytes)}`,
  ];
}

function evaluatePsiReason(
  pressure: HostMemoryPressure,
  policy: ResolvedWorkerPressurePolicy,
): string[] {
  if (!policy.memoryAdmissionEnabled
    || pressure.memoryFullAvg10 === undefined
    || pressure.memoryFullAvg10 < policy.maxMemoryFullAvg10) return [];
  return [
    `memory full PSI avg10 ${pressure.memoryFullAvg10.toFixed(2)}% reached `
    + `${policy.maxMemoryFullAvg10.toFixed(2)}%`,
  ];
}

function evaluatePressureReasons(
  pressure: HostMemoryPressure,
  policy: ResolvedWorkerPressurePolicy,
): string[] {
  return [...evaluateAvailableReason(pressure, policy), ...evaluatePsiReason(pressure, policy)];
}

export function checkWorkerAdmission(
  config?: WorkerConfig,
  options: MemoryPressureReadOptions = {},
): WorkerAdmissionDecision {
  if (config?.memoryAdmissionEnabled === false) {
    return evaluateWorkerAdmission({
      totalMemoryBytes: options.totalMemoryBytes ?? totalmem(),
      totalMemorySource: 'host',
      availableMemorySource: 'unavailable',
      memoryFullAvg10Source: 'unavailable',
      warnings: [],
    }, config);
  }
  return evaluateWorkerAdmission(readHostMemoryPressure(options), config);
}

export function formatMemoryBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
