/**
 * Pure helpers for `botmux ask` argument parsing.
 *
 * Kept in its own file (no I/O, no env reads) so the CSV / timeout parsing can
 * be unit-tested without spinning up a daemon. The actual CLI dispatch
 * (`cmdAsk`) lives in cli.ts and calls these helpers.
 */

import { parseAskQuestions } from './ask-questions.js';
import type { AskOption } from './ask-types.js';

export class AskArgsError extends Error {
  constructor(
    public readonly code:
      | 'questions_invalid'
      | 'options_missing'
      | 'options_too_few'
      | 'options_empty_key'
      | 'options_duplicate_key'
      | 'timeout_out_of_range'
      | 'timeout_not_number'
      | 'mention_not_open_id',
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

/** Parse `--mention <value>` → a human open_id.
 *
 *  与 `botmux send --mention` 的入参形态对齐：接受裸 open_id（`ou_xxx`）或
 *  `open_id:显示名`（显示名仅为可读性，卡片里直接渲染真实 at，不需要它）。
 *  其它 ID 形态（union_id `on_*`、user_id、邮箱）进了卡片 `<at>` 会被飞书
 *  整卡拒收，这里直接 fail loud。 */
export function parseAskMention(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '') {
    throw new AskArgsError('mention_not_open_id', '--mention 需要一个 open_id（ou_ 开头）');
  }
  // 第一个冒号前是 open_id（与 send 的 "open_id:Display Name" 约定一致）。
  const openId = (value.includes(':') ? value.slice(0, value.indexOf(':')) : value).trim();
  if (!/^ou_[A-Za-z0-9]{6,64}$/.test(openId)) {
    throw new AskArgsError(
      'mention_not_open_id',
      `--mention 只接受人类成员的 open_id（ou_ 开头），收到 "${value}"`,
    );
  }
  return openId;
}

/** Resolve the `(sub, rest)` pair for `botmux ask`'s top-level dispatch.
 *
 *  Input: positional args *after* the `ask` token. So for the user typing
 *  `botmux ask buttons --options yes,no "prompt"` we get
 *  `['buttons', '--options', 'yes,no', 'prompt']`; for the bare alias
 *  `botmux ask --options yes,no "prompt"` we get
 *  `['--options', 'yes,no', 'prompt']`.
 *
 *  The first positional starting with `--` means the user skipped the
 *  subcommand and went straight to flags — that's the bare-alias path; we
 *  return `sub=''` and let `cmdAsk` apply its v0.1.7 `buttons` default.
 *  Otherwise the first positional is the subcommand. */
export function normalizeAskDispatch(
  tail: ReadonlyArray<string>,
): { sub: string; rest: string[] } {
  const next = tail[0] ?? '';
  if (next.startsWith('--')) {
    return { sub: '', rest: tail.slice(0) };
  }
  return { sub: next, rest: tail.slice(1) };
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
  ];
  for (const k of required) {
    if (!env[k] || !env[k]!.trim()) return k;
  }
  // Chat sessions have no message root; worker intentionally omits it.
  if (env.BOTMUX_SESSION_SCOPE !== 'chat' && !env.BOTMUX_ROOT_MESSAGE_ID?.trim()) {
    return 'BOTMUX_ROOT_MESSAGE_ID';
  }
  return null;
}

/** Shared with the daemon validator so file input cannot silently lose defaults. */
export function parseAskQuestionsFile(raw: string) {
  let input: unknown;
  try { input = JSON.parse(raw); }
  catch { throw new AskArgsError('questions_invalid', '--questions-file 必须是有效 JSON 问题数组'); }
  const questions = parseAskQuestions(input);
  if (typeof questions === 'string') throw new AskArgsError('questions_invalid', `--questions-file: ${questions}`);
  return questions.map(q => ({ ...q, defaultSelectedKeys: q.defaultSelectedKeys ?? [] }));
}
