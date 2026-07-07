export type VcMeetingSource = 'polling' | 'push';

export type VcMeetingActivityType =
  | 'participant_joined'
  | 'participant_left'
  | 'chat_received'
  | 'transcript_received'
  | 'magic_share_started'
  | 'magic_share_ended';

export interface VcMeetingRef {
  id: string;
  meetingNo?: string;
  topic?: string;
  startTimeMs?: number;
  hostOpenId?: string;
  hostName?: string;
}

export interface VcMeetingActor {
  openId?: string;
  name?: string;
  userType?: number;
}

interface NormalizedVcMeetingItemBase {
  source: VcMeetingSource;
  type: VcMeetingActivityType;
  meetingId: string;
  eventId?: string;
  itemKey: string;
  occurredAtMs?: number;
}

export interface NormalizedVcParticipantItem extends NormalizedVcMeetingItemBase {
  type: 'participant_joined' | 'participant_left';
  participant: VcMeetingActor;
  role?: string;
}

export interface NormalizedVcChatItem extends NormalizedVcMeetingItemBase {
  type: 'chat_received';
  messageId?: string;
  sender: VcMeetingActor;
  messageType?: string;
  text?: string;
}

export interface NormalizedVcTranscriptItem extends NormalizedVcMeetingItemBase {
  type: 'transcript_received';
  sentenceId: string;
  speaker: VcMeetingActor;
  startTimeMs?: number;
  endTimeMs?: number;
  language?: string;
  text: string;
  revision?: number;
  isFinal?: boolean;
}

export interface NormalizedVcMagicShareItem extends NormalizedVcMeetingItemBase {
  type: 'magic_share_started' | 'magic_share_ended';
  shareId?: string;
  title?: string;
  url?: string;
  operator?: VcMeetingActor;
}

export type NormalizedVcMeetingItem =
  | NormalizedVcParticipantItem
  | NormalizedVcChatItem
  | NormalizedVcTranscriptItem
  | NormalizedVcMagicShareItem;

export interface NormalizedVcMeetingBatch {
  source: VcMeetingSource;
  meeting: VcMeetingRef;
  items: NormalizedVcMeetingItem[];
  pageToken?: string;
  hasMore?: boolean;
}

export interface VcTranscriptStateEntry {
  sentenceId: string;
  text: string;
  revision: number;
  externalRevision?: number;
  speaker: VcMeetingActor;
  startTimeMs?: number;
  endTimeMs?: number;
  language?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  firstSeenPollOrdinal: number;
  lastSeenPollOrdinal: number;
  lastChangedPollOrdinal: number;
  final: boolean;
  stable: boolean;
  flushedRevision?: number;
}

export interface VcMeetingSessionState {
  meeting: VcMeetingRef;
  attentionTargetOpenId?: string;
  notificationChatId?: string;
  ingestion: {
    source: VcMeetingSource;
    pageToken?: string;
    lastSeenEventTime?: number;
    lastPollAt?: string;
    emptyPollCount: number;
    pollOrdinal: number;
  };
  dedup: {
    recentEventIds: string[];
    seenItemIds: string[];
    transcriptBySentenceId: Record<string, VcTranscriptStateEntry>;
  };
}

export interface VcMeetingIngestResult {
  acceptedItems: NormalizedVcMeetingItem[];
  droppedDuplicateItems: NormalizedVcMeetingItem[];
  changedTranscripts: VcTranscriptStateEntry[];
}

/**
 * Structured meeting-state window used by polling debug output and future
 * listener-group / agent-consumer emitters. This is not a workflow trigger
 * envelope; P2 may wrap it for a workflow consumer explicitly if needed.
 */
export interface VcMeetingStatePayload {
  format: 'botmux.vc-meeting.v1';
  source: 'lark-cli:vc:+meeting-events' | 'lark:vc.bot.meeting_activity_v1';
  meeting: VcMeetingRef;
  session: {
    attentionTargetOpenId?: string;
    notificationChatId?: string;
  };
  poll: {
    ordinal: number;
    pageToken?: string;
    hasMore?: boolean;
    lastPollAt?: string;
    emptyPollCount: number;
  };
  items: NormalizedVcMeetingItem[];
  state: {
    transcriptCount: number;
    stableTranscriptCount: number;
    seenItemCount: number;
  };
}

export type VcMeetingPushEventKind =
  | 'meeting_invited'
  | 'meeting_activity'
  | 'meeting_ended'
  | 'participant_meeting_joined';

export interface VcMeetingPushContext {
  larkAppId: string;
  kind: VcMeetingPushEventKind;
  eventType: string;
  eventId?: string;
  meeting: VcMeetingRef;
  occurredAtMs?: number;
  raw: unknown;
}
