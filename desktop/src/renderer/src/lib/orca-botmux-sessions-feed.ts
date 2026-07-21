/**
 * Lightweight pub/sub so WorktreeCard badges and OrcaBotmuxSessionsTree share
 * the latest polled orca_botmux sessions without a full Zustand slice.
 */
import type { OrcaBotmuxSessionLeaf } from '@/lib/orca-botmux-session-tree'
import type { BotmuxEndpointLike } from '@/lib/orca-botmux-session-tree'

export type OrcaBotmuxSessionsFeedSnapshot = {
  sessions: OrcaBotmuxSessionLeaf[]
  endpoints: BotmuxEndpointLike[]
  updatedAt: number
}

let snapshot: OrcaBotmuxSessionsFeedSnapshot = {
  sessions: [],
  endpoints: [],
  updatedAt: 0
}

const listeners = new Set<() => void>()

export function publishOrcaBotmuxSessionsFeed(
  sessions: OrcaBotmuxSessionLeaf[],
  endpoints: BotmuxEndpointLike[]
): void {
  snapshot = {
    sessions,
    endpoints,
    updatedAt: Date.now()
  }
  for (const l of listeners) l()
}

export function getOrcaBotmuxSessionsFeedSnapshot(): OrcaBotmuxSessionsFeedSnapshot {
  return snapshot
}

export function subscribeOrcaBotmuxSessionsFeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
