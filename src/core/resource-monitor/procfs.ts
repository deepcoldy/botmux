import { readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { sampleDarwin } from './darwin.js';
import type { ProcfsSample, ProcessResourceSample } from './types.js';

const PAGE_SIZE_BYTES = 4096;

/**
 * Knobs that bound the cost of one /proc sweep.
 *
 * Why this exists (2026-09 incident): the dashboard sampled every process on the
 * host — `stat` + `cmdline` + `smaps_rollup` — synchronously, every 10s.
 * `smaps_rollup` makes the kernel walk the target's page tables (~1ms each) and
 * `cmdline` reads the target's memory (~0.3ms each), so on a ~3000-process
 * fleet host one sweep measured ~3s in-process (bun and node alike) and ~8s
 * under contention — 30–80% of the dashboard's event loop spent inside one
 * synchronous call. Startup fell over because of it: the post-bind loopback
 * self-check (2s budget) timed out, the probe released the port, and the
 * platform tunnel — which only starts after listen — never came up.
 *
 * Three cuts, all measured on that host:
 *  - `cmdline` is not read at all. Nothing in the monitor consumes `cmd`
 *    (attribution keys on pid/ppid/markers; the darwin sampler never filled it).
 *    `stat` alone for 3000 pids is ~55ms.
 *  - PSS is confined to the processes attribution actually sums — botmux's own
 *    trees (dashboard, bot daemons, session workers, CLI markers, adopted CLIs;
 *    see attribution.ts `metricFor` callers) — and within those to the largest
 *    by RSS, since RSS−PSS error is proportional to size and a 3MB shell does
 *    not move a bot's total. Everything else keeps the free RSS from `stat`.
 *  - The periodic sampler ({@link sampleProcfsAsync}) does the reads in small
 *    synchronous chunks and yields the event loop between them, instead of
 *    one long call. Not an async-fs thread pool: on Bun that costs several
 *    times the CPU of the reads themselves (measured 93% of a core in pool
 *    threads for the same sweep) while chunked reads cost exactly the kernel
 *    time and never park the loop for more than one chunk.
 */
export interface ProcfsSampleOptions {
  /**
   * Pids whose process subtrees (by ppid) are eligible for PSS from
   * `/proc/<pid>/smaps_rollup`. Processes outside those subtrees report RSS from
   * `stat`. `undefined` → every process is eligible (legacy behaviour; only sane
   * on small hosts). Empty → PSS for nobody.
   */
  pssRoots?: Iterable<number>;
  /** Hard cap on `smaps_rollup` reads per sweep; the largest-RSS eligible processes win. */
  maxPssProcesses?: number;
}

const DEFAULT_MAX_PSS_PROCESSES = 512;
/** `stat` reads per event-loop turn in the chunked sweep (~20µs each → ~5ms/turn). */
const STAT_CHUNK = 256;
/** `smaps_rollup` reads per event-loop turn (~1–2ms each for a CLI-sized
 *  process → ≤~16ms/turn; measured 33ms max stall at 16/turn on the fleet host). */
const PSS_CHUNK = 8;

interface ProcStatRow {
  pid: number;
  ppid: number;
  cpuTicks: number;
  startTicks: number;
  rssPages: number;
}

export function unsupportedSample(sampledAt: number): ProcfsSample {
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

/**
 * Which pids get the expensive PSS read.
 *
 * Eligibility is the ppid-closure of `pssRoots`; within it, when there are more
 * eligible processes than `maxPssProcesses`, the largest by RSS win — RSS−PSS
 * error grows with the process, so that is where PSS changes a bot's total.
 * Returns null for "everyone" (no roots given) so callers can skip the filter.
 * Roots that are not in the table (exited, never existed) contribute nothing.
 */
export function selectPssPids(
  rows: ReadonlyArray<Pick<ProcStatRow, 'pid' | 'ppid'> & Partial<Pick<ProcStatRow, 'rssPages'>>>,
  opts: ProcfsSampleOptions,
): Set<number> | null {
  if (opts.pssRoots === undefined) return null;
  const max = opts.maxPssProcesses ?? DEFAULT_MAX_PSS_PROCESSES;
  const rssByPid = new Map<number, number>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    rssByPid.set(row.pid, row.rssPages ?? 0);
    const arr = children.get(row.ppid) ?? [];
    arr.push(row.pid);
    children.set(row.ppid, arr);
  }
  const eligible = new Set<number>();
  const stack: number[] = [];
  for (const root of opts.pssRoots) if (Number.isInteger(root) && root > 0) stack.push(root);
  while (stack.length) {
    const pid = stack.pop()!;
    if (eligible.has(pid) || !rssByPid.has(pid)) continue;
    eligible.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  if (eligible.size <= max) return eligible;
  return new Set([...eligible].sort((a, b) => (rssByPid.get(b) ?? 0) - (rssByPid.get(a) ?? 0)).slice(0, max));
}

function toProcessSample(row: ProcStatRow, pssBytes: number | null): ProcessResourceSample {
  return {
    pid: row.pid,
    ppid: row.ppid,
    // Prefer PSS (proportional) so per-group sums don't double-count shared
    // pages; fall back to RSS when smaps_rollup is unavailable or not sampled.
    rssBytes: pssBytes ?? row.rssPages * PAGE_SIZE_BYTES,
    cpuTicks: row.cpuTicks,
    startTicks: row.startTicks,
  };
}

function readStatRow(pid: string): ProcStatRow | null {
  try {
    return parseProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null; // exited between readdir and read
  }
}

function readPss(pid: number): number | null {
  try {
    return parseSmapsRollupPss(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
  } catch {
    return null; // smaps_rollup absent (old kernel), unreadable, or process exited — use RSS.
  }
}

function assembleSample(nowMs: number, processes: ProcessResourceSample[]): ProcfsSample {
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
}

function listProcPids(): string[] | null {
  try {
    return readdirSync('/proc').filter(entry => /^\d+$/.test(entry));
  } catch {
    return null;
  }
}

/**
 * Synchronous sweep. Blocks the caller for the whole /proc walk — fine for
 * one-shot tools and tests; the dashboard's periodic sampler uses
 * {@link sampleProcfsAsync}, which does the same reads in yielding chunks.
 */
export function sampleProcfs(nowMs = Date.now(), opts: ProcfsSampleOptions = {}): ProcfsSample {
  // macOS has no /proc; darwin.ts rebuilds the same shape from ps/vm_stat/sysctl/top
  // and returns null when those tools are unavailable (e.g. denied by a sandbox
  // profile), which degrades to the same "unsupported" snapshot as any other platform.
  if (platform() === 'darwin') return sampleDarwin(nowMs) ?? unsupportedSample(nowMs);
  if (platform() !== 'linux') return unsupportedSample(nowMs);

  const pids = listProcPids();
  if (pids === null) return unsupportedSample(nowMs);

  try {
    const rows: ProcStatRow[] = [];
    for (const pid of pids) {
      const row = readStatRow(pid);
      if (row) rows.push(row);
    }
    const pssPids = selectPssPids(rows, opts);
    const processes = rows.map(row => toProcessSample(row, pssPids === null || pssPids.has(row.pid) ? readPss(row.pid) : null));
    return assembleSample(nowMs, processes);
  } catch {
    return unsupportedSample(nowMs);
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/**
 * Cooperative sweep for long-lived processes (the dashboard sampler).
 *
 * Same output as {@link sampleProcfs}; the reads are the same synchronous
 * `readFileSync` calls, issued in small chunks with an event-loop turn between
 * chunks (STAT_CHUNK / PSS_CHUNK, sized to ~5–20ms of kernel time each). HTTP
 * handlers, the platform tunnel and the post-bind self-check therefore see at
 * most one chunk of latency regardless of how many processes the host has,
 * while the total CPU stays exactly the kernel cost of the reads. Non-Linux
 * platforms fall through to the synchronous path (darwin samples via
 * short-lived tools with its own time budget).
 */
export async function sampleProcfsAsync(nowMs = Date.now(), opts: ProcfsSampleOptions = {}): Promise<ProcfsSample> {
  if (platform() !== 'linux') return sampleProcfs(nowMs, opts);

  const pids = listProcPids();
  if (pids === null) return unsupportedSample(nowMs);

  try {
    const rows: ProcStatRow[] = [];
    for (let i = 0; i < pids.length; i += STAT_CHUNK) {
      for (const pid of pids.slice(i, i + STAT_CHUNK)) {
        const row = readStatRow(pid);
        if (row) rows.push(row);
      }
      await yieldToEventLoop();
    }

    const pssPids = selectPssPids(rows, opts);
    const targets = pssPids === null ? rows.map(row => row.pid) : [...pssPids];
    const pssByPid = new Map<number, number>();
    for (let i = 0; i < targets.length; i += PSS_CHUNK) {
      for (const pid of targets.slice(i, i + PSS_CHUNK)) {
        const pss = readPss(pid);
        if (pss !== null) pssByPid.set(pid, pss);
      }
      await yieldToEventLoop();
    }

    return assembleSample(nowMs, rows.map(row => toProcessSample(row, pssByPid.get(row.pid) ?? null)));
  } catch {
    return unsupportedSample(nowMs);
  }
}
