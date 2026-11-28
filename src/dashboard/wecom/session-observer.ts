/**
 * Tells the host admin's `/events` streams that the WeCom session rows changed.
 *
 * WeCom sessions never travel on `/events`. Who may see them is decided by the
 * REST routes (the host admin only), and the stream's `management` audience is
 * wider than that (platform co-managers, a bare `?t=`). So a host admin's
 * stream gets a frame without data, and the browser reads the rows from
 * {@link WECOM_SESSIONS_PATH}, behind the same gate as every `/api/wecom/*`.
 *
 * The observer collects the rows on a timer, and only while at least one host
 * admin's stream is open and WeCom connections are known to exist; with either
 * gone it leaves no timer behind. How many connections exist is learnt only
 * where it is computed anyway: the board request (`/api/sessions` counts them
 * for every host admin, and the browser sends one each time its stream opens)
 * and each collection here. One collection at a time, however many streams are
 * open; a collection that changes nothing the browser is given (the projected
 * rows, whether the read was complete, the connection count) sends nothing.
 * When the connections are gone, one last hint lets the browser clear its WeCom
 * rows, and the timer stops.
 */
import type { WecomSessionRow } from './sessions.js';

/** One read of the WeCom session rows. */
export interface WecomSessionRead {
  sessions: WecomSessionRow[];
  /** Every source was read (live or from its store): a row absent here is gone. */
  complete: boolean;
  /** Configured connections when the rows were read. */
  connectionCount: number;
}

/** The hint frame's event name on `/events` (the browser's store listens for it). */
export const WECOM_SESSIONS_HINT_EVENT = 'wecom.sessions.changed';

/** Where the browser reads the rows a hint is about. */
export const WECOM_SESSIONS_PATH = '/api/wecom/sessions';

/** Not shorter than the browser's provider poll this replaces. */
export const WECOM_SESSION_OBSERVER_INTERVAL_MS = 5_000;

export interface WecomSessionObserverOptions {
  /** Reads the connection count and, when there are connections, the rows. */
  collect(): Promise<WecomSessionRead>;
  intervalMs?: number;
}

/** What the browser is given of a read, in a form that compares by content. */
function readKey(read: WecomSessionRead): string {
  const rows = [...read.sessions].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  return JSON.stringify([read.complete, read.connectionCount, rows]);
}

export class WecomSessionObserver {
  private readonly listeners = new Set<() => void>();
  private readonly intervalMs: number;
  private knownConnections = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private collecting = false;
  /** Bumped each time the observer stops: a collection begun before that is dropped. */
  private generation = 0;
  /** The read the last hint was about; kept only while the observer runs. */
  private latest: { read: WecomSessionRead; key: string } | undefined;

  constructor(private readonly options: WecomSessionObserverOptions) {
    this.intervalMs = options.intervalMs ?? WECOM_SESSION_OBSERVER_INTERVAL_MS;
  }

  /** A host admin's stream opened. `listener` hears each hint until the returned function is called. */
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    this.schedule();
    let watching = true;
    return () => {
      if (!watching) {
        return;
      }
      watching = false;
      this.listeners.delete(listener);
      this.schedule();
    };
  }

  /**
   * The connection count a board request computed. Going to zero while the
   * observer runs sends the last hint at once, so other streams clear their
   * WeCom rows too.
   */
  noteConnectionCount(count: number): void {
    const wasRunning = this.running();
    this.knownConnections = count;
    if (wasRunning && count === 0) {
      this.stop();
      this.notify();
      return;
    }
    this.schedule();
  }

  /** The read the last hint was about, while the observer runs (undefined before its first collection). */
  current(): WecomSessionRead | undefined {
    return this.latest?.read;
  }

  private running(): boolean {
    return this.listeners.size > 0 && this.knownConnections > 0;
  }

  private schedule(): void {
    if (!this.running()) {
      this.stop();
      return;
    }
    if (this.timer === undefined && !this.collecting) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.collect();
      }, this.intervalMs);
    }
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.generation += 1;
    this.latest = undefined;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private async collect(): Promise<void> {
    const generation = this.generation;
    this.collecting = true;
    try {
      const read = await this.options.collect();
      if (generation !== this.generation) {
        return;
      }
      this.knownConnections = read.connectionCount;
      if (read.connectionCount === 0) {
        // The last hint: the browser's read finds no connections and clears its rows.
        this.stop();
        this.notify();
        return;
      }
      const key = readKey(read);
      if (key === this.latest?.key) {
        return;
      }
      this.latest = { read, key };
      this.notify();
    } catch {
      // Nothing to tell; the next collection tries again.
    } finally {
      this.collecting = false;
      this.schedule();
    }
  }
}
