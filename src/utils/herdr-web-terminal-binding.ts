export interface HerdrWebTerminalSize {
  cols: number;
  rows: number;
}

export interface HerdrWebTerminalBackend {
  acquireWebTerminal(viewer: object): HerdrWebTerminalSize | null;
  resizeWebTerminal(viewer: object, cols: number, rows: number): HerdrWebTerminalSize | null;
  releaseWebTerminal(viewer: object): object | null;
  isWebTerminalOwner(viewer: object): boolean;
}

export interface HerdrWebTerminalBindingState {
  backend: HerdrWebTerminalBackend | null;
  initialSize: HerdrWebTerminalSize | null;
}

export interface HerdrWebTerminalResizeResult extends HerdrWebTerminalBindingState {
  size: HerdrWebTerminalSize | null;
}

/**
 * Keeps one WebSocket viewer attached to the current managed Herdr backend.
 * A worker-level /restart replaces the backend without closing WebSockets, so
 * every message must re-sync this binding before it handles resize ownership.
 */
export class HerdrWebTerminalBinding {
  private attachedBackend: HerdrWebTerminalBackend | null = null;
  private lastSize: HerdrWebTerminalSize | null = null;

  constructor(
    private readonly viewer: object,
    private readonly resolveBackend: () => HerdrWebTerminalBackend | null,
  ) {}

  sync(): HerdrWebTerminalBindingState {
    const nextBackend = this.resolveBackend();
    if (nextBackend === this.attachedBackend) {
      return { backend: nextBackend, initialSize: null };
    }

    this.attachedBackend?.releaseWebTerminal(this.viewer);
    this.attachedBackend = nextBackend;
    return {
      backend: nextBackend,
      initialSize: nextBackend?.acquireWebTerminal(this.viewer) ?? null,
    };
  }

  resize(cols: number, rows: number): HerdrWebTerminalResizeResult {
    this.lastSize = { cols, rows };
    const state = this.sync();
    return {
      ...state,
      size: state.backend?.resizeWebTerminal(this.viewer, cols, rows) ?? null,
    };
  }

  /**
   * Re-attaches an already-connected viewer after an in-worker backend
   * replacement and re-applies the most recent browser grid. Unlike resize(),
   * this path needs no new browser event: /restart keeps the WebSocket alive.
   */
  restore(): HerdrWebTerminalResizeResult {
    const state = this.sync();
    return {
      ...state,
      size: state.backend && this.lastSize
        ? state.backend.resizeWebTerminal(this.viewer, this.lastSize.cols, this.lastSize.rows)
        : null,
    };
  }

  release(): object | null {
    const attachedBackend = this.attachedBackend;
    this.attachedBackend = null;
    this.lastSize = null;
    return attachedBackend?.releaseWebTerminal(this.viewer) ?? null;
  }
}
