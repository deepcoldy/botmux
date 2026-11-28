import { randomUUID } from 'node:crypto';
import { MAX_RUNNER_CONTROL_BYTES, RUNNER_CONTROL_END, RUNNER_CONTROL_PREFIX, RunnerControlWriter } from '../adapters/cli/runner-control-channel.js';
import { CodexAppControlFinalAssembler } from '../utils/codex-app-control.js';

export const MINIMAX_FINAL_MAX_BYTES = 8_000_000;
const CHUNK_BYTES = 16 * 1024;

type Payload = Record<string, unknown>;
type Turn = { turnId?: string; dispatchAttempt?: number };
const sameTurn = (a: Turn, b: Turn) => a.turnId === b.turnId && a.dispatchAttempt === b.dispatchAttempt;

/** A partially received final belongs to the worker turn that accepted its
 * start. Settle it before changing that identity, or after transport silence. */
export class MinimaxFinalReceiver {
  private readonly assembler = new CodexAppControlFinalAssembler(MINIMAX_FINAL_MAX_BYTES, CHUNK_BYTES);
  private pending?: { id: string; owner: Turn };
  private timer?: ReturnType<typeof setTimeout>;
  private settled?: Turn;

  constructor(
    private readonly deliver: (payload: Payload) => void,
    private readonly logMismatch?: (message: string) => void,
    private readonly cliLabel: () => string = () => 'MiniMax Code',
  ) {}

  private clearPending(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.assembler.clear();
  }

  private finish(owner: Turn, payload: Payload): void {
    this.clearPending();
    if (owner.turnId && this.settled && sameTurn(owner, this.settled)) return;
    this.settled = owner;
    this.deliver({ ...payload, ...owner });
  }

  interrupt(): void {
    if (this.pending) this.finish(this.pending.owner, {
      errorCode: 'execution_failed', content: `${this.cliLabel()} 最终回答传输不完整。`,
    });
  }

  reset(): void {
    this.interrupt();
    this.settled = undefined;
  }

  accept(kind: string, payload: Payload | undefined, current: Turn): boolean {
    if (kind !== 'final' && kind !== 'final-start' && kind !== 'final-chunk' && kind !== 'final-end') {
      this.interrupt();
      return false;
    }
    if (!payload) { this.interrupt(); return true; }
    if (payload.turnId !== undefined && payload.turnId !== current.turnId) {
      this.logMismatch?.(`rejected final marker with mismatched turn (marker=${String(payload.turnId).slice(0, 12)}, current=${current.turnId?.slice(0, 12) ?? '-'})`);
      return true;
    }
    if (payload.dispatchAttempt !== undefined && payload.dispatchAttempt !== current.dispatchAttempt) {
      this.logMismatch?.(`rejected final marker with mismatched dispatch attempt (marker=${String(payload.dispatchAttempt).slice(0, 12)}, current=${current.dispatchAttempt ?? '-'})`);
      return true;
    }
    if (current.turnId && this.settled && sameTurn(current, this.settled)) return true;
    if (kind === 'final') {
      if (typeof payload.content === 'string') this.finish(current, payload);
      else this.interrupt();
      return true;
    }
    if (kind === 'final-start') {
      if (this.pending) { this.interrupt(); return true; }
      this.pending = { id: typeof payload.id === 'string' ? payload.id : '', owner: current };
    } else if (!this.pending) {
      // End carries the turn as well so a missing start cannot strand it.
      if (kind === 'final-end' && current.turnId && payload.turnId === current.turnId) {
        this.finish(current, { errorCode: 'execution_failed', content: `${this.cliLabel()} 最终回答缺少起始帧。` });
      }
      return true;
    } else if (payload.id !== this.pending.id) {
      // A late fragment from a retired writer cannot settle the current turn.
      return true;
    }
    const result = this.assembler.accept(kind, payload);
    if (result.status === 'complete') this.finish(this.pending!.owner, result.payload);
    else if (result.status === 'reject') this.interrupt();
    else {
      clearTimeout(this.timer);
      // This is an inter-fragment idle bound after generation has finished,
      // independent of the potentially unlimited model/tool execution time.
      this.timer = setTimeout(() => this.interrupt(), 30_000);
      this.timer.unref();
    }
    return true;
  }
}

/** Keep ordinary finals in one OSC. For larger answers reuse the bounded
 * start/chunk/end protocol, keeping even JSON-escaped control text off the PTY
 * as a single oversized frame. Only the end record settles the turn. */
export function writeMinimaxFinal(writer: RunnerControlWriter, payload: { content: string; [key: string]: unknown }): void {
  // Use serialized size: a NUL takes six bytes in JSON before base64.
  const encodedBytes = payload.content.length > MAX_RUNNER_CONTROL_BYTES ? Infinity
    : 4 * Math.ceil(Buffer.byteLength(JSON.stringify(payload)) / 3);
  if (RUNNER_CONTROL_PREFIX.length + 'final:'.length + encodedBytes + RUNNER_CONTROL_END.length <= MAX_RUNNER_CONTROL_BYTES) {
    writer.marker('final', payload);
    return;
  }
  const { content, ...metadata } = payload;
  const bytes = Buffer.from(content);
  if (bytes.length > MINIMAX_FINAL_MAX_BYTES) throw new Error('mcode_acp_content_limit');
  const id = randomUUID();
  const total = Math.ceil(bytes.length / CHUNK_BYTES);
  writer.marker('final-start', { ...metadata, id, total });
  for (let i = 0; i < total; i++) {
    const data = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64');
    writer.marker('final-chunk', { id, index: i, data });
  }
  writer.marker('final-end', { id, total, turnId: payload.turnId,
    ...(payload.dispatchAttempt !== undefined ? { dispatchAttempt: payload.dispatchAttempt } : {}) });
}
