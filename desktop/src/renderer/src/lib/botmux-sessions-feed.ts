/**
 * Lightweight pub/sub so WorktreeCard badges and BotmuxSessionsTree share
 * the latest polled botmux sessions without a full Zustand slice.
 */
import type { BotmuxSessionLeaf } from '@/lib/botmux-session-tree'
import type { BotmuxEndpointLike } from '@/lib/botmux-session-tree'

export type BotmuxSessionsFeedSnapshot = {
  sessions: BotmuxSessionLeaf[]
  endpoints: BotmuxEndpointLike[]
  updatedAt: number
}

let snapshot: BotmuxSessionsFeedSnapshot = {
  sessions: [],
  endpoints: [],
  updatedAt: 0
}

const listeners = new Set<() => void>()

export function publishBotmuxSessionsFeed(
  sessions: BotmuxSessionLeaf[],
  endpoints: BotmuxEndpointLike[]
): void {
  snapshot = {
    sessions,
    endpoints,
    updatedAt: Date.now()
  }
  for (const l of listeners) l()
}

export function getBotmuxSessionsFeedSnapshot(): BotmuxSessionsFeedSnapshot {
  return snapshot
}

export function subscribeBotmuxSessionsFeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
