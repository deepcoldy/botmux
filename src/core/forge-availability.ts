import { spawnSync } from 'node:child_process';
import { locateExecutable } from '../utils/executable.js';

export interface ForgeAvailability {
  available: boolean;
  reason?: string;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_DOCTOR_TIMEOUT_MS = 15_000;

let cached: { checkedAt: number; result: ForgeAvailability } | undefined;

function compactDoctorOutput(stdout: unknown, stderr: unknown): string {
  const text = `${typeof stdout === 'string' ? stdout : ''}\n${typeof stderr === 'string' ? stderr : ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join('; ');
  return text || 'forge doctor failed';
}

export function checkForgeTraexStartupAvailability(opts: {
  nowMs?: number;
  cacheTtlMs?: number;
  doctorTimeoutMs?: number;
  force?: boolean;
} = {}): ForgeAvailability {
  const nowMs = opts.nowMs ?? Date.now();
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!opts.force && cached && nowMs - cached.checkedAt < cacheTtlMs) return cached.result;

  const forgeBin = locateExecutable('forge');
  let result: ForgeAvailability;
  if (!forgeBin) {
    result = { available: false, reason: 'forge executable not found in PATH' };
  } else {
    const doctor = spawnSync(forgeBin, ['doctor'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.doctorTimeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS,
      env: process.env,
    });
    if (doctor.error) {
      result = {
        available: false,
        reason: doctor.error.message || 'forge doctor failed',
      };
    } else if (doctor.status !== 0) {
      result = {
        available: false,
        reason: compactDoctorOutput(doctor.stdout, doctor.stderr),
      };
    } else {
      result = { available: true };
    }
  }

  cached = { checkedAt: nowMs, result };
  return result;
}

export function __testOnly_clearForgeAvailabilityCache(): void {
  cached = undefined;
}
