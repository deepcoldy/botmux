/**
 * ResilientPoller —— 周期任务唯一的韧性运行时。
 *
 * 设计目的：让「永久错误被当瞬时抖动无限重试」在结构上不可能发生。
 * 以前每个调用方自己写 setInterval + try/catch，失败只 logger.warn 后继续：
 * message-listener 对 230002 空转 19 天、文档评论轮询对 403 每 5s 空转。
 *
 * 状态机（每个 key 独立）：
 *   healthy ──瞬时错误──> 指数退避（1s→2s→4s…封顶）──成功──> healthy
 *      │
 *      └──永久错误连续 ≥ permanentThreshold──> suspended
 *             · 立即跳过该 key 的正常轮询，不再对飞书发请求
 *             · onAlert(key, err) 只触发一次（去重，直到恢复）
 *             · 以 probeIntervalMs 慢探测一次（覆盖 bot 被重新拉回群、权限恢复，
 *               不依赖 WS 事件）；探测成功自动回岗 healthy 并 onResume
 */

export type PollErrorClass = 'permanent' | 'transient';

export interface ClassifiedPollError extends Error {
  classification: PollErrorClass;
  rejoinable?: boolean;
}

type TimerFn = (fn: () => void, ms: number) => NodeJS.Timeout;
type ClearFn = (handle: NodeJS.Timeout) => void;

export interface ResilientPollerOptions<K extends string = string> {
  /** 正常轮询节拍。 */
  intervalMs: number;
  /** 把异常归一为永久/瞬时。默认全部按瞬时（仅退避不熔断）。 */
  classify: (err: unknown) => ClassifiedPollError;
  /** 每拍返回当前需要轮询的 key 列表（配置变化即时反映；key 消失即清理其状态）。 */
  listKeys: () => readonly K[];
  /** 单个 key 的一次轮询；抛错时按 classify 处理。 */
  onTick: (key: K) => Promise<void>;
  /** 永久熔断时回调（每个暂停周期只调一次）。 */
  onAlert?: (key: K, err: ClassifiedPollError) => void;
  /** 从熔断恢复到健康时回调。 */
  onResume?: (key: K) => void;
  /** 连续永久错误几次后熔断。默认 3（避免偶发误分类）。 */
  permanentThreshold?: number;
  /** 瞬时错误退避上限。默认 5 分钟。 */
  maxBackoffMs?: number;
  /** 熔断后慢探测节拍。默认 10 分钟。 */
  probeIntervalMs?: number;
  /** 退避随机抖动比例（0–1）。默认 0.2。 */
  jitterRatio?: number;
  /** 时钟注入（测试用）。 */
  now?: () => number;
  setTimeout?: TimerFn;
  clearTimeout?: ClearFn;
}

interface KeyState {
  permanentStreak: number;
  transientStreak: number;
  backoffUntil: number;
  suspended: boolean;
  alerted: boolean;
  lastProbeAt: number;
  lastErrorSnippet: string;
}

export interface ResilientPoller<K extends string = string> {
  start(): void;
  stop(): void;
  /** 强制某个 key 立即恢复为健康（如收到 bot 重新入群 WS 事件）。 */
  resume(key: K): void;
  /** 测试/诊断用：当前状态快照。 */
  stateFor(key: K): Readonly<KeyState> | undefined;
  /** 测试/诊断用：同步触发一轮（不等待定时器）。 */
  runOnce(): Promise<void>;
}

function nowDefault(): number {
  return Date.now();
}
function setTimerDefault(fn: () => void, ms: number): NodeJS.Timeout {
  return setTimeout(fn, ms);
}
function clearTimerDefault(handle: NodeJS.Timeout): void {
  clearTimeout(handle);
}

export function createResilientPoller<K extends string = string>(
  options: ResilientPollerOptions<K>,
): ResilientPoller<K> {
  const {
    intervalMs,
    classify,
    listKeys,
    onTick,
    onAlert,
    onResume,
    permanentThreshold = 3,
    maxBackoffMs = 5 * 60_000,
    probeIntervalMs = 10 * 60_000,
    jitterRatio = 0.2,
  } = options;
  const now = options.now ?? nowDefault;
  const setTimer = options.setTimeout ?? setTimerDefault;
  const clearTimer = options.clearTimeout ?? clearTimerDefault;

  const states = new Map<K, KeyState>();
  let timer: NodeJS.Timeout | undefined;
  let inFlight = false;
  let stopped = false;

  function stateFor(key: K): KeyState {
    let s = states.get(key);
    if (!s) {
      s = {
        permanentStreak: 0,
        transientStreak: 0,
        backoffUntil: 0,
        suspended: false,
        alerted: false,
        lastProbeAt: 0,
        lastErrorSnippet: '',
      };
      states.set(key, s);
    }
    return s;
  }

  function markHealthy(key: K, s: KeyState): void {
    const wasSuspended = s.suspended;
    s.permanentStreak = 0;
    s.transientStreak = 0;
    s.backoffUntil = 0;
    s.lastErrorSnippet = '';
    s.suspended = false;
    if (wasSuspended) {
      s.alerted = false;
      onResume?.(key);
    }
  }

  function scheduleBackoff(s: KeyState): void {
    const base = Math.min(intervalMs * 2 ** s.transientStreak, maxBackoffMs);
    const jitter = jitterRatio > 0 ? base * jitterRatio * Math.random() : 0;
    s.backoffUntil = now() + Math.round(base + jitter);
  }

  async function handleKey(key: K): Promise<void> {
    const s = stateFor(key);
    const t = now();
    if (s.suspended) {
      if (t - s.lastProbeAt < probeIntervalMs) return;
      s.lastProbeAt = t;
    } else if (t < s.backoffUntil) {
      return;
    }
    try {
      await onTick(key);
      markHealthy(key, s);
    } catch (raw) {
      const e = classify(raw);
      s.lastErrorSnippet = e.message.slice(0, 200);
      if (e.classification === 'permanent') {
        s.permanentStreak += 1;
        s.transientStreak = 0;
        s.backoffUntil = 0;
        if (s.permanentStreak >= permanentThreshold) {
          s.suspended = true;
          s.lastProbeAt = now();
          if (!s.alerted) {
            s.alerted = true;
            try {
              onAlert?.(key, e);
            } catch {
              /* 告警通道自身失败不得影响轮询状态机 */
            }
          }
        }
      } else {
        s.transientStreak += 1;
        scheduleBackoff(s);
      }
    }
  }

  async function runOnce(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      const keys = listKeys();
      const live = new Set(keys);
      for (const key of states.keys()) {
        if (!live.has(key)) states.delete(key);
      }
      for (const key of keys) {
        if (stopped) return;
        await handleKey(key);
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (stopped || timer) return;
      const tick = () => {
        void runOnce().finally(() => {
          if (!stopped) timer = setTimer(tick, intervalMs);
        });
      };
      timer = setTimer(tick, intervalMs);
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimer(timer);
        timer = undefined;
      }
    },
    resume(key) {
      const s = states.get(key);
      if (s) markHealthy(key, s);
    },
    stateFor(key) {
      return states.get(key);
    },
    runOnce,
  };
}
