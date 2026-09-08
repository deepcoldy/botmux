import { existsSync, readFileSync } from 'node:fs';
import { normalizeInteractiveCardInput } from './send-dispatch.js';

/**
 * `botmux card patch` — patch a previously-sent custom interactive card in
 * place by its messageId (no new message, same chat/topic).
 *
 * This module holds the testable core: argv validation, card input reading,
 * the normalize → patch → error-map flow, and output construction. cli.ts keeps
 * a thin wrapper (argv slicing, transport gates, session identity resolution,
 * process.exit). Mirrors the send-dispatch.ts split.
 *
 * Safety boundary: the replacement card goes through the SAME
 * {@link normalizeInteractiveCardInput} as `botmux send --card-file/--card-json`,
 * so a patched card can't smuggle callback controls into botmux action handlers
 * any more than a sent one can.
 */

/** Patch primitive, injected by the caller (real: im/lark/client.updateMessage). */
export type UpdateCardMessageFn = (
  larkAppId: string,
  messageId: string,
  cardJson: string,
) => Promise<void>;

// ─── help text ───────────────────────────────────────────────────────────────

/** Usage for `botmux card patch` (printed by `card patch --help`). Kept
 *  consistent with the global help's card patch section and the missing-arg
 *  errors in parseCardPatchArgs. */
export const CARD_PATCH_USAGE = `botmux card patch — 原地更新之前发出的自定义卡片

用法:
  botmux card patch --message-id <om_xxx> (--card-file <path> | --card-json <json>) [--session-id <sid>]

说明:
  按 messageId 原地更新之前用 send --card-file/--card-json 发出的自定义卡片
  （不发新消息、不换群/话题）。messageId 取自 send 成功输出的 .messageId，
  卡片安全校验与 send 相同。

选项:
  --message-id <om_xxx>  要更新的消息 id（必填，om_ 开头）
  --card-file <path>     替换卡片 JSON 文件路径（与 --card-json 二选一）
  --card-json <json>     替换卡片 JSON 字符串（与 --card-file 二选一）
  --session-id <sid>     手动指定会话（默认从会话上下文自动推断）`;

/** Usage for `botmux card` (printed by `card --help` / `card` with no
 *  subcommand). */
export const CARD_COMMAND_USAGE = `botmux card — 卡片相关命令

用法:
  botmux card patch --message-id <om_xxx> (--card-file <path> | --card-json <json>) [--session-id <sid>]
      原地更新之前用 send --card-file/--card-json 发出的自定义卡片
      （不发新消息、不换群/话题）；messageId 取自 send 成功输出的 .messageId，
      卡片安全校验与 send 相同；[--session-id <sid>] 可手动指定会话

  botmux card stream open|write|snapshot|reanchor|finish ...
      使用 CardKit 原生文本流式更新（打字机效果）；运行
      botmux card stream --help 查看完整流程`;

/** True when `botmux card patch` argv asks for help. Help wins over the
 *  missing-arg validation (cli.ts checks this before parseCardPatchArgs). */
export function cardPatchArgsWantHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

// ─── argv parsing ────────────────────────────────────────────────────────────

export type CardPatchParsedArgs =
  | {
      ok: true;
      messageId: string;
      cardFile?: string;
      cardJson?: string;
      sessionId?: string;
    }
  | { ok: false; error: string };

/** True when `flag` is present but lacks a usable value (last token, followed
 *  by another flag, or `--flag=` empty). Mirrors cli.ts's
 *  flagPresentButValueMissing (kept local so this module stays import-safe). */
function flagPresentButValueMissing(args: string[], flag: string): boolean {
  const i = args.findIndex(a => a === flag || a.startsWith(flag + '='));
  if (i < 0) return false; // absent entirely — not "missing a value"
  if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1) === '';
  const next = args[i + 1];
  if (next === undefined) return true;
  if (next.startsWith('-')) return true;
  return false;
}

/** Pick a value from --flag <value> or --flag=value style args. */
function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === flag && i + 1 < args.length) return args[i + 1];
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Validate `botmux card patch` argv. Pure: returns a discriminated result
 * instead of exiting, so the CLI wrapper maps failures to exit 2 and tests can
 * drive every branch. Unknown flags / positionals are ignored (same leniency
 * as `botmux send`; a missing --message-id still fails closed).
 */
export function parseCardPatchArgs(args: string[]): CardPatchParsedArgs {
  if (flagPresentButValueMissing(args, '--message-id')) {
    return { ok: false, error: '--message-id 需要消息 id 参数（om_ 开头）' };
  }
  const messageId = flagValue(args, '--message-id');
  if (!messageId) {
    return { ok: false, error: '缺少必填参数 --message-id <om_xxx>' };
  }
  if (!messageId.startsWith('om_')) {
    return { ok: false, error: `messageId 格式无效: ${messageId}（需以 om_ 开头）` };
  }
  if (flagPresentButValueMissing(args, '--card-file')) {
    return { ok: false, error: '--card-file 需要路径参数' };
  }
  if (flagPresentButValueMissing(args, '--card-json')) {
    return { ok: false, error: '--card-json 需要 JSON 字符串参数' };
  }
  const cardFile = flagValue(args, '--card-file');
  const cardJson = flagValue(args, '--card-json');
  if (cardFile !== undefined && cardJson !== undefined) {
    return { ok: false, error: '--card-json 与 --card-file 不能同时使用' };
  }
  if (cardFile === undefined && cardJson === undefined) {
    return { ok: false, error: '需要 --card-file <path> 或 --card-json <json> 之一' };
  }
  if (flagPresentButValueMissing(args, '--session-id')) {
    return { ok: false, error: '--session-id 需要会话 id 参数' };
  }
  const sessionId = flagValue(args, '--session-id');
  return {
    ok: true,
    messageId,
    ...(cardFile !== undefined ? { cardFile } : {}),
    ...(cardJson !== undefined ? { cardJson } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

// ─── card input reading ──────────────────────────────────────────────────────

export type CardPatchInput =
  | { ok: true; rawCard: string }
  | { ok: false; exitCode: number; error: string };

/** Read the replacement card JSON: inline --card-json wins, else --card-file.
 *  A missing/unreadable file is exit 1 (runtime), never exit 2. */
export function readCardPatchInput(
  cardFile: string | undefined,
  cardJson: string | undefined,
): CardPatchInput {
  if (cardJson !== undefined) return { ok: true, rawCard: cardJson };
  const path = cardFile!;
  if (!existsSync(path)) return { ok: false, exitCode: 1, error: `文件不存在: ${path}` };
  try {
    return { ok: true, rawCard: readFileSync(path, 'utf-8') };
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      error: `读取文件失败: ${path}: ${(err as Error)?.message ?? String(err)}`,
    };
  }
}

// ─── transport verdict (unit-testable mirror of the cli.ts gates) ────────────

/**
 * Whether a resolved session has NO Feishu transport: its chat is an HTTP
 * control-API virtual session (http_async_/http_wait_) or its owning bot is
 * core-only (apiOnly). This is the same verdict cli.ts's
 * assertSessionTransportOrExit enforces with the real bot registry; exported
 * as a pure predicate (isApiOnly injected) so the gate logic is unit-testable
 * without importing cli.ts.
 */
export function sessionHasNoFeishuTransport(
  session: { chatId?: string; larkAppId?: string },
  isApiOnly: (larkAppId: string) => boolean,
): boolean {
  const chatId = session.chatId ?? '';
  if (chatId.startsWith('http_async_') || chatId.startsWith('http_wait_')) return true;
  return !!session.larkAppId && isApiOnly(session.larkAppId);
}

// ─── patch execution + error mapping ─────────────────────────────────────────

export type CardPatchDeps = {
  updateMessage: UpdateCardMessageFn;
};

export type CardPatchOutcome =
  | { ok: true; messageId: string; cardJson: string }
  | { ok: false; exitCode: number; error: string };

/**
 * Normalize the replacement card through the SAME safety validator `send`
 * uses, then patch in place. Never throws: every failure (validation,
 * withdrawn, transport, API) is mapped to an exit code + message so the CLI
 * wrapper stays a thin print-and-exit shell.
 */
export async function executeCardPatch(
  deps: CardPatchDeps,
  opts: { larkAppId: string; messageId: string; rawCard: string },
): Promise<CardPatchOutcome> {
  const normalized = normalizeInteractiveCardInput(opts.rawCard);
  if (!normalized.ok) return { ok: false, exitCode: 2, error: normalized.error };
  try {
    await deps.updateMessage(opts.larkAppId, opts.messageId, normalized.cardJson);
    return { ok: true, messageId: opts.messageId, cardJson: normalized.cardJson };
  } catch (err) {
    return { ok: false, ...mapCardPatchError(err) };
  }
}

/**
 * Extract the Feishu business error `{code, msg}` from an AxiosError-shaped
 * throw: the Lark SDK raises HTTP 4xx/5xx as AxiosError with the parsed
 * `{code, msg, ...}` body on `err.response.data`. A string body is tried
 * with JSON.parse first. Returns undefined when no business error can be
 * extracted (caller falls back to err.message).
 */
function extractLarkBusinessError(err: unknown): { code: unknown; msg: string } | undefined {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const msg = (parsed as { msg?: unknown }).msg;
  if (typeof msg !== 'string' || msg.length === 0) return undefined;
  return { code: (parsed as { code?: unknown }).code, msg };
}

/**
 * Map patch failures to exit codes.
 * - MessageWithdrawnError (Lark 230011, already typed by updateMessage) → exit 1
 * - LarkTransportDisabledError → exit 2 (the cli.ts gates normally refuse
 *   first; this is the defensive backstop if a caller bypasses them)
 * - AxiosError-shaped failures (HTTP 4xx/5xx from the Lark SDK) → exit 1 with
 *   the provider's business msg+code extracted from err.response.data, so a
 *   patch on a missing/non-card message surfaces the real reason instead of
 *   just "Request failed with status code 400"
 * - Everything else (no permission, non-card target, ephemeral, network, …)
 *   → exit 1 with err.message passed through verbatim. No speculative
 *   error-code mapping: only 230011 has a typed constant in the codebase, so
 *   unmapped codes surface exactly what the API returned.
 */
function mapCardPatchError(err: unknown): { exitCode: number; error: string } {
  const name = (err as { name?: string } | null | undefined)?.name;
  if (name === 'MessageWithdrawnError') {
    return { exitCode: 1, error: '消息已撤回，无法更新' };
  }
  if (name === 'LarkTransportDisabledError') {
    return { exitCode: 2, error: '当前会话 Bot 无飞书连接（core-only/apiOnly），无法更新卡片' };
  }
  const biz = extractLarkBusinessError(err);
  if (biz) {
    const codePart = biz.code !== undefined ? ` (code: ${biz.code})` : '';
    return { exitCode: 1, error: `更新失败: ${biz.msg}${codePart}` };
  }
  const msg = (err as { message?: string } | null | undefined)?.message ?? String(err);
  return { exitCode: 1, error: `更新失败: ${msg}` };
}

// ─── output ──────────────────────────────────────────────────────────────────

/** Machine-parseable success JSON. Field naming matches `botmux send` output
 *  (success/messageId/sessionId). stdout must contain ONLY this JSON. */
export function buildCardPatchSuccessOutput(messageId: string, sessionId: string): string {
  return JSON.stringify({ success: true, messageId, sessionId });
}
