import { readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import type { ProcfsSample, ProcessResourceSample } from './types.js';

const PAGE_SIZE_BYTES = 4096;

function unsupportedSample(sampledAt: number): ProcfsSample {
  return {
    supported: false,
    sampledAt,
    reason: 'procfs_unavailable',
    totalCpuTicks: 0,
    idleCpuTicks: 0,
    loadavg: { load1: 0, load5: 0, load15: 0 },
    mem: { memTotalBytes: 0, memAvailableBytes: 0, swapTotalBytes: 0, swapFreeBytes: 0 },
    processes: [],
  };
}

export function parseSystemStat(raw: string): number {
  return parseSystemCpuTimes(raw).total;
}

export function parseSystemCpuTimes(raw: string): { total: number; idle: number } {
  const line = raw.split('\n').find(part => part.startsWith('cpu '));
  if (!line) return { total: 0, idle: 0 };
  const values = line.trim().split(/\s+/).slice(1).map(value => Number(value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  return { total, idle: (values[3] || 0) + (values[4] || 0) };
}

export function parseLoadavg(raw: string): { load1: number; load5: number; load15: number } {
  const [load1 = 0, load5 = 0, load15 = 0] = raw.trim().split(/\s+/).map(Number);
  return { load1: load1 || 0, load5: load5 || 0, load15: load15 || 0 };
}

export function parseMeminfo(raw: string): ProcfsSample['mem'] {
  const values = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/);
    if (!match) continue;
    values.set(match[1], Number(match[2]) * 1024);
  }
  return {
    memTotalBytes: values.get('MemTotal') ?? 0,
    memAvailableBytes: values.get('MemAvailable') ?? values.get('MemFree') ?? 0,
    swapTotalBytes: values.get('SwapTotal') ?? 0,
    swapFreeBytes: values.get('SwapFree') ?? 0,
  };
}

// Proportional Set Size from /proc/<pid>/smaps_rollup — shared pages are divided
// by the number of processes sharing them, so summing PSS across a process group
// does NOT double-count the shared Node runtime / libs the way summing RSS does.
// Returns null when unavailable (kernel < 4.14, no mm i.e. kernel threads,
// permission denied, or the process exited) so the caller can fall back to RSS.
export function parseSmapsRollupPss(raw: string): number | null {
  const match = raw.match(/^Pss:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : null;
}

export function parseProcessStat(raw: string): { pid: number; ppid: number; cpuTicks: number; startTicks: number; rssPages: number } | null {
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close < open) return null;

  const pid = Number(raw.slice(0, open).trim());
  const fieldsAfterComm = raw.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(fieldsAfterComm[1]);
  const utime = Number(fieldsAfterComm[11]) || 0;
  const stime = Number(fieldsAfterComm[12]) || 0;
  const startTicks = Number(fieldsAfterComm[19]) || 0;
  const rssPages = Number(fieldsAfterComm[21]) || 0;
  if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return null;
  return { pid, ppid, cpuTicks: utime + stime, startTicks, rssPages };
}

export function sampleProcfs(nowMs = Date.now()): ProcfsSample {
  if (platform() !== 'linux') return unsupportedSample(nowMs);

  let procEntries: string[];
  try {
    procEntries = readdirSync('/proc');
  } catch {
    return unsupportedSample(nowMs);
  }

  try {
    const processes: ProcessResourceSample[] = [];
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const parsed = parseProcessStat(readFileSync(`/proc/${entry}/stat`, 'utf8'));
        if (!parsed) continue;
        let cmd = '';
        try {
          cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        } catch {
          // Process may have exited or denied cmdline access after stat was read.
        }
        // Prefer PSS (proportional) so per-group sums don't double-count shared
        // pages; fall back to RSS when smaps_rollup is unavailable.
        let pssBytes: number | null = null;
        try {
          pssBytes = parseSmapsRollupPss(readFileSync(`/proc/${entry}/smaps_rollup`, 'utf8'));
        } catch {
          // smaps_rollup absent (old kernel), unreadable, or process exited — use RSS.
        }
        processes.push({
          pid: parsed.pid,
          ppid: parsed.ppid,
          rssBytes: pssBytes ?? parsed.rssPages * PAGE_SIZE_BYTES,
          cpuTicks: parsed.cpuTicks,
          startTicks: parsed.startTicks,
          cmd,
        });
      } catch {
        // Processes can exit between readdir and readFile; skip those snapshots.
      }
    }

    const cpuTimes = parseSystemCpuTimes(readFileSync('/proc/stat', 'utf8'));
    return {
      supported: true,
      sampledAt: nowMs,
      totalCpuTicks: cpuTimes.total,
      idleCpuTicks: cpuTimes.idle,
      loadavg: parseLoadavg(readFileSync('/proc/loadavg', 'utf8')),
      mem: parseMeminfo(readFileSync('/proc/meminfo', 'utf8')),
      processes,
    };
  } catch {
    return unsupportedSample(nowMs);
  }
}
