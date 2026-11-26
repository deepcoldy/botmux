/**
 * Bot ref resolver for `botmux create-group`. Pure function, no I/O — testable
 * in isolation by passing in mock bot configs + bot-info entries.
 *
 * Resolution order for each ref:
 *   1. Exact `larkAppId` match
 *   2. `botName` from bots-info.json (case-insensitive)
 *   3. `cliId` from bots.json (case-insensitive) — fallback when botName is
 *      unknown (bots-info.json gets populated by daemon at startup)
 *
 * Multiple matches by name → take the first in `botConfigs` order (= bots.json
 * traversal order, the user's deployment intent). Same ref repeated → dedup,
 * keeping first occurrence. Unresolvable ref → reported in `invalid` list.
 */

import type { ChatMode } from '../services/groups-store.js';
import { botsInfoObjectEntries, isBotsInfoRouteEntry } from '../services/bots-info-shape.js';

export interface BotConfigForResolve {
  larkAppId: string;
  cliId: string;
}

export interface BotInfoForResolve {
  larkAppId: string;
  botName: string | null;
}

export interface BotInfoForKickoff {
  larkAppId: string;
  botOpenId: string | null;
}

export type ResolvedKickoff =
  | { ok: true; targetLarkAppId?: string; prompt?: string }
  | { ok: false; error: string };

export interface ResolvedBots {
  /** Resolved larkAppIds in input order, deduped. First element is creator. */
  larkAppIds: string[];
  /** Refs that couldn't be matched to any bot. */
  invalid: string[];
  /** Warnings about ambiguous name → first match picked. */
  ambiguousWarnings: string[];
}

export interface CreateGroupCompletionStatus {
  success: boolean;
  chatCreated: true;
  chatId: string;
  shareLink: string | null;
  shareLinkError: string | null;
  collaborationReady: boolean;
  kickoffAccepted: boolean;
  kickoffRequested: boolean;
  kickoffMessageId: string | null;
  kickoffError: string | null;
}

/** Build the machine-readable terminal status for create-group. Success means
 * an explicitly requested kickoff (if any) was sent. `collaborationReady` reports
 * whether the best-effort bot-to-bot grants were written: a miss there is a
 * warning, and must not make callers that retry on failure create a second
 * group. `shareLink` / `shareLinkError` are best-effort metadata and likewise
 * do not flip `success` to false. */
export function createGroupCompletionStatus(input: {
  chatId: string;
  shareLink?: string | null;
  shareLinkError?: string | null;
  collaborationReady: boolean;
  kickoffRequested: boolean;
  kickoffMessageId: string | null;
  kickoffError: string | null;
}): CreateGroupCompletionStatus {
  const kickoffAccepted = !input.kickoffRequested
    || (!!input.kickoffMessageId && !input.kickoffError);
  return {
    success: kickoffAccepted,
    chatCreated: true,
    chatId: input.chatId,
    shareLink: input.shareLink ?? null,
    shareLinkError: input.shareLinkError ?? null,
    collaborationReady: input.collaborationReady,
    kickoffAccepted,
    kickoffRequested: input.kickoffRequested,
    kickoffMessageId: input.kickoffMessageId,
    kickoffError: input.kickoffError,
  };
}

/** Preserve the long-standing stdout contract: create-group emits only the
 * chatId by default, including partial/non-zero outcomes. Callers that can
 * consume a second structured line must opt in explicitly. */
export function shouldWriteCreateGroupCompletionStatus(
  _status: CreateGroupCompletionStatus,
  explicitJsonStatus: boolean,
): boolean {
  return explicitJsonStatus;
}

export type OwnerNoticeCommand =
  /** Not an owner-notice invocation: an ordinary `create-group` call. */
  | { kind: 'none' }
  | { kind: 'status' }
  | { kind: 'set'; enabled: boolean }
  | { kind: 'invalid'; error: string };

export const OWNER_NOTICE_USAGE = '用法: botmux create-group owner-notice [status|on|off]';

/**
 * `botmux create-group owner-notice [status|on|off]` — the machine-wide switch
 * (`groupOwnerNotice` in ~/.botmux/config.json) for the @-owner notice a newly
 * created group posts. Only a leading `owner-notice` positional selects it, so
 * an ordinary `create-group --bot …` call is never mistaken for a settings
 * write; a stray value refuses instead of guessing which way to flip it.
 */
export function parseOwnerNoticeCommand(rest: string[]): OwnerNoticeCommand {
  if (rest[0] !== 'owner-notice') return { kind: 'none' };
  const args = rest.slice(1);
  if (args.length === 0) return { kind: 'status' };
  if (args.length > 1) {
    return { kind: 'invalid', error: `owner-notice 只接受一个参数，收到: ${args.join(' ')}` };
  }
  const value = args[0].trim().toLowerCase();
  if (value === 'status') return { kind: 'status' };
  if (value === 'on' || value === 'enable') return { kind: 'set', enabled: true };
  if (value === 'off' || value === 'disable') return { kind: 'set', enabled: false };
  return { kind: 'invalid', error: `owner-notice 只支持 status / on / off，收到: "${args[0]}"` };
}

export interface OwnerNoticeCommandDeps {
  /** Persist the switch (global-config `setGroupOwnerNoticeEnabled`). */
  setEnabled(enabled: boolean): void;
  /** Effective value, as group creation reads it (config.ts getter). */
  isEnabled(): boolean;
  /** The stored value exactly as written, for hand-edit diagnostics. */
  rawValue(): unknown;
  configPath(): string;
}

export interface OwnerNoticeCommandOutcome {
  exitCode: 0 | 1 | 2;
  /** Effective switch after the command; absent when it was refused. */
  enabled?: boolean;
  stdout: string[];
  stderr: string[];
}

/** Execute a parsed `create-group owner-notice …` (I/O only through deps). */
export function runOwnerNoticeCommand(
  cmd: Exclude<OwnerNoticeCommand, { kind: 'none' }>,
  deps: OwnerNoticeCommandDeps,
): OwnerNoticeCommandOutcome {
  if (cmd.kind === 'invalid') return { exitCode: 2, stdout: [], stderr: [cmd.error, OWNER_NOTICE_USAGE] };
  if (cmd.kind === 'set') {
    try {
      deps.setEnabled(cmd.enabled);
    } catch (err: any) {
      return {
        exitCode: 1,
        stdout: [],
        stderr: [`写入 ${deps.configPath()} 失败: ${err?.message ?? err}（可改用 Dashboard「设置 → 群聊创建」）`],
      };
    }
  }
  const enabled = deps.isEnabled();
  const raw = deps.rawValue();
  const stderr = raw !== undefined && typeof raw !== 'boolean'
    ? [`⚠️  ${deps.configPath()} 里的 groupOwnerNotice 是 ${JSON.stringify(raw)}，不是 JSON 布尔值，已忽略（按默认开）；用 botmux create-group owner-notice off 改写。`]
    : [];
  return {
    exitCode: 0,
    enabled,
    stdout: [
      `建群后 @ 群主提醒: ${enabled ? 'on' : 'off'}${cmd.kind === 'set' ? '（已保存）' : ''}`,
      `配置文件: ${deps.configPath()}（${enabled ? 'groupOwnerNotice 未设为 false，默认开' : '"groupOwnerNotice": false'}）`,
      '下一次建群即生效，无需重启 daemon。',
    ],
    stderr,
  };
}

export type ResolvedChatMode =
  | { ok: true; chatMode?: ChatMode }
  | { ok: false; error: string };

/**
 * Parse the optional `--chat-mode` flag for `botmux create-group`.
 *
 * Absent/empty → `{ ok: true }` with no `chatMode`, so the request omits
 * `chat_mode` and keeps Feishu's default (普通群). Only the two creation-time
 * topologies are accepted; `p2p` is a direct message, not a creatable group.
 */
export function resolveChatMode(raw: string | undefined): ResolvedChatMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return { ok: true };
  if (value === 'group' || value === 'topic') return { ok: true, chatMode: value };
  return { ok: false, error: `--chat-mode 只支持 group 或 topic，收到: "${raw}"。` };
}

export type ParsedCreateGroupCliArgs =
  | { kind: 'help' }
  | { kind: 'deprecated-chat' }
  | { kind: 'team' }
  | { kind: 'error'; error: string }
  | {
    kind: 'ok';
    botRefs: string[];
    name?: string;
    chatMode?: string;
    workingDir?: string;
    kickoffBot?: string;
    kickoffPrompt?: string;
    jsonStatus: boolean;
  };

const CREATE_GROUP_KNOWN_FLAGS = new Set([
  '--help', '-h', '--json-status',
  '--bot', '--name', '--chat-mode', '--working-dir', '--cwd', '--dir',
  '--kickoff-bot', '--kickoff-prompt', '--chat', '--team', '--agent',
]);

const CREATE_GROUP_VALUE_FLAG_PREFIXES = [
  '--bot=', '--name=', '--chat-mode=', '--working-dir=', '--cwd=', '--dir=',
  '--kickoff-bot=', '--kickoff-prompt=', '--chat=', '--team=', '--agent=',
];

function looksLikeKnownCreateGroupFlag(token: string): boolean {
  if (CREATE_GROUP_KNOWN_FLAGS.has(token)) return true;
  if (/\s/.test(token)) return false;
  return CREATE_GROUP_VALUE_FLAG_PREFIXES.some(prefix => token.startsWith(prefix));
}

/**
 * Single-pass left-to-right argv parser for `botmux create-group`.
 *
 * Walking once and advancing past consumed flag values prevents value tokens
 * (such as prose inside `--kickoff-prompt` or `--name`) from being re-read as
 * `--help`, `--chat`, `--team`, `--kickoff-bot`, or `--json-status`, while
 * still catching missing values, blank `--kickoff-bot` / `--kickoff-prompt`,
 * and trailing bare duplicate flags.
 */
export function parseCreateGroupCliArgs(rest: readonly string[]): ParsedCreateGroupCliArgs {
  const botRefs: string[] = [];
  let name: string | undefined;
  let chatMode: string | undefined;
  let workingDir: string | undefined;
  let kickoffBot: string | undefined;
  let kickoffPrompt: string | undefined;
  let jsonStatus = false;
  let hasChat = false;
  let hasTeamOrAgent = false;
  let seenKickoffBot = false;
  let seenKickoffPrompt = false;
  let pendingError: string | undefined;

  const takeValue = (
    i: number,
    flag: string,
  ): { nextIndex: number; value: string | undefined; fromEq: boolean } => {
    const token = rest[i]!;
    if (token.startsWith(`${flag}=`)) {
      return { nextIndex: i, value: token.slice(flag.length + 1), fromEq: true };
    }
    if (i + 1 < rest.length) {
      return { nextIndex: i + 1, value: rest[i + 1], fromEq: false };
    }
    return { nextIndex: i, value: undefined, fromEq: false };
  };

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--help' || token === '-h') return { kind: 'help' };
    if (token === '--json-status') {
      jsonStatus = true;
      continue;
    }
    if (token === '--chat' || token.startsWith('--chat=')) {
      hasChat = true;
      if (token === '--chat' && i + 1 < rest.length && !rest[i + 1]!.startsWith('-')) i++;
      continue;
    }
    if (token === '--team' || token.startsWith('--team=') || token === '--agent' || token.startsWith('--agent=')) {
      hasTeamOrAgent = true;
      if ((token === '--team' || token === '--agent') && i + 1 < rest.length && !rest[i + 1]!.startsWith('-')) i++;
      continue;
    }
    if (token === '--bot' || token.startsWith('--bot=')) {
      const { nextIndex, value } = takeValue(i, '--bot');
      i = nextIndex;
      if (value !== undefined) botRefs.push(value);
      continue;
    }
    if (token === '--name' || token.startsWith('--name=')) {
      const { nextIndex, value } = takeValue(i, '--name');
      i = nextIndex;
      if (name === undefined && value !== undefined) name = value;
      continue;
    }
    if (token === '--chat-mode' || token.startsWith('--chat-mode=')) {
      const { nextIndex, value } = takeValue(i, '--chat-mode');
      i = nextIndex;
      if (chatMode === undefined && value !== undefined) chatMode = value;
      continue;
    }
    if (
      token === '--working-dir' || token.startsWith('--working-dir=')
      || token === '--cwd' || token.startsWith('--cwd=')
      || token === '--dir' || token.startsWith('--dir=')
    ) {
      const flag = token.startsWith('--working-dir') ? '--working-dir'
        : token.startsWith('--cwd') ? '--cwd' : '--dir';
      const { nextIndex, value } = takeValue(i, flag);
      i = nextIndex;
      if (workingDir === undefined && value !== undefined) workingDir = value;
      continue;
    }
    if (token === '--kickoff-bot' || token.startsWith('--kickoff-bot=')) {
      if (seenKickoffBot) {
        pendingError ??= '--kickoff-bot 不能重复指定。';
        if (token === '--kickoff-bot' && i + 1 < rest.length && !rest[i + 1]!.startsWith('-')) i++;
        continue;
      }
      seenKickoffBot = true;
      const { nextIndex, value, fromEq } = takeValue(i, '--kickoff-bot');
      if (value === undefined || (!fromEq && value.startsWith('-'))) {
        pendingError ??= '--kickoff-bot 缺少值。';
        continue;
      }
      i = nextIndex;
      if (!value.trim()) {
        pendingError ??= '--kickoff-bot 不能为空。';
        continue;
      }
      kickoffBot = value;
      continue;
    }
    if (token === '--kickoff-prompt' || token.startsWith('--kickoff-prompt=')) {
      if (seenKickoffPrompt) {
        pendingError ??= '--kickoff-prompt 不能重复指定。';
        if (token === '--kickoff-prompt' && i + 1 < rest.length && !looksLikeKnownCreateGroupFlag(rest[i + 1]!)) i++;
        continue;
      }
      seenKickoffPrompt = true;
      const { nextIndex, value, fromEq } = takeValue(i, '--kickoff-prompt');
      if (value === undefined || (!fromEq && looksLikeKnownCreateGroupFlag(value))) {
        pendingError ??= '--kickoff-prompt 缺少值。';
        continue;
      }
      i = nextIndex;
      if (!value.trim()) {
        pendingError ??= '--kickoff-prompt 不能为空。';
        continue;
      }
      kickoffPrompt = value;
      continue;
    }
  }

  if (hasChat) return { kind: 'deprecated-chat' };
  if (hasTeamOrAgent) return { kind: 'team' };
  if (pendingError) return { kind: 'error', error: pendingError };
  return {
    kind: 'ok',
    botRefs,
    name,
    chatMode,
    workingDir,
    kickoffBot,
    kickoffPrompt,
    jsonStatus,
  };
}

export function resolveBotRefs(
  refs: string[],
  botConfigs: BotConfigForResolve[],
  botInfo: unknown[],
): ResolvedBots {
  const safeBotInfo: BotInfoForResolve[] = botsInfoObjectEntries(botInfo)
    .filter(isBotsInfoRouteEntry)
    .map(entry => ({ larkAppId: entry.larkAppId, botName: entry.botName ?? null }));
  const out: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const ambiguousWarnings: string[] = [];

  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed) continue;

    let matchedAppId: string | undefined;
    let ambiguousLabel: string | undefined;

    // 1. Exact larkAppId
    const byAppId = botConfigs.find(c => c.larkAppId === trimmed);
    if (byAppId) {
      matchedAppId = byAppId.larkAppId;
    } else {
      // 2. botName (case-insensitive). bots-info.json is merge-written by
      //    multiple daemons and its order is NOT guaranteed to match bots.json.
      //    Spec says "重名取 bots.json 中第一个", so we walk botConfigs in
      //    deployment order and pick the first whose appId appears in the
      //    set of name-matched entries.
      const lower = trimmed.toLowerCase();
      const nameMatchSet = new Set(
        safeBotInfo.filter(b => b.botName?.toLowerCase() === lower).map(b => b.larkAppId),
      );
      const byNameAll = botConfigs.filter(c => nameMatchSet.has(c.larkAppId));
      if (byNameAll.length > 0) {
        matchedAppId = byNameAll[0].larkAppId;
        if (byNameAll.length > 1) ambiguousLabel = `botName "${trimmed}"`;
      } else {
        // 3. cliId fallback — relies on botConfigs order which IS bots.json
        //    order (loadBotConfigs preserves file traversal order).
        const byCliIdAll = botConfigs.filter(c => c.cliId.toLowerCase() === lower);
        if (byCliIdAll.length > 0) {
          matchedAppId = byCliIdAll[0].larkAppId;
          if (byCliIdAll.length > 1) ambiguousLabel = `cliId "${trimmed}"`;
        }
      }
    }

    if (!matchedAppId) {
      invalid.push(trimmed);
      continue;
    }

    if (seen.has(matchedAppId)) continue;
    seen.add(matchedAppId);
    out.push(matchedAppId);

    if (ambiguousLabel) {
      ambiguousWarnings.push(
        `${ambiguousLabel} matches multiple bots in bots.json — picked first (${matchedAppId}).`,
      );
    }
  }

  return { larkAppIds: out, invalid, ambiguousWarnings };
}

const KICKOFF_LARK_APP_ID_RE = /^cli_[A-Za-z0-9_-]{1,128}$/;
const KICKOFF_BOT_OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,160}$/;

/**
 * Validate the optional kickoff pair and resolve the target bot reference
 * (`botOpenId` `ou_...` or `larkAppId` `cli_...`) to a selected `larkAppId`.
 *
 * The two identifier namespaces (`ou_` vs `cli_`) are strictly disjoint so
 * resolution is unambiguous:
 * - `cli_...` resolves directly against `selectedLarkAppIds` (and optional
 *   `knownLarkAppIds`), working even when `bots-info.json` is absent or stale.
 * - `ou_...` resolves via `botInfo` (`bots-info.json`) to a unique `larkAppId`.
 * - Any other value (display name, cliId, `local_*`, flag token, etc.) fails
 *   closed so kickoff never guesses an ambiguous target.
 *
 * The service later obtains the target bot's observer-scoped `open_id` from the
 * creator app before sending the `@mention`; a bot's self-reported `open_id` is
 * never used across Lark apps.
 */
export function resolveKickoff(
  botRefRaw: string | undefined,
  promptRaw: string | undefined,
  selectedLarkAppIds: string[],
  botInfo: BotInfoForKickoff[],
  knownLarkAppIds?: readonly string[],
): ResolvedKickoff {
  const botRef = botRefRaw?.trim() || undefined;
  const prompt = promptRaw?.trim() || undefined;

  if (!botRef && !prompt) return { ok: true };
  if (!botRef || !prompt) {
    return { ok: false, error: '--kickoff-bot 与 --kickoff-prompt 必须同时提供且不能为空。' };
  }

  let targetLarkAppId: string;
  if (KICKOFF_LARK_APP_ID_RE.test(botRef)) {
    if (selectedLarkAppIds.includes(botRef)) {
      targetLarkAppId = botRef;
    } else {
      const known = new Set<string>([
        ...(knownLarkAppIds ?? []),
        ...botInfo.map(info => info.larkAppId),
      ]);
      if (known.has(botRef)) {
        return { ok: false, error: '--kickoff-bot 必须属于本次 --bot 列表。' };
      }
      return { ok: false, error: `--kickoff-bot 未匹配到本机 bot: ${botRef}` };
    }
  } else if (KICKOFF_BOT_OPEN_ID_RE.test(botRef)) {
    const matches = botInfo.filter(
      info => typeof info.botOpenId === 'string' && info.botOpenId.trim() === botRef,
    );
    if (matches.length === 0) {
      return { ok: false, error: `--kickoff-bot 未匹配到本机 bot: ${botRef}` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `--kickoff-bot 匹配到多个本机 bot，请检查 bots-info.json: ${botRef}` };
    }
    targetLarkAppId = matches[0].larkAppId;
    if (!selectedLarkAppIds.includes(targetLarkAppId)) {
      return { ok: false, error: '--kickoff-bot 必须属于本次 --bot 列表。' };
    }
  } else {
    return {
      ok: false,
      error: `--kickoff-bot 格式无效（仅支持 botOpenId (ou_...) 或 larkAppId (cli_...)）: ${botRef}`,
    };
  }

  if (targetLarkAppId === selectedLarkAppIds[0]) {
    return { ok: false, error: '--kickoff-bot 不能是 creator（第一个 --bot）。' };
  }

  return { ok: true, targetLarkAppId, prompt };
}
