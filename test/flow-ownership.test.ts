/**
 * flow 所有权（设计文档 §6.2）：lease / 代次 / 接管 / 写即核对。
 *
 * 真进程故障注入：
 *   - 心跳陈旧但仍存活的 holder（`sleep` 子进程）→ TERM→KILL 后接管
 *   - 占着 `run.lease.lock` 不放的进程（子进程在 withFileLock 回调里挂起）→ 按锁实例连续占有计时后杀
 *   - 锁实例切换：纯计时器测试证明累计等待永远不会到期
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import {
  FencedError,
  LockOccupancyTimer,
  OwnershipLockTimeoutError,
  RunBusyError,
  __testOnly_writeLease,
  acquireRun,
  heartbeat,
  holderAlive,
  leaseExists,
  leaseLockPath,
  leaseTargetPath,
  readLeaseUnlocked,
  readLockInstance,
  releaseRun,
  selfIdentity,
  terminateProcess,
  withRunOwnership,
  type AcquireOptions,
  type AcquireResult,
} from '../src/flow/ownership.js';
import type { Lease } from '../src/flow/types.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];

function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ownership-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一个会活着的无关进程（模拟别的 runner）。 */
function spawnSleeper(): { pid: number; identity: string; child: ChildProcess } {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(child);
  const pid = child.pid!;
  const identity = readProcessStartIdentity(pid);
  if (!identity) throw new Error('cannot read identity of sleeper');
  return { pid, identity, child };
}

/** 子进程拿到 `<runDir>/run.lease.lock` 后永远不放；stdout 输出 `locked` 表示已持有。 */
async function spawnStuckLockHolder(runDir: string): Promise<{ pid: number; identity: string; child: ChildProcess }> {
  const source = `
    const { withFileLock } = await import('./src/utils/file-lock.js');
    await withFileLock(process.env.FLOW_TEST_LOCK_TARGET, async () => {
      process.stdout.write('locked\\n');
      // 一个永不触发的定时器让事件循环活着；否则 Node 会以「未决的顶层 await」退出（exit 13）并放掉锁。
      setInterval(() => {}, 60_000);
      await new Promise(() => {});
    });
  `;
  const child = spawnTsEvalWithRepoImports(source, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FLOW_TEST_LOCK_TARGET: leaseTargetPath(runDir) },
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stderr!.on('data', (chunk: Buffer) => { err += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('locked')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`lock holder exited early (code ${code}): ${err}`)));
  });
  // 拿到锁后再等一拍，确认子进程没有因为事件循环空转而退出（那样锁会被回收，测试就测不到占锁）。
  await sleepMs(150);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`lock holder exited after locking (code ${child.exitCode}): ${err}`);
  }
  if (!existsSync(leaseLockPath(runDir))) throw new Error('lock holder printed locked but no lock file exists');
  const pid = child.pid!;
  const identity = readProcessStartIdentity(pid);
  if (!identity) throw new Error('cannot read identity of lock holder');
  return { pid, identity, child };
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

interface Harness {
  opts: AcquireOptions;
  commits: Array<{ gen: number; from: AcquireResult['from']; reason: AcquireResult['reason'] }>;
  kills: Array<{ pid: number; identity: string }>;
}

function harness(overrides: Partial<AcquireOptions> = {}): Harness {
  const commits: Harness['commits'] = [];
  const kills: Harness['kills'] = [];
  const opts: AcquireOptions = {
    pid: process.pid,
    identity: selfIdentity(),
    persistedMaxGen: () => 0,
    onCommit: (info) => { commits.push(info); },
    killProcess: async (pid, identity) => {
      kills.push({ pid, identity });
      return terminateProcess(pid, identity, { graceMs: 2_000, confirmMs: 2_000 });
    },
    heartbeatStaleMs: 1_000,
    lockHolderStaleMs: 1_000,
    lockWaitMs: 300,
    giveUpAfterMs: 20_000,
    ...overrides,
  };
  return { opts, commits, kills };
}

function writeLease(runDir: string, lease: Lease): void {
  __testOnly_writeLease(runDir, JSON.stringify(lease));
}

describe('LockOccupancyTimer（锁实例连续占有计时）', () => {
  const a = { key: 'ino1:1:100:s1', pid: 100, procStart: 's1' };
  const b = { key: 'ino2:2:200:s2', pid: 200, procStart: 's2' };

  it('同一实例连续占有到期才 expired；到期前 waiting', () => {
    const timer = new LockOccupancyTimer(1_000);
    expect(timer.observe(a, null, 0)).toBe('reset');
    expect(timer.observe(a, null, 500)).toBe('waiting');
    expect(timer.observe(a, null, 999)).toBe('waiting');
    expect(timer.observe(a, null, 1_000)).toBe('expired');
  });

  it('锁实例切换：累计等待再久也不到期', () => {
    const timer = new LockOccupancyTimer(1_000);
    let t = 0;
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      seen.push(timer.observe(i % 2 === 0 ? a : b, null, t));
      t += 800; // 每个实例最多占 800ms，总计 8s
    }
    expect(seen.every((v) => v === 'reset')).toBe(true);
  });

  it('同一实例但 lease 心跳有进展：重置', () => {
    const timer = new LockOccupancyTimer(1_000);
    expect(timer.observe(a, 10, 0)).toBe('reset');
    expect(timer.observe(a, 10, 900)).toBe('waiting');
    expect(timer.observe(a, 20, 1_100)).toBe('reset');
    expect(timer.observe(a, 20, 2_000)).toBe('waiting');
    expect(timer.observe(a, 20, 2_100)).toBe('expired');
  });

  it('锁消失 → absent 并清空；reset() 后重新计时', () => {
    const timer = new LockOccupancyTimer(1_000);
    expect(timer.observe(a, null, 0)).toBe('reset');
    expect(timer.observe(null, null, 500)).toBe('absent');
    expect(timer.observe(a, null, 600)).toBe('reset');
    expect(timer.observe(a, null, 1_700)).toBe('expired');
    timer.reset();
    expect(timer.observe(a, null, 1_800)).toBe('reset');
  });
});

describe('readLeaseUnlocked / readLockInstance', () => {
  it('缺失、损坏、字段不全都返回 null', () => {
    const runDir = makeRunDir();
    expect(readLeaseUnlocked(runDir)).toBeNull();
    __testOnly_writeLease(runDir, '{not json');
    expect(readLeaseUnlocked(runDir)).toBeNull();
    __testOnly_writeLease(runDir, JSON.stringify({ holderPid: 1, gen: 1 }));
    expect(readLeaseUnlocked(runDir)).toBeNull();
    __testOnly_writeLease(runDir, JSON.stringify({ holderPid: 1.5, holderIdentity: 'x', gen: 1, heartbeatAt: 1, acquiredAt: 1 }));
    expect(readLeaseUnlocked(runDir)).toBeNull();
  });

  it('锁实例 key 随 inode/ctime 与 payload 变化；空锁也有实例', () => {
    const runDir = makeRunDir();
    const lockPath = leaseLockPath(runDir);
    expect(readLockInstance(lockPath)).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ pid: 4242, procStart: 'abc' }));
    const first = readLockInstance(lockPath)!;
    expect(first.pid).toBe(4242);
    expect(first.procStart).toBe('abc');
    rmSync(lockPath);
    writeFileSync(lockPath, '4243');
    const second = readLockInstance(lockPath)!;
    expect(second.pid).toBe(4243);
    expect(second.procStart).toBeNull();
    expect(second.key).not.toBe(first.key);
    rmSync(lockPath);
    writeFileSync(lockPath, '');
    const empty = readLockInstance(lockPath)!;
    expect(empty.pid).toBeNull();
    expect(empty.key).not.toBe(second.key);
  });
});

describe('acquireRun（接管协议）', () => {
  it('全新 run：gen 1，reason fresh，lease 写入本进程身份，onCommit 在 lease 写入后调用', async () => {
    const runDir = makeRunDir();
    const h = harness({
      onCommit: (info) => {
        // 提交回调运行时 lease 必须已经落盘且属于我们
        const lease = readLeaseUnlocked(runDir)!;
        expect(lease.gen).toBe(info.gen);
        expect(lease.holderPid).toBe(process.pid);
        h.commits.push(info);
      },
    });
    const result = await acquireRun(runDir, h.opts);
    expect(result).toEqual({ gen: 1, reason: 'fresh', from: { pid: null, identity: null } });
    expect(h.commits).toEqual([result]);
    expect(h.kills).toEqual([]);
    const lease = readLeaseUnlocked(runDir)!;
    expect(lease.holderIdentity).toBe(selfIdentity());
    expect(lease.acquiredAt).toBe(lease.heartbeatAt);
    expect(existsSync(leaseLockPath(runDir))).toBe(false);
  });

  it('holder 存活且心跳新鲜 → RunBusyError，不改 lease', async () => {
    const runDir = makeRunDir();
    const h = harness();
    await acquireRun(runDir, h.opts);
    const before = readFileSync(leaseTargetPath(runDir), 'utf8');
    await expect(acquireRun(runDir, harness().opts)).rejects.toBeInstanceOf(RunBusyError);
    expect(readFileSync(leaseTargetPath(runDir), 'utf8')).toBe(before);
  });

  it('两个接管者并发抢全新 run：恰好一个成功，另一个 RunBusyError', async () => {
    const runDir = makeRunDir();
    const results = await Promise.allSettled([
      acquireRun(runDir, harness().opts),
      acquireRun(runDir, harness().opts),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const busy = results.filter((r) => r.status === 'rejected' && r.reason instanceof RunBusyError);
    expect(ok).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect((ok[0] as PromiseFulfilledResult<AcquireResult>).value.gen).toBe(1);
  });

  it('holder 已死（出生身份不匹配）→ holder_dead，gen 递增，不杀任何进程', async () => {
    const runDir = makeRunDir();
    writeLease(runDir, { holderPid: process.pid, holderIdentity: 'not-this-process', gen: 3, heartbeatAt: Date.now(), acquiredAt: Date.now() });
    const h = harness();
    const result = await acquireRun(runDir, h.opts);
    expect(result).toEqual({ gen: 4, reason: 'holder_dead', from: { pid: process.pid, identity: 'not-this-process' } });
    expect(h.kills).toEqual([]);
    expect(readLeaseUnlocked(runDir)!.holderIdentity).toBe(selfIdentity());
  });

  it('代次取 lease 与持久化最大值 +1', async () => {
    const runDir = makeRunDir();
    writeLease(runDir, { holderPid: process.pid, holderIdentity: 'ghost', gen: 2, heartbeatAt: 0, acquiredAt: 0 });
    const result = await acquireRun(runDir, harness({ persistedMaxGen: () => 7 }).opts);
    expect(result.gen).toBe(8);
    expect(result.reason).toBe('holder_dead');
  });

  it('lease 丢失但 journal 有代次 → lease_missing，from 取 run.json 的上一持有者（已死则不杀）', async () => {
    const runDir = makeRunDir();
    const dead = spawnSleeper();
    dead.child.kill('SIGKILL');
    await waitForExit(dead.child);
    expect(holderAlive(dead.pid, dead.identity)).toBe(false);
    const h = harness({ persistedMaxGen: () => 5, lastHolder: { pid: dead.pid, identity: dead.identity } });
    const result = await acquireRun(runDir, h.opts);
    expect(result).toEqual({ gen: 6, reason: 'lease_missing', from: { pid: dead.pid, identity: dead.identity } });
    expect(h.kills).toEqual([]);
  });

  it('lease 丢失且上一持有者仍活着 → 尽力杀掉后接管', async () => {
    const runDir = makeRunDir();
    const alive = spawnSleeper();
    const h = harness({ persistedMaxGen: () => 1, lastHolder: { pid: alive.pid, identity: alive.identity } });
    const result = await acquireRun(runDir, h.opts);
    expect(result.reason).toBe('lease_missing');
    expect(result.gen).toBe(2);
    expect(h.kills).toEqual([{ pid: alive.pid, identity: alive.identity }]);
    await waitForExit(alive.child);
    expect(holderAlive(alive.pid, alive.identity)).toBe(false);
  });

  it('holder 存活但心跳陈旧 → 临界区外 TERM→KILL，确认后接管为 heartbeat_stale', async () => {
    const runDir = makeRunDir();
    const holder = spawnSleeper();
    writeLease(runDir, { holderPid: holder.pid, holderIdentity: holder.identity, gen: 4, heartbeatAt: Date.now() - 5_000, acquiredAt: Date.now() - 10_000 });
    const h = harness();
    const result = await acquireRun(runDir, h.opts);
    expect(result).toEqual({ gen: 5, reason: 'heartbeat_stale', from: { pid: holder.pid, identity: holder.identity } });
    expect(h.kills).toEqual([{ pid: holder.pid, identity: holder.identity }]);
    await waitForExit(holder.child);
    expect(holderAlive(holder.pid, holder.identity)).toBe(false);
  });

  it('占着锁不放的进程：按同一锁实例连续占有到期后被杀，接管为 lock_holder_stale', async () => {
    const runDir = makeRunDir();
    const stuck = await spawnStuckLockHolder(runDir);
    const h = harness({ lockHolderStaleMs: 1_000, lockWaitMs: 250 });
    const startedAt = Date.now();
    const result = await acquireRun(runDir, h.opts);
    const elapsed = Date.now() - startedAt;
    expect(result).toEqual({ gen: 1, reason: 'lock_holder_stale', from: { pid: stuck.pid, identity: stuck.identity } });
    expect(h.kills).toEqual([{ pid: stuck.pid, identity: stuck.identity }]);
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    await waitForExit(stuck.child);
    expect(holderAlive(stuck.pid, stuck.identity)).toBe(false);
    expect(readLeaseUnlocked(runDir)!.holderPid).toBe(process.pid);
  }, 20_000);

  it('占着锁的进程：lease 心跳仍在进展时计时被重置，心跳停止后才按连续占有到期', async () => {
    const runDir = makeRunDir();
    const stuck = await spawnStuckLockHolder(runDir);
    // lease 属于一个已死的 runner（否则会直接 RunBusy），但有人在推进它的 heartbeatAt：
    // 前 1.6s 每 300ms 改一次，模拟「锁没换实例、可 lease 有进展」的重置条件。
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks++;
      writeLease(runDir, { holderPid: process.pid, holderIdentity: 'ghost-runner', gen: 1, heartbeatAt: Date.now(), acquiredAt: 0 });
    }, 300);
    const stopTickingAt = Date.now() + 1_600;
    const stopper = setTimeout(() => clearInterval(ticker), 1_600);
    let killedAt = 0;
    const h = harness({
      lockHolderStaleMs: 800,
      lockWaitMs: 200,
      killProcess: async (pid, identity) => {
        killedAt = Date.now();
        return terminateProcess(pid, identity, { graceMs: 2_000, confirmMs: 2_000 });
      },
    });
    try {
      const result = await acquireRun(runDir, h.opts);
      expect(ticks).toBeGreaterThanOrEqual(4);
      expect(killedAt).toBeGreaterThan(0);
      // 心跳停止后至少要再连续占有 lockHolderStaleMs 才允许杀（留出一次 lockWaitMs 的采样误差）
      expect(killedAt - stopTickingAt).toBeGreaterThanOrEqual(800 - 250);
      expect(result.reason).toBe('lock_holder_stale');
      expect(result.from).toEqual({ pid: process.pid, identity: 'ghost-runner' });
      expect(result.gen).toBe(2);
    } finally {
      clearInterval(ticker);
      clearTimeout(stopper);
    }
  }, 20_000);

  it('超过 giveUpAfterMs 仍拿不到锁 → 放弃并抛错，不杀进程', async () => {
    const runDir = makeRunDir();
    const stuck = await spawnStuckLockHolder(runDir);
    const h = harness({ lockHolderStaleMs: 60_000, lockWaitMs: 150, giveUpAfterMs: 700 });
    await expect(acquireRun(runDir, h.opts)).rejects.toThrow(/gave up/);
    expect(h.kills).toEqual([]);
    expect(holderAlive(stuck.pid, stuck.identity)).toBe(true);
  }, 20_000);
});

describe('withRunOwnership / heartbeat / releaseRun（写即核对）', () => {
  it('持有者在临界区内拿到 lease；心跳刷新 heartbeatAt；释放后 lease 消失', async () => {
    const runDir = makeRunDir();
    const { gen } = await acquireRun(runDir, harness().opts);
    const self = { pid: process.pid, identity: selfIdentity(), gen };
    const seen = await withRunOwnership(runDir, self, (lease) => lease.gen);
    expect(seen).toBe(gen);
    const before = readLeaseUnlocked(runDir)!;
    let extraSeen: Lease | null = null;
    await heartbeat(runDir, self, (lease) => { extraSeen = lease; }, () => before.heartbeatAt + 5_000);
    expect(readLeaseUnlocked(runDir)!.heartbeatAt).toBe(before.heartbeatAt + 5_000);
    expect(extraSeen).not.toBeNull();
    await releaseRun(runDir, self);
    expect(leaseExists(runDir)).toBe(false);
    expect(existsSync(leaseLockPath(runDir))).toBe(false);
  });

  it('代次不符、lease 缺失、被别人接管 → FencedError，且 fn 不执行', async () => {
    const runDir = makeRunDir();
    const { gen } = await acquireRun(runDir, harness().opts);
    const self = { pid: process.pid, identity: selfIdentity(), gen };
    let ran = 0;
    await expect(withRunOwnership(runDir, { ...self, gen: gen + 1 }, () => { ran++; })).rejects.toBeInstanceOf(FencedError);
    // 被接管：另一个 runner（不同身份）写入了新 lease
    writeLease(runDir, { holderPid: process.pid, holderIdentity: 'other-runner', gen: gen + 1, heartbeatAt: Date.now(), acquiredAt: Date.now() });
    await expect(heartbeat(runDir, self)).rejects.toBeInstanceOf(FencedError);
    await expect(releaseRun(runDir, self)).rejects.toBeInstanceOf(FencedError);
    rmSync(leaseTargetPath(runDir));
    const err = await withRunOwnership(runDir, self, () => { ran++; }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FencedError);
    expect((err as FencedError).lease).toBeNull();
    expect(ran).toBe(0);
  });

  it('临界区被占：连续三次锁超时后抛 OwnershipLockTimeoutError（不杀持锁者）', async () => {
    const runDir = makeRunDir();
    const { gen } = await acquireRun(runDir, harness().opts);
    const self = { pid: process.pid, identity: selfIdentity(), gen };
    const stuck = await spawnStuckLockHolder(runDir);
    const startedAt = Date.now();
    const err = await withRunOwnership(runDir, self, () => 'unreachable', { maxWaitMs: 150 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnershipLockTimeoutError);
    expect((err as OwnershipLockTimeoutError).attempts).toBe(3);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
    expect(holderAlive(stuck.pid, stuck.identity)).toBe(true);
  }, 20_000);

  it('fn 抛出的异常原样透传，锁被释放', async () => {
    const runDir = makeRunDir();
    const { gen } = await acquireRun(runDir, harness().opts);
    const self = { pid: process.pid, identity: selfIdentity(), gen };
    await expect(withRunOwnership(runDir, self, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(leaseLockPath(runDir))).toBe(false);
    expect(await withRunOwnership(runDir, self, () => 'ok')).toBe('ok');
  });
});

describe('terminateProcess', () => {
  it('对已死进程立即返回 true；对存活进程 TERM 后确认消失', async () => {
    const dead = spawnSleeper();
    dead.child.kill('SIGKILL');
    await waitForExit(dead.child);
    expect(await terminateProcess(dead.pid, dead.identity)).toBe(true);
    const alive = spawnSleeper();
    expect(await terminateProcess(alive.pid, alive.identity, { graceMs: 2_000, confirmMs: 2_000 })).toBe(true);
    await waitForExit(alive.child);
    expect(holderAlive(alive.pid, alive.identity)).toBe(false);
  });

  it('pid 复用防护：身份不匹配视为已消失，不发信号', async () => {
    const alive = spawnSleeper();
    expect(await terminateProcess(alive.pid, 'someone-else')).toBe(true);
    expect(holderAlive(alive.pid, alive.identity)).toBe(true);
  });
});
