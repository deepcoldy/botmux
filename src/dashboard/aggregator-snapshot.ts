/**
 * Overview aggregator snapshot (PR1) — pure projection of (sessions, schedules,
 * bots, groups) into the six dashboard overview sections. Self-contained: no
 * imports from `aggregator.ts` / `dashboard.ts` / worker-pool runtime; only
 * shared types from `card-model-types.ts`.
 *
 * Adapter at PR2 maps live aggregator data into these four minimal inputs.
 */

import type { SectionLimit } from './card-model-types.js';

/** Minimum session shape needed for the overview. */
export interface OverviewSessionInput {
  sessionId: string;
  status: string;
  lastMessageAt: number;
  larkAppId?: string;
  botName?: string;
  title?: string;
  pendingRepo?: boolean;
  tuiPromptActive?: boolean;
}

/** Minimum schedule shape needed for the upcoming section. */
export interface OverviewScheduleInput {
  id: string;
  name: string;
  enabled: boolean;
  /** ISO; absent or invalid → row dropped from upcoming section. */
  nextRunAt?: string;
}

/** Minimum bot shape for the team strip. */
export interface OverviewBotInput {
  larkAppId: string;
  botName: string;
  online: boolean;
}

/** Minimum group shape for the hero groupCount. */
export interface OverviewGroupInput {
  chatId: string;
  name?: string;
}

export type AttentionReason = 'pendingRepo' | 'tuiPromptActive' | 'limited';

export interface HeroSectionDto {
  workingCount: number;
  needsYouCount: number;
  onlineBotCount: number;
  totalBotCount: number;
  groupCount: number;
}

export interface AiTeamBotDto {
  larkAppId: string;
  botName: string;
  online: boolean;
}

export interface AiTeamSectionDto {
  bots: AiTeamBotDto[];
  onlineCount: number;
  totalCount: number;
}

export interface AttentionRowDto {
  sessionId: string;
  title?: string;
  larkAppId?: string;
  botName?: string;
  reasons: AttentionReason[];
  lastMessageAt: number;
}

export interface AttentionSectionDto {
  rows: AttentionRowDto[];
  totalCount: number;
  limit: number;
}

export interface ActiveSessionRowDto {
  sessionId: string;
  title?: string;
  larkAppId?: string;
  status: string;
  lastMessageAt: number;
}

export interface ActiveSessionsSectionDto {
  rows: ActiveSessionRowDto[];
  totalCount: number;
  limit: number;
}

export interface MomentCountsSectionDto {
  needsYou: number;
  working: number;
  idle: number;
}

export interface UpcomingScheduleRowDto {
  id: string;
  name: string;
  nextRunAt: string;
  nextRunAtMs: number;
}

export interface UpcomingSchedulesSectionDto {
  rows: UpcomingScheduleRowDto[];
  totalCount: number;
  limit: number;
}

export interface OverviewSnapshotDto {
  hero: HeroSectionDto;
  aiTeam: AiTeamSectionDto;
  attention: AttentionSectionDto;
  activeSessions: ActiveSessionsSectionDto;
  momentCounts: MomentCountsSectionDto;
  upcomingSchedules: UpcomingSchedulesSectionDto;
}

export interface OverviewLimitOptions {
  attention?: number;
  active?: number;
  upcoming?: number;
}

export interface BuildOverviewInput {
  sessions: ReadonlyArray<OverviewSessionInput>;
  schedules: ReadonlyArray<OverviewScheduleInput>;
  bots: ReadonlyArray<OverviewBotInput>;
  groups: ReadonlyArray<OverviewGroupInput>;
  /** Epoch ms used to filter past schedule nextRunAt; defaults to 0 (keep everything). */
  now?: number;
  limit?: OverviewLimitOptions;
}

const DEFAULT_SECTION_LIMIT = 5;
const MIN_SECTION_LIMIT = 1;
const MAX_SECTION_LIMIT = 50;
/**
 * Busy status set — mirrors `src/dashboard/web/overview.ts:41 BUSY_STATUSES`.
 * Includes legacy `'active'`, which dashboard-ipc-server.ts:156-160 publishes
 * via `patch: { status: 'active' }` after a resume and aggregator.ts:26-29
 * merges directly into snapshot.
 */
const BUSY_STATUSES: ReadonlySet<string> = new Set(['working', 'analyzing', 'active', 'starting']);

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SECTION_LIMIT;
  const floored = Math.floor(limit);
  if (floored < MIN_SECTION_LIMIT) return MIN_SECTION_LIMIT;
  if (floored > MAX_SECTION_LIMIT) return MAX_SECTION_LIMIT;
  return floored;
}

function isClosed(s: OverviewSessionInput): boolean { return s.status === 'closed'; }
function isBusy(s: OverviewSessionInput): boolean { return BUSY_STATUSES.has(s.status); }

/**
 * `needs-you` signals: pendingRepo, tuiPromptActive, or status='limited'.
 * Matches the dashboard-attention-signals semantics; appending new reasons is
 * additive only.
 */
function isNeedsYou(s: OverviewSessionInput): boolean {
  return s.pendingRepo === true || s.tuiPromptActive === true || s.status === 'limited';
}

function attentionReasonsOf(s: OverviewSessionInput): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (s.pendingRepo === true) reasons.push('pendingRepo');
  if (s.tuiPromptActive === true) reasons.push('tuiPromptActive');
  if (s.status === 'limited') reasons.push('limited');
  return reasons;
}

/**
 * Hero capsule: working count, needs-you count, online/total bots, group count.
 *
 * `workingCount` follows the same convention as `src/dashboard/web/overview.ts:247-258`:
 * busy AND not needs-you AND not closed. needs-you wins precedence so a session
 * cannot double-count.
 */
export function buildHeroSection(
  sessions: ReadonlyArray<OverviewSessionInput>,
  bots: ReadonlyArray<OverviewBotInput>,
  groups: ReadonlyArray<OverviewGroupInput>,
): HeroSectionDto {
  let workingCount = 0;
  let needsYouCount = 0;
  for (const s of sessions) {
    if (isClosed(s)) continue;
    if (isNeedsYou(s)) { needsYouCount += 1; continue; }
    if (isBusy(s)) workingCount += 1;
  }
  let onlineBotCount = 0;
  for (const b of bots) if (b.online) onlineBotCount += 1;
  return {
    workingCount,
    needsYouCount,
    onlineBotCount,
    totalBotCount: bots.length,
    groupCount: groups.length,
  };
}

/** AI team bot list — preserves input order, totals online vs total. */
export function buildAiTeamSection(bots: ReadonlyArray<OverviewBotInput>): AiTeamSectionDto {
  let onlineCount = 0;
  const list: AiTeamBotDto[] = bots.map(b => {
    if (b.online) onlineCount += 1;
    return { larkAppId: b.larkAppId, botName: b.botName, online: b.online };
  });
  return { bots: list, onlineCount, totalCount: bots.length };
}

/**
 * Attention section: needs-you sessions sorted oldest-first (longest-waiting
 * surfaces first) to match `src/dashboard/web/overview.ts:247-249` and the
 * global attention strip in `src/dashboard/web/app.ts:119-129`, then truncated.
 */
export function buildAttentionSection(
  sessions: ReadonlyArray<OverviewSessionInput>,
  opts?: SectionLimit,
): AttentionSectionDto {
  const limit = clampLimit(opts?.limit);
  const eligible = sessions.filter(s => !isClosed(s) && isNeedsYou(s));
  const sorted = eligible.slice().sort((a, b) => a.lastMessageAt - b.lastMessageAt);
  const rows: AttentionRowDto[] = sorted.slice(0, limit).map(s => ({
    sessionId: s.sessionId,
    title: s.title,
    larkAppId: s.larkAppId,
    botName: s.botName,
    reasons: attentionReasonsOf(s),
    lastMessageAt: s.lastMessageAt,
  }));
  return { rows, totalCount: eligible.length, limit };
}

/** Active sessions section: busy statuses only (working/analyzing/active/starting), sorted desc, truncated. */
export function buildActiveSessionsSection(
  sessions: ReadonlyArray<OverviewSessionInput>,
  opts?: SectionLimit,
): ActiveSessionsSectionDto {
  const limit = clampLimit(opts?.limit);
  const eligible = sessions.filter(isBusy);
  const sorted = eligible.slice().sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  const rows: ActiveSessionRowDto[] = sorted.slice(0, limit).map(s => ({
    sessionId: s.sessionId,
    title: s.title,
    larkAppId: s.larkAppId,
    status: s.status,
    lastMessageAt: s.lastMessageAt,
  }));
  return { rows, totalCount: eligible.length, limit };
}

/**
 * Moment counts (needs-you / working / idle). Closed excluded. needs-you wins
 * over both working and idle when flags coincide (precedence rule).
 *
 * 'working' bucket covers any busy CLI state (working / analyzing / active / starting);
 * 'idle' is the residual non-closed, non-needs-you, non-busy set.
 */
export function buildMomentCountsSection(sessions: ReadonlyArray<OverviewSessionInput>): MomentCountsSectionDto {
  let needsYou = 0;
  let working = 0;
  let idle = 0;
  for (const s of sessions) {
    if (isClosed(s)) continue;
    if (isNeedsYou(s)) { needsYou += 1; continue; }
    if (isBusy(s)) { working += 1; continue; }
    idle += 1;
  }
  return { needsYou, working, idle };
}

/** Upcoming schedules: enabled + future nextRunAt, sorted ascending, truncated. */
export function buildUpcomingSchedulesSection(
  schedules: ReadonlyArray<OverviewScheduleInput>,
  opts?: { limit?: number; now?: number },
): UpcomingSchedulesSectionDto {
  const limit = clampLimit(opts?.limit);
  const nowMs = typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : 0;
  const eligible: UpcomingScheduleRowDto[] = [];
  for (const s of schedules) {
    if (s.enabled !== true) continue;
    if (typeof s.nextRunAt !== 'string') continue;
    const ms = Date.parse(s.nextRunAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs) continue;
    eligible.push({ id: s.id, name: s.name, nextRunAt: s.nextRunAt, nextRunAtMs: ms });
  }
  const sorted = eligible.slice().sort((a, b) => a.nextRunAtMs - b.nextRunAtMs);
  return { rows: sorted.slice(0, limit), totalCount: eligible.length, limit };
}

/** Compose the full overview snapshot from raw inputs. */
export function buildOverviewSnapshot(input: BuildOverviewInput): OverviewSnapshotDto {
  const nowMs = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : 0;
  return {
    hero: buildHeroSection(input.sessions, input.bots, input.groups),
    aiTeam: buildAiTeamSection(input.bots),
    attention: buildAttentionSection(input.sessions, { limit: input.limit?.attention }),
    activeSessions: buildActiveSessionsSection(input.sessions, { limit: input.limit?.active }),
    momentCounts: buildMomentCountsSection(input.sessions),
    upcomingSchedules: buildUpcomingSchedulesSection(input.schedules, {
      limit: input.limit?.upcoming,
      now: nowMs,
    }),
  };
}
