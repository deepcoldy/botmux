import { Buffer } from 'node:buffer';

export const RUNNER_CONTROL_PREFIX = '\x1b]777;botmux:';
export const RUNNER_CONTROL_END = '\x07';
export const MAX_RUNNER_CONTROL_BYTES = 4 * 1024 * 1024;

const VISIBLE_ESCAPE = '␛';

/** Runner display text is model/user/tool controlled and shares a PTY byte
 * stream with botmux OSC control frames. Escaping every ESC byte makes the
 * separation structural and naturally safe across arbitrary delta chunks. */
export function escapeRunnerDisplay(value: unknown): string {
  return String(value ?? '').replace(/\x1b/g, VISIBLE_ESCAPE);
}

type WriteChunk = (chunk: string) => unknown;

/** The only producer allowed to write a raw botmux OSC prefix. */
export class RunnerControlWriter {
  constructor(
    private readonly stdout: WriteChunk = chunk => process.stdout.write(chunk),
    private readonly stderr: WriteChunk = chunk => process.stderr.write(chunk),
  ) {}

  display(value: unknown): void {
    this.stdout(escapeRunnerDisplay(value));
  }

  line(value: unknown = ''): void {
    this.display(`${String(value ?? '')}\n`);
  }

  error(value: unknown): void {
    this.stderr(escapeRunnerDisplay(value));
  }

  marker(kind: string, payload: unknown): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(kind)) throw new Error(`invalid runner control kind: ${kind}`);
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    this.stdout(`${RUNNER_CONTROL_PREFIX}${kind}:${encoded}${RUNNER_CONTROL_END}`);
  }
}

/** Stateful decoder for control frames that may be split across PTY chunks.
 * Oversized/unterminated candidates are rendered inert instead of buffering
 * without bound or invoking a partial control message. */
export class RunnerControlDecoder {
  private pending = '';

  constructor(private readonly maxControlBytes = MAX_RUNNER_CONTROL_BYTES) {}

  push(data: string, enabled: boolean, onMarker: (body: string) => void): string {
    if (!enabled) {
      // A CLI/config transition must never let an unfinished app-runner frame
      // become authoritative after control decoding has been disabled. Keep
      // ordinary terminal escape sequences in the new chunk intact, while
      // rendering only the old control candidate inert.
      const released = this.pending ? escapeRunnerDisplay(this.pending) : '';
      this.pending = '';
      return released + data;
    }
    const input = this.pending + data;
    this.pending = '';

    let out = '';
    let cursor = 0;
    for (;;) {
      const start = input.indexOf(RUNNER_CONTROL_PREFIX, cursor);
      if (start < 0) {
        let tailStart = input.length;
        const tail = input.slice(cursor);
        for (let n = Math.min(RUNNER_CONTROL_PREFIX.length - 1, tail.length); n > 0; n--) {
          if (RUNNER_CONTROL_PREFIX.startsWith(tail.slice(tail.length - n))) {
            tailStart = input.length - n;
            break;
          }
        }
        out += input.slice(cursor, tailStart);
        this.pending = input.slice(tailStart);
        return out;
      }

      out += input.slice(cursor, start);
      const end = input.indexOf(RUNNER_CONTROL_END, start + RUNNER_CONTROL_PREFIX.length);
      if (end < 0) {
        const candidate = input.slice(start);
        if (Buffer.byteLength(candidate, 'utf8') > this.maxControlBytes) {
          out += escapeRunnerDisplay(candidate);
          this.pending = '';
          return out;
        }
        this.pending = candidate;
        return out;
      }

      const frame = input.slice(start, end + RUNNER_CONTROL_END.length);
      if (Buffer.byteLength(frame, 'utf8') > this.maxControlBytes) {
        out += escapeRunnerDisplay(frame);
      } else {
        onMarker(input.slice(start + RUNNER_CONTROL_PREFIX.length, end));
      }
      cursor = end + RUNNER_CONTROL_END.length;
    }
  }

  reset(): void {
    this.pending = '';
  }

  /** Test/diagnostic visibility only; never expose pending control bytes. */
  pendingBytes(): number {
    return Buffer.byteLength(this.pending, 'utf8');
  }
}
