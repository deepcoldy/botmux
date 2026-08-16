import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import type { ProcfsSample, ProcessResourceSample } from './types.js';

/**
 * macOS resource sampling — the darwin counterpart of `procfs.ts`.
 *
 * There is no /proc on macOS, so every field of `ProcfsSample` is rebuilt from a
 * different source. The tick unit is fixed at **centiseconds (10ms)** so it matches
 * Linux's USER_HZ=100 convention: the service layer only ever divides process ticks
 * by host ticks, so the two must share one unit.
 *
 *  - host cpu ticks  → `os.cpus()` per-core times (ms) summed across cores
 *  - loadavg         → `os.loadavg()`
 *  - mem             → `vm_stat` page counters + `sysctl vm.swapusage`
 *  - process table   → `ps -Ao pid=,ppid=,rss=,time=,lstart=`
 *  - process memory  → `top -l 1 -stats pid,mem` (phys_footprint), RSS as fallback
 *
 * Every external command is spawned by absolute path with a pinned PATH/LANG, the
 * same hardening `session-marker.ts` already applies to its `ps` fallback, and the
 * whole sample shares one wall-clock budget so a wedged tool cannot stall the daemon
 * for the length of every timeout in turn.
 *
 * The process table deliberately does *not* select `command`. No consumer reads
 * `cmd`, and including it would put attacker-sized data in the output: argv can reach
 * ARG_MAX (1MiB) per process, so a handful of processes could push the table past
 * maxBuffer and take the whole dashboard to "unsupported". Without it the table is
 * kernel-derived, fixed-width, and ~40KB on a 700-process host (vs ~120KB with).
 */

const PS_BINS = ['/bin/ps', '/usr/bin/ps'];
const VM_STAT_BINS = ['/usr/bin/vm_stat'];
const SYSCTL_BINS = ['/usr/sbin/sysctl', '/sbin/sysctl'];
const TOP_BINS = ['/usr/bin/top'];
const COMMAND_TIMEOUT_MS = 2_000;
// One budget for the whole sample. Each tool is capped at the smaller of its own
// timeout and what is left, so the worst case is bounded by this instead of by the
// sum of five separate timeouts — these are synchronous spawns on the daemon's event
// loop, and the sampler runs every 10s.
const SAMPLE_BUDGET_MS = 3_000;
const COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
// `top` truncates the process list at -n; 4096 is far above any real host's count
// while still bounding the output we have to parse.
const TOP_PROCESS_LIMIT = 4096;

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Wall-clock budget shared by every tool in one sample. */
export function createSampleBudget(nowFn: () => number, budgetMs = SAMPLE_BUDGET_MS): () => number {
  const deadline = nowFn() + budgetMs;
  return () => Math.max(0, deadline - nowFn());
}

/**
 * Why the outcome distinguishes "absent" from "failed":
 *
 * Some tools decide *how* a metric is defined — vm_stat decides what "available
 * memory" means, top decides whether process memory is phys_footprint or RSS. A tool
 * that does not exist on this host is a stable property: the fallback definition then
 * holds for every sample and the series stays internally comparable. A tool that
 * exists but failed *this once* (timeout, sandbox denial, exhausted budget) is the
 * dangerous case — falling back for one sample splices a different definition into a
 * series and draws a step that reads as a real spike. Callers must drop such a sample
 * instead, so collapsing both cases into `undefined` is not good enough.
 */
export type ToolOutcome =
  | { ok: true; stdout: string }
  | { ok: false; absent: true }
  | { ok: false; absent: false };

export type ToolRunner = (candidates: string[], args: string[], remainingMs: () => number, maxMs?: number) => ToolOutcome;

const runTool: ToolRunner = (candidates, args, remainingMs, maxMs = COMMAND_TIMEOUT_MS) => {
  const bin = firstExisting(candidates);
  if (!bin) return { ok: false, absent: true };
  const timeout = Math.min(maxMs, remainingMs());
  if (timeout <= 0) return { ok: false, absent: false };
  try {
    return {
      ok: true,
      stdout: execFileSync(bin, args, {
        encoding: 'utf-8',
        timeout,
        maxBuffer: COMMAND_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Pinned env: LANG=C keeps `ps -o lstart=` byte-identical to the marker
        // birth-stamps written by readProcessStartIdentity(), which also pins LANG=C.
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
      }),
    };
  } catch {
    // Denied by a sandbox profile, timed out, or output over maxBuffer.
    return { ok: false, absent: false };
  }
};

/**
 * Host CPU ticks in centiseconds, summed across cores.
 *
 * `os.cpus()` reports milliseconds per core; dividing by 10 lands on the same unit
 * as the process table below. macOS has no iowait, so idle is idle.
 */
export function hostCpuTicks(cpuList: ReturnType<typeof cpus>): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of cpuList) {
    const times = cpu.times;
    total += (times.user + times.nice + times.sys + times.irq + times.idle) / 10;
    idle += times.idle / 10;
  }
  return { total: Math.round(total), idle: Math.round(idle) };
}

/**
 * `ps -o time` cumulative CPU time → centiseconds.
 * Formats seen from macOS ps: `0:00.14`, `170:41.46`, `27:03:12.08`, `3-04:11:22.31`.
 */
export function parsePsCpuTime(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const dashSplit = trimmed.split('-');
  const days = dashSplit.length > 1 ? Number(dashSplit[0]) || 0 : 0;
  const clock = dashSplit.length > 1 ? dashSplit[1] : dashSplit[0];
  const parts = clock.split(':');
  if (parts.length === 0) return 0;
  const seconds = Number(parts[parts.length - 1]) || 0;
  const minutes = parts.length >= 2 ? Number(parts[parts.length - 2]) || 0 : 0;
  const hours = parts.length >= 3 ? Number(parts[parts.length - 3]) || 0 : 0;
  const totalSeconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return Math.round(totalSeconds * 100);
}

// `[dd-][hh:]mm:ss.cc` and `%a %b %e %H:%M:%S %Y`, the only shapes ps emits for the
// two fixed-format columns. Validating them means a row whose layout we did not
// expect is dropped rather than mistaken for a process (see parsePsLine).
const PS_CPUTIME_RE = /^(?:\d+-)?(?:\d+:)?\d+:\d+(?:\.\d+)?$/;
const PS_LSTART_RE = /^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

/**
 * One row of `ps -Ao pid=,ppid=,rss=,time=,lstart=`.
 *
 * Every column is kernel-derived and fixed-format: `lstart` is ps's
 * `%a %b %e %H:%M:%S %Y`, always exactly 5 whitespace-separated tokens, so a row is
 * exactly 9 tokens and anything else is not a row we understand. The lstart string is
 * carried through as `startTicks`: on macOS it is what marker birth-stamps are
 * compared against (see readProcessStartIdentity), hence `number | string`.
 *
 * Rejecting off-shape rows matters because a row is what grants a pid its ppid, its
 * memory and its birth identity — a fabricated one would place a process anywhere in
 * the tree. There is no attacker-controlled text in this table (argv is not selected),
 * and the format checks keep it that way if ps ever changes its output.
 */
export function parsePsLine(line: string): ProcessResourceSample | null {
  const fields = line.trim().split(/\s+/);
  if (fields.length !== 9) return null;
  const pid = Number(fields[0]);
  const ppid = Number(fields[1]);
  const rssKb = Number(fields[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rssKb)) return null;
  if (!PS_CPUTIME_RE.test(fields[3])) return null;
  const startTicks = fields.slice(4, 9).join(' ');
  if (!PS_LSTART_RE.test(startTicks)) return null;
  return {
    pid,
    ppid,
    rssBytes: rssKb * 1024,
    cpuTicks: parsePsCpuTime(fields[3]),
    startTicks,
  };
}

export function parsePsTable(raw: string): ProcessResourceSample[] {
  const out: ProcessResourceSample[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parsePsLine(line);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * `top`'s MEM column is phys_footprint — the same number Activity Monitor shows as
 * "Memory", and the closest macOS analogue to the PSS the Linux sampler prefers:
 * shared clean pages are excluded and compressed pages are counted, so summing it
 * across a process group does not double-count the shared Node runtime the way RSS
 * does (measured: 213MB footprint vs 558MB RSS for one claude process).
 *
 * The cost is precision — top rounds to 3-4 significant digits with a unit suffix.
 */
export function parseTopMemBytes(raw: string): number | null {
  // Trailing +/- markers appear once top has a previous frame to diff against.
  const match = raw.trim().match(/^([\d.]+)([BKMGT]?)[+-]?$/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const scale: Record<string, number> = { B: 1, '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return value * (scale[match[2]] ?? 1);
}

export function parseTopFootprints(raw: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s*$/);
    if (!match) continue;
    const bytes = parseTopMemBytes(match[2]);
    if (bytes === null) continue;
    out.set(Number(match[1]), bytes);
  }
  return out;
}

/** `ps -Ao pid=,lstart=` → pid → birth stamp, used to re-check identity after top. */
export function parsePsBirthStamps(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of raw.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const pid = Number(fields[0]);
    const stamp = fields.slice(1, 6).join(' ');
    if (!Number.isInteger(pid) || !PS_LSTART_RE.test(stamp)) continue;
    out.set(pid, stamp);
  }
  return out;
}

/**
 * Overlay top's phys_footprint onto the ps table, but only for pids that provably
 * did not change identity in between.
 *
 * ps and top are separate instants. A pid sampled by ps can exit and be recycled
 * before top runs, which would otherwise splice the new process's memory onto the old
 * process's identity and process tree — and if the old process still had a live
 * marker, the wrong number would be shown with `confidence=marker`. Re-reading the
 * birth stamps after top brackets the whole window: an unchanged stamp means the pid
 * did not change hands. Anything unproven — recycled, or absent from the second pass
 * because it exited — keeps its ps RSS.
 *
 * Precision caveat: `lstart` resolves to one second, so a recycle *within the same
 * second* presents an identical stamp and slips through. XNU hands out pids
 * sequentially from `lastpid + 1` and wraps at PID_MAX back to 100, so hitting it
 * takes roughly a full lap of the pid space — ~100k allocations — inside one second.
 * That is extremely hard to reach in practice, not provably impossible. Closing it
 * outright would mean microsecond birth times from `proc_pidinfo`, i.e. a native
 * binding; not worth it for a memory number that self-corrects on the next sample.
 */
export function applyFootprints(
  processes: ProcessResourceSample[],
  footprints: Map<number, number>,
  birthAfter: Map<number, string>,
): void {
  if (footprints.size === 0) return;
  for (const proc of processes) {
    const footprint = footprints.get(proc.pid);
    if (footprint === undefined) continue;
    if (birthAfter.get(proc.pid) !== proc.startTicks) continue;
    proc.rssBytes = footprint;
  }
}

/**
 * `vm_stat` page counters → the memTotal/memAvailable pair.
 *
 * "Available" = free + speculative + inactive. This deliberately follows Linux
 * MemAvailable semantics rather than Activity Monitor's "used": those queues are
 * reclaimable under pressure, exactly like Linux's page cache and inactive LRU. Pages
 * held by the compressor are *not* reclaimable and are therefore counted as used,
 * since they are in none of those queues. Do not "fix" this to match Activity
 * Monitor — it would make macOS hosts read as permanently ~90% full and break
 * comparability with the Linux hosts on the same dashboard.
 *
 * `Pages purgeable` is deliberately NOT added. It is not a fifth, disjoint queue:
 * XNU bumps `vm_page_purgeable_count` for resident non-wired pages of volatile
 * purgeable objects, and those pages simultaneously sit on the active/inactive
 * queues. Adding it double-counts the inactive∩purgeable overlap, overstating
 * available memory (unbounded in the graphics/cache-heavy case, and able to exceed
 * total). The aggregate counters cannot express the overlap-free reclaimable union,
 * so this stays a documented under-estimate rather than a double-counted guess.
 */
export function parseVmStat(raw: string, totalBytes: number): { memTotalBytes: number; memAvailableBytes: number } | null {
  const pageSize = Number(raw.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pages = (label: string): number => {
    const match = raw.match(new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm'));
    return match ? Number(match[1]) : 0;
  };
  const reclaimable = pages('Pages free') + pages('Pages speculative') + pages('Pages inactive');
  if (reclaimable <= 0) return null;
  return {
    memTotalBytes: totalBytes,
    memAvailableBytes: reclaimable * pageSize,
  };
}

/** `sysctl -n vm.swapusage` → `total = 2048.00M  used = 1024.25M  free = 1023.75M  (encrypted)` */
export function parseSwapusage(raw: string): { swapTotalBytes: number; swapFreeBytes: number } {
  const scale: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  const read = (label: string): number => {
    const match = raw.match(new RegExp(`${label}\\s*=\\s*([\\d.]+)([BKMGT])`, 'i'));
    if (!match) return 0;
    return (Number(match[1]) || 0) * (scale[match[2].toUpperCase()] ?? 1);
  };
  return { swapTotalBytes: read('total'), swapFreeBytes: read('free') };
}

export interface DarwinSampleDeps {
  nowFn?: () => number;
  run?: ToolRunner;
}

/**
 * Build one macOS sample, or null when this round cannot be trusted.
 *
 * The degradation rule, applied to every tool that defines a metric:
 *
 *  - **deterministic** — binary absent, or output this host's OS version formats in a
 *    way we cannot parse → stable fallback. It applies to every sample on this host,
 *    so the series stays internally comparable and no step appears.
 *  - **transient** — the binary is there and normally parses, but *this call* failed
 *    (timeout, sandbox denial, exhausted budget) → return null. The caller renders
 *    "unsupported" for one round, which is honest; substituting the fallback for a
 *    single sample splices a second definition into a live series and draws a step
 *    that reads as a real spike (os.freemem() understates available memory; ps RSS
 *    runs ~2.7× phys_footprint).
 *
 * Order follows that rule: the mandatory process table first — with the whole budget,
 * since losing it invalidates the sample and resets the dashboard's CPU and session
 * baselines — then the cheap host counters, and only then the optional footprint pass.
 */
export function sampleDarwin(nowMs: number, deps: DarwinSampleDeps = {}): ProcfsSample | null {
  const run = deps.run ?? runTool;
  const remainingMs = createSampleBudget(deps.nowFn ?? Date.now);

  const ps = run(PS_BINS, ['-Ao', 'pid=,ppid=,rss=,time=,lstart='], remainingMs, SAMPLE_BUDGET_MS);
  if (!ps.ok) return null;
  const processes = parsePsTable(ps.stdout);
  if (processes.length === 0) return null;

  const totalBytes = totalmem();
  const vmStat = run(VM_STAT_BINS, [], remainingMs);
  if (!vmStat.ok && !vmStat.absent) return null;
  // os.freemem() on macOS counts only free+speculative pages, so it understates what
  // is actually reclaimable. Reached only when vm_stat is absent or unparseable here.
  const mem = (vmStat.ok ? parseVmStat(vmStat.stdout, totalBytes) : null)
    ?? { memTotalBytes: totalBytes, memAvailableBytes: freemem() };

  // Swap is exempt from the rule above: it is not written to any history series, so a
  // missed reading shows as a zeroed swap gauge for one refresh and nothing more.
  const swapRaw = run(SYSCTL_BINS, ['-n', 'vm.swapusage'], remainingMs);
  const swap = parseSwapusage(swapRaw.ok ? swapRaw.stdout : '');
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();
  const cpuTicks = hostCpuTicks(cpus());

  // phys_footprint per pid. Absent or unparseable top → every sample on this host
  // reports ps RSS (stable). A failed top call, or a failed identity re-check that
  // would silently leave RSS inside a footprint series → drop this sample.
  const top = run(TOP_BINS, ['-l', '1', '-n', String(TOP_PROCESS_LIMIT), '-stats', 'pid,mem'], remainingMs);
  if (!top.ok && !top.absent) return null;
  const footprints = top.ok ? parseTopFootprints(top.stdout) : new Map<number, number>();
  if (footprints.size > 0) {
    const birthAfter = run(PS_BINS, ['-Ao', 'pid=,lstart='], remainingMs);
    if (!birthAfter.ok) return null;
    applyFootprints(processes, footprints, parsePsBirthStamps(birthAfter.stdout));
  }

  return {
    supported: true,
    sampledAt: nowMs,
    totalCpuTicks: cpuTicks.total,
    idleCpuTicks: cpuTicks.idle,
    loadavg: { load1, load5, load15 },
    mem: { ...mem, ...swap },
    processes,
  };
}
