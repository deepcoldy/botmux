/**
 * Transport-agnostic core of a newline-delimited JSON-RPC client over a child's
 * stdio: NDJSON framing, the pending-request table (with optional per-request
 * timeouts) and fail-everything-on-exit.
 *
 * The three stdio clients that used to carry their own copy — the Codex app
 * runner's `AppServerClient`, the thread-picker's `CodexAppServerProbe` and the
 * dsh runner's `DshJsonRpcClient` — differ in everything around this core (how
 * the child is spawned, what a closed/exited client does, the shape of the
 * errors they raise, how server requests are answered), so none of that lives
 * here. A client owns its child process and its write path, feeds stdout chunks
 * to {@link JsonRpcStdioCore.push}, and gets back:
 *   - responses to requests it {@link JsonRpcStdioCore.track}ed, settled here;
 *   - everything else (server requests, notifications) through `onMessage`.
 *
 * A response is a message with a numeric `id` and a defined `result` or
 * `error`. One whose id is not pending (late reply after a timeout, unknown id)
 * is dropped silently and is NOT forwarded to `onMessage`.
 */

export type JsonRpcMessage = Record<string, any>;

export interface JsonRpcStdioCoreOptions {
  /** Turn a JSON-RPC `error` member into the Error a caller's promise rejects
   *  with. Only called for a truthy `error`. */
  mapRpcError: (method: string, error: any) => Error;
  /** Every parsed, truthy message that is not a response to a pending request. */
  onMessage: (msg: JsonRpcMessage) => void;
  /** A non-empty stdout line that is not valid JSON. Default: ignore it. */
  onInvalidLine?: (line: string) => void;
  /**
   * How complete lines are handed to `onMessage` / settled.
   * - 'sync' (default): all lines of a chunk are processed in one synchronous
   *   loop.
   * - 'microtask': one line per microtask. Dispatching line N+1 synchronously
   *   after line N starves the microtask continuations line N scheduled — a
   *   response resolving `await request(...)` would run its awaiting caller only
   *   AFTER the whole loop, so a notification coalesced into the same chunk
   *   behind its own request's response is handled against stale state. The
   *   kernel coalesces adjacent writes whenever the reader is scheduled late
   *   (routine on loaded runners), so yield a MICROtask between lines: queued
   *   continuations run before the next dispatch, while anything deliberately
   *   deferred past the current burst (macrotask publications) still sees the
   *   burst as one unit.
   */
  dispatch?: 'sync' | 'microtask';
}

export interface TrackOptions {
  /** Reject with `onTimeout(method, timeoutMs)` after this long. Omit for no
   *  timeout. The caller validates the value (finite and > 0). */
  timeoutMs?: number;
  onTimeout?: (method: string, timeoutMs: number) => Error;
  /** Do not let the timeout timer keep the event loop alive. */
  unrefTimer?: boolean;
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export class JsonRpcStdioCore {
  private id = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private draining = false;

  constructor(private readonly options: JsonRpcStdioCoreOptions) {}

  /** Allocate the next request id (ids start at 1 and are never reused). */
  nextId(): number {
    return this.id++;
  }

  /**
   * Register a request that is about to be (or has just been) written and
   * return the promise its response settles. Registering before the write is
   * safe — replies are only processed on a later tick — and lets the caller
   * {@link abort} when the write itself throws.
   */
  track<T = any>(id: number, method: string, opts: TrackOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject };
      const { timeoutMs } = opts;
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          reject(opts.onTimeout?.(method, timeoutMs)
            ?? new Error(`${method}: timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (opts.unrefTimer) pending.timer.unref?.();
      }
      this.pending.set(id, pending);
    });
  }

  /** Reject and forget one tracked request (e.g. its write threw). No-op when
   *  it was already settled. */
  abort(id: number, err: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(err);
  }

  /** Reject every outstanding request with `err` and forget them. */
  failAll(err: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  /** Feed a decoded stdout chunk. Lines may span chunks; empty lines and
   *  unparseable / falsy JSON values are skipped. */
  push(chunk: string): void {
    this.buffer += chunk;
    if (this.options.dispatch === 'microtask') {
      this.drainMicrotask();
      return;
    }
    for (;;) {
      const line = this.takeLine();
      if (line === undefined) return;
      this.handleLine(line);
    }
  }

  private takeLine(): string | undefined {
    const nl = this.buffer.indexOf('\n');
    if (nl < 0) return undefined;
    const line = this.buffer.slice(0, nl).trim();
    this.buffer = this.buffer.slice(nl + 1);
    return line;
  }

  private drainMicrotask(): void {
    if (this.draining) return;
    this.draining = true;
    const step = (): void => {
      const line = this.takeLine();
      if (line === undefined) {
        this.draining = false;
        return;
      }
      this.handleLine(line);
      queueMicrotask(step);
    };
    step();
  }

  private handleLine(line: string): void {
    if (!line) return;
    let msg: JsonRpcMessage | undefined;
    try {
      msg = JSON.parse(line);
    } catch {
      this.options.onInvalidLine?.(line);
      return;
    }
    if (msg) this.handleMessage(msg);
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) pending.reject(this.options.mapRpcError(pending.method, msg.error));
      else pending.resolve(msg.result);
      return;
    }
    this.options.onMessage(msg);
  }
}
