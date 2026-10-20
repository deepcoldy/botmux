import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { posix } from 'node:path';
import type { WorkerConfig } from '../global-config.js';

export const DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION = 0.25;
/** Upper bound for the fraction-derived default reserve. The reserve only has
 *  to cover spawning ONE worker — production measurement of ~200 live CLI
 *  workers showed RSS p99 ≈ 0.43 GiB / max ≈ 0.57 GiB, so 4 GiB already
 *  leaves ~7x headroom and the fraction must not grow with capacity. Without
 *  this cap a 248 GiB host demanded ~62 GiB free to start a single worker,
 *  rejecting spawns at 60 GiB available with zero PSI stall.
 *  The default reserve is min(cap, 25% of total) for the host and for finite
 *  cgroup limits (v1 or v2) alike: ≥16 GiB → 4 GiB, an 8 GiB box → 2 GiB.
 *  There is deliberately NO 4 GiB floor on the host path: on a sub-4 GiB VPS
 *  that floor exceeded the whole RAM, MemAvailable could never reach it, and
 *  every worker fork was rejected. The live PSI gate (maxMemoryFullAvg10)
 *  remains the signal for genuine host-wide contention. */
export const DEFAULT_MIN_AVAILABLE_MEMORY_CAP_BYTES = 4 * 1024 ** 3;
export const DEFAULT_MAX_MEMORY_FULL_AVG10 = 20;
/**
 * Edge-of-rejection band for worker admission: when available memory is below
 * the reserve by at most this fraction, the fork may reclaim idle workers and
 * retry once instead of being rejected immediately. PSI pressure never qualifies
 * for the marginal band (its avg10 window is ~10s, a 2s retry is meaningless).
 */
export const MARGINAL_AVAILABLE_MEMORY_MARGIN = 0.1;

export type MemoryMetricSource = 'host' | 'cgroup-v2' | 'cgroup-v1' | 'unavailable';

export interface CgroupMemoryBoundary {
  version: 1 | 2;
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

/**
 * cgroup v1 reports "no limit" as the page-counter sentinel
 * 9223372036854771712 (= 2^63 - 4096), not a `max` token. It exceeds
 * Number.MAX_SAFE_INTEGER, so a plain Number()+isSafeInteger parse would
 * classify an unlimited hierarchy as a parse failure (degraded) instead of
 * unlimited — silently dropping host protection on every bare-metal v1 host.
 * Compare as BigInt and return 'max' for any sentinel-sized value.
 */
const CGROUP_V1_LIMIT_SENTINEL = 9223372036854771712n;

function parseV1ByteValue(raw: string): number | 'max' | undefined {
  const value = raw.trim();
  if (value === 'max') return 'max';
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = BigInt(value);
  if (parsed >= CGROUP_V1_LIMIT_SENTINEL) return 'max';
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
}

function parseInactiveFile(raw: string, version: 1 | 2): number | undefined {
  // cgroup v1's memory.usage_in_bytes is hierarchical. On kernels that expose
  // both fields, `inactive_file` is local to this cgroup while
  // `total_inactive_file` includes descendants and therefore matches the usage
  // scope. Prefer the total only for v1; cgroup v2's `inactive_file` already
  // describes the current cgroup tree and has no standard total_* twin.
  const match = (version === 1 ? /^total_inactive_file\s+(\d+)$/m.exec(raw) : undefined)
    ?? /^inactive_file\s+(\d+)$/m.exec(raw);
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

/**
 * Find the cgroup-v1 membership record whose hierarchy owns the memory
 * controller, e.g. `4:memory:/docker/demo` or `9:cpu,memory:/tenant/x`.
 * Named hierarchies (`1:name=systemd:/...`) and co-mounted controllers
 * without memory are ignored. An empty path means the cgroup root.
 */
function parseV1MemoryCgroupPath(raw: string): string | undefined {
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(':');
    if (fields.length !== 3) continue;
    const [hierarchyId, controllers, path] = fields;
    if (!/^\d+$/.test(hierarchyId) || hierarchyId === '0') continue;
    const hasMemory = controllers.split(',').some(controller => controller === 'memory');
    if (!hasMemory) continue;
    if (path === '') return '/';
    if (path.startsWith('/')) return posix.normalize(path);
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

type CgroupMountFilter =
  | { fstype: 'cgroup2' }
  | { fstype: 'cgroup'; controller: string };

function parseCgroupMounts(raw: string, filter: CgroupMountFilter): CgroupMount[] {
  const mounts: CgroupMount[] = [];
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 5 || after[0] !== filter.fstype) continue;
    if (filter.fstype === 'cgroup') {
      // cgroup-v1 super-block options list the co-mounted controllers, e.g.
      // `cgroup cgroup rw,memory` or `cgroup cgroup rw,cpu,memory`. Named
      // hierarchies carry `name=systemd` and never a bare controller name.
      const superOptions = after.slice(2).flatMap(value => value.split(','));
      if (!superOptions.includes(filter.controller)) continue;
    }
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
      // hierarchyComplete is true only for a mount rooted at '/'. When the
      // cgroup fs is bind-mounted from a nested sub-root (e.g. root '/docker'
      // inside a container), ancestors ABOVE the mount point are not visible
      // in this namespace, so we cannot prove there is no tighter limit
      // toward the hierarchy root. A candidate that finds no finite limit on
      // such a mount degrades to 'unavailable' (fail-open) instead of
      // 'unlimited', and the ancestor walk stops at the mount point. This
      // applies to v1 and v2 alike; v2 already behaved this way on master.
      hierarchyComplete: mount.root === '/',
    };
  }).sort((a, b) => Number(b.hierarchyComplete) - Number(a.hierarchyComplete));
}

interface CgroupFileNames {
  limit: string;
  current: string;
  stat: string;
  pressure: string;
}

const CGROUP_V2_FILES: CgroupFileNames = {
  limit: 'memory.max',
  current: 'memory.current',
  stat: 'memory.stat',
  pressure: 'memory.pressure',
};

const CGROUP_V1_FILES: CgroupFileNames = {
  limit: 'memory.limit_in_bytes',
  current: 'memory.usage_in_bytes',
  stat: 'memory.stat',
  pressure: 'memory.pressure',
};

function readBoundary(
  version: 1 | 2,
  directory: string,
  memoryMax: number,
  hostTotalMemoryBytes: number,
  readFile: (path: string) => string,
  warnings: string[],
  files: CgroupFileNames,
): CgroupMemoryBoundary | undefined {
  if (memoryMax > hostTotalMemoryBytes) return undefined;
  let availableMemoryBytes: number | undefined;
  try {
    const current = parseCgroupValue(readFile(posix.join(directory, files.current)));
    if (typeof current === 'number') {
      let inactiveFile = 0;
      try {
        inactiveFile = parseInactiveFile(readFile(posix.join(directory, files.stat)), version) ?? 0;
      } catch {}
      const workingSet = Math.max(0, current - Math.min(inactiveFile, current));
      availableMemoryBytes = Math.max(0, Math.min(memoryMax, memoryMax - workingSet));
    } else {
      warnings.push(`${directory}/${files.current} has no valid byte value`);
    }
  } catch (error) {
    warnings.push(`cannot read ${directory}/${files.current}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // cgroup v1 has no standard per-cgroup PSI file (memory.pressure only exists
  // on v2 or on vendor kernels that backported it). Its absence is normal and
  // must NOT push a warning, and a finite v1 container must NOT fall back to
  // /proc/pressure/memory: that file reports host-wide stall, not the
  // container's, so a busy neighbour on the host would reject container spawns
  // that have ample headroom against their own limit.
  let memoryFullAvg10: number | undefined;
  try {
    memoryFullAvg10 = parseMemoryFullAvg10(readFile(posix.join(directory, files.pressure)));
    if (version === 2 && memoryFullAvg10 === undefined) {
      warnings.push(`${directory}/${files.pressure} has no valid full avg10 value`);
    }
  } catch (error) {
    if (version === 2) {
      warnings.push(`cannot read ${directory}/${files.pressure}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    version,
    totalMemoryBytes: memoryMax,
    ...(availableMemoryBytes !== undefined ? { availableMemoryBytes } : {}),
    ...(memoryFullAvg10 !== undefined ? { memoryFullAvg10 } : {}),
    cgroupPath: directory,
  };
}

function resolveCgroupMemoryHierarchy(
  version: 1 | 2,
  membershipPath: string,
  mounts: CgroupMount[],
  fallbackRoot: string,
  hostTotalMemoryBytes: number,
  readFile: (path: string) => string,
  files: CgroupFileNames,
  parseLimit: (raw: string) => number | 'max' | undefined,
): CgroupMemoryResult {
  const unavailableWarnings: string[] = [];
  for (const candidate of cgroupCandidates(membershipPath, mounts, fallbackRoot)) {
    const boundaries: CgroupMemoryBoundary[] = [];
    const warnings: string[] = [];
    let directory = candidate.directory;
    let complete = true;
    while (directory === candidate.mountPoint || directory.startsWith(`${candidate.mountPoint}/`)) {
      let memoryMax: number | 'max' | undefined;
      try {
        memoryMax = parseLimit(readFile(posix.join(directory, files.limit)));
      } catch (error) {
        complete = false;
        warnings.push(`cannot read ${directory}/${files.limit}: ${error instanceof Error ? error.message : String(error)}`);
        if (directory === candidate.mountPoint) break;
        directory = posix.dirname(directory);
        continue;
      }
      if (memoryMax === undefined) {
        complete = false;
        warnings.push(`${directory}/${files.limit} has no valid byte value or max token`);
      } else if (typeof memoryMax === 'number') {
        const boundary = readBoundary(version, directory, memoryMax, hostTotalMemoryBytes, readFile, warnings, files);
        if (boundary) boundaries.push(boundary);
      }
      if (directory === candidate.mountPoint) break;
      directory = posix.dirname(directory);
    }
    if (boundaries.length > 0 && candidate.hierarchyComplete) return { kind: 'finite', boundaries, warnings };
    if (boundaries.length > 0) warnings.push(`${candidate.mountPoint} does not expose finite ancestor limits`);
    if (complete && candidate.hierarchyComplete) return { kind: 'unlimited' };
    if (complete) warnings.push(`${candidate.mountPoint} does not expose the full cgroup-v${version} hierarchy`);
    unavailableWarnings.push(...warnings);
  }
  return {
    kind: 'unavailable',
    warnings: unavailableWarnings.length > 0
      ? unavailableWarnings
      : [`cgroup-v${version} memory hierarchy could not be resolved`],
  };
}

function readCgroupV2MemoryPressure(
  hostTotalMemoryBytes: number,
  readFile: (path: string) => string,
  membershipRaw: string,
  mounts: CgroupMount[],
  cgroupRoot: string,
): CgroupMemoryResult {
  const membershipPath = parseUnifiedCgroupPath(membershipRaw);
  if (!membershipPath) return { kind: 'none' };
  return resolveCgroupMemoryHierarchy(
    2, membershipPath, mounts, cgroupRoot, hostTotalMemoryBytes, readFile,
    CGROUP_V2_FILES, parseCgroupValue,
  );
}

function readCgroupV1MemoryPressure(
  hostTotalMemoryBytes: number,
  readFile: (path: string) => string,
  membershipRaw: string,
  mounts: CgroupMount[],
  cgroupRoot: string,
): CgroupMemoryResult {
  const membershipPath = parseV1MemoryCgroupPath(membershipRaw);
  if (!membershipPath) return { kind: 'none' };
  return resolveCgroupMemoryHierarchy(
    1, membershipPath, mounts, posix.join(cgroupRoot, 'memory'), hostTotalMemoryBytes, readFile,
    CGROUP_V1_FILES, parseV1ByteValue,
  );
}

function pressureFromBoundary(
  boundary: CgroupMemoryBoundary,
  boundaries: CgroupMemoryBoundary[],
  warnings: string[],
): HostMemoryPressure {
  const cgroupSource: MemoryMetricSource = boundary.version === 2 ? 'cgroup-v2' : 'cgroup-v1';
  return {
    totalMemoryBytes: boundary.totalMemoryBytes,
    ...(boundary.availableMemoryBytes !== undefined ? { availableMemoryBytes: boundary.availableMemoryBytes } : {}),
    ...(boundary.memoryFullAvg10 !== undefined ? { memoryFullAvg10: boundary.memoryFullAvg10 } : {}),
    totalMemorySource: cgroupSource,
    availableMemorySource: boundary.availableMemoryBytes === undefined ? 'unavailable' : cgroupSource,
    memoryFullAvg10Source: boundary.memoryFullAvg10 === undefined ? 'unavailable' : cgroupSource,
    cgroupPath: boundary.cgroupPath,
    cgroupBoundaries: boundaries,
    warnings,
  };
}

function finiteCgroupPressure(result: Extract<CgroupMemoryResult, { kind: 'finite' }>): HostMemoryPressure {
  const initial = result.boundaries.reduce((selected, boundary) => (
    boundary.totalMemoryBytes < selected.totalMemoryBytes ? boundary : selected
  ));
  return pressureFromBoundary(initial, result.boundaries, result.warnings);
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
  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';

  let membershipRaw: string;
  try {
    membershipRaw = readFile(posix.join(procRoot, 'self/cgroup'));
  } catch (error) {
    return {
      totalMemoryBytes,
      totalMemorySource: 'host',
      availableMemorySource: 'unavailable',
      memoryFullAvg10Source: 'unavailable',
      warnings: [`cannot read ${posix.join(procRoot, 'self/cgroup')}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  // mountinfo is read once and resolved against both hierarchy versions: a
  // pure v1 host has no `0::` record, while a hybrid host may expose a cgroup2
  // mount whose memory controller remains on v1 (memory.max then ENOENT).
  let v2Mounts: CgroupMount[] = [];
  let v1MemoryMounts: CgroupMount[] = [];
  try {
    const mountinfo = readFile(posix.join(procRoot, 'self/mountinfo'));
    v2Mounts = parseCgroupMounts(mountinfo, { fstype: 'cgroup2' });
    v1MemoryMounts = parseCgroupMounts(mountinfo, { fstype: 'cgroup', controller: 'memory' });
  } catch {}

  const v2 = readCgroupV2MemoryPressure(totalMemoryBytes, readFile, membershipRaw, v2Mounts, cgroupRoot);
  if (v2.kind === 'finite') return finiteCgroupPressure(v2);
  const v1 = readCgroupV1MemoryPressure(totalMemoryBytes, readFile, membershipRaw, v1MemoryMounts, cgroupRoot);
  if (v1.kind === 'finite') return finiteCgroupPressure(v1);

  // No finite container limit. Read host-wide /proc metrics only when a
  // hierarchy positively proved unlimited (bare metal / unlimited cgroup),
  // or when no memory-controller membership exists at all. If resolution
  // merely degraded (kind 'unavailable'), host PSI must NOT be substituted
  // for the missing container signal — that rejected healthy v1 containers
  // whenever an unrelated tenant stressed the host (PSI ~35% at the gate).
  const hierarchyProvedUnlimited = v2.kind === 'unlimited' || v1.kind === 'unlimited';
  const noMemoryHierarchy = v2.kind === 'none' && v1.kind === 'none';
  if (!hierarchyProvedUnlimited && !noMemoryHierarchy) {
    const warnings = [
      ...(v2.kind === 'unavailable' ? v2.warnings : []),
      ...(v1.kind === 'unavailable' ? v1.warnings : []),
    ];
    return {
      totalMemoryBytes,
      totalMemorySource: 'host',
      availableMemorySource: 'unavailable',
      memoryFullAvg10Source: 'unavailable',
      warnings: [...new Set(warnings)],
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
): ResolvedWorkerPressurePolicy {
  // Same formula for host RAM and finite cgroup limits — see the cap constant
  // for why there is neither an uncapped fraction nor a host-only floor.
  const defaultReserve = Math.min(
    DEFAULT_MIN_AVAILABLE_MEMORY_CAP_BYTES,
    Math.max(1, Math.ceil(totalMemoryBytes * DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION)),
  );
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
    const policy = resolveWorkerPressurePolicy(config, pressure.totalMemoryBytes);
    const reasons = evaluatePressureReasons(pressure, policy);
    return { allowed: reasons.length === 0, reasons, pressure, policy };
  }

  const evaluated = boundaries.map(boundary => {
    const candidate = pressureFromBoundary(boundary, boundaries, pressure.warnings);
    const policy = resolveWorkerPressurePolicy(config, boundary.totalMemoryBytes);
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
      ? {
          availableMemoryBytes: available.candidate.availableMemoryBytes,
          availableMemorySource: available.candidate.availableMemorySource,
        }
      : { availableMemoryBytes: undefined, availableMemorySource: 'unavailable' as const }),
    ...(psi.candidate.memoryFullAvg10 !== undefined
      ? {
          memoryFullAvg10: psi.candidate.memoryFullAvg10,
          memoryFullAvg10Source: psi.candidate.memoryFullAvg10Source,
        }
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

/**
 * Admission tiers for a (possibly rejected) decision:
 *  - `allowed`: proceed with the fork.
 *  - `marginal`: rejected ONLY by the available-memory dimension and the
 *    shortfall is within {@link MARGINAL_AVAILABLE_MEMORY_MARGIN} of the reserve;
 *    the caller may reclaim idle workers, wait briefly and re-check once.
 *  - `hard`: PSI pressure is active (its 10s window makes a 2s retry pointless),
 *    the memory shortfall exceeds the marginal band, or the rejection cannot be
 *    attributed to a recoverable memory shortfall — reject immediately.
 */
export type WorkerAdmissionTier = 'allowed' | 'marginal' | 'hard';

export function tierWorkerAdmission(decision: WorkerAdmissionDecision): WorkerAdmissionTier {
  if (decision.allowed) return 'allowed';
  // PSI hit (alone or together with the memory dimension) is always hard.
  if (evaluatePsiReason(decision.pressure, decision.policy).length > 0) return 'hard';
  if (evaluateAvailableReason(decision.pressure, decision.policy).length === 0) return 'hard';
  const available = decision.pressure.availableMemoryBytes ?? 0;
  const marginalFloor = decision.policy.minAvailableMemoryBytes * (1 - MARGINAL_AVAILABLE_MEMORY_MARGIN);
  return available >= marginalFloor ? 'marginal' : 'hard';
}

export function formatMemoryBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
