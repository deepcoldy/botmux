export type BackendType = 'pty' | 'tmux' | 'herdr' | 'zellij';

/**
 * Tri-state result of probing whether a named backing session exists.
 *
 *   - 'exists'  — the probe command succeeded and confirmed a live session.
 *   - 'missing' — the probe command succeeded and confirmed no such live session.
 *   - 'unknown' — the probe command FAILED (error / timeout / unparseable output),
 *                 so we could not determine existence either way.
 *
 * The distinction matters wherever a `false`/`missing` answer drives a
 * destructive action (e.g. closing an active session on restore): a transient
 * 'unknown' must never be treated as 'missing', or one flaky probe could
 * permanently tear down a still-alive session.
 */
export type SessionProbe = 'exists' | 'missing' | 'unknown';

export interface SpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
}

export interface SessionBackend {
  spawn(bin: string, args: string[], opts: SpawnOpts): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  /** Permanently destroy the backing session (e.g. kill tmux session).
   *  Called only on explicit /close. Default: same as kill(). */
  destroySession?(): void;
  getAttachInfo?(): { type: 'tmux'; sessionName: string } | null;
  /** PID of the CLI process running inside the backend. */
  getChildPid?(): number | null;
  captureCurrentScreen?(): string;
  captureViewport?(): string;
  getPaneSize?(): { cols: number; rows: number } | null;
}

/**
 * Observe/adopt backends that expose authoritative screen snapshots of a pane
 * they don't own (TmuxPipeBackend via capture-pane, ZellijObserveBackend via
 * dump-screen). The worker's adopt-mode web-terminal seed + transient-snapshot
 * screenshot path consume these instead of the long-lived renderer, so the
 * snapshot dimensions always match the real pane.
 */
export interface ObserveBackend extends SessionBackend {
  /** Full-history snapshot (ANSI) — seeds the web terminal on attach. */
  captureCurrentScreen(): string;
  /** Current-viewport snapshot (ANSI) — sized to the pane, for screenshots. */
  captureViewport(): string;
  /** Live pane dimensions, or null if the pane is gone. */
  getPaneSize(): { cols: number; rows: number } | null;
  /** Cheap liveness probe. */
  isPaneAlive(): boolean;
  /**
   * True while a live web-attach client is connected and this backend has
   * paused its change-emission poller (ZellijObserveBackend does this to avoid
   * attach flicker — see setLiveAttach). During that window the pane can keep
   * changing without ever reaching onData, so a snapshot watermark fed by
   * onData/onPtyData goes stale. Backends that never pause emission omit this.
   */
  isLiveAttachActive?(): boolean;
}

/** Duck-typed guard — true for any backend exposing the ObserveBackend surface. */
export function isObserveBackend(b: unknown): b is ObserveBackend {
  return (
    !!b &&
    typeof (b as ObserveBackend).captureViewport === 'function' &&
    typeof (b as ObserveBackend).getPaneSize === 'function' &&
    typeof (b as ObserveBackend).captureCurrentScreen === 'function'
  );
}
