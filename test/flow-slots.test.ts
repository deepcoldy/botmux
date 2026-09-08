/**
 * 宿主槽位（设计文档 §9）：释放只认容器为空；holder 死亡只标 pending_reclaim；清扫器锁内比较后再删。
 * 纯文件逻辑，容器回收通过注入的 reclaim 桩控制。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../src/utils/process-identity.js';
import type { ContainerBackend, ReclaimResult } from '../src/flow/container.js';
import { acquireSlot, adoptRunSlots, listSlots, markDeadHolders, releaseSlot, sweepSlots, type SlotEntry } from '../src/flow/slots.js';
import { containerPath, createContainerDir, probeContainerBackend, removeRunTreeIfEmpty } from '../src/flow/container.js';
import { startFlowSlotSweeper } from '../src/flow/sweeper.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill('SIGKILL');
      await new Promise<void>((r) => c.once('exit', () => r()));
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function slotsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-slots-'));
  dirs.push(dir);
  return join(dir, 'flow-host-slots.json');
}

function self(pid = process.pid): { pid: number; identity: string } {
  return { pid, identity: readProcessStartIdentity(pid)! };
}

async function deadHolder(): Promise<{ pid: number; identity: string }> {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(child);
  await new Promise((r) => setTimeout(r, 50));
  const identity = readProcessStartIdentity(child.pid!)!;
  child.kill('SIGKILL');
  await new Promise<void>((r) => child.once('exit', () => r()));
  return { pid: child.pid!, identity };
}

function entry(runId: string, n: number, holder: { pid: number; identity: string }, gen = 1): Omit<SlotEntry, 'state'> {
  return { runId, gen, container: `c-${gen}-${n}`, cgroupPath: `/sys/fs/cgroup/freezer/botmux-flow/${runId}/c-${gen}-${n}`, holderPid: holder.pid, holderIdentity: holder.identity };
}

const fakeBackend: ContainerBackend = { kind: 'cgroup1-freezer', mount: '/sys/fs/cgroup/freezer', base: '/sys/fs/cgroup/freezer/botmux-flow' };

describe('flow slots', () => {
  it('容量：held 与 pending_reclaim 都计入；同 run 同容器重复申请视为已持有', async () => {
    const file = slotsFile();
    const me = self();
    expect(await acquireSlot(file, entry('r1', 0, me), 2)).toEqual({ ok: true });
    expect(await acquireSlot(file, entry('r1', 0, me), 2)).toEqual({ ok: true }); // 幂等
    expect(await acquireSlot(file, entry('r2', 0, me), 2)).toEqual({ ok: true });
    expect(await acquireSlot(file, entry('r3', 0, me), 2)).toEqual({ ok: false, occupied: 2, capacity: 2 });
    // holder 死了 → pending_reclaim，仍占用
    const dead = await deadHolder();
    const file2 = slotsFile();
    expect(await acquireSlot(file2, entry('r1', 0, dead), 1)).toEqual({ ok: true });
    const marked = await markDeadHolders(file2);
    expect(marked.map((m) => m.state)).toEqual(['pending_reclaim']);
    expect(await acquireSlot(file2, entry('r2', 0, me), 1)).toEqual({ ok: false, occupied: 1, capacity: 1 });
  });

  it('释放是 compare-and-delete：条目被改记后旧持有者释放不掉', async () => {
    const file = slotsFile();
    const me = self();
    const e = entry('r1', 0, me);
    await acquireSlot(file, e);
    // 另一个 runner 改记（模拟接管）
    const other = await deadHolder();
    await adoptRunSlots(file, 'r1', { ...other, gen: 2 });
    expect(await releaseSlot(file, { ...e, state: 'held' })).toBe(false);
    const list = await listSlots(file);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ holderPid: other.pid, gen: 2, state: 'held' });
    expect(await releaseSlot(file, list[0]!)).toBe(true);
    expect(await listSlots(file)).toEqual([]);
  });

  it('清扫器：holder 死亡只标记；回收失败保留；回收成功且条目未变才删；已被改记的跳过', async () => {
    const file = slotsFile();
    const dead = await deadHolder();
    const dead2 = await deadHolder();
    const me = self();
    await acquireSlot(file, entry('r1', 0, dead));
    await acquireSlot(file, entry('r2', 0, dead2));
    await acquireSlot(file, entry('r3', 0, me)); // 活着的，不能动

    // 第一轮：r1 回收失败（容器还没空），r2 回收成功
    const outcomes = new Map<string, ReclaimResult>([
      [entry('r1', 0, dead).cgroupPath, { ok: false, reason: 'drain_timeout', residual: [4242], detail: 'still populated' }],
      [entry('r2', 0, dead2).cgroupPath, { ok: true, killed: 1, cycles: 1 }],
    ]);
    const calls: string[] = [];
    const reclaim = async (_backend: ContainerBackend, path: string): Promise<ReclaimResult> => {
      calls.push(path);
      return outcomes.get(path) ?? { ok: true, killed: 0, cycles: 0 };
    };
    const report1 = await sweepSlots(file, fakeBackend, reclaim);
    expect(report1.marked.map((m) => m.runId).sort()).toEqual(['r1', 'r2']);
    expect(report1.failed.map((f) => f.entry.runId)).toEqual(['r1']);
    expect(report1.reclaimed.map((r) => r.runId)).toEqual(['r2']);
    expect(calls).not.toContain(entry('r3', 0, me).cgroupPath);
    const after1 = await listSlots(file);
    expect(after1.map((e) => [e.runId, e.state])).toEqual([['r1', 'pending_reclaim'], ['r3', 'held']]);

    // 第二轮：r1 容器空了，但在回收期间被新 runner 改记 → 跳过，不删
    const reclaimThenAdopt = async (_backend: ContainerBackend, path: string): Promise<ReclaimResult> => {
      await adoptRunSlots(file, 'r1', { ...me, gen: 2 });
      return { ok: true, killed: 0, cycles: 1 };
    };
    const report2 = await sweepSlots(file, fakeBackend, reclaimThenAdopt);
    expect(report2.skipped.map((s) => s.runId)).toEqual(['r1']);
    expect(report2.reclaimed).toEqual([]);
    const after2 = await listSlots(file);
    expect(after2.find((e) => e.runId === 'r1')).toMatchObject({ holderPid: me.pid, gen: 2, state: 'held' });

    // 没有容器后端：不回收也不删，报 failed
    const file3 = slotsFile();
    await acquireSlot(file3, entry('r9', 0, dead));
    const report3 = await sweepSlots(file3, null, reclaim);
    expect(report3.failed).toHaveLength(1);
    expect((await listSlots(file3))[0]!.state).toBe('pending_reclaim');
  });

  it('daemon 清扫器：无后端时只标记不删；有真实 cgroup 后端时空容器被回收、槽位释放；活 holder 不动', async () => {
    const file = slotsFile();
    const dead = await deadHolder();
    const me = self();
    await acquireSlot(file, entry('r1', 0, dead));
    await acquireSlot(file, entry('r2', 0, me));
    const lines: string[] = [];
    const stop = startFlowSlotSweeper({ slotsFile: file, intervalMs: 60_000, backend: null, log: (l) => lines.push(l) });
    await new Promise((r) => setTimeout(r, 200));
    stop();
    expect((await listSlots(file)).map((e) => [e.runId, e.state])).toEqual([['r1', 'pending_reclaim'], ['r2', 'held']]);
    expect(lines.some((l) => l.includes('marked 1 slot'))).toBe(true);
    expect(lines.some((l) => l.includes('not reclaimable yet'))).toBe(true);

    const probed = probeContainerBackend();
    if (probed.kind === 'none') return; // 没有容器后端的宿主：真实回收路径无法验证（不算通过）
    const runId = `slots-${process.pid}-${Date.now().toString(36)}`;
    const cpath = containerPath(probed, runId, 'c-1-0');
    createContainerDir(cpath);
    const file2 = slotsFile();
    await acquireSlot(file2, { ...entry(runId, 0, dead), cgroupPath: cpath });
    await acquireSlot(file2, entry('alive', 0, me));
    const lines2: string[] = [];
    const stop2 = startFlowSlotSweeper({ slotsFile: file2, intervalMs: 60_000, backend: probed, log: (l) => lines2.push(l) });
    await new Promise((r) => setTimeout(r, 500));
    stop2();
    removeRunTreeIfEmpty(probed, runId);
    expect((await listSlots(file2)).map((e) => e.runId)).toEqual(['alive']);
    expect(lines2.some((l) => l.includes('reclaimed 1 slot'))).toBe(true);
  });
});
