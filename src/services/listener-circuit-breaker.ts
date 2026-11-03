/**
 * ListenerCircuitBreaker —— 单个轮询目标（群/文档/订阅 key）的熔断状态机。
 *
 * event-dispatcher 的 message-listener 轮询已有自己的整轮看门狗+游标+全局
 * roster 循环，不适合整体替换；daemon 文档评论轮询同样在既有 5s 循环内接入。
 * 这里提供零依赖的 per-key 熔断判定，供两条链路在既有循环内调用。
 *
 * 判定规则：
 *  - 永久错误连续 ≥ threshold 次 → 熔断（suspended），跳过正常轮询；
 *  - 熔断后仅在距上次探测 ≥ probeIntervalMs 时放行一次（慢探测）；
 *  - 任意一次成功 → 立即清除状态（bot 被重新拉回/权限恢复自动回岗）。
 *
 * 本类只管状态，不负责告警：「刚熔断」由 recordPermanent 的返回值告知调用方，
 * 告警去重（避免应用级故障时逐目标告警风暴）由调用方按 app 维度处理。
 */

export interface ListenerCircuitEntry {
  suspended: boolean;
  permanentStreak: number;
  lastProbeAt: number;
}

export interface ListenerCircuitBreakerOptions {
  permanentThreshold?: number;
  probeIntervalMs?: number;
  now?: () => number;
}

export class ListenerCircuitBreaker {
  private readonly states = new Map<string, ListenerCircuitEntry>();
  private readonly threshold: number;
  private readonly probeIntervalMs: number;
  private readonly now: () => number;

  constructor(options: ListenerCircuitBreakerOptions = {}) {
    this.threshold = options.permanentThreshold ?? 3;
    this.probeIntervalMs = options.probeIntervalMs ?? 10 * 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  private entry(key: string): ListenerCircuitEntry {
    let e = this.states.get(key);
    if (!e) {
      e = { suspended: false, permanentStreak: 0, lastProbeAt: 0 };
      this.states.set(key, e);
    }
    return e;
  }

  stateFor(key: string): Readonly<ListenerCircuitEntry> | undefined {
    return this.states.get(key);
  }

  /**
   * 本拍是否允许对该 key 发请求。
   * 健康：总是允许；熔断中：仅慢探测节拍点允许（并记录探测时间）。
   */
  shouldPoll(key: string): boolean {
    const e = this.entry(key);
    if (!e.suspended) return true;
    const t = this.now();
    if (t - e.lastProbeAt >= this.probeIntervalMs) {
      e.lastProbeAt = t;
      return true;
    }
    return false;
  }

  /**
   * 登记一次永久错误。返回 true 表示「这一次刚进入熔断」（调用方据此发一次告警）。
   */
  recordPermanent(key: string): boolean {
    const e = this.entry(key);
    e.permanentStreak += 1;
    if (!e.suspended && e.permanentStreak >= this.threshold) {
      e.suspended = true;
      e.lastProbeAt = this.now();
      return true;
    }
    return false;
  }

  /**
   * 一次成功：清除全部状态。返回 true 表示「从熔断中恢复」（调用方可发恢复通知）。
   * 不存在/健康时返回 false。
   */
  recordSuccess(key: string): boolean {
    const e = this.states.get(key);
    if (!e) return false;
    const wasSuspended = e.suspended;
    this.states.delete(key);
    return wasSuspended;
  }

  /** 显式恢复（如收到 bot 重新入群 WS 事件），不等慢探测。 */
  resume(key: string): boolean {
    return this.recordSuccess(key);
  }

  /** 配置里已不存在的 key：清理其状态。 */
  prune(liveKeys: ReadonlySet<string>): void {
    for (const key of this.states.keys()) {
      if (!liveKeys.has(key)) this.states.delete(key);
    }
  }

  clear(): void {
    this.states.clear();
  }
}
