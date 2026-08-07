/**
 * Shared collection + short-TTL cache for the /adopt V2 picker.
 *
 * The picker card is re-rendered on every search / page click, and Lark cards
 * are stateless server-side — so each click would otherwise re-run discovery.
 * Live discovery shells out to tmux (`tmux list-panes` + per-pane process-tree
 * walks) and scans the on-disk resume store, which is wasteful to repeat just
 * to flip a page. We snapshot candidates at first render, keyed by the card's
 * root message id, and serve search / page re-renders from that snapshot.
 *
 * Confirmation does NOT use the cache: a live pane may have exited between
 * render and click, so the card-handler re-discovers and re-validates the
 * chosen target before committing (mirrors the legacy adopt_select path).
 */
import type { DaemonSession } from '../core/types.js';
import type { AdoptableSession } from '../core/session-discovery.js';
import type { ZellijAdoptableSession } from '../core/zellij-adopt-discovery.js';
import type { ResumableSession } from '../adapters/cli/types.js';
import {
  discoverAdoptableSessions,
  excludeOwnedHerdrAdoptTargets,
} from '../core/session-discovery.js';
import { discoverAdoptableZellijSessions } from '../core/zellij-adopt-discovery.js';

export interface AdoptCandidates {
  sessions: Array<AdoptableSession | ZellijAdoptableSession>;
  resumable: ResumableSession[];
  /** The resume cap applied, so the card can show a truncation hint. */
  resumeLimit: number;
}

/**
 * Discover adopt candidates for a bot: live panes (only this bot's CLI) plus
 * disk-resumable sessions. `discoverResumable` is injected to avoid a static
 * import cycle with command-handler (which owns the resume-discovery + limit).
 */
export async function collectAdoptCandidates(
  botCliId: string | undefined,
  cliPathOverride: string | undefined,
  activeSessions: Map<string, DaemonSession>,
  discoverResumable: (
    cliId: any,
    cliPathOverride: string | undefined,
    activeSessions: Map<string, DaemonSession>,
    limit?: number,
  ) => Promise<ResumableSession[]>,
  resumeLimit: number,
  /** Exact live-process identity asserted only by a structured cliRuntime.
   *  Kept separate from cliPathOverride because legacy paths may be wrappers. */
  runtimeExecutable?: string,
): Promise<AdoptCandidates> {
  // Only offer live panes for THIS bot's configured CLI (adopting another
  // CLI's pane would silently change the agent behind the bot).
  const ownedHerdrTargets = [...activeSessions.values()].flatMap((active) => {
    const target = active.session.persistentBackendTarget;
    return active.session.status === 'active'
      && !active.adoptedFrom
      && target?.backendType === 'herdr'
      && !!target.agentName
      ? [{ sessionName: target.sessionName, agentName: target.agentName }]
      : [];
  });
  // Only a structured cliRuntime asserts exact process identity. A legacy
  // cliPathOverride may be a wrapper/router whose child is still stock Codex;
  // preserving the one-argument path keeps those existing bots discoverable.
  const tmuxAndHerdr = runtimeExecutable
    ? discoverAdoptableSessions(botCliId as any, runtimeExecutable)
    : discoverAdoptableSessions(botCliId as any);
  const zellij = runtimeExecutable
    ? discoverAdoptableZellijSessions(botCliId as any, runtimeExecutable)
    : discoverAdoptableZellijSessions(botCliId as any);
  const sessions: Array<AdoptableSession | ZellijAdoptableSession> = [
    ...excludeOwnedHerdrAdoptTargets(
      tmuxAndHerdr,
      ownedHerdrTargets,
    ),
    ...zellij,
  ];
  // Resume needs the bot's own CLI binary, so only offer it when known.
  const resumable = botCliId
    ? await discoverResumable(botCliId, cliPathOverride, activeSessions, resumeLimit)
    : [];
  return { sessions, resumable, resumeLimit };
}

// ─── Snapshot cache (keyed by card root message id) ─────────────────────────

interface CacheEntry {
  at: number;
  candidates: AdoptCandidates;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — long enough for a browse session
const cache = new Map<string, CacheEntry>();

/** Store the candidates snapshot for a rendered picker card. */
export function cacheAdoptCandidates(rootId: string, candidates: AdoptCandidates, nowMs: number): void {
  cache.set(rootId, { at: nowMs, candidates });
  // Opportunistic sweep of stale entries so the map doesn't grow unbounded
  // across many /adopt invocations.
  for (const [k, v] of cache) {
    if (nowMs - v.at > CACHE_TTL_MS) cache.delete(k);
  }
}

/** Read a cached snapshot for search / page re-renders. Returns undefined when
 *  absent or expired — caller re-discovers in that case. */
export function getCachedAdoptCandidates(rootId: string, nowMs: number): AdoptCandidates | undefined {
  const hit = cache.get(rootId);
  if (!hit) return undefined;
  if (nowMs - hit.at > CACHE_TTL_MS) {
    cache.delete(rootId);
    return undefined;
  }
  return hit.candidates;
}

/** Drop a card's snapshot (call on confirm / detach so it doesn't linger). */
export function clearAdoptCandidates(rootId: string): void {
  cache.delete(rootId);
}
