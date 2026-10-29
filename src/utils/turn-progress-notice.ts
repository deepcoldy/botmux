/**
 * Periodic "still working" notice for a CLI whose progress is otherwise
 * invisible in the chat.
 *
 * Why this exists: the streaming card mirrors the terminal, so a long silent
 * stretch looks identical to a wedged process, while a notice on every step
 * would flood the topic. This fires at most once per interval of CONTINUOUS
 * work and forgets everything the moment the session goes idle, so a slow turn
 * reports itself and a busy one stays quiet.
 */
export const DEFAULT_PROGRESS_NOTICE_MINUTES = 5;

/** Interval in minutes; 0 disables. An unset or unusable value falls back to
 *  the default rather than silently turning the notice off. */
export function progressNoticeIntervalMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.BOTMUX_PROGRESS_NOTICE_MINUTES ?? '').trim();
  if (!raw) return DEFAULT_PROGRESS_NOTICE_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROGRESS_NOTICE_MINUTES;
  return parsed;
}

export class TurnProgressNotice {
  readonly #intervalMs: number;
  readonly #now: () => number;
  #busySince: number | null = null;
  #lastNoticeAt = 0;

  constructor(minutes: number, now: () => number = Date.now) {
    this.#intervalMs = Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
    this.#now = now;
  }

  /**
   * Feed the current busy state. Returns the whole minutes of continuous work
   * when a notice is due, else null. Idle resets the clock: only an unbroken
   * stretch of work is reported, and the first poll of a stretch never fires.
   */
  poll(working: boolean, nowMs = this.#now()): number | null {
    if (this.#intervalMs === 0) return null;
    if (!working) {
      this.#busySince = null;
      this.#lastNoticeAt = 0;
      return null;
    }
    if (this.#busySince === null) {
      this.#busySince = nowMs;
      this.#lastNoticeAt = nowMs;
      return null;
    }
    if (nowMs - this.#lastNoticeAt < this.#intervalMs) return null;
    this.#lastNoticeAt = nowMs;
    return Math.max(1, Math.round((nowMs - this.#busySince) / 60_000));
  }
}
