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
}
