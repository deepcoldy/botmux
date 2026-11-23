/** Deterministic quota evidence from agy's own `--log-file` stream. */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export interface AntigravityNativeQuota {
  /** Stable native timestamp, unique across repeated quota episodes. */
  key: string;
  /** Raw provider message including the relative reset duration. */
  text: string;
  /** Native input sequence immediately preceding this refusal. */
  inputSequence: number;
}

export interface AntigravityNativeQuotaLogState {
  inputSequence: number;
  latestInput?: { sequence: number; text: string };
  quota?: AntigravityNativeQuota;
}

const INPUT_MARKER = 'HandleUserInput called with text: ';
const QUOTA_MARKER = 'Individual quota reached.';

function parseNativeInput(line: string): string | undefined {
  const at = line.indexOf(INPUT_MARKER);
  if (at < 0 || !line.includes('input_loop.go:')) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(at + INPUT_MARKER.length));
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseNativeQuota(line: string): { key: string; text: string } | undefined {
  // Accept the executor's own RPC failure, not a model/tool quoting the same
  // text. The second generic errorreport line is intentionally not consumed.
  if (!line.includes('agent executor error:')
    || !line.includes('transport error (ResourceExhausted, HTTP 429)')
    || !line.includes('RESOURCE_EXHAUSTED (code 429)')) return undefined;
  const key = /^[A-Z]\d{4} \d{2}:\d{2}:\d{2}\.\d+/.exec(line)?.[0];
  const at = line.indexOf(QUOTA_MARKER);
  if (!key || at < 0) return undefined;
  return { key, text: line.slice(at) };
}

/** Increment-read one session's native log. The reader is independent from the
 * conversation-id observer so both can consume the same file safely. */
export class AntigravityNativeQuotaLog {
  private offset = 0;
  private inode: string | undefined;
  private tail = '';
  private state: AntigravityNativeQuotaLogState = { inputSequence: 0 };

  constructor(readonly path: string) {}

  read(): Readonly<AntigravityNativeQuotaLogState> {
    try {
      const stat = statSync(this.path);
      const inode = `${stat.dev}:${stat.ino}`;
      if (inode !== this.inode || stat.size < this.offset) {
        this.inode = inode;
        this.offset = Math.max(0, stat.size - 256 * 1024);
        this.tail = '';
        this.state = { inputSequence: 0 };
      }
      if (stat.size === this.offset) return this.state;
      const fd = openSync(this.path, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size - this.offset, 256 * 1024));
        const count = readSync(fd, buf, 0, buf.length, this.offset);
        this.offset += count;
        const lines = (this.tail + buf.subarray(0, count).toString('utf8')).split('\n');
        this.tail = lines.pop() ?? '';
        for (const line of lines) {
          const input = parseNativeInput(line);
          if (input !== undefined) {
            const sequence = this.state.inputSequence + 1;
            this.state.inputSequence = sequence;
            this.state.latestInput = { sequence, text: input };
          }
          const quota = parseNativeQuota(line);
          if (quota) this.state.quota = { ...quota, inputSequence: this.state.inputSequence };
        }
      } finally { closeSync(fd); }
    } catch { /* Startup may not have created the native log yet. */ }
    return this.state;
  }
}

/** A refusal is current only when the latest native input is still the one that
 * precedes it. A later resend makes an older log refusal ineligible, even when
 * its text is identical. When the worker has an exact written input, require
 * byte equality with agy's own decoded HandleUserInput payload as well. */
export function currentAntigravityNativeQuota(
  state: Readonly<AntigravityNativeQuotaLogState>,
  currentInput?: string,
): AntigravityNativeQuota | undefined {
  const quota = state.quota;
  const latest = state.latestInput;
  if (!quota || !latest || quota.inputSequence !== latest.sequence) return undefined;
  if (currentInput !== undefined && latest.text !== currentInput) return undefined;
  return quota;
}
