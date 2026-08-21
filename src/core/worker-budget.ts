import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import type { WorkerConfig } from '../global-config.js';

export const DEFAULT_MIN_AVAILABLE_MEMORY_BYTES = 4 * 1024 ** 3;
export const DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION = 0.25;
export const DEFAULT_MAX_MEMORY_FULL_AVG10 = 20;

export interface HostMemoryPressure {
  totalMemoryBytes: number;
  availableMemoryBytes?: number;
  memoryFullAvg10?: number;
  warnings: string[];
}

export interface ResolvedWorkerPressurePolicy {
  minAvailableMemoryBytes: number;
  maxMemoryFullAvg10: number;
  sessionMemoryMaxBytes?: number;
  minAvailableMemorySource: 'default' | 'config';
  maxMemoryFullAvg10Source: 'default' | 'config';
}

export interface WorkerAdmissionDecision {
  allowed: boolean;
  reasons: string[];
  pressure: HostMemoryPressure;
  policy: ResolvedWorkerPressurePolicy;
}

function parseMemAvailable(raw: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(raw);
  if (!match) return undefined;
  const kib = Number(match[1]);
  return Number.isFinite(kib) ? kib * 1024 : undefined;
}

function parseMemoryFullAvg10(raw: string): number | undefined {
  const full = raw.split('\n').find(line => line.startsWith('full '));
  const match = full && /(?:^|\s)avg10=([0-9.]+)/.exec(full);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export function readHostMemoryPressure(options: {
  platform?: NodeJS.Platform;
  totalMemoryBytes?: number;
  readFile?: (path: string) => string;
} = {}): HostMemoryPressure {
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const warnings: string[] = [];
  const readFile = options.readFile ?? (path => readFileSync(path, 'utf8'));
  if ((options.platform ?? process.platform) !== 'linux') {
    return { totalMemoryBytes, warnings: ['memory pressure inspection is unavailable on this platform'] };
  }

  let availableMemoryBytes: number | undefined;
  let memoryFullAvg10: number | undefined;
  try {
    availableMemoryBytes = parseMemAvailable(readFile('/proc/meminfo'));
    if (availableMemoryBytes === undefined) warnings.push('/proc/meminfo has no valid MemAvailable value');
  } catch (error) {
    warnings.push(`cannot read /proc/meminfo: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    memoryFullAvg10 = parseMemoryFullAvg10(readFile('/proc/pressure/memory'));
    if (memoryFullAvg10 === undefined) warnings.push('/proc/pressure/memory has no valid full avg10 value');
  } catch (error) {
    warnings.push(`cannot read /proc/pressure/memory: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { totalMemoryBytes, availableMemoryBytes, memoryFullAvg10, warnings };
}

export function resolveWorkerPressurePolicy(
  config: WorkerConfig | undefined,
  totalMemoryBytes: number,
): ResolvedWorkerPressurePolicy {
  return {
    minAvailableMemoryBytes: config?.minAvailableMemoryBytes
      ?? Math.max(DEFAULT_MIN_AVAILABLE_MEMORY_BYTES, Math.ceil(totalMemoryBytes * DEFAULT_MIN_AVAILABLE_MEMORY_FRACTION)),
    maxMemoryFullAvg10: config?.maxMemoryFullAvg10 ?? DEFAULT_MAX_MEMORY_FULL_AVG10,
    ...(config?.sessionMemoryMaxBytes !== undefined
      ? { sessionMemoryMaxBytes: config.sessionMemoryMaxBytes }
      : {}),
    minAvailableMemorySource: config?.minAvailableMemoryBytes === undefined ? 'default' : 'config',
    maxMemoryFullAvg10Source: config?.maxMemoryFullAvg10 === undefined ? 'default' : 'config',
  };
}

export function evaluateWorkerAdmission(
  pressure: HostMemoryPressure,
  config?: WorkerConfig,
): WorkerAdmissionDecision {
  const policy = resolveWorkerPressurePolicy(config, pressure.totalMemoryBytes);
  const reasons: string[] = [];
  if (pressure.availableMemoryBytes !== undefined
    && pressure.availableMemoryBytes < policy.minAvailableMemoryBytes) {
    reasons.push(
      `MemAvailable ${formatMemoryBytes(pressure.availableMemoryBytes)} is below the reserved `
      + `${formatMemoryBytes(policy.minAvailableMemoryBytes)}`,
    );
  }
  if (pressure.memoryFullAvg10 !== undefined
    && pressure.memoryFullAvg10 >= policy.maxMemoryFullAvg10) {
    reasons.push(
      `memory full PSI avg10 ${pressure.memoryFullAvg10.toFixed(2)}% reached `
      + `${policy.maxMemoryFullAvg10.toFixed(2)}%`,
    );
  }
  return { allowed: reasons.length === 0, reasons, pressure, policy };
}

export function checkWorkerAdmission(config?: WorkerConfig): WorkerAdmissionDecision {
  return evaluateWorkerAdmission(readHostMemoryPressure(), config);
}

export function formatMemoryBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
