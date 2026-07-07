import type {
  NormalizedVcMeetingItem,
  NormalizedVcTranscriptItem,
  VcMeetingIngestResult,
  VcMeetingRef,
  VcMeetingSource,
  VcMeetingSessionState,
  VcMeetingStatePayload,
  VcTranscriptStateEntry,
} from './types.js';

const DEFAULT_RECENT_LIMIT = 50_000;

export function createVcMeetingSessionState(input: {
  meeting: VcMeetingRef;
  source?: VcMeetingSource;
  attentionTargetOpenId?: string;
  notificationChatId?: string;
}): VcMeetingSessionState {
  return {
    meeting: input.meeting,
    ...(input.attentionTargetOpenId ? { attentionTargetOpenId: input.attentionTargetOpenId } : {}),
    ...(input.notificationChatId ? { notificationChatId: input.notificationChatId } : {}),
    ingestion: {
      source: input.source ?? 'polling',
      emptyPollCount: 0,
      pollOrdinal: 0,
    },
    dedup: {
      recentEventIds: [],
      seenItemIds: [],
      transcriptBySentenceId: {},
    },
  };
}

export function beginVcIngestionPass(state: VcMeetingSessionState, now: Date = new Date()): void {
  state.ingestion.pollOrdinal += 1;
  state.ingestion.lastPollAt = now.toISOString();
}

export const beginVcPollingPass = beginVcIngestionPass;

function remember(values: string[], value: string | undefined, limit: number): void {
  if (!value || values.includes(value)) return;
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

export function applyDropOnSeenMeetingItem(
  state: VcMeetingSessionState,
  item: Exclude<NormalizedVcMeetingItem, NormalizedVcTranscriptItem>,
  opts: { recentLimit?: number } = {},
): { accepted: boolean } {
  const limit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
  if (state.dedup.seenItemIds.includes(item.itemKey)) return { accepted: false };
  remember(state.dedup.seenItemIds, item.itemKey, limit);
  remember(state.dedup.recentEventIds, item.eventId, limit);
  if (item.occurredAtMs !== undefined) {
    state.ingestion.lastSeenEventTime = Math.max(state.ingestion.lastSeenEventTime ?? 0, item.occurredAtMs);
  }
  return { accepted: true };
}

export function upsertTranscriptMeetingItem(
  state: VcMeetingSessionState,
  item: NormalizedVcTranscriptItem,
  opts: { now?: Date; recentLimit?: number } = {},
): { changed: boolean; entry: VcTranscriptStateEntry } {
  const nowIso = (opts.now ?? new Date()).toISOString();
  const prior = state.dedup.transcriptBySentenceId[item.sentenceId];
  const textChanged = !prior || prior.text !== item.text;
  const finalChanged = item.isFinal === true && prior?.final !== true;
  const changed = textChanged || finalChanged;
  const revision = prior ? prior.revision + (changed ? 1 : 0) : 1;
  const entry: VcTranscriptStateEntry = {
    sentenceId: item.sentenceId,
    text: changed ? item.text : prior.text,
    revision,
    ...(item.revision !== undefined || prior?.externalRevision !== undefined ? { externalRevision: item.revision ?? prior?.externalRevision } : {}),
    speaker: item.speaker.openId || item.speaker.name ? item.speaker : (prior?.speaker ?? item.speaker),
    ...(item.startTimeMs !== undefined || prior?.startTimeMs !== undefined ? { startTimeMs: item.startTimeMs ?? prior?.startTimeMs } : {}),
    ...(item.endTimeMs !== undefined || prior?.endTimeMs !== undefined ? { endTimeMs: item.endTimeMs ?? prior?.endTimeMs } : {}),
    ...(item.language || prior?.language ? { language: item.language ?? prior?.language } : {}),
    firstSeenAt: prior?.firstSeenAt ?? nowIso,
    lastSeenAt: nowIso,
    lastChangedAt: changed ? nowIso : prior.lastChangedAt,
    firstSeenPollOrdinal: prior?.firstSeenPollOrdinal ?? state.ingestion.pollOrdinal,
    lastSeenPollOrdinal: state.ingestion.pollOrdinal,
    lastChangedPollOrdinal: changed ? state.ingestion.pollOrdinal : prior.lastChangedPollOrdinal,
    final: item.isFinal === true || prior?.final === true,
    stable: item.isFinal === true || (prior?.stable === true && !changed),
    ...(prior?.flushedRevision !== undefined ? { flushedRevision: prior.flushedRevision } : {}),
  };
  state.dedup.transcriptBySentenceId[item.sentenceId] = entry;
  remember(state.dedup.seenItemIds, item.itemKey, opts.recentLimit ?? DEFAULT_RECENT_LIMIT);
  remember(state.dedup.recentEventIds, item.eventId, opts.recentLimit ?? DEFAULT_RECENT_LIMIT);
  if (item.occurredAtMs !== undefined) {
    state.ingestion.lastSeenEventTime = Math.max(state.ingestion.lastSeenEventTime ?? 0, item.occurredAtMs);
  }
  return { changed, entry };
}

export function ingestNormalizedVcMeetingItems(
  state: VcMeetingSessionState,
  items: NormalizedVcMeetingItem[],
  opts: { now?: Date; recentLimit?: number } = {},
): VcMeetingIngestResult {
  const acceptedItems: NormalizedVcMeetingItem[] = [];
  const droppedDuplicateItems: NormalizedVcMeetingItem[] = [];
  const changedTranscripts: VcTranscriptStateEntry[] = [];

  for (const item of items) {
    if (item.type === 'transcript_received') {
      const result = upsertTranscriptMeetingItem(state, item, opts);
      if (result.changed) changedTranscripts.push(result.entry);
      continue;
    }
    const result = applyDropOnSeenMeetingItem(state, item, opts);
    if (result.accepted) acceptedItems.push(item);
    else droppedDuplicateItems.push(item);
  }

  const anyChange = acceptedItems.length > 0 || changedTranscripts.length > 0;
  state.ingestion.emptyPollCount = anyChange ? 0 : state.ingestion.emptyPollCount + 1;

  return { acceptedItems, droppedDuplicateItems, changedTranscripts };
}

export function collectStableTranscriptItems(
  state: VcMeetingSessionState,
  opts: { stabilizePollWindows?: number; stabilizeMs?: number; now?: Date; markFlushed?: boolean } = {},
): NormalizedVcTranscriptItem[] {
  const windows = opts.stabilizePollWindows ?? 1;
  const nowMs = (opts.now ?? new Date()).getTime();
  const ready: NormalizedVcTranscriptItem[] = [];
  for (const entry of Object.values(state.dedup.transcriptBySentenceId)) {
    const lastChangedMs = Date.parse(entry.lastChangedAt);
    const stableByTime = opts.stabilizeMs !== undefined
      && Number.isFinite(lastChangedMs)
      && nowMs - lastChangedMs >= opts.stabilizeMs;
    const stableByWindow = state.ingestion.pollOrdinal - entry.lastChangedPollOrdinal >= windows;
    const stable = entry.final || stableByTime || (opts.stabilizeMs === undefined && stableByWindow);
    entry.stable = stable;
    if (!stable || entry.flushedRevision === entry.revision) continue;
    if (opts.markFlushed !== false) entry.flushedRevision = entry.revision;
    ready.push({
      source: state.ingestion.source,
      type: 'transcript_received',
      meetingId: state.meeting.id,
      itemKey: `transcript:${entry.sentenceId}`,
      sentenceId: entry.sentenceId,
      speaker: entry.speaker,
      ...(entry.startTimeMs !== undefined ? { startTimeMs: entry.startTimeMs } : {}),
      ...(entry.endTimeMs !== undefined ? { endTimeMs: entry.endTimeMs } : {}),
      ...(entry.language ? { language: entry.language } : {}),
      text: entry.text,
      revision: entry.revision,
      isFinal: entry.final,
    });
  }
  return ready;
}

export function markVcTranscriptItemsFlushed(
  state: VcMeetingSessionState,
  items: NormalizedVcTranscriptItem[],
): void {
  for (const item of items) {
    const entry = state.dedup.transcriptBySentenceId[item.sentenceId];
    if (!entry) continue;
    if (item.revision !== undefined && item.revision === entry.revision) {
      entry.flushedRevision = entry.revision;
    }
  }
}

export function buildVcMeetingStatePayload(
  state: VcMeetingSessionState,
  items: NormalizedVcMeetingItem[],
  page: { pageToken?: string; hasMore?: boolean } = {},
): VcMeetingStatePayload {
  const transcripts = Object.values(state.dedup.transcriptBySentenceId);
  return {
    format: 'botmux.vc-meeting.v1',
    source: state.ingestion.source === 'push' ? 'lark:vc.bot.meeting_activity_v1' : 'lark-cli:vc:+meeting-events',
    meeting: state.meeting,
    session: {
      ...(state.attentionTargetOpenId ? { attentionTargetOpenId: state.attentionTargetOpenId } : {}),
      ...(state.notificationChatId ? { notificationChatId: state.notificationChatId } : {}),
    },
    poll: {
      ordinal: state.ingestion.pollOrdinal,
      ...(page.pageToken ?? state.ingestion.pageToken ? { pageToken: page.pageToken ?? state.ingestion.pageToken } : {}),
      ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
      ...(state.ingestion.lastPollAt ? { lastPollAt: state.ingestion.lastPollAt } : {}),
      emptyPollCount: state.ingestion.emptyPollCount,
    },
    items,
    state: {
      transcriptCount: transcripts.length,
      stableTranscriptCount: transcripts.filter((t) => t.stable).length,
      seenItemCount: state.dedup.seenItemIds.length,
    },
  };
}
