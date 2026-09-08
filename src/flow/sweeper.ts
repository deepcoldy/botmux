/**
 * `botmux flow` 宿主槽位清扫器（设计文档 §9）：由主 daemon 每 30 秒跑一次，幂等。
 *
 * 只处理 holder 已死的槽位：按 cgroupPath 回收容器，确认为空后在锁内比较条目未变再删除。
 * 不写任何 run 的 journal，不碰活着的 runner 的槽位。slots 文件不存在时零开销。
 */
import { existsSync } from 'node:fs';
import { probeContainerBackend, type ContainerBackend } from './container.js';
import { sweepSlots } from './slots.js';

export interface FlowSlotSweeperOptions {
  slotsFile: string;
  intervalMs?: number;
  log?: (line: string) => void;
  /** 测试注入；缺省首轮探测一次并缓存。 */
  backend?: ContainerBackend | null;
}

export const FLOW_SLOT_SWEEP_INTERVAL_MS = 30_000;

/** 启动清扫器；返回 stop。 */
export function startFlowSlotSweeper(opts: FlowSlotSweeperOptions): () => void {
  let backend: ContainerBackend | null | undefined = opts.backend;
  let inFlight = false;
  const log = opts.log ?? (() => undefined);
  const sweep = async (): Promise<void> => {
    if (inFlight) return;
    if (!existsSync(opts.slotsFile)) return;
    inFlight = true;
    try {
      if (backend === undefined) {
        const probed = probeContainerBackend();
        backend = probed.kind === 'none' ? null : probed;
      }
      const report = await sweepSlots(opts.slotsFile, backend);
      if (report.marked.length > 0) log(`marked ${report.marked.length} slot(s) pending_reclaim: ${report.marked.map((m) => `${m.runId}/${m.container}`).join(', ')}`);
      if (report.reclaimed.length > 0) log(`reclaimed ${report.reclaimed.length} slot(s): ${report.reclaimed.map((m) => `${m.runId}/${m.container}`).join(', ')}`);
      for (const f of report.failed) log(`slot ${f.entry.runId}/${f.entry.container} not reclaimable yet: ${f.result.ok ? 'ok' : f.result.detail}`);
    } catch (err) {
      log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };
  const timer = setInterval(() => void sweep(), opts.intervalMs ?? FLOW_SLOT_SWEEP_INTERVAL_MS);
  timer.unref?.();
  void sweep();
  return () => clearInterval(timer);
}
