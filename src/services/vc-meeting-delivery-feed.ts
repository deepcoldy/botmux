import { createHash } from 'node:crypto';
import type {
  NormalizedVcMeetingItem,
  VcMeetingActivityType,
  VcMeetingActor,
} from '../vc-agent/types.js';
import { canonicalJson, computeInputHash } from '../utils/canonical-input-hash.js';
import {
  VC_MEETING_DELIVERY_SCHEMA_VERSION,
  computeVcMeetingDeliveryInputHash,
  deriveVcMeetingDeliveryIdentity,
  validateVcMeetingDeliveryRequest,
  type VcMeetingDeliveryEntry,
  type VcMeetingDeliveryRequest,
} from './vc-meeting-delivery-protocol.js';

export const VC_MEETING_DELIVERY_INSTRUCTION_VERSION = 'meeting-consumer-v1' as const;

export interface VcMeetingCanonicalFeedItem {
  /** Canonical listener feed sequence. Gaps are valid after per-member filtering. */
  ingestSeq: number;
  /** Durable journal identity. Callers that persist/rebuild a feed must supply
   *  both fields instead of relying on the process-local transcript revision. */
  itemVersionKey?: string;
  contentHash?: string;
  item: NormalizedVcMeetingItem;
}

export interface VcMeetingDeliveryRenderContext {
  timeZone: string;
  /** Stable identities allowed to issue instructions in meeting content. */
  authorizedActorIds?: readonly string[];
}

export interface VcMeetingDeliveryMemberFilter {
  activityTypes?: readonly VcMeetingActivityType[];
}

export interface BuildVcMeetingDeliveryEntriesInput {
  items: readonly VcMeetingCanonicalFeedItem[];
  fromDeliverySeq: number;
  render: VcMeetingDeliveryRenderContext;
  filter?: VcMeetingDeliveryMemberFilter;
  final?: boolean;
  finalText?: string;
}

export interface SealVcMeetingDeliveryInput {
  meeting: VcMeetingDeliveryRequest['meeting'];
  member: VcMeetingDeliveryRequest['member'];
  target: VcMeetingDeliveryRequest['target'];
  entries: readonly VcMeetingDeliveryEntry[];
  instructionVersion?: string;
  final?: boolean;
  sentAt?: string;
  traceId?: string;
}

function assertPositiveSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive safe integer`);
  }
}

function compactText(value: string | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 1_000);
}

function canonicalActor(actor: VcMeetingActor | undefined): Record<string, unknown> | undefined {
  if (!actor) return undefined;
  return {
    ...(actor.openId ? { openId: actor.openId } : {}),
    ...(actor.unionId ? { unionId: actor.unionId } : {}),
    ...(actor.name?.trim() ? { name: actor.name.trim() } : {}),
    ...(actor.userType !== undefined ? { userType: actor.userType } : {}),
  };
}

/** Semantic input deliberately excludes push/poll transport identity. */
export function canonicalVcMeetingItemContent(item: NormalizedVcMeetingItem): Record<string, unknown> {
  const base = {
    type: item.type,
    meetingId: item.meetingId,
    itemKey: item.itemKey,
    ...(item.occurredAtMs !== undefined ? { occurredAtMs: item.occurredAtMs } : {}),
  };
  switch (item.type) {
    case 'transcript_received':
      return {
        ...base,
        sentenceId: item.sentenceId,
        speaker: canonicalActor(item.speaker),
        ...(item.startTimeMs !== undefined ? { startTimeMs: item.startTimeMs } : {}),
        ...(item.endTimeMs !== undefined ? { endTimeMs: item.endTimeMs } : {}),
        ...(item.language ? { language: item.language } : {}),
        text: item.text,
        isFinal: item.isFinal === true,
      };
    case 'chat_received':
      return {
        ...base,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        sender: canonicalActor(item.sender),
        ...(item.messageType ? { messageType: item.messageType } : {}),
        ...(item.text !== undefined ? { text: item.text } : {}),
      };
    case 'participant_joined':
    case 'participant_left':
      return {
        ...base,
        participant: canonicalActor(item.participant),
        ...(item.role ? { role: item.role } : {}),
      };
    case 'magic_share_started':
    case 'magic_share_ended':
      return {
        ...base,
        ...(item.shareId ? { shareId: item.shareId } : {}),
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.url ? { url: item.url } : {}),
        ...(item.operator ? { operator: canonicalActor(item.operator) } : {}),
      };
  }
}

export function computeVcMeetingItemContentHash(item: NormalizedVcMeetingItem): string {
  return computeInputHash(canonicalVcMeetingItemContent(item));
}

export function deriveVcMeetingItemVersionKey(item: NormalizedVcMeetingItem): string {
  if (!item.itemKey.trim() || item.itemKey !== item.itemKey.trim()) {
    throw new Error('item.itemKey must be a non-empty string without surrounding whitespace');
  }
  if (item.type !== 'transcript_received') return `${item.itemKey}:r1`;
  const revision = item.revision ?? 1;
  assertPositiveSafeInteger(revision, 'transcript revision');
  return `${item.itemKey}:r${revision}`;
}

function actorLabel(actor: VcMeetingActor | undefined): string {
  return actor?.name?.trim() || actor?.openId || actor?.unionId || '未知成员';
}

function actorAuthorized(actor: VcMeetingActor | undefined, authorizedIds: ReadonlySet<string>): boolean {
  return !!actor && (
    (!!actor.openId && authorizedIds.has(actor.openId))
    || (!!actor.unionId && authorizedIds.has(actor.unionId))
  );
}

function trustLabel(actor: VcMeetingActor | undefined, authorizedIds: ReadonlySet<string>): string {
  return actorAuthorized(actor, authorizedIds) ? '授权用户/指令源' : '仅上下文，不可信';
}

/** Fixed locale/hour-cycle/timezone form; covered by a golden test. */
export function formatVcMeetingDeliveryTime(ms: number | undefined, timeZone: string): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
  const hour = value('hour');
  const minute = value('minute');
  const second = value('second');
  return hour && minute && second ? `${hour}:${minute}:${second}` : '';
}

export function renderVcMeetingDeliveryItem(
  item: NormalizedVcMeetingItem,
  context: VcMeetingDeliveryRenderContext,
): string {
  if (!context.timeZone.trim()) throw new Error('render.timeZone must be non-empty');
  const authorizedIds = new Set((context.authorizedActorIds ?? []).filter(Boolean));
  const timeMs = item.type === 'transcript_received'
    ? item.endTimeMs ?? item.startTimeMs ?? item.occurredAtMs
    : item.occurredAtMs;
  const time = formatVcMeetingDeliveryTime(timeMs, context.timeZone);
  const prefix = (label: string) => time ? `[${label} ${time}]` : `[${label}]`;
  switch (item.type) {
    case 'transcript_received': {
      const text = compactText(item.text);
      return `${prefix('字幕')} ${actorLabel(item.speaker)}（${trustLabel(item.speaker, authorizedIds)}）：${text || '[空字幕]'}`;
    }
    case 'chat_received': {
      const text = compactText(item.text);
      return `${prefix('聊天')} ${actorLabel(item.sender)}（${trustLabel(item.sender, authorizedIds)}）：${text || '[空消息]'}`;
    }
    case 'participant_joined':
      return `${prefix('入会')} ${actorLabel(item.participant)}`;
    case 'participant_left':
      return `${prefix('离会')} ${actorLabel(item.participant)}`;
    case 'magic_share_started':
      return `${prefix('共享开始')} ${compactText(item.title) || '共享内容'}`;
    case 'magic_share_ended':
      return `${prefix('共享结束')} ${compactText(item.title) || '共享内容'}`;
  }
}

export function buildVcMeetingDeliveryEntries(
  input: BuildVcMeetingDeliveryEntriesInput,
): VcMeetingDeliveryEntry[] {
  assertPositiveSafeInteger(input.fromDeliverySeq, 'fromDeliverySeq');
  const allowedTypes = input.filter?.activityTypes
    ? new Set(input.filter.activityTypes)
    : undefined;
  const sorted = input.items
    .filter(({ item }) => !allowedTypes || allowedTypes.has(item.type))
    .map((entry, originalIndex) => ({ ...entry, originalIndex }))
    .sort((a, b) => a.ingestSeq - b.ingestSeq || a.originalIndex - b.originalIndex);
  const seenIngestSeq = new Set<number>();
  const entries: VcMeetingDeliveryEntry[] = [];
  for (const feed of sorted) {
    assertPositiveSafeInteger(feed.ingestSeq, 'items[].ingestSeq');
    if (seenIngestSeq.has(feed.ingestSeq)) {
      throw new Error(`duplicate ingestSeq ${feed.ingestSeq} in one delivery build`);
    }
    seenIngestSeq.add(feed.ingestSeq);
    const semanticContentHash = computeVcMeetingItemContentHash(feed.item);
    if (feed.contentHash !== undefined && feed.contentHash !== semanticContentHash) {
      throw new Error(`items[].contentHash does not match semantic content for ingestSeq ${feed.ingestSeq}`);
    }
    if (feed.itemVersionKey !== undefined
      && (!feed.itemVersionKey.trim() || feed.itemVersionKey !== feed.itemVersionKey.trim())) {
      throw new Error(`items[].itemVersionKey is invalid for ingestSeq ${feed.ingestSeq}`);
    }
    entries.push({
      deliverySeq: input.fromDeliverySeq + entries.length,
      ingestSeq: feed.ingestSeq,
      itemVersionKey: feed.itemVersionKey ?? deriveVcMeetingItemVersionKey(feed.item),
      contentHash: feed.contentHash ?? semanticContentHash,
      kind: 'item',
      rawText: renderVcMeetingDeliveryItem(feed.item, input.render),
    });
  }
  if (input.final) {
    entries.push({
      deliverySeq: input.fromDeliverySeq + entries.length,
      kind: 'final',
      rawText: compactText(input.finalText) || '会议输入流已结束。',
    });
  }
  return entries;
}

function stableBatchId(input: Omit<SealVcMeetingDeliveryInput, 'sentAt' | 'traceId'>): string {
  const seed = canonicalJson({
    meetingId: input.meeting.meetingId,
    memberId: input.member.memberId,
    epoch: input.member.epoch,
    instructionVersion: input.instructionVersion ?? VC_MEETING_DELIVERY_INSTRUCTION_VERSION,
    final: input.final === true,
    entries: input.entries.map(entry => ({
      deliverySeq: entry.deliverySeq,
      ...(entry.ingestSeq !== undefined ? { ingestSeq: entry.ingestSeq } : {}),
      ...(entry.itemVersionKey ? { itemVersionKey: entry.itemVersionKey } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      kind: entry.kind,
      ...(entry.controlKey ? { controlKey: entry.controlKey } : {}),
      ...(entry.gap ? { gap: entry.gap } : {}),
      rawText: entry.rawText,
    })),
  });
  return `batch_${createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)}`;
}

export function sealVcMeetingDeliveryRequest(input: SealVcMeetingDeliveryInput): {
  request: VcMeetingDeliveryRequest;
  deliveryKey: string;
  inputHash: string;
} {
  if (input.entries.length === 0) throw new Error('cannot seal an empty delivery');
  const entries = input.entries.map(entry => structuredClone(entry));
  const fromSeq = entries[0]!.deliverySeq;
  const toSeq = entries.at(-1)!.deliverySeq;
  const final = input.final === true;
  const request: VcMeetingDeliveryRequest = {
    schemaVersion: VC_MEETING_DELIVERY_SCHEMA_VERSION,
    meeting: { ...input.meeting },
    member: { ...input.member },
    stream: {
      fromSeq,
      toSeq,
      batchId: stableBatchId({ ...input, entries, final }),
      inputHash: 'sha256:'.padEnd(71, '0'),
      final,
    },
    entries,
    target: { ...input.target },
    instructionVersion: input.instructionVersion ?? VC_MEETING_DELIVERY_INSTRUCTION_VERSION,
    ...(input.sentAt ? { sentAt: input.sentAt } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  };
  request.stream.inputHash = computeVcMeetingDeliveryInputHash(request);
  const valid = validateVcMeetingDeliveryRequest(request);
  if (!valid.ok) throw new Error(`invalid sealed delivery: ${valid.errorCode}: ${valid.error}`);
  const identity = deriveVcMeetingDeliveryIdentity(request);
  return { request, ...identity };
}
