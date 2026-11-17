import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeSendMarker } from './bridge-fallback-gate.js';

export type CrossChatFollowThreadMode = 'at' | 'off';

export interface CrossChatFollowedThreadOrigin {
  sourceChatId: string;
  followedChatId: string;
  followedRootMessageId: string;
}

export interface CrossChatFollowedThreadMatch extends CrossChatFollowedThreadOrigin {
  sourceSessionId: string;
  scope: 'chat' | 'thread';
  anchor: string;
  runtimeRoutingAnchor?: string;
}

export interface CrossChatCandidateSession {
  sessionId: string;
  larkAppId?: string;
  chatId: string;
  scope?: 'thread' | 'chat';
  rootMessageId: string;
  runtimeRoutingAnchor?: string;
  status: 'active' | 'closed';
  queued?: boolean;
  messageListenerRun?: unknown;
  deferredScheduleRun?: { routingAnchor?: string };
}

const MESSAGE_ID_RE = /^om_[A-Za-z0-9_-]{1,128}$/;

interface CachedTurnSends {
  mtimeMs: number;
  size: number;
  markers: BridgeSendMarker[];
}

const turnSendsCache = new Map<string, CachedTurnSends>();
const MAX_CACHE_ENTRIES = 512;

function readSessionTurnSendMarkers(dataDir: string, sessionId: string): readonly BridgeSendMarker[] {
  const filePath = join(dataDir, 'turn-sends', `${sessionId}.jsonl`);
  let stat: ReturnType<typeof statSync>;
  try {
    if (!existsSync(filePath)) {
      turnSendsCache.delete(filePath);
      return [];
    }
    stat = statSync(filePath);
  } catch {
    turnSendsCache.delete(filePath);
    return [];
  }

  const cached = turnSendsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.markers;
  }

  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const markers: BridgeSendMarker[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as BridgeSendMarker;
      if (parsed && typeof parsed === 'object') {
        markers.push(parsed);
      }
    } catch {
      // Ignore malformed/partial lines.
    }
  }

  if (turnSendsCache.size >= MAX_CACHE_ENTRIES && !turnSendsCache.has(filePath)) {
    const oldestKey = turnSendsCache.keys().next().value;
    if (oldestKey) turnSendsCache.delete(oldestKey);
  }
  turnSendsCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    markers,
  });
  return markers;
}

/**
 * Resolve whether an inbound message in `chatId` (under `candidateRootIds`, e.g.
 * `[message.root_id, message.parent_id]`) is replying to a cross-chat message
 * sent by an active session of `larkAppId` in ANOTHER chat.
 *
 * Precedence:
 *  1. An active thread-scope session in `chatId` itself anchored at one of
 *     `candidateRootIds` always wins (returns `null`).
 *  2. Among active non-listener sessions in other chats (`s.chatId !== chatId`),
 *     scan their durable `turn-sends/<sessionId>.jsonl` markers for a cross-chat
 *     `detoured_send` targeting `chatId` whose `messageId` or
 *     `targetRootMessageId` matches a candidate root id.
 *  3. If the latest matching marker for that `(session, canonicalRootId)` did
 *     not opt out (`crossChatFollowThread !== 'off'`), select the match with the
 *     newest `sentAtMs`.
 */
export function resolveCrossChatFollowedThread(input: {
  dataDir: string;
  larkAppId: string;
  chatId: string;
  candidateRootIds: ReadonlyArray<string | undefined | null>;
  sessions: Iterable<CrossChatCandidateSession>;
}): CrossChatFollowedThreadMatch | null {
  const { dataDir, larkAppId, chatId } = input;
  if (!dataDir || !larkAppId || !chatId) return null;

  const validRoots: string[] = [];
  for (const raw of input.candidateRootIds) {
    if (typeof raw === 'string' && MESSAGE_ID_RE.test(raw) && !validRoots.includes(raw)) {
      validRoots.push(raw);
    }
  }
  if (validRoots.length === 0) return null;

  const sessionById = new Map<string, CrossChatCandidateSession>();
  for (const s of input.sessions) {
    if (!s?.sessionId) continue;
    // Prefer the first-seen entry (caller passes live activeSessions before disk rows).
    if (!sessionById.has(s.sessionId)) {
      sessionById.set(s.sessionId, s);
    }
  }

  const rootSet = new Set(validRoots);
  for (const s of sessionById.values()) {
    if (
      s.status === 'active'
      && s.larkAppId === larkAppId
      && s.scope !== 'chat'
      && s.chatId === chatId
      && rootSet.has(s.rootMessageId)
    ) {
      return null;
    }
  }

  let best: {
    session: CrossChatCandidateSession;
    canonicalRootId: string;
    sentAtMs: number;
  } | null = null;

  for (const s of sessionById.values()) {
    if (
      s.status !== 'active'
      || s.queued === true
      || s.larkAppId !== larkAppId
      || !s.chatId
      || s.chatId === chatId
      || s.messageListenerRun !== undefined
    ) {
      continue;
    }

    const markers = readSessionTurnSendMarkers(dataDir, s.sessionId);
    if (markers.length === 0) continue;

    // Group by canonical thread root in the target chat so a later --no-follow-thread
    // on the same root can override an earlier marker for that session.
    const latestByCanonicalRoot = new Map<string, BridgeSendMarker>();
    for (const marker of markers) {
      if (marker.deliveryKind !== 'detoured_send' || marker.targetChatId !== chatId) continue;
      const matched = (marker.messageId && rootSet.has(marker.messageId))
        || (marker.targetRootMessageId && rootSet.has(marker.targetRootMessageId));
      if (!matched) continue;
      const canonicalRoot = (marker.targetRootMessageId && MESSAGE_ID_RE.test(marker.targetRootMessageId))
        ? marker.targetRootMessageId
        : (marker.messageId && MESSAGE_ID_RE.test(marker.messageId))
          ? marker.messageId
          : validRoots[0];
      const prev = latestByCanonicalRoot.get(canonicalRoot);
      const sentAtMs = Number.isFinite(marker.sentAtMs) ? marker.sentAtMs : 0;
      const prevMs = prev && Number.isFinite(prev.sentAtMs) ? prev.sentAtMs : -1;
      if (!prev || sentAtMs >= prevMs) {
        latestByCanonicalRoot.set(canonicalRoot, marker);
      }
    }

    for (const [canonicalRootId, marker] of latestByCanonicalRoot) {
      if (marker.crossChatFollowThread === 'off') continue;
      const sentAtMs = Number.isFinite(marker.sentAtMs) ? marker.sentAtMs : 0;
      if (!best || sentAtMs > best.sentAtMs) {
        best = { session: s, canonicalRootId, sentAtMs };
      }
    }
  }

  if (!best) return null;

  const isChat = best.session.scope === 'chat';
  const runtimeRoutingAnchor = best.session.runtimeRoutingAnchor
    ?? best.session.deferredScheduleRun?.routingAnchor;

  return {
    sourceSessionId: best.session.sessionId,
    sourceChatId: best.session.chatId,
    scope: isChat ? 'chat' : 'thread',
    anchor: isChat ? best.session.chatId : best.session.rootMessageId,
    ...(runtimeRoutingAnchor ? { runtimeRoutingAnchor } : {}),
    followedChatId: chatId,
    followedRootMessageId: best.canonicalRootId,
  };
}

export function __clearCrossChatTurnSendsCacheForTest(): void {
  turnSendsCache.clear();
}
