import type { PtyHandle } from '../adapters/cli/types.js';

export interface TuiKeySequenceOptions {
  isCurrent?: () => boolean;
  pause?: (ms: number) => Promise<void>;
  keyDelayMs?: number;
}

export type TuiInputWriteResult = void | {
  submitted: boolean;
};

const defaultPause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Deliver one TUI key sequence without crossing a backend-generation boundary.
 *
 * `void` / `true` preserve the established PTY/tmux contract. An explicit
 * `false` is a definite transport rejection and stops the sequence before any
 * later key can be injected into an unknown TUI state.
 */
export async function sendTuiKeySequence(
  target: PtyHandle,
  keys: string[],
  keyToAnsi: Readonly<Record<string, string>>,
  options: TuiKeySequenceOptions = {},
): Promise<boolean> {
  const isCurrent = options.isCurrent ?? (() => true);
  const pause = options.pause ?? defaultPause;
  const keyDelayMs = options.keyDelayMs ?? 100;

  for (const key of keys) {
    if (!isCurrent()) return false;
    if (typeof target.sendSpecialKeys === 'function') {
      if (target.sendSpecialKeys(key) === false) return false;
    } else {
      target.write(keyToAnsi[key] ?? key);
    }
    if (keyDelayMs > 0) await pause(keyDelayMs);
  }

  return isCurrent();
}

export interface TuiTextSubmissionOptions extends TuiKeySequenceOptions {
  target: PtyHandle;
  keys: string[];
  text: string;
  keyToAnsi: Readonly<Record<string, string>>;
  writeInput: (
    target: PtyHandle,
    text: string,
  ) => Promise<TuiInputWriteResult>;
  textSettleMs?: number;
}

/**
 * Navigate into a TUI's custom-input row, then submit text atomically.
 * Returns false for an explicit key rejection, backend replacement, or an
 * adapter-level `submitted: false`; exceptions remain visible to the caller.
 */
export async function submitTuiTextInput(
  options: TuiTextSubmissionOptions,
): Promise<boolean> {
  const {
    target,
    keys,
    text,
    keyToAnsi,
    writeInput,
  } = options;
  const isCurrent = options.isCurrent ?? (() => true);
  const pause = options.pause ?? defaultPause;
  const navKeys = keys[keys.length - 1] === 'Enter' ? keys.slice(0, -1) : keys;

  const navigated = await sendTuiKeySequence(target, navKeys, keyToAnsi, {
    isCurrent,
    pause,
    keyDelayMs: options.keyDelayMs,
  });
  if (!navigated) return false;

  await pause(options.textSettleMs ?? 200);
  if (!isCurrent()) return false;

  const result = await writeInput(target, text);
  if (result?.submitted === false) return false;
  return isCurrent();
}
