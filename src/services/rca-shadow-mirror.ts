import { createHmac } from 'node:crypto';
import type { CliTurnPayload } from '../types.js';
import type { getBotOpenId } from '../bot-registry.js';
import type { getMessageDetail, listChatMessages } from '../im/lark/client.js';
import {
  cardContentHasUpgradeFallback,
  parseApiMessage,
  resolveMergedCardContent,
} from '../im/lark/message-parser.js';
import { logger } from '../utils/logger.js';
import { rcaShadowTokenFromEnv } from './rca-shadow-notifier.js';
import type { CandidateTurnReceipt } from './candidate-turn-durability.js';

export interface RcaShadowMirrorConfig {
  url: string;
  token: string;
  botAppIds: string[];
  /** Candidate bot identities must never feed their own output back into RCA mirroring. */
  candidateBotAppIds?: string[];
  /** Chats used for Candidate replay/Shadow output must never become mirror sources. */
  shadowChatIds?: string[];
  timeoutMs: number;
  maxInFlight: number;
  maxQueued: number;
}

export interface RcaShadowTurn {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  turnKind: 'first_turn' | 'follow_up';
  /** Source-only lookup key. Never serialized into the RCA Server request. */
  chatId: string;
  /** Genuine Lark message id when the turn was triggered by a message. */
  sourceMessageId?: string;
  topicId: string;
  title?: string;
  preparedInput: string | CliTurnPayload;
  sourceSnapshot?: RcaSourceSnapshot;
}

export interface RcaChampionResult {
  larkAppId: string;
  sessionId: string;
  turnId: string;
  result: string;
  runtime?: {
    cliId?: string;
    model?: string;
    backendType?: string;
  };
}

export interface RcaSourceSnapshotMessage {
  referenceKey: string;
  relation: 'current' | 'quoted' | 'recent';
  senderRole: 'human' | 'external_bot' | 'self_bot' | 'unknown';
  senderName?: string;
  messageType: string;
  content: string;
  at?: string;
}

export interface RcaSourceSnapshot {
  schemaVersion: '1';
  capturedAt: string;
  captureStatus: 'complete' | 'partial' | 'failed';
  warnings: string[];
  timeline: RcaSourceSnapshotMessage[];
}

export interface SnapshotCaptureDeps {
  getMessageDetail: typeof getMessageDetail;
  listChatMessages: typeof listChatMessages;
  resolveMergedCardContent: typeof resolveMergedCardContent;
  getBotOpenId: typeof getBotOpenId;
  now: () => Date;
}

async function loadDefaultCaptureDeps(): Promise<SnapshotCaptureDeps> {
  const [larkClient, botRegistry] = await Promise.all([
    import('../im/lark/client.js'),
    import('../bot-registry.js'),
  ]);
  return {
    getMessageDetail: larkClient.getMessageDetail,
    listChatMessages: larkClient.listChatMessages,
    resolveMergedCardContent,
    getBotOpenId: botRegistry.getBotOpenId,
    now: () => new Date(),
  };
}

const SOURCE_SNAPSHOT_MAX_MESSAGES = 8;
const SOURCE_SNAPSHOT_MAX_CHARS = 12_000;
const SOURCE_SNAPSHOT_RECENT_MESSAGES = 50;
const SOURCE_SNAPSHOT_MESSAGE_TIMEOUT_MS = 1_200;
const SOURCE_SNAPSHOT_HISTORY_TIMEOUT_MS = 2_400;
export const SOURCE_SNAPSHOT_CAPTURE_TIMEOUT_MS = 5_000;

type FetchLike = typeof fetch;
type LogLike = Pick<typeof logger, 'info' | 'warn'>;

export class CandidateTurnReceiptDeliveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'CandidateTurnReceiptDeliveryError';
    this.retryable = retryable;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function rcaShadowMirrorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RcaShadowMirrorConfig {
  const config: RcaShadowMirrorConfig = {
    url: env.BOTMUX_RCA_MIRROR_URL?.trim() || '',
    token: rcaShadowTokenFromEnv(env),
    botAppIds: (env.BOTMUX_RCA_MIRROR_BOT_APP_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    candidateBotAppIds: (env.BOTMUX_RCA_MIRROR_CANDIDATE_BOT_APP_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    shadowChatIds: [...new Set([
      env.BOTMUX_RCA_SHADOW_CHAT_ID || '',
      ...(env.BOTMUX_RCA_MIRROR_SHADOW_CHAT_IDS || '').split(','),
    ].map((value) => value.trim()).filter(Boolean))],
    timeoutMs: positiveInteger(env.BOTMUX_RCA_MIRROR_TIMEOUT_MS, 500),
    maxInFlight: positiveInteger(env.BOTMUX_RCA_MIRROR_MAX_IN_FLIGHT, 2),
    maxQueued: nonNegativeInteger(env.BOTMUX_RCA_MIRROR_MAX_QUEUED, 16),
  };
  const enabled = Boolean(config.url && config.token && config.botAppIds.length > 0);
  if (enabled && config.candidateBotAppIds!.length === 0) {
    throw new Error('Candidate bot app exclusion is required when RCA Shadow mirroring is configured');
  }
  if (enabled && config.shadowChatIds!.length === 0) {
    throw new Error('Shadow chat exclusion is required when RCA Shadow mirroring is configured');
  }
  if (config.candidateBotAppIds!.some(appId => !config.botAppIds.includes(appId))) {
    throw new Error('Candidate bot app exclusion must also be present in the RCA mirror bot allowlist');
  }
  return config;
}

function opaqueKey(token: string, namespace: string, value: string): string {
  return createHmac('sha256', token)
    .update(`${namespace}\0${value}`)
    .digest('hex');
}

export async function deliverRcaChampionResult(
  input: RcaChampionResult,
  config: RcaShadowMirrorConfig = rcaShadowMirrorConfigFromEnv(),
  fetchImpl: FetchLike = fetch,
): Promise<'sent' | 'disabled'> {
  if (!config.url || !config.token
    || !config.botAppIds.includes(input.larkAppId)
    || config.candidateBotAppIds?.includes(input.larkAppId)) {
    return 'disabled';
  }
  const result = input.result.trim();
  if (!result) return 'disabled';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  timeout.unref();
  try {
    const response = await fetchImpl(
      `${config.url.replace(/\/+$/, '')}/api/mirrors/champions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          correlationKey: opaqueKey(config.token, 'session', input.sessionId),
          turnKey: opaqueKey(config.token, 'turn', input.turnId),
          result,
          ...(input.runtime ? { runtime: input.runtime } : {}),
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`RCA Server returned HTTP ${response.status}`);
    }
    return 'sent';
  } finally {
    clearTimeout(timeout);
  }
}

/** Project one durable Candidate turn transition into Search RCA's control
 * plane. The BotMux receipt remains authoritative; a later transition or boot
 * reconciliation may replay this idempotent callback after transport failure. */
export async function deliverCandidateTurnReceipt(
  receipt: CandidateTurnReceipt,
  mirrorConfig: RcaShadowMirrorConfig = rcaShadowMirrorConfigFromEnv(),
  fetchImpl: FetchLike = fetch,
): Promise<'sent' | 'disabled'> {
  if (!mirrorConfig.url || !mirrorConfig.token
    || !mirrorConfig.botAppIds.includes(receipt.larkAppId)) {
    return 'disabled';
  }
  if (!mirrorConfig.candidateBotAppIds?.includes(receipt.larkAppId)) {
    throw new CandidateTurnReceiptDeliveryError(
      'Candidate turn receipt app is missing from the Candidate bot exclusion',
      false,
    );
  }
  const transition = receipt.transitions.at(-1);
  if (!transition) return 'disabled';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), mirrorConfig.timeoutMs);
  timeout.unref();
  try {
    const response = await fetchImpl(
      `${mirrorConfig.url.replace(/\/+$/, '')}/api/candidates/turns/receipts`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${mirrorConfig.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          incidentKey: receipt.incidentKey,
          candidateDispatchId: receipt.candidateDispatchId,
          releaseId: receipt.releaseId,
          releaseManifestSha256: receipt.releaseManifestSha256,
          runtimeBundleId: receipt.runtimeBundleId,
          turnId: receipt.turnId,
          sequence: receipt.sequence,
          larkAppId: receipt.larkAppId,
          chatId: receipt.chatId,
          rootMessageId: receipt.rootMessageId,
          botmuxSessionId: receipt.botmuxSessionId,
          botmuxCommit: receipt.botmuxCommit,
          botmuxArtifactSha256: receipt.botmuxArtifactSha256,
          status: transition.status,
          dispatchAttempt: transition.dispatchAttempt,
          workerGeneration: transition.workerGeneration,
          evidence: transition.evidence,
          ...(transition.status === 'completed'
            && typeof transition.evidence.output === 'string'
            ? { result: transition.evidence.output }
            : {}),
          ...(transition.status === 'completed'
            && receipt.outputDelivery?.status === 'delivered'
            && receipt.outputDelivery.messageId
            ? {
                outputDelivery: {
                  provider: 'lark',
                  messageId: receipt.outputDelivery.messageId,
                },
              }
            : {}),
          occurredAt: transition.occurredAt,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new CandidateTurnReceiptDeliveryError(
        `RCA Server returned HTTP ${response.status}`,
        response.status !== 409 && response.status !== 422,
      );
    }
    return 'sent';
  } finally {
    clearTimeout(timeout);
  }
}

export async function deliverCandidateTurnReceiptHistory(
  receipt: CandidateTurnReceipt,
  mirrorConfig: RcaShadowMirrorConfig = rcaShadowMirrorConfigFromEnv(),
  fetchImpl: FetchLike = fetch,
): Promise<'sent' | 'disabled'> {
  let result: 'sent' | 'disabled' = 'disabled';
  for (let index = 0; index < receipt.transitions.length; index += 1) {
    result = await deliverCandidateTurnReceipt(
      { ...receipt, transitions: receipt.transitions.slice(0, index + 1) },
      mirrorConfig,
      fetchImpl,
    );
  }
  return result;
}

function signalSource(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes('slardar')) return 'slardar';
  if (lower.includes('kepler')) return 'kepler';
  if (lower.includes('argos')) return 'argos';
  return 'botmux';
}

function normalizedInput(input: string | CliTurnPayload): CliTurnPayload {
  return typeof input === 'string' ? { content: input } : input;
}

const RAW_LARK_IDENTIFIER = /\b(?:oc|om|ou|on)_[A-Za-z0-9_-]{16,}\b/g;

function sanitizeTransportText(value: string): string {
  return value
    .replace(
      /<attachments\b[^>]*>[\s\S]*?<\/attachments>/gi,
      '[attachments omitted: source-local paths unavailable]',
    )
    .replace(/<session_id>[\s\S]*?<\/session_id>/gi, '')
    .replace(/<botmux_routing>[\s\S]*?<\/botmux_routing>/gi, '')
    .replace(/<botmux_reminder>[\s\S]*?<\/botmux_reminder>/gi, '')
    .replace(/<botmux_builtin_skills>[\s\S]*?<\/botmux_builtin_skills>/gi, '')
    .replace(
      /\bbotmux\s+(?:history|quoted|send|bots)\b(?:\s+(?:(?:oc|om|ou|on)_[A-Za-z0-9_-]+|list|--?[A-Za-z][A-Za-z0-9_-]*(?:=[^\s,，。；;]+)?|\d+)){0,3}/gi,
      '[transport-command-removed]',
    )
    .replace(RAW_LARK_IDENTIFIER, '[redacted-reference]')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizedInput(input: string | CliTurnPayload): CliTurnPayload {
  const content = sanitizeTransportText(normalizedInput(input).content);
  return { content: content || '[transport metadata removed]' };
}

function stableKeplerIdentifiers(
  content: string,
  name: 'submonitorId' | 'eventId',
): Set<string> {
  const values = new Set<string>();
  const pattern = new RegExp(
    `["']?${name}["']?\\s*(?:=|:)\\s*["']?([A-Za-z0-9._:-]{1,256})`,
    'gi',
  );
  for (const match of content.matchAll(pattern)) {
    if (match[1]) values.add(match[1]);
  }
  return values;
}

function keplerIncidentKey(token: string, candidates: string[]): string | null {
  if (!candidates.some(content => content.toLowerCase().includes('kepler'))) return null;
  const completePairs = new Set<string>();
  for (const content of candidates) {
    const submonitorIds = stableKeplerIdentifiers(content, 'submonitorId');
    const eventIds = stableKeplerIdentifiers(content, 'eventId');
    if (submonitorIds.size > 1 || eventIds.size > 1) return null;
    if (submonitorIds.size === 1 && eventIds.size === 1) {
      completePairs.add(`${[...submonitorIds][0]}\0${[...eventIds][0]}`);
    }
  }
  if (completePairs.size !== 1) return null;
  return opaqueKey(token, 'kepler-incident', [...completePairs][0]!);
}

function sanitizedSourceSnapshot(snapshot: RcaSourceSnapshot): RcaSourceSnapshot {
  return {
    schemaVersion: sanitizeTransportText(snapshot.schemaVersion) as RcaSourceSnapshot['schemaVersion'],
    capturedAt: sanitizeTransportText(snapshot.capturedAt),
    captureStatus: sanitizeTransportText(snapshot.captureStatus) as RcaSourceSnapshot['captureStatus'],
    warnings: snapshot.warnings.map(sanitizeTransportText),
    timeline: snapshot.timeline.map(item => ({
      referenceKey: sanitizeTransportText(item.referenceKey),
      relation: sanitizeTransportText(item.relation) as RcaSourceSnapshotMessage['relation'],
      senderRole: sanitizeTransportText(item.senderRole) as RcaSourceSnapshotMessage['senderRole'],
      ...(item.senderName ? { senderName: sanitizeTransportText(item.senderName) } : {}),
      messageType: sanitizeTransportText(item.messageType),
      content: sanitizeTransportText(item.content),
      ...(item.at ? { at: sanitizeTransportText(item.at) } : {}),
    })),
  };
}

function incidentCandidates(
  preparedInput: CliTurnPayload,
  sourceSnapshot: RcaSourceSnapshot,
): string[] {
  const byRelation = (relation: RcaSourceSnapshotMessage['relation']) => sourceSnapshot.timeline
    .filter(item => item.relation === relation)
    .map(item => item.content);
  return [
    ...byRelation('current'),
    preparedInput.content,
    ...byRelation('quoted'),
    ...byRelation('recent'),
  ];
}

function failedSourceSnapshot(
  warning = 'source_snapshot_capture_failed',
  now: Date = new Date(),
): RcaSourceSnapshot {
  return {
    schemaVersion: '1',
    capturedAt: now.toISOString(),
    captureStatus: 'failed',
    warnings: [warning],
    timeline: [],
  };
}

function rawMessageItem(detail: any): any | null {
  return detail?.items?.[0] ?? detail?.message ?? null;
}

function rawSenderId(message: any): string {
  return typeof message?.sender?.id === 'string' ? message.sender.id : '';
}

function senderRole(message: any, selfBotOpenId: string | undefined): RcaSourceSnapshotMessage['senderRole'] {
  const senderId = rawSenderId(message);
  if (selfBotOpenId && senderId === selfBotOpenId) return 'self_bot';
  const senderType = message?.sender?.sender_type;
  if (senderType === 'user') return 'human';
  if (senderType === 'app' || senderType === 'bot') return 'external_bot';
  return 'unknown';
}

function redactLarkIdentifiers(content: string): string {
  return content.replace(RAW_LARK_IDENTIFIER, '[redacted-reference]');
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then(value => ({ ok: true as const, value })).catch(() => ({ ok: false as const })),
      timedOut,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function looksLikeAlarmContext(message: any): boolean {
  const parsed = parseApiMessage(message);
  const haystack = `${parsed.senderName ?? ''}\n${parsed.content}`;
  return /报警时间|告警时间|触发时间|规则摘要|告警规则|报警规则|Tags?\s*[:：]|Vars?\s*[:：]|argos|kepler|slardar/i.test(haystack);
}

function recentContextMessages(
  recent: Awaited<ReturnType<typeof listChatMessages>>,
  selfBotOpenId: string | undefined,
): any[] {
  return recent
    .map((message, index) => ({
      message,
      index,
      role: senderRole(message, selfBotOpenId),
      alarm: looksLikeAlarmContext(message),
    }))
    .filter(item => item.role !== 'self_bot' && item.message?.msg_type !== 'system')
    .sort((left, right) => Number(right.alarm) - Number(left.alarm) || left.index - right.index)
    .map(item => item.message);
}

async function snapshotContent(
  turn: RcaShadowTurn,
  message: any,
  deps: SnapshotCaptureDeps,
  allowRemoteResolution: boolean,
): Promise<string> {
  const parsed = parseApiMessage(message).content;
  const hasCompleteLocalBody = message?.msg_type !== 'interactive'
    || Boolean(
      parsed
      && parsed !== '[卡片]'
      && parsed !== '[卡片 (模板)]'
      && parsed.includes('\n')
      && !cardContentHasUpgradeFallback(parsed),
    );
  if (hasCompleteLocalBody || !allowRemoteResolution) return parsed;
  if (message?.msg_type === 'interactive' && typeof message?.message_id === 'string') {
    const merged = await deps.resolveMergedCardContent(turn.larkAppId, message.message_id).catch(() => null);
    if (merged?.text) return merged.text;
  }
  return parsed;
}

/** Capture bounded Lark context on the source daemon. Raw Lark identifiers are
 * used only for lookup and are replaced with HMAC reference keys before return. */
export async function captureRcaSourceSnapshot(
  turn: RcaShadowTurn,
  token: string,
  providedDeps?: SnapshotCaptureDeps,
): Promise<RcaSourceSnapshot> {
  const deps = providedDeps ?? await loadDefaultCaptureDeps();
  const warnings: string[] = [];
  const messages: RcaSourceSnapshotMessage[] = [];
  const seenMessageIds = new Set<string>();
  const selfBotOpenId = deps.getBotOpenId(turn.larkAppId);
  let remainingChars = SOURCE_SNAPSHOT_MAX_CHARS;
  let truncated = false;

  const append = async (
    message: any,
    relation: RcaSourceSnapshotMessage['relation'],
    resolvedContent?: string,
  ): Promise<void> => {
    const messageId = typeof message?.message_id === 'string' ? message.message_id : '';
    if (!messageId || seenMessageIds.has(messageId)) return;
    seenMessageIds.add(messageId);
    if (messages.length >= SOURCE_SNAPSHOT_MAX_MESSAGES || remainingChars <= 0) {
      truncated = true;
      return;
    }
    const role = senderRole(message, selfBotOpenId);
    if (relation === 'recent' && role === 'self_bot') return;
    const localContent = parseApiMessage(message).content;
    const contentResult = resolvedContent === undefined
      ? await settleWithin(
        snapshotContent(turn, message, deps, true),
        SOURCE_SNAPSHOT_MESSAGE_TIMEOUT_MS,
      )
      : { ok: true as const, value: resolvedContent };
    let content = redactLarkIdentifiers(contentResult.ok ? contentResult.value : localContent);
    if (!content) return;
    if (content.length > remainingChars) {
      content = content.slice(0, remainingChars);
      truncated = true;
    }
    remainingChars -= content.length;
    const parsed = parseApiMessage(message);
    messages.push({
      referenceKey: opaqueKey(token, 'message', messageId),
      relation,
      senderRole: role,
      ...(parsed.senderName ? { senderName: parsed.senderName } : {}),
      messageType: parsed.msgType,
      content,
      ...(parsed.createTime ? { at: parsed.createTime } : {}),
    });
  };

  const sourceMessageId = turn.sourceMessageId
    ?? (turn.turnId.startsWith('om_') ? turn.turnId : '');
  const currentRequest = sourceMessageId
    ? settleWithin(
      deps.getMessageDetail(turn.larkAppId, sourceMessageId),
      SOURCE_SNAPSHOT_MESSAGE_TIMEOUT_MS,
    )
    : Promise.resolve({ ok: false as const });
  const recentRequest = settleWithin(
    deps.listChatMessages(turn.larkAppId, turn.chatId, SOURCE_SNAPSHOT_RECENT_MESSAGES),
    SOURCE_SNAPSHOT_HISTORY_TIMEOUT_MS,
  );

  let current: any | null = null;
  const currentResult = await currentRequest;
  if (currentResult.ok) {
    current = rawMessageItem(currentResult.value);
    if (current) await append(current, 'current');
    else warnings.push('current_message_unavailable');
  } else if (sourceMessageId) {
    warnings.push('current_message_unavailable');
  }

  const quotedMessageId = typeof current?.parent_id === 'string' ? current.parent_id : '';
  if (quotedMessageId) {
    const quotedResult = await settleWithin(
      deps.getMessageDetail(turn.larkAppId, quotedMessageId),
      SOURCE_SNAPSHOT_MESSAGE_TIMEOUT_MS,
    );
    if (quotedResult.ok) {
      const quoted = rawMessageItem(quotedResult.value);
      if (quoted) await append(quoted, 'quoted');
      else warnings.push('quoted_message_unavailable');
    } else {
      warnings.push('quoted_message_unavailable');
    }
  }

  const recentResult = await recentRequest;
  if (!recentResult.ok) {
    warnings.push('recent_messages_unavailable');
  } else {
    const candidates = recentContextMessages(recentResult.value, selfBotOpenId)
      .filter(message => !seenMessageIds.has(message?.message_id))
      .slice(0, Math.max(0, SOURCE_SNAPSHOT_MAX_MESSAGES - messages.length));
    const resolved = await Promise.all(candidates.map(async message => {
      const localContent = parseApiMessage(message).content;
      const result = await settleWithin(
        snapshotContent(turn, message, deps, true),
        SOURCE_SNAPSHOT_MESSAGE_TIMEOUT_MS,
      );
      return { message, content: result.ok ? result.value : localContent };
    }));
    for (const item of resolved) await append(item.message, 'recent', item.content);
  }

  const finalWarnings = truncated ? [...warnings, 'source_snapshot_truncated'] : warnings;
  return {
    schemaVersion: '1',
    capturedAt: deps.now().toISOString(),
    captureStatus: messages.length === 0
      ? 'failed'
      : finalWarnings.length > 0 ? 'partial' : 'complete',
    warnings: finalWarnings,
    timeline: messages,
  };
}

export class RcaShadowMirror {
  private readonly config: RcaShadowMirrorConfig;
  private readonly fetchImpl: FetchLike;
  private readonly log: LogLike;
  private readonly captureSnapshot: (turn: RcaShadowTurn, token: string) => Promise<RcaSourceSnapshot>;
  private readonly queue: RcaShadowTurn[] = [];
  private readonly activeSessionIds = new Set<string>();
  private readonly idleWaiters: Array<() => void> = [];
  private inFlight = 0;

  constructor(
    config: RcaShadowMirrorConfig,
    {
      fetchImpl = fetch,
      log = logger,
      captureSnapshot = captureRcaSourceSnapshot,
    }: {
      fetchImpl?: FetchLike;
      log?: LogLike;
      captureSnapshot?: (turn: RcaShadowTurn, token: string) => Promise<RcaSourceSnapshot>;
    } = {},
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.captureSnapshot = captureSnapshot;
  }

  submit(turn: RcaShadowTurn): 'disabled' | 'filtered' | 'queued' | 'dropped' {
    if (!this.config.url || !this.config.token || this.config.botAppIds.length === 0) {
      return 'disabled';
    }
    if (!this.config.botAppIds.includes(turn.larkAppId)
      || this.config.candidateBotAppIds?.includes(turn.larkAppId)
      || this.config.shadowChatIds?.includes(turn.chatId)) return 'filtered';
    const canStartImmediately = this.inFlight < this.config.maxInFlight
      && !this.activeSessionIds.has(turn.sessionId);
    if (!canStartImmediately && this.queue.length >= this.config.maxQueued) {
      this.log.warn('[rca-shadow] mirror queue saturated; dropping challenger turn');
      return 'dropped';
    }
    this.queue.push(turn);
    this.drain();
    return 'queued';
  }

  async onIdle(): Promise<void> {
    if (this.inFlight === 0 && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private drain(): void {
    while (this.inFlight < this.config.maxInFlight && this.queue.length > 0) {
      const nextIndex = this.queue.findIndex(turn => !this.activeSessionIds.has(turn.sessionId));
      if (nextIndex < 0) return;
      const [turn] = this.queue.splice(nextIndex, 1);
      this.inFlight += 1;
      this.activeSessionIds.add(turn.sessionId);
      void this.deliver(turn)
        .catch((error) => {
          this.log.warn(
            `[rca-shadow] mirror failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          this.inFlight -= 1;
          this.activeSessionIds.delete(turn.sessionId);
          this.drain();
          if (this.inFlight === 0 && this.queue.length === 0) {
            for (const resolve of this.idleWaiters.splice(0)) resolve();
          }
        });
    }
  }

  private async captureSourceSnapshot(turn: RcaShadowTurn): Promise<RcaSourceSnapshot> {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<RcaSourceSnapshot>((resolve) => {
      timeout = setTimeout(
        () => resolve(failedSourceSnapshot('source_snapshot_capture_timeout')),
        SOURCE_SNAPSHOT_CAPTURE_TIMEOUT_MS,
      );
      timeout.unref();
    });
    try {
      return await Promise.race([
        this.captureSnapshot(turn, this.config.token)
          .catch(() => failedSourceSnapshot()),
        timedOut,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async deliver(turn: RcaShadowTurn): Promise<void> {
    const preparedInput = sanitizedInput(turn.preparedInput);
    const sourceSnapshot = sanitizedSourceSnapshot(
      turn.sourceSnapshot ?? await this.captureSourceSnapshot(turn),
    );
    const incidentContent = [
      preparedInput.content,
      ...sourceSnapshot.timeline.map(item => item.content),
    ].join('\n');
    const incidentKey = keplerIncidentKey(
      this.config.token,
      incidentCandidates(preparedInput, sourceSnapshot),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetchImpl(
        `${this.config.url.replace(/\/+$/, '')}/api/mirrors/turns`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            correlationKey: opaqueKey(this.config.token, 'session', turn.sessionId),
            turnKey: opaqueKey(this.config.token, 'turn', turn.turnId),
            turnKind: turn.turnKind,
            preparedInput,
            sourceSnapshot,
            signalSource: signalSource(incidentContent),
            ...(incidentKey ? { incidentKey } : {}),
            title: sanitizeTransportText(turn.title ?? '') || 'Botmux RCA mirror',
            symptom: preparedInput.content.slice(0, 2_000),
            championReference: {
              delivery: 'original_alarm_group',
              topicKey: opaqueKey(this.config.token, 'topic', turn.topicId),
            },
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`RCA Server returned HTTP ${response.status}`);
      }
      // Search RCA now launches the durable Candidate topic itself. The old
      // notifier polled Search RCA run.status and posted a second top-level
      // card into the Shadow chat, creating a competing conversation surface.
      // A successful mirror response therefore has no follow-on UI side effect.
    } finally {
      clearTimeout(timeout);
    }
  }
}

let defaultMirror: RcaShadowMirror | null = null;

/** Fire-and-forget boundary used only after the primary Coco IPC dispatch.
 * Configuration, hashing, queueing, fetch and logging are all contained here;
 * no failure is allowed to escape into the current RCA path. */
export function mirrorPreparedTurn(turn: RcaShadowTurn): void {
  try {
    defaultMirror ??= new RcaShadowMirror(rcaShadowMirrorConfigFromEnv());
    defaultMirror.submit(turn);
  } catch (error) {
    logger.warn(
      `[rca-shadow] mirror submission ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Capture the result produced by the currently deployed RCA runtime without
 * delaying or changing its original Lark delivery. The RCA Server joins it to
 * the already mirrored input through the same opaque session/turn identity. */
export function mirrorChampionResult(input: RcaChampionResult): void {
  const mirrorReady = defaultMirror?.onIdle() ?? Promise.resolve();
  void mirrorReady.then(() => deliverRcaChampionResult(input)).catch((error) => {
    logger.warn(
      `[rca-shadow] Champion callback ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}
