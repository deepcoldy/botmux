/**
 * Daemon side of the Claude Code prompt-cache keep-alive (policy and decision
 * rules live in services/prompt-cache-policy.ts).
 *
 * The daemon's 60s idle sweep asks, per live session, whether a keep-alive is
 * due; if so it sends the worker a `prompt_cache_keepalive` with the one-line
 * prompt. The worker types it into the idle CLI with no botmux turn identity
 * (so no reply card, reaction or final delivery is attributed to it) and acks.
 *
 * The keep-alive's own working→idle edge must not look like user activity: it
 * would restart the per-bot idle-suspend clock and reset the ping budget. So the
 * screen-status hook below recognises an in-flight keep-alive and restores the
 * idle stretch's original `idleSinceAt`; any other busy edge ends the stretch.
 */
import type { DaemonSession } from './types.js';
import type { BotConfig } from '../bot-registry.js';
import { readGlobalConfig } from '../global-config.js';
import { readStatuslineSnapshot } from '../services/statusline-snapshot.js';
import {
  KEEPALIVE_IN_FLIGHT_STALE_MS,
  buildPromptCacheKeepalivePrompt,
  decidePromptCacheKeepalive,
  resolvePromptCachePolicy,
  type PromptCacheTtl,
  type ResolvedPromptCachePolicy,
} from '../services/prompt-cache-policy.js';

/** Backends whose CLI runs in a local pane the worker can type into AND whose
 *  viewport the worker treats as authoritative (zmx can carry stale scrollback,
 *  so the keep-alive write gate could not trust it). */
const LOCAL_BACKENDS = new Set(['pty', 'tmux', 'herdr', 'zellij']);

export function botPromptCachePolicy(bot: Pick<BotConfig, 'promptCache'>): ResolvedPromptCachePolicy {
  return resolvePromptCachePolicy(readGlobalConfig().promptCache, bot.promptCache);
}

export function resolvedPromptCacheTtl(bot: Pick<BotConfig, 'promptCache'>): PromptCacheTtl | undefined {
  return botPromptCachePolicy(bot).ttl;
}

/** Why a session can never take a keep-alive right now; undefined = eligible. */
export function promptCacheKeepaliveIneligibility(ds: DaemonSession): string | undefined {
  const init = ds.initConfig;
  if (!ds.worker || ds.worker.killed || !ds.workerReady) return 'no_worker';
  if (!init || init.cliId !== 'claude-code') return 'not_claude_code';
  if (init.adoptMode) return 'adopted';
  // Zero-prompt sessions carry no botmux system prompt, so the model has no
  // reason to honour BOTMUX_NOTHING_TO_SEND, and their local-turn finals are
  // forwarded to the chat: a keep-alive could post into the topic.
  if (init.promptInjection === 'none') return 'zero_prompt';
  if (!LOCAL_BACKENDS.has(init.backendType)) return 'remote_backend';
  if (ds.lastScreenStatus !== 'idle') return 'not_idle';
  // Background tasks report back into the conversation on their own; a
  // keep-alive turn would only interleave with them.
  if (ds.backgroundTaskCount) return 'background_tasks';
  return undefined;
}

function contextTokens(dataDir: string, sessionId: string, now: number): number | undefined {
  const snap = readStatuslineSnapshot(dataDir, sessionId, { now });
  if (snap?.contextPercent === undefined || snap.contextWindowTokens === undefined) return undefined;
  return Math.round(snap.contextPercent * snap.contextWindowTokens / 100);
}

export interface PromptCacheKeepaliveSweepOptions {
  bot: Pick<BotConfig, 'promptCache'>;
  dataDir: string;
  /** Deliver the IPC; false when the worker is gone / mid-transfer. */
  send(ds: DaemonSession, text: string): boolean;
  log(message: string): void;
  now?: Date;
}

/** One sweep over a bot's sessions. Returns how many keep-alives were sent. */
export function runPromptCacheKeepaliveSweep(
  sessions: Iterable<DaemonSession>,
  opts: PromptCacheKeepaliveSweepOptions,
): number {
  const policy = botPromptCachePolicy(opts.bot);
  if (!policy.keepalive.enabled) return 0;
  const date = opts.now ?? new Date();
  const now = date.getTime();
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  let sent = 0;
  for (const ds of sessions) {
    if (promptCacheKeepaliveIneligibility(ds)) continue;
    const sessionId = ds.session.sessionId;
    const verdict = decidePromptCacheKeepalive(policy, {
      now,
      minuteOfDay,
      idleSinceAt: ds.idleSinceAt,
      state: ds.promptCacheKeepalive,
      contextTokens: contextTokens(opts.dataDir, sessionId, now),
    });
    if (!verdict.due) continue;
    const text = buildPromptCacheKeepalivePrompt(ds.initConfig?.locale);
    if (!opts.send(ds, text)) continue;
    const state = ds.promptCacheKeepalive ?? { pings: 0, idleSinceAt: ds.idleSinceAt! };
    ds.promptCacheKeepalive = { ...state, inFlightSince: now };
    sent += 1;
    opts.log(
      `[prompt-cache] keep-alive ${state.pings + 1}/${policy.keepalive.maxPings} → ${sessionId.slice(0, 8)} `
      + `(idle ${Math.round((now - (state.lastPingAt ?? state.idleSinceAt)) / 60_000)}m, ttl ${policy.ttl ?? 'cli-default'})`,
    );
  }
  return sent;
}

/** Worker ack: the prompt was queued into the CLI (counts) or refused (retry
 *  on a later sweep while the cache is still alive). */
export function notePromptCacheKeepaliveResult(ds: DaemonSession, injected: boolean): void {
  const state = ds.promptCacheKeepalive;
  if (!state || state.inFlightSince === undefined) return;
  if (injected) {
    ds.promptCacheKeepalive = { ...state, pings: state.pings + 1, lastPingAt: state.inFlightSince };
  } else {
    const { inFlightSince: _dropped, ...rest } = state;
    ds.promptCacheKeepalive = rest.pings === 0 && rest.lastPingAt === undefined ? undefined : rest;
  }
}

/** A real turn started: the idle stretch (and its ping budget) is over. */
export function resetPromptCacheKeepalive(ds: DaemonSession): void {
  ds.promptCacheKeepalive = undefined;
}

/**
 * Screen-status hook, called right after `ds.lastScreenStatus` changes and the
 * idle stamp has been applied. A keep-alive in flight keeps the stretch alive
 * across its own busy period and gets the original idle start restored on its
 * idle edge; any other busy edge means real activity and ends the stretch.
 */
export function notePromptCacheKeepaliveScreenStatus(
  ds: DaemonSession,
  prev: DaemonSession['lastScreenStatus'],
  now = Date.now(),
): void {
  const state = ds.promptCacheKeepalive;
  if (!state || prev === ds.lastScreenStatus) return;
  const inFlight = state.inFlightSince !== undefined && now - state.inFlightSince < KEEPALIVE_IN_FLIGHT_STALE_MS;
  if (!inFlight) {
    if (ds.lastScreenStatus !== 'idle') ds.promptCacheKeepalive = undefined;
    return;
  }
  if (ds.lastScreenStatus === 'idle') {
    ds.idleSinceAt = state.idleSinceAt;
    const { inFlightSince: _done, ...rest } = state;
    ds.promptCacheKeepalive = rest;
  }
}
