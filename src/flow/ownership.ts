/**
 * run 所有权：lease、代次、接管与「写即核对」（设计文档 §6.2）。
 *
 * 唯一的锁 target 是 `<runDir>/run.lease`；`withFileLock` 会自动追加 `.lock`，
 * 实际锁文件是 `run.lease.lock`。run 目录下所有共享状态（journal、run.json、
 * processes.json、cgroup 目录）的每一次写入都必须经 `withRunOwnership`：
 * 进临界区 → 读 lease → 核对 gen 与出生身份 → 才执行写入。
 *
 * 于是 journal 的文件顺序就是所有权顺序：被围栏的旧 runner 写不进任何东西。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileLockTimeoutError, withFileLock } from '../utils/file-lock.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import {
  HEARTBEAT_STALE_MS,
  LOCK_HOLDER_STALE_MS,
  RUN_LEASE_FILE,
  type Lease,
  type RunTakeoverRow,
} from './types.js';

export interface RunSelf {
  pid: number;
  identity: string;
  gen: number;
}

export class FencedError extends Error {
  readonly code = 'fenced';
  constructor(message: string, readonly lease: Lease | null) {
    super(message);
    this.name = 'FencedError';
  }
}

export class RunBusyError extends Error {
  readonly code = 'run_busy';
  constructor(readonly lease: Lease) {
    super(`run is held by pid ${lease.holderPid} (gen ${lease.gen}, heartbeat ${Math.round((Date.now() - lease.heartbeatAt) / 1000)}s ago)`);
    this.name = 'RunBusyError';
  }
}

export class OwnershipLockTimeoutError extends Error {
  readonly code = 'ownership_lock_timeout';
  constructor(readonly attempts: number, cause: FileLockTimeoutError) {
    super(`could not enter the run ownership critical section after ${attempts} attempts: ${cause.message}`);
    this.name = 'OwnershipLockTimeoutError';
  }
}

export function leaseTargetPath(runDir: string): string {
  return join(runDir, RUN_LEASE_FILE);
}

export function leaseLockPath(runDir: string): string {
  return `${leaseTargetPath(runDir)}.lock`;
}

/** 无锁读取 lease；只用于判断陈旧与展示，任何决定性写入都要在临界区内重读。 */
export function readLeaseUnlocked(runDir: string): Lease | null {
  let raw: string;
  try {
    raw = readFileSync(leaseTargetPath(runDir), 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<Lease>;
    if (
      !value ||
      typeof value !== 'object' ||
      !Number.isSafeInteger(value.holderPid) ||
      typeof value.holderIdentity !== 'string' ||
      !Number.isSafeInteger(value.gen) ||
      typeof value.heartbeatAt !== 'number' ||
      typeof value.acquiredAt !== 'number'
    ) return null;
    return value as Lease;
  } catch {
    return null;
  }
}

function writeLeaseLocked(runDir: string, lease: Lease): void {
  atomicWriteFileSync(leaseTargetPath(runDir), JSON.stringify(lease));
}

export function selfIdentity(pid: number = process.pid): string {
  const identity = readProcessStartIdentity(pid);
  if (!identity) throw new Error(`cannot read process start identity for pid ${pid}`);
  return identity;
}

export function holderAlive(pid: number, identity: string): boolean {
  return readProcessStartIdentity(pid) === identity;
}

function leaseMatches(lease: Lease | null, self: RunSelf): boolean {
  return (
    lease !== null &&
    lease.gen === self.gen &&
    lease.holderPid === self.pid &&
    lease.holderIdentity === self.identity
  );
}

export interface OwnershipOptions {
  /** 连续锁超时多少次后放弃（默认 3；§6.2：连续三次失败 runner 自认围栏）。 */
  maxLockAttempts?: number;
  maxWaitMs?: number;
}

/**
 * 写即核对的唯一入口。`fn` 在临界区内执行，只做文件读写、fsync 与 cgroup 目录操作，
 * 不做 IPC、不等待子进程。核对失败抛 `FencedError`；连续锁超时抛
 * `OwnershipLockTimeoutError`（调用方按围栏处理）。
 */
export async function withRunOwnership<T>(
  runDir: string,
  self: RunSelf,
  fn: (lease: Lease) => T | Promise<T>,
  opts: OwnershipOptions = {},
): Promise<T> {
  const attempts = opts.maxLockAttempts ?? 3;
  let lastTimeout: FileLockTimeoutError | null = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withFileLock(
        leaseTargetPath(runDir),
        async () => {
          const lease = readLeaseUnlocked(runDir);
          if (lease === null || !leaseMatches(lease, self)) {
            throw new FencedError(
              `ownership check failed for pid ${self.pid} gen ${self.gen}: lease is ${lease ? `pid ${lease.holderPid} gen ${lease.gen}` : 'missing'}`,
              lease,
            );
          }
          return await fn(lease);
        },
        opts.maxWaitMs !== undefined ? { maxWaitMs: opts.maxWaitMs } : {},
      );
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        lastTimeout = err;
        continue;
      }
      throw err;
    }
  }
  throw new OwnershipLockTimeoutError(attempts, lastTimeout!);
}

/** 心跳：临界区内核对后刷新 heartbeatAt；`extra` 顺带写缓存（run.json 的 activeMs 等）。 */
export async function heartbeat(
  runDir: string,
  self: RunSelf,
  extra?: (lease: Lease) => void | Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  await withRunOwnership(runDir, self, async (lease) => {
    writeLeaseLocked(runDir, { ...lease, heartbeatAt: now() });
    if (extra) await extra(lease);
  });
}

/** 主动释放（中断退出）：核对后删除 lease；代次仍留在 journal 与 run.json 里。 */
export async function releaseRun(runDir: string, self: RunSelf): Promise<void> {
  await withRunOwnership(runDir, self, () => {
    try {
      unlinkSync(leaseTargetPath(runDir));
    } catch {
      // already gone
    }
  });
}

// ---------------------------------------------------------------------------
// 接管
// ---------------------------------------------------------------------------

export type TakeoverReason = RunTakeoverRow['reason'];

export interface AcquireOptions {
  pid: number;
  identity: string;
  /** 临界区内调用：journal 最后一条有效 run.started/run.takeover 的 gen 与 run.json.gen 的最大值。 */
  persistedMaxGen: () => number;
  /** run.json 记录的上一持有者（lease 丢失时尽力清理用）。 */
  lastHolder?: { pid: number; identity: string } | null;
  /** 临界区内、lease 写入之后调用：追加 run.takeover 行并重写 run.json。 */
  onCommit: (info: { gen: number; from: { pid: number | null; identity: string | null }; reason: TakeoverReason }) => void | Promise<void>;
  /** TERM → 宽限 → KILL → 确认退出。返回是否已确认消失。 */
  killProcess: (pid: number, identity: string) => Promise<boolean>;
  heartbeatStaleMs?: number;
  lockHolderStaleMs?: number;
  /** 单次进临界区的等待上限（默认 withFileLock 的 5s）；超时后进入锁实例计时。 */
  lockWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 总体放弃时限（默认 3 分钟），防止接管在异常宿主上无限循环。 */
  giveUpAfterMs?: number;
}

export interface AcquireResult {
  gen: number;
  reason: TakeoverReason;
  from: { pid: number | null; identity: string | null };
}

export interface LockInstance {
  key: string;
  pid: number | null;
  procStart: string | null;
}

/**
 * 锁持有者假死计时器（§6.2）：只按**同一锁实例**的连续占有计时。实例变化
 * （别的进程拿到又放掉了锁）或 lease 心跳有进展都会重置——累计等待时间
 * 永远不能成为杀当前持锁者的理由。纯逻辑，便于确定性测试。
 */
export class LockOccupancyTimer {
  private watch: { key: string; firstSeenAt: number; heartbeatAt: number | null } | null = null;

  constructor(private readonly staleMs: number) {}

  observe(
    instance: LockInstance | null,
    heartbeatAt: number | null,
    now: number,
  ): 'absent' | 'reset' | 'waiting' | 'expired' {
    if (!instance) {
      this.watch = null;
      return 'absent';
    }
    if (!this.watch || this.watch.key !== instance.key || this.watch.heartbeatAt !== heartbeatAt) {
      this.watch = { key: instance.key, firstSeenAt: now, heartbeatAt };
      return 'reset';
    }
    return now - this.watch.firstSeenAt < this.staleMs ? 'waiting' : 'expired';
  }

  reset(): void {
    this.watch = null;
  }
}

/** 读锁文件实例：inode + ctime + payload 三者合起来标识一次占有。 */
export function readLockInstance(lockPath: string): LockInstance | null {
  let ino: number;
  let ctimeMs: number;
  try {
    const st = lstatSync(lockPath);
    ino = st.ino;
    ctimeMs = st.ctimeMs;
  } catch {
    return null;
  }
  let pid: number | null = null;
  let procStart: string | null = null;
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (/^\d+$/.test(raw)) pid = Number(raw);
    else if (raw) {
      const parsed = JSON.parse(raw) as { pid?: unknown; procStart?: unknown };
      if (Number.isSafeInteger(parsed.pid)) pid = parsed.pid as number;
      if (typeof parsed.procStart === 'string') procStart = parsed.procStart;
    }
  } catch {
    // 空锁或半写：实例仍以 inode+ctime 区分
  }
  return { key: `${ino}:${ctimeMs}:${pid ?? '?'}:${procStart ?? '?'}`, pid, procStart };
}

/**
 * 接管协议（§6.2）。调用方在成功后持有 gen，之后所有写入经 `withRunOwnership`。
 *
 * - holder 存活且心跳新鲜 → `RunBusyError`
 * - holder 存活但心跳陈旧 → 临界区外 TERM→KILL，确认后再进临界区
 * - lease 缺失/损坏/holder 已死 → 直接接管；lease 缺失时尽力杀 run.json 里的上一持有者
 * - 锁持有者假死 → 按同一锁实例连续占有 `lockHolderStaleMs` 计时，变化即重置，
 *   到期前再核验一次实例未变，再杀、确认、交 `withFileLock` 陈旧回收
 */
export async function acquireRun(runDir: string, opts: AcquireOptions): Promise<AcquireResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const heartbeatStaleMs = opts.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
  const lockHolderStaleMs = opts.lockHolderStaleMs ?? LOCK_HOLDER_STALE_MS;
  const giveUpAfterMs = opts.giveUpAfterMs ?? 3 * 60_000;
  const giveUpAt = now() + giveUpAfterMs;
  mkdirSync(runDir, { recursive: true });
  const lockPath = leaseLockPath(runDir);

  const occupancy = new LockOccupancyTimer(lockHolderStaleMs);
  const lockOpts = opts.lockWaitMs !== undefined ? { maxWaitMs: opts.lockWaitMs } : {};
  let killedStaleHolder: { pid: number; identity: string } | null = null;
  let killedLockHolder: { pid: number; identity: string } | null = null;
  let lastHolderHandled = false;

  while (true) {
    if (now() > giveUpAt) throw new Error(`acquireRun gave up after ${giveUpAfterMs}ms`);

    // 临界区外：判断 holder 是否需要先杀掉（杀进程要等待，不能占着锁做）。
    const observed = readLeaseUnlocked(runDir);
    if (observed && holderAlive(observed.holderPid, observed.holderIdentity)) {
      if (now() - observed.heartbeatAt < heartbeatStaleMs) throw new RunBusyError(observed);
      await opts.killProcess(observed.holderPid, observed.holderIdentity);
      killedStaleHolder = { pid: observed.holderPid, identity: observed.holderIdentity };
      continue; // 杀完重新观察：可能已被别人接管
    }
    if (!observed && opts.lastHolder && !lastHolderHandled) {
      // lease 丢失时尽力释放上一持有者的资源；正确性不依赖这一步（它会在下一次写入时被围栏）。
      lastHolderHandled = true;
      if (holderAlive(opts.lastHolder.pid, opts.lastHolder.identity)) {
        await opts.killProcess(opts.lastHolder.pid, opts.lastHolder.identity);
      }
    }

    try {
      const result = await withFileLock(leaseTargetPath(runDir), async (): Promise<AcquireResult | 'retry'> => {
        occupancy.reset(); // 进了临界区：之前观察到的锁实例已经不存在
        const current = readLeaseUnlocked(runDir);
        if (current && holderAlive(current.holderPid, current.holderIdentity)) {
          if (now() - current.heartbeatAt < heartbeatStaleMs) throw new RunBusyError(current);
          return 'retry';
        }
        const persisted = opts.persistedMaxGen();
        const gen = Math.max(current?.gen ?? 0, persisted) + 1;
        let reason: TakeoverReason;
        let from: AcquireResult['from'];
        if (current) {
          from = { pid: current.holderPid, identity: current.holderIdentity };
          // 杀过占锁进程就以它为准（那是真正发生过的强制动作，inspect 时必须看得见）。
          if (killedLockHolder) reason = 'lock_holder_stale';
          else if (killedStaleHolder && killedStaleHolder.pid === current.holderPid) reason = 'heartbeat_stale';
          else reason = 'holder_dead';
        } else if (killedLockHolder) {
          // 没有 lease、但我们杀过一个占着锁不放的进程：接管原因就是它。
          reason = 'lock_holder_stale';
          from = { pid: killedLockHolder.pid, identity: killedLockHolder.identity };
        } else if (persisted === 0 && !observed) {
          reason = 'fresh';
          from = { pid: null, identity: null };
        } else {
          reason = 'lease_missing';
          const prior = observed
            ? { pid: observed.holderPid, identity: observed.holderIdentity }
            : opts.lastHolder ?? null;
          from = prior ? { pid: prior.pid, identity: prior.identity } : { pid: null, identity: null };
        }
        const stamp = now();
        writeLeaseLocked(runDir, {
          holderPid: opts.pid,
          holderIdentity: opts.identity,
          gen,
          heartbeatAt: stamp,
          acquiredAt: stamp,
        });
        await opts.onCommit({ gen, from, reason });
        return { gen, reason, from };
      }, lockOpts);
      if (result === 'retry') continue;
      return result;
    } catch (err) {
      if (!(err instanceof FileLockTimeoutError)) throw err;
      // 锁持有者假死处理：按同一锁实例的连续占有计时（§6.2）。
      const instance = readLockInstance(lockPath);
      const heartbeatAt = readLeaseUnlocked(runDir)?.heartbeatAt ?? null;
      const verdict = occupancy.observe(instance, heartbeatAt, now());
      if (verdict !== 'expired' || !instance) {
        await sleep(verdict === 'absent' ? 100 : 200);
        continue;
      }
      // 到期：发信号前再核验一次实例未变。
      const recheck = readLockInstance(lockPath);
      if (!recheck || recheck.key !== instance.key || instance.pid === null) {
        occupancy.reset();
        continue;
      }
      const identity = instance.procStart ?? readProcessStartIdentity(instance.pid) ?? '';
      if (identity && holderAlive(instance.pid, identity)) {
        await opts.killProcess(instance.pid, identity);
        killedLockHolder = { pid: instance.pid, identity };
      }
      occupancy.reset();
      // 杀死并确认后，withFileLock 会把死持有者的锁按陈旧回收；重试即可。
      await sleep(200);
    }
  }
}

/** 默认的 TERM → 5 秒 → KILL → 确认退出实现（按出生身份核对，防 pid 复用）。 */
export async function terminateProcess(
  pid: number,
  identity: string,
  opts: { graceMs?: number; confirmMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const graceMs = opts.graceMs ?? 5_000;
  const confirmMs = opts.confirmMs ?? 5_000;
  if (!holderAlive(pid, identity)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  const graceUntil = Date.now() + graceMs;
  while (Date.now() < graceUntil) {
    if (!holderAlive(pid, identity)) return true;
    await sleep(100);
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  const confirmUntil = Date.now() + confirmMs;
  while (Date.now() < confirmUntil) {
    if (!holderAlive(pid, identity)) return true;
    await sleep(100);
  }
  return !holderAlive(pid, identity);
}

/** 测试与 inspect 用：lease 文件是否存在。 */
export function leaseExists(runDir: string): boolean {
  return existsSync(leaseTargetPath(runDir));
}

/** 供测试注入损坏 lease。 */
export function __testOnly_writeLease(runDir: string, raw: string): void {
  writeFileSync(leaseTargetPath(runDir), raw);
}
