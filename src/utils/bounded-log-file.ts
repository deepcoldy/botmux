import { createWriteStream, statSync, type WriteStream } from 'node:fs';

interface LogLimits {
  onLimit: (kind: 'disk' | 'buffer') => void;
  onError?: (error: Error) => void;
  maxBytes?: number;
  maxBufferedBytes?: number;
}

/** One append-only writer owns this attempt file, including bytes from an earlier open. */
export class BoundedLogFile {
  private stream?: WriteStream;
  private acceptedBytes?: number;
  private stopped = false;
  private closeTimer?: NodeJS.Timeout;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });

  constructor(readonly path: string, private readonly limits: LogLimits) {}

  write(chunk: string | Buffer): void {
    if (this.stopped || chunk.length === 0) return;
    try {
      this.acceptedBytes ??= statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
      const size = Buffer.byteLength(chunk);
      const diskFull = this.acceptedBytes + size > (this.limits.maxBytes ?? 64_000_000);
      const queueFull = (this.stream?.writableLength ?? 0) + size > (this.limits.maxBufferedBytes ?? 16_000_000);
      if (diskFull || queueFull) {
        void this.end();
        this.limits.onLimit(diskFull ? 'disk' : 'buffer');
        return;
      }
      if (!this.stream) {
        this.stream = createWriteStream(this.path, { flags: 'a', mode: 0o600 });
        this.stream.once('close', () => {
          clearTimeout(this.closeTimer);
          this.resolveClosed();
        });
        this.stream.once('error', error => {
          this.stopped = true;
          this.limits.onError?.(error);
        });
      }
      this.acceptedBytes += size;
      this.stream.write(chunk);
    } catch (error) {
      void this.end();
      this.limits.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  writeLine(line: string): void {
    this.write(line.endsWith('\n') ? line : line + '\n');
  }

  end(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      if (this.stream) {
        // A stuck diagnostic sink must not hold a finished or cancelled attempt open.
        this.closeTimer = setTimeout(() => {
          this.stream!.destroy();
          this.resolveClosed();
        }, 1_000);
        this.stream.end();
      } else {
        this.resolveClosed();
      }
    }
    return this.closed;
  }
}
