/**
 * 进程容器 = cgroup（设计文档 §6.3）。runner 创建容器目录、把 worker 放进去；
 * 回收一律按子树处理：v2 `cgroup.kill` / v2 `cgroup.freeze` / v1 freezer 三条路径。
 *
 * 这个模块只做内核级操作，不写 journal、不碰 lease——所有权与记录顺序由 runner 负责：
 * `container.created` 追加与 `mkdir` 在同一临界区、入容器写入与 `attempt.state: spawning`
 * 在同一临界区（§6.2「写即核对」）。这里的函数都是幂等的，清扫器与下一任 runner 可以对
 * 同一 cgroup 重复执行。
 *
 * M1 平台限定：Linux。三条路径都不可用时 `probeContainerBackend()` 返回 `none`，
 * `flow run` 据此拒绝（除非 `--unsafe-no-container`）。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import type { Containment, ContainmentBoundary, ContainerKind } from './types.js';

export const FLOW_CGROUP_ROOT_NAME = 'botmux-flow';

export interface ContainerBackend {
  kind: Exclude<ContainerKind, 'none'>;
  /** cgroupfs 挂载点：v2 是统一层级根，v1 是 freezer 层级根。 */
  mount: string;
  /** `botmux-flow` 所在目录：v2 在 runner 自己的 cgroup 下，v1 在层级根下。 */
  base: string;
}

export interface NoContainerBackend {
  kind: 'none';
  reason: string;
}

function readCgroupfsMount(): { version: 1 | 2; mount: string } | null {
  let info: string;
  try {
    info = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return null;
  }
  let v2: string | null = null;
  let v1Freezer: string | null = null;
  for (const line of info.split('\n')) {
    const parts = line.split(' ');
    const dash = parts.indexOf('-');
    if (dash === -1) continue;
    const mountPoint = parts[4]!;
    const fsType = parts[dash + 1]!;
    const superOpts = parts[dash + 3] ?? '';
    if (fsType === 'cgroup2' && v2 === null) v2 = mountPoint;
    if (fsType === 'cgroup' && superOpts.split(',').includes('freezer') && v1Freezer === null) v1Freezer = mountPoint;
  }
  // 混合模式（本宿主）：v1 freezer 优先于挂在 /sys/fs/cgroup/unified 的无控制器 v2
  if (v1Freezer) return { version: 1, mount: v1Freezer };
  if (v2) return { version: 2, mount: v2 };
  return null;
}

function canWrite(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return false;
    const probe = join(path, `.botmux-flow-probe-${process.pid}-${Date.now()}`);
    mkdirSync(probe);
    rmdirSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** runner 自己在统一层级里的 cgroup 目录（v2 容器建在它下面，不需要额外权限）。 */
function selfCgroupV2Dir(mount: string): string | null {
  try {
    const raw = readFileSync('/proc/self/cgroup', 'utf8');
    for (const line of raw.split('\n')) {
      const m = /^0::(.*)$/.exec(line.trim());
      if (m) return join(mount, m[1]!);
    }
  } catch {
    // fallthrough
  }
  return null;
}

/** 能力探测：三条路径按优先级尝试，返回第一条可用的。 */
export function probeContainerBackend(): ContainerBackend | NoContainerBackend {
  if (process.platform !== 'linux') return { kind: 'none', reason: `platform ${process.platform} is not supported in M1 (Linux only)` };
  const found = readCgroupfsMount();
  if (!found) return { kind: 'none', reason: 'no cgroup2 mount and no cgroup v1 freezer hierarchy in /proc/self/mountinfo' };
  if (found.version === 2) {
    const selfDir = selfCgroupV2Dir(found.mount) ?? found.mount;
    const base = join(selfDir, FLOW_CGROUP_ROOT_NAME);
    if (!canWrite(selfDir)) return { kind: 'none', reason: `cgroup2 directory ${selfDir} is not writable` };
    const probeDir = join(selfDir, `.botmux-flow-cap-${process.pid}`);
    try {
      mkdirSync(probeDir);
      const hasKill = existsSync(join(probeDir, 'cgroup.kill'));
      const hasFreeze = existsSync(join(probeDir, 'cgroup.freeze'));
      if (!hasKill && !hasFreeze) return { kind: 'none', reason: 'cgroup2 has neither cgroup.kill nor cgroup.freeze (kernel < 5.2?)' };
      return { kind: hasKill ? 'cgroup2-kill' : 'cgroup2-freeze', mount: found.mount, base };
    } finally {
      try { rmdirSync(probeDir); } catch { /* best effort */ }
    }
  }
  const base = join(found.mount, FLOW_CGROUP_ROOT_NAME);
  if (!canWrite(found.mount)) return { kind: 'none', reason: `cgroup v1 freezer hierarchy ${found.mount} is not writable` };
  return { kind: 'cgroup1-freezer', mount: found.mount, base };
}

export function runTreePath(backend: ContainerBackend, runId: string): string {
  return join(backend.base, runId);
}

export function containerName(gen: number, n: number | 'probe'): string {
  return `c-${gen}-${n}`;
}

export function containerPath(backend: ContainerBackend, runId: string, container: string): string {
  return join(runTreePath(backend, runId), container);
}

/** 解析容器名里的代次：`c-<gen>-<n>` → gen；不合形态返回 null。 */
export function containerGen(name: string): number | null {
  const m = /^c-(\d+)-(?:\d+|probe)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** 创建容器目录（幂等）。调用方在所有权临界区内、紧接 `container.created` 追加之后调用。 */
export function createContainerDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/** 把 pid 放进容器。调用方在所有权临界区内调用（§6.3 步骤 ③）。 */
export function addPidToContainer(path: string, pid: number): void {
  writeFileSync(join(path, 'cgroup.procs'), `${pid}\n`);
}

export function readProcs(path: string): number[] {
  try {
    return readFileSync(join(path, 'cgroup.procs'), 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(Number)
      .filter((n) => Number.isSafeInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** 子树全部节点，叶子在前（删除顺序）。根不存在返回 []。 */
export function listSubtreeLeavesFirst(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return;
    }
    for (const name of entries) walk(join(dir, name));
    out.push(dir);
  };
  if (!existsSync(root)) return [];
  walk(root);
  return out;
}

export function subtreeProcs(root: string): Array<{ node: string; pids: number[] }> {
  return listSubtreeLeavesFirst(root)
    .map((node) => ({ node, pids: readProcs(node) }))
    .filter((e) => e.pids.length > 0);
}

export function isSubtreeEmpty(root: string): boolean {
  return subtreeProcs(root).length === 0;
}

export interface ReclaimOptions {
  freezeTimeoutMs?: number;
  drainTimeoutMs?: number;
  maxCycles?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ReclaimResult =
  | { ok: true; killed: number; cycles: number }
  | { ok: false; reason: 'freeze_timeout' | 'drain_timeout' | 'rmdir_failed' | 'enumerate_failed'; residual: Array<{ node: string; pids: number[] }>; detail: string };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

function killAll(pids: number[]): number {
  let n = 0;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      n++;
    } catch {
      // already gone
    }
  }
  return n;
}

async function waitEmpty(root: string, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (isSubtreeEmpty(root)) return true;
    await sleep(50);
  }
  return isSubtreeEmpty(root);
}

function rmdirLeavesUp(root: string): { ok: true } | { ok: false; detail: string } {
  for (const node of listSubtreeLeavesFirst(root)) {
    try {
      rmdirSync(node);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { ok: false, detail: `${node}: ${(err as Error).message}` };
    }
  }
  return { ok: true };
}

/**
 * 回收一个容器子树（幂等）。不存在 → 直接成功。返回 `ok:false` 表示**未清理**：
 * 调用方必须进入 `paused` 并报告残留，不许猜（§6.3）。
 */
export async function reclaimContainer(backend: ContainerBackend, root: string, opts: ReclaimOptions = {}): Promise<ReclaimResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const freezeTimeoutMs = opts.freezeTimeoutMs ?? 5_000;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 10_000;
  const maxCycles = opts.maxCycles ?? 3;
  if (!existsSync(root)) return { ok: true, killed: 0, cycles: 0 };

  let killed = 0;
  let cycles = 0;
  for (; cycles < maxCycles; cycles++) {
    if (isSubtreeEmpty(root)) break;
    if (backend.kind === 'cgroup2-kill') {
      // 内核保证：杀死本组与所有后代组的进程，处理并发 fork 并阻止迁移
      for (const node of listSubtreeLeavesFirst(root)) {
        try { writeFileSync(join(node, 'cgroup.kill'), '1'); } catch { /* 节点可能已空并被删 */ }
      }
    } else if (backend.kind === 'cgroup2-freeze') {
      writeFileSync(join(root, 'cgroup.freeze'), '1');
      const frozen = await waitFor(() => /(?:^|\n)frozen 1(?:\n|$)/.test(readTrimmed(join(root, 'cgroup.events')) ?? ''), freezeTimeoutMs, sleep);
      if (!frozen) {
        try { writeFileSync(join(root, 'cgroup.freeze'), '0'); } catch { /* best effort */ }
        return { ok: false, reason: 'freeze_timeout', residual: subtreeProcs(root), detail: `cgroup.events did not report frozen within ${freezeTimeoutMs}ms` };
      }
      const targets = subtreeProcs(root).flatMap((e) => e.pids);
      killed += killAll(targets);
      writeFileSync(join(root, 'cgroup.freeze'), '0');
    } else {
      // v1 freezer：FROZEN → 轮询读回 FROZEN（写入后先是 FREEZING；新任务加入会退回 FREEZING）
      const statePath = join(root, 'freezer.state');
      writeFileSync(statePath, 'FROZEN');
      const frozen = await waitFor(() => readTrimmed(statePath) === 'FROZEN', freezeTimeoutMs, sleep);
      if (!frozen) {
        try { writeFileSync(statePath, 'THAWED'); } catch { /* best effort */ }
        return { ok: false, reason: 'freeze_timeout', residual: subtreeProcs(root), detail: `freezer.state did not reach FROZEN within ${freezeTimeoutMs}ms (${readTrimmed(statePath)})` };
      }
      // 冻结是层级的：后代组随之冻结；枚举子树后再确认一次仍为 FROZEN，否则重新枚举
      let targets: number[] = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        targets = subtreeProcs(root).flatMap((e) => e.pids);
        if (readTrimmed(statePath) === 'FROZEN') break;
        const refrozen = await waitFor(() => readTrimmed(statePath) === 'FROZEN', freezeTimeoutMs, sleep);
        if (!refrozen) {
          try { writeFileSync(statePath, 'THAWED'); } catch { /* best effort */ }
          return { ok: false, reason: 'enumerate_failed', residual: subtreeProcs(root), detail: 'freezer kept leaving FROZEN while enumerating the subtree' };
        }
      }
      killed += killAll(targets);
      writeFileSync(statePath, 'THAWED'); // 冻结中的进程要解冻才会真的死
    }
    if (await waitEmpty(root, drainTimeoutMs, sleep)) break;
  }
  if (!isSubtreeEmpty(root)) {
    return { ok: false, reason: 'drain_timeout', residual: subtreeProcs(root), detail: `subtree still populated after ${cycles} freeze-enumerate-kill cycle(s)` };
  }
  const removed = rmdirLeavesUp(root);
  if (!removed.ok) return { ok: false, reason: 'rmdir_failed', residual: subtreeProcs(root), detail: removed.detail };
  return { ok: true, killed, cycles };
}

async function waitFor(pred: () => boolean, timeoutMs: number, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(25);
  }
  return pred();
}

/** run 级树下现存的容器名（不含非容器形态的目录）。 */
export function listRunContainers(backend: ContainerBackend, runId: string): string[] {
  const tree = runTreePath(backend, runId);
  try {
    return readdirSync(tree, { withFileTypes: true })
      .filter((e) => e.isDirectory() && containerGen(e.name) !== null)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * run 级树扫描（§6.3）：回收所有非本代次的容器。返回每个容器的结果；任何一个失败即整体未清理。
 */
export async function reclaimForeignContainers(
  backend: ContainerBackend,
  runId: string,
  keepGen: number,
  opts: ReclaimOptions = {},
): Promise<Array<{ container: string; result: ReclaimResult }>> {
  const results: Array<{ container: string; result: ReclaimResult }> = [];
  for (const name of listRunContainers(backend, runId)) {
    if (containerGen(name) === keepGen) continue;
    results.push({ container: name, result: await reclaimContainer(backend, containerPath(backend, runId, name), opts) });
  }
  return results;
}

/** run 级树目录本身（空了才删；非空保留，不猜）。 */
export function removeRunTreeIfEmpty(backend: ContainerBackend, runId: string): boolean {
  const tree = runTreePath(backend, runId);
  try {
    rmdirSync(tree);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 逃逸检测（cooperative 档：只是检测，不是清理证明）
// ---------------------------------------------------------------------------

export interface EscapedProcess {
  pid: number;
  cgroup: string;
  attempt: string;
}

/** 读某进程在本后端层级里的 cgroup 路径（相对层级根）。 */
export function readProcessCgroupPath(backend: ContainerBackend, pid: number): string | null {
  const raw = readTrimmed(`/proc/${pid}/cgroup`);
  if (raw === null) return null;
  for (const line of raw.split('\n')) {
    const [, controllers, path] = line.split(':');
    if (path === undefined) continue;
    if (backend.kind === 'cgroup1-freezer') {
      if ((controllers ?? '').split(',').includes('freezer')) return path;
    } else if (controllers === '') {
      return path;
    }
  }
  return null;
}

/**
 * 扫描 `/proc/*`：带本 run 的 `BOTMUX_FLOW_ATTEMPT` 标记、但 cgroup 路径不在
 * `botmux-flow/<runId>` 之下的进程。扫描为空不改变档位表述。
 */
export function scanEscapes(backend: ContainerBackend, runId: string, envKey: string): EscapedProcess[] {
  const out: EscapedProcess[] = [];
  const prefix = `${envKey}=${runId}/`;
  const treeSuffix = `/${FLOW_CGROUP_ROOT_NAME}/${runId}`;
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: Buffer;
    try {
      environ = readFileSync(`/proc/${pid}/environ`);
    } catch {
      continue;
    }
    const marker = environ.toString('utf8').split('\0').find((kv) => kv.startsWith(prefix));
    if (!marker) continue;
    const cgroup = readProcessCgroupPath(backend, pid);
    if (cgroup === null) continue;
    if (cgroup.includes(treeSuffix)) continue;
    out.push({ pid, cgroup, attempt: marker.slice(prefix.length) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 归属证伪探测（§6.3）：真实尝试从探测容器迁出到 run 级父组
// ---------------------------------------------------------------------------

export interface ProbeResult {
  attempted: boolean;
  migratedOut: boolean;
  error: string | null;
  uid: number;
  /** 探测进程在本层级的 cgroup 路径（迁出后的观察值）。 */
  observedCgroup: string | null;
}

export interface ContainmentVerdict {
  containment: Containment;
  boundary: ContainmentBoundary;
  probe: ProbeResult;
}

/**
 * 在 `c-<gen>-probe` 里起一个 `sh`，让它自己把 pid 写进 run 级父组的 `cgroup.procs`。
 * 迁出成功 → `cooperative`；失败不改变档位（M1 一律 `cooperative`，`boundary: none`）。
 * 探测容器随后回收。调用方在临界区外调用（要等子进程）。
 */
export async function runFalsificationProbe(
  backend: ContainerBackend,
  runId: string,
  gen: number,
  opts: { timeoutMs?: number; uid?: number; gid?: number } = {},
): Promise<ContainmentVerdict> {
  const probeDir = containerPath(backend, runId, containerName(gen, 'probe'));
  const parentProcs = join(runTreePath(backend, runId), 'cgroup.procs');
  const timeoutMs = opts.timeoutMs ?? 5_000;
  createContainerDir(probeDir);
  const probe: ProbeResult = { attempted: false, migratedOut: false, error: null, uid: opts.uid ?? process.getuid?.() ?? -1, observedCgroup: null };
  try {
    // 子进程先等 stdin 一行（我们把它放进探测容器之后再放行），再尝试迁出，把结果打到 stdout。
    const script = 'read _go; if echo $$ > "$1" 2>/tmp/.botmux-flow-probe-err.$$; then echo migrated; else echo "denied: $(cat /tmp/.botmux-flow-probe-err.$$)"; fi; rm -f /tmp/.botmux-flow-probe-err.$$; cat /proc/self/cgroup';
    const child = spawn('sh', ['-c', script, 'probe', parentProcs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
      ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
    });
    const pid = child.pid;
    if (!pid) {
      probe.error = 'probe process failed to spawn';
      return { containment: 'cooperative', boundary: 'none', probe };
    }
    try {
      addPidToContainer(probeDir, pid);
    } catch (err) {
      probe.error = `could not place probe in container: ${(err as Error).message}`;
      child.kill('SIGKILL');
      return { containment: 'cooperative', boundary: 'none', probe };
    }
    probe.attempted = true;
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on('data', () => {});
    child.stdin.write('go\n');
    child.stdin.end();
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(false);
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (!exited) {
      probe.error = 'probe timed out';
      return { containment: 'cooperative', boundary: 'none', probe };
    }
    const [verdict, ...cgroupLines] = stdout.split('\n');
    probe.migratedOut = verdict?.trim() === 'migrated';
    if (!probe.migratedOut) probe.error = verdict?.trim() ?? 'no output';
    const cg = cgroupLines
      .map((l) => l.split(':'))
      .find(([, controllers]) => (backend.kind === 'cgroup1-freezer' ? (controllers ?? '').split(',').includes('freezer') : controllers === ''));
    probe.observedCgroup = cg?.[2] ?? null;
    return { containment: 'cooperative', boundary: 'none', probe };
  } finally {
    await reclaimContainer(backend, probeDir, { drainTimeoutMs: 2_000 });
  }
}

/** 进程是否仍存活且身份匹配（清扫器与逃逸报告用）。 */
export function processAlive(pid: number, identity: string): boolean {
  return readProcessStartIdentity(pid) === identity;
}
