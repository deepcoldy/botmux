/**
 * runtime 级联定序器的等待原语（设计 docs/design/2026-09-11-command-router.md §6）。
 *
 * daemon 侧对 CLI 只有两样可读的"空闲"证据，都由 worker 上报：
 *   - `prompt_ready` IPC → `ds.cliReady` / `ds.cliReadyGeneration`（代际单调递增，见 types.ts）；
 *   - `screen_update` IPC 的 `status`（`working` / `idle` / `limited`）→ `ds.lastScreenStatus`，
 *     worker 在忙/闲转换时立即发（`publishScreenStatus('working', { force })`）。
 *
 * 两条都要用：`raw_input` 在 CLI 忙时也会被收进 composer 排队，紧随其后的 `prompt_ready`
 * 属于上一轮，所以"这条命令执行完了"必须看**发送之后**的代际增量；而 `/model` `/clear`
 * 这类瞬时命令可能根本不让 CLI 进入忙态、不产生新的 `prompt_ready`，于是给它一个"忙态
 * 宽限窗"：发送后若在宽限窗内既没见到代际增量也没见到 `working`，就当它已经完成。
 *
 * 纯函数（只读 ds 上的字段、轮询），不碰 IPC；轮询而不是事件订阅是刻意的最小实现，
 * 200ms 的粒度对"等 /compact 跑完"这种秒级等待绰绰有余。参数集中在 {@link cascadeTiming}，
 * 测试用 {@link __testOnly_setCascadeTiming} 缩短。
 */
import { delay } from '../utils/timing.js';

export interface CliIdleView {
  worker: { killed: boolean } | null;
  cliReady?: boolean;
  cliReadyGeneration?: number;
  lastScreenStatus?: string;
}

export interface CascadeTiming {
  /** 等 CLI 空闲的上限；超过就按今天的 busy delivery 语义把剩余条目直接发出（§6）。 */
  idleTimeoutMs: number;
  /** 发送一条之后等"进入忙态"的宽限窗；窗内没忙也没新 prompt_ready → 视为瞬时命令已完成。 */
  busyGraceMs: number;
  pollMs: number;
}

export const cascadeTiming: CascadeTiming = { idleTimeoutMs: 120_000, busyGraceMs: 3_000, pollMs: 200 };

export function __testOnly_setCascadeTiming(patch: Partial<CascadeTiming>): void {
  Object.assign(cascadeTiming, patch);
}

function workerLive(ds: CliIdleView): boolean {
  return !!ds.worker && !ds.worker.killed;
}

/** `ScreenStatus` 五值里只有 `idle`（与尚未收到过 screen_update 的 undefined）算空闲；
 *  `working` / `analyzing` 是忙，`limited` / `stalled` 是"卡住"——见 {@link screenBlocked}。 */
function screenIdle(ds: CliIdleView): boolean {
  return ds.lastScreenStatus === undefined || ds.lastScreenStatus === 'idle';
}

/** 限流（`limited`，daemon 侧有 fresh usageLimit 时无条件改写）或卡住（`stalled`）：提示符
 *  可能已就绪但轮次没有推进，等下去只会白等到上限。定序器对它们走与超时相同的 busy delivery。 */
function screenBlocked(ds: CliIdleView): boolean {
  return ds.lastScreenStatus === 'limited' || ds.lastScreenStatus === 'stalled';
}

/**
 * 等到 CLI 空闲：worker 活着、提示符曾就绪（cliReady）且屏幕状态是 `idle`（或未知）。
 * 返回 `'idle'` / `'blocked'`（限流或卡住，立即返回）/ `'timeout'` / `'gone'`（worker 没了）。
 */
export async function waitForCliIdle(ds: CliIdleView): Promise<'idle' | 'blocked' | 'timeout' | 'gone'> {
  const started = Date.now();
  for (;;) {
    if (!workerLive(ds)) return 'gone';
    if (screenBlocked(ds)) return 'blocked';
    if (ds.cliReady && screenIdle(ds)) return 'idle';
    if (Date.now() - started >= cascadeTiming.idleTimeoutMs) return 'timeout';
    await delay(cascadeTiming.pollMs);
  }
}

/**
 * 发送一条命令之后，等它"执行完"：
 *   1. 宽限窗内看到代际 > `sentAtGeneration` → settled；看到 `working` → 进入第 2 步；
 *      宽限窗结束都没看到 → 瞬时命令，settled；
 *   2. 忙态之后等代际增量或屏幕回到非 `working`，上限 idleTimeoutMs。
 */
export async function waitForCommandSettled(
  ds: CliIdleView,
  sentAtGeneration: number,
): Promise<'settled' | 'blocked' | 'timeout' | 'gone'> {
  const started = Date.now();
  let busySeen = false;
  for (;;) {
    if (!workerLive(ds)) return 'gone';
    if (screenBlocked(ds)) return 'blocked';
    const gen = ds.cliReadyGeneration ?? 0;
    if (gen > sentAtGeneration) return 'settled';
    const elapsed = Date.now() - started;
    if (!busySeen) {
      if (ds.lastScreenStatus === 'working') busySeen = true;
      else if (elapsed >= cascadeTiming.busyGraceMs) return 'settled';
    } else if (screenIdle(ds)) {
      return 'settled';
    }
    if (elapsed >= cascadeTiming.idleTimeoutMs) return 'timeout';
    await delay(cascadeTiming.pollMs);
  }
}
