/** MiniMax's opt-in cumulative execution budget. It is not an idle watchdog. */
export function parseMinimaxTurnTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new Error('Invalid MiniMax turn budget');
  }
  return ms;
}

interface BudgetClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: BudgetClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer),
};

export class MinimaxTurnBudget {
  private timer?: ReturnType<typeof setTimeout>;
  private remainingMs?: number;
  private resumedAt = 0;
  private waiting = false;
  private stopped = false;
  private generation = 0;

  constructor(timeoutMs: number | undefined, private readonly exhaust: () => void,
    private readonly clock: BudgetClock = systemClock) {
    this.remainingMs = timeoutMs;
    this.arm();
  }

  waitingForHuman(waiting: boolean): void {
    if (this.stopped || waiting === this.waiting) return;
    this.waiting = waiting;
    if (waiting) {
      if (this.remainingMs !== undefined) {
        this.remainingMs = Math.max(0, this.remainingMs - (this.clock.now() - this.resumedAt));
      }
      this.clear();
    } else this.arm();
  }

  dispose(): void {
    this.stopped = true;
    this.clear();
  }

  private clear(): void {
    ++this.generation;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.remainingMs === undefined || this.stopped) return;
    this.resumedAt = this.clock.now();
    const generation = ++this.generation;
    this.timer = this.clock.setTimeout(() => {
      if (this.stopped || this.waiting || this.generation !== generation) return;
      this.dispose();
      this.exhaust();
    }, this.remainingMs);
  }
}
