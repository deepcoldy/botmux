import { existsSync, readFileSync } from 'node:fs';
import type {
  CardStreamAuthority,
  CardStreamBinding,
  CardStreamFinishResult,
  CardStreamOpenResult,
  CardStreamRecord,
  CardStreamSequenceLease,
} from '../services/card-stream-store.js';

const STREAM_ID_RE = /^cs_[0-9a-f]{32}$/;
const ELEMENT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,19}$/;
const MAX_STREAM_CONTENT_CHARS = 30_000;
const MAX_SUMMARY_CHARS = 50;

export const CARD_STREAM_USAGE = `botmux card stream — 原生 CardKit 流式更新

用法:
  botmux card stream open --message-id <om_xxx> [--summary <text>] [--session-id <sid>]
  botmux card stream write --stream-id <cs_xxx> --element-id <id> (--content <text> | --content-file <path|->) [--session-id <sid>]
  botmux card stream snapshot --stream-id <cs_xxx> [--session-id <sid>]
  botmux card stream reanchor --stream-id <cs_xxx> --message-id <om_xxx> [--summary <text>] [--session-id <sid>]
  botmux card stream bind-runtime --stream-id <cs_xxx> --status-element-id <id> --image-element-id <id>
      --active-image-key <img_xxx> --inactive-image-key <img_xxx> [--labels-json <json>] [--session-id <sid>]
  botmux card stream unbind-runtime --stream-id <cs_xxx> [--session-id <sid>]
  botmux card stream finish --stream-id <cs_xxx> [--summary <text>] [--session-id <sid>]

流程:
  1. 用 botmux send --card-file 发一张 Card 2.0 卡片；要流式写入的 markdown/plain_text
     组件必须设置唯一 element_id（字母开头，最多 20 字符）。
  2. stream open 把 messageId 绑定为当前会话独享的 streamId，并开启原生打字机模式。
  3. stream write 每次传该 element 的完整最新内容；新增后缀会以打字机效果出现。
  4. snapshot 读取当前会话原生累计 Token 四桶快照；无可靠数据时返回 usage:null，不估算。
  5. reanchor 把活动流迁移到新卡片，迁移成功后拒绝旧流迟到写入并尽力撤回旧消息。
  6. 可选 bind-runtime：让 daemon 的 working/analyzing/idle/stalled/limited 状态驱动指定元素。
  7. stream finish 关闭流式光标并更新会话列表摘要。

说明:
  --content-file - 从 stdin 读取多行内容。单次内容最多 ${MAX_STREAM_CONTENT_CHARS} 字符。
  streamId 绑定 session / bot / chat；不能跨会话或跨机器人复用。`;

export function cardStreamArgsWantHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function flagPresentButValueMissing(args: string[], flag: string): boolean {
  const i = args.findIndex(a => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return false;
  if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1) === '';
  const next = args[i + 1];
  return next === undefined || (next.startsWith('-') && next !== '-');
}

function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function optionalSessionId(args: string[]): { ok: true; sessionId?: string } | { ok: false; error: string } {
  if (flagPresentButValueMissing(args, '--session-id')) {
    return { ok: false, error: '--session-id 需要会话 id 参数' };
  }
  const sessionId = flagValue(args, '--session-id');
  return { ok: true, ...(sessionId ? { sessionId } : {}) };
}

function optionalSummary(args: string[]): { ok: true; summary?: string } | { ok: false; error: string } {
  if (flagPresentButValueMissing(args, '--summary')) {
    return { ok: false, error: '--summary 需要文本参数' };
  }
  const summary = flagValue(args, '--summary');
  if (summary !== undefined && summary.length > MAX_SUMMARY_CHARS) {
    return { ok: false, error: `--summary 最多 ${MAX_SUMMARY_CHARS} 字符` };
  }
  return { ok: true, ...(summary !== undefined ? { summary } : {}) };
}

export type CardStreamParsedArgs =
  | { ok: true; operation: 'open'; messageId: string; summary?: string; sessionId?: string }
  | {
      ok: true;
      operation: 'write';
      streamId: string;
      elementId: string;
      content?: string;
      contentFile?: string;
      sessionId?: string;
    }
  | { ok: true; operation: 'snapshot'; streamId: string; sessionId?: string }
  | { ok: true; operation: 'reanchor'; streamId: string; messageId: string; summary?: string; sessionId?: string }
  | { ok: true; operation: 'finish'; streamId: string; summary?: string; sessionId?: string }
  | { ok: false; error: string };

export function parseCardStreamArgs(args: string[]): CardStreamParsedArgs {
  const operation = args[0];
  const flags = args.slice(1);
  if (operation !== 'open' && operation !== 'write' && operation !== 'snapshot' && operation !== 'reanchor' && operation !== 'finish') {
    return { ok: false, error: '需要子命令 open、write、snapshot、reanchor 或 finish' };
  }
  const session = optionalSessionId(flags);
  if (!session.ok) return session;
  const sessionFields = session.sessionId ? { sessionId: session.sessionId } : {};

  if (operation === 'open') {
    if (flagPresentButValueMissing(flags, '--message-id')) {
      return { ok: false, error: '--message-id 需要消息 id 参数（om_ 开头）' };
    }
    const messageId = flagValue(flags, '--message-id');
    if (!messageId) return { ok: false, error: '缺少必填参数 --message-id <om_xxx>' };
    if (!messageId.startsWith('om_')) {
      return { ok: false, error: `messageId 格式无效: ${messageId}（需以 om_ 开头）` };
    }
    const summary = optionalSummary(flags);
    if (!summary.ok) return summary;
    return {
      ok: true,
      operation,
      messageId,
      ...(summary.summary !== undefined ? { summary: summary.summary } : {}),
      ...sessionFields,
    };
  }

  if (flagPresentButValueMissing(flags, '--stream-id')) {
    return { ok: false, error: '--stream-id 需要 cs_ 开头的流 id' };
  }
  const streamId = flagValue(flags, '--stream-id');
  if (!streamId) return { ok: false, error: '缺少必填参数 --stream-id <cs_xxx>' };
  if (!STREAM_ID_RE.test(streamId)) {
    return { ok: false, error: `streamId 格式无效: ${streamId}` };
  }

  if (operation === 'snapshot') {
    return { ok: true, operation, streamId, ...sessionFields };
  }

  if (operation === 'reanchor') {
    if (flagPresentButValueMissing(flags, '--message-id')) {
      return { ok: false, error: '--message-id 需要消息 id 参数（om_ 开头）' };
    }
    const messageId = flagValue(flags, '--message-id');
    if (!messageId?.startsWith('om_')) {
      return { ok: false, error: 'reanchor 缺少有效的 --message-id <om_xxx>' };
    }
    const summary = optionalSummary(flags);
    if (!summary.ok) return summary;
    return {
      ok: true,
      operation,
      streamId,
      messageId,
      ...(summary.summary !== undefined ? { summary: summary.summary } : {}),
      ...sessionFields,
    };
  }

  if (operation === 'finish') {
    const summary = optionalSummary(flags);
    if (!summary.ok) return summary;
    return {
      ok: true,
      operation,
      streamId,
      ...(summary.summary !== undefined ? { summary: summary.summary } : {}),
      ...sessionFields,
    };
  }

  if (flagPresentButValueMissing(flags, '--element-id')) {
    return { ok: false, error: '--element-id 需要组件 id 参数' };
  }
  const elementId = flagValue(flags, '--element-id');
  if (!elementId) return { ok: false, error: '缺少必填参数 --element-id <id>' };
  if (!ELEMENT_ID_RE.test(elementId)) {
    return { ok: false, error: 'elementId 格式无效：需字母开头，仅含字母/数字/_/-，最多 20 字符' };
  }
  if (flagPresentButValueMissing(flags, '--content')) {
    return { ok: false, error: '--content 需要文本参数' };
  }
  if (flagPresentButValueMissing(flags, '--content-file')) {
    return { ok: false, error: '--content-file 需要路径或 -' };
  }
  const content = flagValue(flags, '--content');
  const contentFile = flagValue(flags, '--content-file');
  if (content !== undefined && contentFile !== undefined) {
    return { ok: false, error: '--content 与 --content-file 不能同时使用' };
  }
  if (content === undefined && contentFile === undefined) {
    return { ok: false, error: '需要 --content <text> 或 --content-file <path|-> 之一' };
  }
  return {
    ok: true,
    operation,
    streamId,
    elementId,
    ...(content !== undefined ? { content } : {}),
    ...(contentFile !== undefined ? { contentFile } : {}),
    ...sessionFields,
  };
}

export type CardStreamContentInput =
  | { ok: true; content: string }
  | { ok: false; exitCode: number; error: string };

export function readCardStreamContent(
  content: string | undefined,
  contentFile: string | undefined,
): CardStreamContentInput {
  let value: string;
  try {
    if (content !== undefined) value = content;
    else if (contentFile === '-') value = readFileSync(0, 'utf-8');
    else {
      const path = contentFile!;
      if (!existsSync(path)) return { ok: false, exitCode: 1, error: `文件不存在: ${path}` };
      value = readFileSync(path, 'utf-8');
    }
  } catch (err) {
    return {
      ok: false,
      exitCode: 1,
      error: `读取流内容失败: ${(err as Error)?.message ?? String(err)}`,
    };
  }
  if (value.length > MAX_STREAM_CONTENT_CHARS) {
    return { ok: false, exitCode: 2, error: `流内容超过 ${MAX_STREAM_CONTENT_CHARS} 字符` };
  }
  return { ok: true, content: value };
}

export interface CardMessageRoute {
  messageId: string;
  chatId?: string;
  rootMessageId?: string;
  messageType?: string;
}

export interface CardStreamSessionRoute {
  chatId: string;
  rootMessageId: string;
  scope?: 'thread' | 'chat';
}

/** Normalize the response shapes returned by im.v1.message.get. */
export function cardMessageRouteFromDetail(detail: any, messageId: string): CardMessageRoute {
  const item = detail?.items?.[0] ?? detail?.message ?? detail ?? {};
  return {
    messageId: typeof item.message_id === 'string' ? item.message_id : messageId,
    ...(typeof item.chat_id === 'string' ? { chatId: item.chat_id } : {}),
    ...(typeof item.root_id === 'string' ? { rootMessageId: item.root_id } : {}),
    ...(typeof item.msg_type === 'string' ? { messageType: item.msg_type } : {}),
  };
}

export function cardMessageBelongsToSession(
  route: CardMessageRoute,
  session: CardStreamSessionRoute,
): { ok: true } | { ok: false; error: string } {
  if (!route.chatId) return { ok: false, error: '无法确认目标消息所在群，拒绝打开卡片流' };
  if (route.chatId !== session.chatId) return { ok: false, error: '目标消息不属于当前会话所在群' };
  if (route.messageType && route.messageType !== 'interactive') {
    return { ok: false, error: '目标消息不是 interactive 卡片' };
  }
  if (session.scope !== 'chat') {
    const sameRoot = route.messageId === session.rootMessageId || route.rootMessageId === session.rootMessageId;
    if (!sameRoot) return { ok: false, error: '目标消息不属于当前话题' };
  }
  return { ok: true };
}

export interface CardStreamStoreLike {
  open(
    binding: CardStreamBinding,
    cardId: string,
    callback: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamOpenResult>;
  write(
    streamId: string,
    authority: CardStreamAuthority,
    callback: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamRecord>;
  inspect(streamId: string, authority: CardStreamAuthority): Promise<CardStreamRecord>;
  reanchor(
    streamId: string,
    authority: CardStreamAuthority,
    nextBinding: CardStreamBinding,
    nextCardId: string,
    callback: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<{ previous: CardStreamRecord; current: CardStreamRecord }>;
  finish(
    streamId: string,
    authority: CardStreamAuthority,
    callback: (lease: CardStreamSequenceLease) => Promise<void>,
  ): Promise<CardStreamFinishResult>;
}

export interface CardStreamUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
}

export interface CardStreamDeps {
  store: CardStreamStoreLike;
  getMessageRoute: (larkAppId: string, messageId: string) => Promise<CardMessageRoute>;
  resolveCardId: (larkAppId: string, messageId: string) => Promise<string>;
  updateSettings: (input: {
    larkAppId: string;
    cardId: string;
    streamingMode: boolean;
    sequence: number;
    uuid: string;
    summary?: string;
    print?: { frequencyMs: number; step: number; strategy: 'fast' };
  }) => Promise<void>;
  updateElementContent: (input: {
    larkAppId: string;
    cardId: string;
    elementId: string;
    content: string;
    sequence: number;
    uuid: string;
  }) => Promise<void>;
  moveRuntimeBinding: (
    previousStreamId: string,
    currentStreamId: string,
    authority: CardStreamAuthority,
  ) => Promise<boolean>;
  deleteMessage: (larkAppId: string, messageId: string) => Promise<boolean>;
}

export type CardStreamOutcome =
  | {
      ok: true;
      operation: 'open';
      streamId: string;
      messageId: string;
      sequence: number;
      alreadyOpen: boolean;
    }
  | { ok: true; operation: 'write'; streamId: string; elementId: string; sequence: number }
  | {
      ok: true;
      operation: 'snapshot';
      streamId: string;
      capturedAt: string;
      usage: CardStreamUsageSnapshot | null;
      anchorTurnId?: string;
      currentTurnId?: string;
    }
  | {
      ok: true;
      operation: 'reanchor';
      previousStreamId: string;
      streamId: string;
      previousMessageId: string;
      messageId: string;
      sequence: number;
      runtimeRebound: boolean;
      previousMessageRecalled: boolean;
      anchorTurnId?: string;
    }
  | { ok: true; operation: 'finish'; streamId: string; sequence: number; alreadyFinished: boolean }
  | { ok: false; exitCode: number; error: string };

export async function executeCardStreamOpen(
  deps: CardStreamDeps,
  opts: {
    binding: CardStreamBinding;
    sessionRoute: CardStreamSessionRoute;
    summary?: string;
  },
): Promise<CardStreamOutcome> {
  try {
    const route = await deps.getMessageRoute(opts.binding.larkAppId, opts.binding.messageId);
    const ownership = cardMessageBelongsToSession(route, opts.sessionRoute);
    if (!ownership.ok) return { ok: false, exitCode: 2, error: ownership.error };
    const cardId = await deps.resolveCardId(opts.binding.larkAppId, opts.binding.messageId);
    const result = await deps.store.open(opts.binding, cardId, async lease => {
      await deps.updateSettings({
        larkAppId: opts.binding.larkAppId,
        ...lease,
        streamingMode: true,
        ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
        print: { frequencyMs: 70, step: 1, strategy: 'fast' },
      });
    });
    return {
      ok: true,
      operation: 'open',
      streamId: result.record.streamId,
      messageId: result.record.messageId,
      sequence: result.record.sequence,
      alreadyOpen: result.alreadyOpen,
      ...(result.record.anchorTurnId ? { anchorTurnId: result.record.anchorTurnId } : {}),
    };
  } catch (err) {
    return { ok: false, ...mapCardStreamError(err) };
  }
}

export async function executeCardStreamWrite(
  deps: CardStreamDeps,
  opts: {
    streamId: string;
    authority: CardStreamAuthority;
    elementId: string;
    content: string;
  },
): Promise<CardStreamOutcome> {
  try {
    const record = await deps.store.write(opts.streamId, opts.authority, async lease => {
      await deps.updateElementContent({
        larkAppId: opts.authority.larkAppId,
        ...lease,
        elementId: opts.elementId,
        content: opts.content,
      });
    });
    return {
      ok: true,
      operation: 'write',
      streamId: record.streamId,
      elementId: opts.elementId,
      sequence: record.sequence,
    };
  } catch (err) {
    return { ok: false, ...mapCardStreamError(err) };
  }
}

export async function executeCardStreamSnapshot(
  deps: Pick<CardStreamDeps, 'store'>,
  opts: {
    streamId: string;
    authority: CardStreamAuthority;
    readUsage: () => CardStreamUsageSnapshot | null | Promise<CardStreamUsageSnapshot | null>;
    currentTurnId?: string;
    now?: () => Date;
  },
): Promise<CardStreamOutcome> {
  try {
    const record = await deps.store.inspect(opts.streamId, opts.authority);
    const usage = await opts.readUsage();
    return {
      ok: true,
      operation: 'snapshot',
      streamId: opts.streamId,
      capturedAt: (opts.now?.() ?? new Date()).toISOString(),
      usage,
      ...(record.anchorTurnId ? { anchorTurnId: record.anchorTurnId } : {}),
      ...(opts.currentTurnId ? { currentTurnId: opts.currentTurnId } : {}),
    };
  } catch (err) {
    return { ok: false, ...mapCardStreamError(err) };
  }
}

export async function executeCardStreamReanchor(
  deps: CardStreamDeps,
  opts: {
    streamId: string;
    nextBinding: CardStreamBinding;
    authority: CardStreamAuthority;
    sessionRoute: CardStreamSessionRoute;
    summary?: string;
  },
): Promise<CardStreamOutcome> {
  try {
    const route = await deps.getMessageRoute(opts.nextBinding.larkAppId, opts.nextBinding.messageId);
    const ownership = cardMessageBelongsToSession(route, opts.sessionRoute);
    if (!ownership.ok) return { ok: false, exitCode: 2, error: ownership.error };
    const cardId = await deps.resolveCardId(opts.nextBinding.larkAppId, opts.nextBinding.messageId);
    const moved = await deps.store.reanchor(
      opts.streamId,
      opts.authority,
      opts.nextBinding,
      cardId,
      async lease => deps.updateSettings({
        larkAppId: opts.nextBinding.larkAppId,
        ...lease,
        streamingMode: true,
        ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
        print: { frequencyMs: 70, step: 1, strategy: 'fast' },
      }),
    );
    let runtimeRebound = false;
    try {
      runtimeRebound = await deps.moveRuntimeBinding(
        moved.previous.streamId,
        moved.current.streamId,
        opts.authority,
      );
    } catch { /* the stream remains usable without runtime decoration */ }
    let previousMessageRecalled = false;
    try {
      previousMessageRecalled = await deps.deleteMessage(
        opts.authority.larkAppId,
        moved.previous.messageId,
      );
    } catch { /* old stream is fenced even when Lark recall fails */ }
    return {
      ok: true,
      operation: 'reanchor',
      previousStreamId: moved.previous.streamId,
      streamId: moved.current.streamId,
      previousMessageId: moved.previous.messageId,
      messageId: moved.current.messageId,
      sequence: moved.current.sequence,
      runtimeRebound,
      previousMessageRecalled,
      ...(moved.current.anchorTurnId ? { anchorTurnId: moved.current.anchorTurnId } : {}),
    };
  } catch (err) {
    return { ok: false, ...mapCardStreamError(err) };
  }
}

export async function executeCardStreamFinish(
  deps: CardStreamDeps,
  opts: { streamId: string; authority: CardStreamAuthority; summary?: string },
): Promise<CardStreamOutcome> {
  try {
    const result = await deps.store.finish(opts.streamId, opts.authority, async lease => {
      await deps.updateSettings({
        larkAppId: opts.authority.larkAppId,
        ...lease,
        streamingMode: false,
        ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
      });
    });
    return {
      ok: true,
      operation: 'finish',
      streamId: result.record.streamId,
      sequence: result.record.sequence,
      alreadyFinished: result.alreadyFinished,
    };
  } catch (err) {
    return { ok: false, ...mapCardStreamError(err) };
  }
}

function extractLarkBusinessError(err: unknown): { code: unknown; msg: string } | undefined {
  const data = (err as { response?: { data?: unknown } } | null | undefined)?.response?.data;
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try { parsed = JSON.parse(data); } catch { return undefined; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const msg = (parsed as { msg?: unknown }).msg;
  if (typeof msg !== 'string' || !msg) return undefined;
  return { code: (parsed as { code?: unknown }).code, msg };
}

export function mapCardStreamError(err: unknown): { exitCode: number; error: string } {
  const name = (err as { name?: string } | null | undefined)?.name;
  if (name === 'CardStreamStoreError') {
    return { exitCode: 2, error: (err as Error).message };
  }
  if (name === 'CardRuntimeStatusBridgeError') {
    return { exitCode: 2, error: (err as Error).message };
  }
  if ((err as { code?: string } | null | undefined)?.code === 'FILE_LOCK_TIMEOUT') {
    return { exitCode: 1, error: '卡片流暂时忙，请稍后重试' };
  }
  if (name === 'MessageWithdrawnError') return { exitCode: 1, error: '消息已撤回，无法操作卡片流' };
  if (name === 'LarkTransportDisabledError') {
    return { exitCode: 2, error: '当前会话 Bot 无飞书连接（core-only/apiOnly），无法操作卡片流' };
  }
  const biz = extractLarkBusinessError(err);
  if (biz) {
    const code = biz.code !== undefined ? ` (code: ${biz.code})` : '';
    return { exitCode: 1, error: `CardKit 更新失败: ${biz.msg}${code}` };
  }
  const message = (err as { message?: string } | null | undefined)?.message ?? String(err);
  return { exitCode: 1, error: `CardKit 更新失败: ${message}` };
}

export function buildCardStreamSuccessOutput(outcome: Exclude<CardStreamOutcome, { ok: false }>, sessionId: string): string {
  const { ok: _ok, ...fields } = outcome;
  return JSON.stringify({ success: true, ...fields, sessionId });
}
