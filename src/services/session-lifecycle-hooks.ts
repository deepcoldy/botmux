import type { StreamStatus } from '../types.js';
import type { DaemonSession } from '../core/types.js';
import { sessionAnchorId } from '../core/types.js';
import { emitHookEvent, type HookEvent } from './hook-runner.js';
import { logger } from '../utils/logger.js';

type SessionLifecycleEvent = Extract<
  HookEvent,
  'session.start' | 'session.exit' | 'session.idle' | 'session.requires_attention'
>;

const IDLE_DEDUP_WINDOW_MS = 10_000;

let shutdownInProgress = false;
const lastIdleEmits = new Map<string, number>();

export function setSessionLifecycleShutdown(value: boolean): void {
  shutdownInProgress = value;
}

function lifecyclePayload(ds: DaemonSession, body: Record<string, unknown>): Record<string, unknown> {
  const initCliId = ds.initConfig && 'cliId' in ds.initConfig ? ds.initConfig.cliId : undefined;
  return {
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    chatType: ds.chatType,
    larkAppId: ds.larkAppId,
    scope: ds.scope,
    anchor: sessionAnchorId(ds),
    title: ds.currentTurnTitle ?? ds.session.title,
    cliId: ds.session.cliId ?? initCliId,
    workingDir: ds.workingDir ?? ds.session.workingDir,
    hasHistory: ds.hasHistory,
    spawnedAt: ds.spawnedAt,
    lastMessageAt: ds.lastMessageAt,
    ...body,
  };
}

export function emitSessionLifecycleHook(
  ds: DaemonSession,
  event: SessionLifecycleEvent,
  body: Record<string, unknown> = {},
): boolean {
  if (event === 'session.exit') {
    // Prune dedup state to prevent unbounded Map growth
    const prefix = `:${ds.session.sessionId}:`;
    for (const key of lastIdleEmits.keys()) {
      if (key.includes(prefix)) lastIdleEmits.delete(key);
    }
    if (shutdownInProgress) {
      logger.debug(`[hooks] session.exit suppressed during daemon shutdown (session ${ds.session.sessionId})`);
      return false;
    }
  }

  emitHookEvent(event, lifecyclePayload(ds, body));
  return true;
}

export function emitSessionStateTransitionHook(
  ds: DaemonSession,
  prevState: StreamStatus | undefined,
  newState: StreamStatus | undefined,
  body: Record<string, unknown> = {},
): boolean {
  if (!newState || prevState === newState) return false;
  if (prevState !== 'idle' && newState !== 'idle') return false;

  const now = Date.now();
  const key = `session.idle:${ds.session.sessionId}:${newState}`;
  const last = lastIdleEmits.get(key);
  if (last !== undefined && now - last < IDLE_DEDUP_WINDOW_MS) return false;
  lastIdleEmits.set(key, now);

  return emitSessionLifecycleHook(ds, 'session.idle', {
    prevState,
    newState,
    transition: newState === 'idle' ? 'enter' : 'exit',
    ...body,
  });
}

export function __testOnly_resetSessionLifecycleHooks(): void {
  shutdownInProgress = false;
  lastIdleEmits.clear();
}
