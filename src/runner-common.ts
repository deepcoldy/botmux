/**
 * Boilerplate shared by the stdin-bridge runners (dsh / mir / mira / codex-app):
 * the three terminal helpers over a {@link RunnerControlWriter} and the
 * `--flag value` argv loop. Per-runner argument sets, validation and the
 * runners' own control-marker plumbing stay in each runner.
 */
import type { RunnerControlWriter } from './adapters/cli/runner-control-channel.js';

/** The terminal-facing helpers every runner defines identically. `emitMarker`
 *  writes a control frame straight to the writer; runners that queue or sign
 *  their markers (codex-app) define their own and take only the other two. */
export function createRunnerTerminal(output: RunnerControlWriter): {
  emitMarker: (kind: string, payload: unknown) => void;
  writeLine: (text?: string) => void;
  prompt: () => void;
} {
  return {
    emitMarker: (kind, payload) => output.marker(kind, payload),
    writeLine: (text = '') => output.line(text),
    prompt: () => output.display('› '),
  };
}

type StringKeyOf<T> = { [K in keyof T]-?: [Extract<T[K], string>] extends [never] ? never : K }[keyof T] & string;

/** Either the name of a string field of `T` to assign, or a handler that takes
 *  the raw value (for coercion / validation). */
export type RunnerFlag<T> = StringKeyOf<T> | ((out: T, value: string) => void);

/**
 * Walk `argv` as `--flag value` pairs. A recognised flag followed by a value
 * consumes both and applies its handler; everything else (unknown flags, a
 * recognised flag with no value after it) is skipped one token at a time. A later
 * occurrence wins. Required-field checks are the caller's.
 */
export function parseRunnerFlags<T extends object>(
  argv: readonly string[],
  out: T,
  flags: Readonly<Record<string, RunnerFlag<T>>>,
): T {
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (value === undefined || !Object.prototype.hasOwnProperty.call(flags, key)) continue;
    const flag = flags[key]!;
    if (typeof flag === 'function') flag(out, value);
    else (out as Record<string, unknown>)[flag] = value;
    i++;
  }
  return out;
}
