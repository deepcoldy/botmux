import * as pty from 'node-pty';
import { chmodSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { SessionBackend, SpawnOpts } from './types.js';

// npx may strip execute bits from prebuilt binaries — fix before first spawn.
try {
  const req = createRequire(import.meta.url);
  const helper = join(dirname(req.resolve('node-pty/package.json')),
    'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  const mode = statSync(helper).mode;
  if (!(mode & 0o111)) chmodSync(helper, mode | 0o755);
} catch { /* best effort */ }

export class PtyBackend implements SessionBackend {
  private process: pty.IPty | null = null;

  /** Claude Code session JSONL path — set by worker for claude-code sessions so
   *  the claude-code adapter can verify paste+Enter submissions via file growth. */
  claudeJsonlPath?: string;

  spawn(bin: string, args: string[], opts: SpawnOpts): void {
    this.process = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.process?.resize(cols, rows);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onData(cb: (data: string) => void): void {
    this.process?.onData(cb);
  }

  /** Must be called AFTER spawn(). Callbacks registered before spawn are silently lost. */
  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.process?.onExit(({ exitCode, signal }) => {
      cb(exitCode, signal !== undefined ? String(signal) : null);
    });
  }

  getChildPid(): number | null {
    return this.process?.pid ?? null;
  }

  kill(): void {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
  }
}
