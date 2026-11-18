import { randomUUID } from 'node:crypto';
import { MAX_RUNNER_CONTROL_BYTES, RUNNER_CONTROL_END, RUNNER_CONTROL_PREFIX, RunnerControlWriter } from '../adapters/cli/runner-control-channel.js';
import { CodexAppControlFinalAssembler } from '../utils/codex-app-control.js';

export const MINIMAX_FINAL_MAX_BYTES = 8_000_000;
const CHUNK_BYTES = 16 * 1024;

export function createMinimaxFinalAssembler() {
  return new CodexAppControlFinalAssembler(MINIMAX_FINAL_MAX_BYTES, CHUNK_BYTES);
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
  writer.marker('final-end', { id, total });
}
