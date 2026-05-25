/**
 * Pure helpers for `botmux ask` argument parsing.
 *
 * Kept in its own file (no I/O, no env reads) so the CSV / timeout / approver
 * parsing can be unit-tested without spinning up a daemon. The actual CLI
 * dispatch (`cmdAsk`) lives in cli.ts and calls these helpers.
 */

import type { AskOption } from './ask-types.js';

export class AskArgsError extends Error {
  constructor(
    public readonly code:
      | 'options_missing'
      | 'options_too_few'
      | 'options_empty_key'
      | 'options_duplicate_key'
      | 'timeout_out_of_range'
      | 'timeout_not_number',
    message: string,
  ) {
    super(message);
    this.name = 'AskArgsError';
  }
}

/** Parse `--options` CSV. Each item is either `key` (key==label) or `key=label`.
 *
 *  Rules:
 *   - Trims whitespace around each item and around `key=label` halves.
 *   - Drops empty items (trailing commas / `"a,,b"`); does not count them.
 *   - Requires ≥ 2 distinct keys after parsing.
 *   - Empty `key` (e.g. `"=label"`) is rejected.
 *   - Duplicate keys are rejected — let the caller surface a clear error rather
 *     than silently de-duping (which would change observable button count).
 *   - The first `=` splits key/label; subsequent `=` are part of the label, so
 *     `"go=继续=右"` → key=`go`, label=`继续=右`. */
export function parseAskOptions(raw: string | undefined): AskOption[] {
  if (raw === undefined || raw.trim() === '') {
    throw new AskArgsError('options_missing', '缺少 --options（需要 ≥ 2 项，例如 --options "yes,no" 或 --options "yes=继续,no=回滚"）');
  }
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const out: AskOption[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const eq = item.indexOf('=');
    let key: string;
    let label: string;
    if (eq < 0) {
      key = item;
      label = item;
    } else {
      key = item.slice(0, eq).trim();
      label = item.slice(eq + 1).trim();
      if (label === '') label = key; // `"yes="` → label falls back to key
    }
    if (key === '') {
      throw new AskArgsError(
        'options_empty_key',
        `--options 项的 key 不能为空（"${item}"）`,
      );
    }
    if (seen.has(key)) {
      throw new AskArgsError(
        'options_duplicate_key',
        `--options 出现重复 key: ${key}`,
      );
    }
    seen.add(key);
    out.push({ key, label });
  }

  if (out.length < 2) {
    throw new AskArgsError(
      'options_too_few',
      `--options 至少需要 2 项，收到 ${out.length}`,
    );
  }
  return out;
}

/** Parse `--timeout <seconds>` → milliseconds. Bounds match §7:
 *   - lower bound: 10s (sub-10s asks are almost always a bug)
 *   - upper bound: 3600s (1h — past that, recovery should kick in v0.1.8)
 *   - default: 300s (caller passes `undefined` to use it) */
export function parseAskTimeoutSeconds(
  raw: string | undefined,
  defaults: { default: number; min: number; max: number } = {
    default: 300,
    min: 10,
    max: 3600,
  },
): number {
  if (raw === undefined) return defaults.default * 1000;
  const trimmed = raw.trim();
  if (trimmed === '') return defaults.default * 1000;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AskArgsError(
      'timeout_not_number',
      `--timeout 必须是整数秒数，收到 "${raw}"`,
    );
  }
  if (n < defaults.min || n > defaults.max) {
    throw new AskArgsError(
      'timeout_out_of_range',
      `--timeout 范围 [${defaults.min}, ${defaults.max}] 秒，收到 ${n}`,
    );
  }
  return n * 1000;
}

/** Required env vars on the CLI side (§5). Returns the first missing one so
 *  the caller can produce a single, specific error message. */
export function findMissingAskEnv(
  env: NodeJS.ProcessEnv,
): string | null {
  const required = [
    'BOTMUX_SESSION_ID',
    'BOTMUX_CHAT_ID',
    'BOTMUX_LARK_APP_ID',
    'BOTMUX_ROOT_MESSAGE_ID',
  ];
  for (const k of required) {
    if (!env[k] || !env[k]!.trim()) return k;
  }
  return null;
}
