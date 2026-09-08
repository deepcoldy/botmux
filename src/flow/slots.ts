/**
 * 宿主级槽位（设计文档 §9「槽位释放只认容器为空」）。
 *
 * 文件 `<dataDir>/flow-host-slots.json`，`withFileLock` 保护，条目
 * `{runId, gen, container, cgroupPath, holderPid, holderIdentity, state: held | pending_reclaim}`。
 *
 * - 申请：held 与 pending_reclaim 都计入占用。
 * - holder 死亡只把条目置为 pending_reclaim，**不释放**。
 * - 释放只有两条路：① 下一任 runner 改记到自己名下 → 回收容器 → 确认为空后释放；
 *   ② 清扫器对 pending_reclaim 条目按 cgroupPath 幂等回收，确认为空后在锁内**比较条目未变**再删除。
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';
import { readProcessStartIdentity } from '../utils/process-identity.js';
import { reclaimContainer, type ContainerBackend, type ReclaimResult } from './container.js';

export interface SlotEntry {
  runId: string;
  gen: number;
  container: string;
  cgroupPath: string;
  holderPid: number;
  holderIdentity: string;
  state: 'held' | 'pending_reclaim';
}

export const DEFAULT_HOST_SLOTS = 16;

interface SlotsFile {
  entries: SlotEntry[];
}

function readSlots(file: string): SlotsFile {
  if (!existsSync(file)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SlotsFile>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [] };
  } catch {
    return { entries: [] };
  }
}

function isEntry(value: unknown): value is SlotEntry {
  const e = value as Partial<SlotEntry>;
  return (
    !!e &&
    typeof e.runId === 'string' &&
    Number.isSafeInteger(e.gen) &&
    typeof e.container === 'string' &&
    typeof e.cgroupPath === 'string' &&
    Number.isSafeInteger(e.holderPid) &&
    typeof e.holderIdentity === 'string' &&
    (e.state === 'held' || e.state === 'pending_reclaim')
  );
}

function writeSlots(file: string, data: SlotsFile): void {
  atomicWriteFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function sameEntry(a: SlotEntry, b: SlotEntry): boolean {
  return (
    a.runId === b.runId &&
    a.gen === b.gen &&
    a.container === b.container &&
    a.cgroupPath === b.cgroupPath &&
    a.holderPid === b.holderPid &&
    a.holderIdentity === b.holderIdentity &&
    a.state === b.state
  );
}

export function holderDead(entry: SlotEntry): boolean {
  return readProcessStartIdentity(entry.holderPid) !== entry.holderIdentity;
}

export type AcquireSlotResult = { ok: true } | { ok: false; occupied: number; capacity: number };

/** 申请一个槽位；`pending_reclaim` 条目照常计入占用。同 run 同 container 重复申请视为已持有。 */
export async function acquireSlot(file: string, entry: Omit<SlotEntry, 'state'>, capacity: number = DEFAULT_HOST_SLOTS): Promise<AcquireSlotResult> {
  return withFileLock(file, async () => {
    const data = readSlots(file);
    const existing = data.entries.find((e) => e.runId === entry.runId && e.container === entry.container);
    if (existing) {
      if (existing.holderPid === entry.holderPid && existing.holderIdentity === entry.holderIdentity && existing.state === 'held') return { ok: true };
      // 同名容器已有别人的条目：容器名含 gen，正常不会撞；撞了按占用处理
      return { ok: false, occupied: data.entries.length, capacity };
    }
    if (data.entries.length >= capacity) return { ok: false, occupied: data.entries.length, capacity };
    data.entries.push({ ...entry, state: 'held' });
    writeSlots(file, data);
    return { ok: true };
  });
}

/** 释放：只删除与给定条目完全一致的记录（compare-and-delete）。返回是否删除了。 */
export async function releaseSlot(file: string, entry: SlotEntry): Promise<boolean> {
  return withFileLock(file, async () => {
    const data = readSlots(file);
    const idx = data.entries.findIndex((e) => sameEntry(e, entry));
    if (idx === -1) return false;
    data.entries.splice(idx, 1);
    writeSlots(file, data);
    return true;
  });
}

/** 下一任 runner 把本 run 的旧条目改记到自己名下（回收前）。返回改记后的条目。 */
export async function adoptRunSlots(file: string, runId: string, self: { pid: number; identity: string; gen: number }): Promise<SlotEntry[]> {
  return withFileLock(file, async () => {
    const data = readSlots(file);
    const adopted: SlotEntry[] = [];
    for (const e of data.entries) {
      if (e.runId !== runId) continue;
      if (e.holderPid === self.pid && e.holderIdentity === self.identity) {
        adopted.push(e);
        continue;
      }
      e.holderPid = self.pid;
      e.holderIdentity = self.identity;
      e.gen = self.gen;
      e.state = 'held';
      adopted.push(e);
    }
    if (adopted.length > 0) writeSlots(file, data);
    return adopted.map((e) => ({ ...e }));
  });
}

export async function listSlots(file: string): Promise<SlotEntry[]> {
  return withFileLock(file, async () => readSlots(file).entries.map((e) => ({ ...e })));
}

/** 清扫器第一步：holder 已死的 held 条目置为 pending_reclaim（不释放）。 */
export async function markDeadHolders(file: string): Promise<SlotEntry[]> {
  return withFileLock(file, async () => {
    const data = readSlots(file);
    const marked: SlotEntry[] = [];
    for (const e of data.entries) {
      if (e.state === 'held' && holderDead(e)) {
        e.state = 'pending_reclaim';
        marked.push({ ...e });
      }
    }
    if (marked.length > 0) writeSlots(file, data);
    return marked;
  });
}

export interface SweepReport {
  marked: SlotEntry[];
  reclaimed: SlotEntry[];
  failed: Array<{ entry: SlotEntry; result: ReclaimResult }>;
  /** 回收成功但锁内比较发现条目已被改记（新 runner 接手）：不删，由它释放。 */
  skipped: SlotEntry[];
}

/**
 * daemon 清扫器（每 30 秒；幂等）。对 holder 仍死亡的 pending_reclaim 条目按 cgroupPath 回收，
 * 确认为空后在锁内比较条目未变再删除。不写任何 run 的 journal。
 */
export async function sweepSlots(file: string, backend: ContainerBackend | null, reclaim = reclaimContainer): Promise<SweepReport> {
  const report: SweepReport = { marked: await markDeadHolders(file), reclaimed: [], failed: [], skipped: [] };
  const pending = (await listSlots(file)).filter((e) => e.state === 'pending_reclaim' && holderDead(e));
  for (const entry of pending) {
    if (!backend) {
      report.failed.push({ entry, result: { ok: false, reason: 'enumerate_failed', residual: [], detail: 'no container backend available on this host' } });
      continue;
    }
    const result = await reclaim(backend, entry.cgroupPath);
    if (!result.ok) {
      report.failed.push({ entry, result });
      continue;
    }
    const deleted = await releaseSlot(file, entry);
    if (deleted) report.reclaimed.push(entry);
    else report.skipped.push(entry);
  }
  return report;
}
