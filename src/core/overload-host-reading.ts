import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';
import type { HostReading } from './host-overload-alert.js';
import { parseVmStat } from './resource-monitor/darwin.js';
import { parseMeminfo } from './resource-monitor/procfs.js';

export interface OverloadHostReadingDeps {
  platform?: NodeJS.Platform;
  totalmem?: () => number;
  freemem?: () => number;
  loadavg?: () => number[];
  readMeminfo?: () => string;
  readVmStat?: () => string;
}

/** Cheap host counters only: reuse the dashboard's available-memory parsers,
 * without its process sweep. A failed native read throws so the caller keeps
 * its previous overload state; substituting os.freemem() for one tick would
 * change the metric and manufacture an alert or recovery. */
export function readOverloadHostReading(deps: OverloadHostReadingDeps = {}): HostReading {
  const reading: HostReading = {
    load15: (deps.loadavg ?? loadavg)()[2] ?? 0,
    memTotalBytes: (deps.totalmem ?? totalmem)(),
    memFreeBytes: (deps.freemem ?? freemem)(),
  };
  const hostPlatform = deps.platform ?? process.platform;
  if (hostPlatform === 'linux') {
    const raw = (deps.readMeminfo ?? (() => readFileSync('/proc/meminfo', 'utf8')))();
    // Old kernels without MemAvailable use the same MemFree fallback as the
    // dashboard; missing/malformed counters are not a valid zero reading.
    const lines = raw.split('\n');
    const counter = lines.find(line => line.startsWith('MemAvailable:'))
      ?? lines.find(line => line.startsWith('MemFree:'));
    if (!counter || !/^(?:MemAvailable|MemFree):[\t ]+\d+[\t ]+kB$/.test(counter)) {
      throw new Error('Host memory sample has no available-memory counter');
    }
    const mem = parseMeminfo(raw);
    reading.memTotalBytes = mem.memTotalBytes;
    reading.memAvailableBytes = mem.memAvailableBytes;
  } else if (hostPlatform === 'darwin') {
    const raw = (deps.readVmStat ?? (() => execFileSync('/usr/bin/vm_stat', {
      encoding: 'utf8', timeout: 500, maxBuffer: 64 * 1024,
    })))();
    const mem = parseVmStat(raw, reading.memTotalBytes);
    if (!mem) throw new Error('Host memory sample has invalid vm_stat counters');
    reading.memAvailableBytes = mem.memAvailableBytes;
  }
  const available = reading.memAvailableBytes ?? reading.memFreeBytes;
  if (!Number.isFinite(reading.memTotalBytes) || reading.memTotalBytes <= 0
    || !Number.isFinite(available) || available < 0 || available > reading.memTotalBytes) {
    throw new Error('Host memory sample is outside physical-memory bounds');
  }
  return reading;
}
