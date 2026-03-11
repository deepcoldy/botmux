import type { SessionBackend, SpawnOpts } from './types.js';

/**
 * TmuxBackend — experimental session backend using tmux.
 * Enables: physical `tmux attach`, web terminal, and IM all on same session.
 * TODO: Full implementation.
 */
export class TmuxBackend implements SessionBackend {
  private sessionName = '';

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  write(data: string): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  resize(_cols: number, _rows: number): void {
    // tmux resize is handled by the attaching client
  }

  onData(_cb: (data: string) => void): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  onExit(_cb: (code: number | null, signal: string | null) => void): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  kill(): void {
    throw new Error('TmuxBackend is not yet implemented');
  }

  getAttachInfo() {
    return { type: 'tmux' as const, sessionName: this.sessionName };
  }
}
