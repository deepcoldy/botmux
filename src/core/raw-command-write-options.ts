import type { CliAdapter, CliId } from '../adapters/cli/types.js';
import type { RawCommandWriteOptions } from './raw-command-writer.js';

export const COCO_SLASH_TYPE_THROTTLE_MS = 40;
export const RAW_COMMAND_SUBMIT_BEAT_MS = 200;

export interface WorkerRawCommandWriteOptions extends RawCommandWriteOptions {
  readonly pasteLine?: boolean;
  readonly pasteSettleMs?: number;
}

export function rawCommandWriteOptionsFor(
  adapter: Pick<CliAdapter, 'id' | 'rawCommandInputMode' | 'rawCommandSettleMs'> | undefined,
  cliId: CliId | string | undefined,
  command?: string,
): WorkerRawCommandWriteOptions {
  const options: WorkerRawCommandWriteOptions = {
    coco: cliId === 'coco',
    cocoThrottleMs: COCO_SLASH_TYPE_THROTTLE_MS,
    submitBeatMs: RAW_COMMAND_SUBMIT_BEAT_MS,
  };
  if (options.coco) return options;
  // TraeX can read typed text and Enter in one batch after a stall, treating
  // Enter as a pasted newline. Only frame the single-line native rename.
  if (adapter?.id === 'traex' && command && /^\/rename [^\x00-\x1f\x7f-\x9f]+$/u.test(command)) {
    return { ...options, bracketedPaste: true };
  }
  if (
    adapter?.rawCommandInputMode === 'paste-line' &&
    adapter.rawCommandSettleMs !== undefined &&
    Number.isFinite(adapter.rawCommandSettleMs) &&
    adapter.rawCommandSettleMs > 0
  ) {
    return {
      ...options,
      pasteLine: true,
      pasteSettleMs: adapter.rawCommandSettleMs,
    };
  }
  return options;
}
