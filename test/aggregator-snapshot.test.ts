import { describe, expect, it } from 'vitest';

import {
  buildActiveSessionsSection,
  buildAiTeamSection,
  buildAttentionSection,
  buildHeroSection,
  buildMomentCountsSection,
  buildOverviewSnapshot,
  buildUpcomingSchedulesSection,
  type OverviewBotInput,
  type OverviewGroupInput,
  type OverviewScheduleInput,
  type OverviewSessionInput,
} from '../src/dashboard/aggregator-snapshot.js';

const FIXED_NOW = Date.parse('2025-04-15T08:00:00Z');

function makeSession(over: Partial<OverviewSessionInput> & { sessionId: string }): OverviewSessionInput {
  return {
    status: 'idle',
    lastMessageAt: FIXED_NOW - 60_000,
    ...over,
  };
}

function makeBot(over: Partial<OverviewBotInput> & { larkAppId: string }): OverviewBotInput {
  return { botName: over.larkAppId.replace(/^cli_/, ''), online: true, ...over };
}

function makeSchedule(over: Partial<OverviewScheduleInput> & { id: string }): OverviewScheduleInput {
  return { name: `task-${over.id}`, enabled: true, ...over };
}

function makeGroup(chatId: string, name?: string): OverviewGroupInput {
  return { chatId, name };
}

describe('aggregator-snapshot · buildHeroSection', () => {
  it('counts working (busy && !needs-you), needs-you, online/total bots, groups (incl. legacy `active` status)', () => {
    const sessions = [
      makeSession({ sessionId: 'w1', status: 'working' }),                    // busy → working
      makeSession({ sessionId: 'ac', status: 'active' }),                     // legacy busy → working
      makeSession({ sessionId: 'an', status: 'analyzing' }),                  // busy → working
      makeSession({ sessionId: 'wp', status: 'working', pendingRepo: true }), // busy + needs-you → needs-you ONLY
      makeSession({ sessionId: 'l1', status: 'limited' }),                    // needs-you only
      makeSession({ sessionId: 'i1', status: 'idle' }),                       // neither
      makeSession({ sessionId: 'c1', status: 'closed' }),                     // ignored
    ];
    const bots = [
      makeBot({ larkAppId: 'cli_claude', online: true }),
      makeBot({ larkAppId: 'cli_codex',  online: false }),
      makeBot({ larkAppId: 'cli_mira',   online: true }),
    ];
    const groups = [makeGroup('oc_a'), makeGroup('oc_b')];

    const hero = buildHeroSection(sessions, bots, groups);
    expect(hero.workingCount).toBe(3);  // w1 + ac + an (NOT wp — needs-you precedence)
    expect(hero.needsYouCount).toBe(2); // wp + l1
    expect(hero.onlineBotCount).toBe(2);
    expect(hero.totalBotCount).toBe(3);
    expect(hero.groupCount).toBe(2);
  });
});

describe('aggregator-snapshot · buildAiTeamSection', () => {
  it('preserves the input order and reports onlineCount / totalCount accurately', () => {
    const bots = [
      makeBot({ larkAppId: 'cli_claude', online: true }),
      makeBot({ larkAppId: 'cli_codex',  online: false }),
      makeBot({ larkAppId: 'cli_mira',   online: true }),
    ];
    const team = buildAiTeamSection(bots);
    expect(team.bots.map(b => b.larkAppId)).toEqual(['cli_claude', 'cli_codex', 'cli_mira']);
    expect(team.onlineCount).toBe(2);
    expect(team.totalCount).toBe(3);
  });
});

describe('aggregator-snapshot · buildAttentionSection', () => {
  it('surfaces pendingRepo / tuiPromptActive / limited reasons, sorts oldest-first (longest-waiting), respects limit + totalCount', () => {
    const sessions = [
      makeSession({ sessionId: 'p1', pendingRepo: true,     lastMessageAt: FIXED_NOW - 90_000 }),
      makeSession({ sessionId: 't1', tuiPromptActive: true, lastMessageAt: FIXED_NOW - 30_000 }),
      makeSession({ sessionId: 'l1', status: 'limited',     lastMessageAt: FIXED_NOW - 60_000 }),
      makeSession({ sessionId: 'i1', status: 'idle' }),  // not needs-you → filtered out
      makeSession({ sessionId: 'c1', status: 'closed', pendingRepo: true }), // closed → excluded
    ];
    const all = buildAttentionSection(sessions);
    // p1 (oldest, longest-waiting) first; t1 (newest) last — matches web/overview.ts:247-249.
    expect(all.rows.map(r => r.sessionId)).toEqual(['p1', 'l1', 't1']);
    expect(all.totalCount).toBe(3);

    const reasonsForT1 = all.rows.find(r => r.sessionId === 't1')!.reasons;
    expect(reasonsForT1).toEqual(['tuiPromptActive']);
    const reasonsForL1 = all.rows.find(r => r.sessionId === 'l1')!.reasons;
    expect(reasonsForL1).toEqual(['limited']);

    const limited = buildAttentionSection(sessions, { limit: 2 });
    expect(limited.rows.length).toBe(2);
    expect(limited.rows.map(r => r.sessionId)).toEqual(['p1', 'l1']); // oldest two
    expect(limited.totalCount).toBe(3); // pre-slice count
    expect(limited.limit).toBe(2);
  });
});

describe('aggregator-snapshot · buildActiveSessionsSection', () => {
  it('keeps busy statuses (working / analyzing / active / starting), sorts desc, truncates; totalCount reflects pre-truncation', () => {
    const sessions = [
      makeSession({ sessionId: 's1', status: 'starting',  lastMessageAt: FIXED_NOW - 10_000 }),
      makeSession({ sessionId: 'a1', status: 'analyzing', lastMessageAt: FIXED_NOW - 50_000 }),
      makeSession({ sessionId: 'w1', status: 'working',   lastMessageAt: FIXED_NOW - 30_000 }),
      makeSession({ sessionId: 'ac', status: 'active',    lastMessageAt: FIXED_NOW - 20_000 }), // legacy busy
      makeSession({ sessionId: 'i1', status: 'idle' }),     // excluded
      makeSession({ sessionId: 'l1', status: 'limited' }),  // excluded
      makeSession({ sessionId: 'c1', status: 'closed' }),   // excluded
    ];
    const all = buildActiveSessionsSection(sessions);
    expect(all.rows.map(r => r.sessionId)).toEqual(['s1', 'ac', 'w1', 'a1']);
    expect(all.totalCount).toBe(4);

    const limited = buildActiveSessionsSection(sessions, { limit: 2 });
    expect(limited.rows.length).toBe(2);
    expect(limited.totalCount).toBe(4);
  });
});

describe('aggregator-snapshot · buildMomentCountsSection', () => {
  it('excludes closed; needs-you wins precedence; working bucket covers busy set incl. legacy `active`', () => {
    const sessions = [
      // working AND needs-you (pendingRepo): MUST land in needs-you bucket, not working.
      makeSession({ sessionId: 'wn', status: 'working', pendingRepo: true }),
      makeSession({ sessionId: 'w1', status: 'working' }),
      makeSession({ sessionId: 'ac', status: 'active' }),    // legacy busy → working
      makeSession({ sessionId: 'an', status: 'analyzing' }), // busy → working
      // idle AND needs-you (limited): MUST land in needs-you, not idle.
      makeSession({ sessionId: 'in', status: 'limited' }),
      makeSession({ sessionId: 'i1', status: 'idle' }),
      makeSession({ sessionId: 'c1', status: 'closed' }), // excluded
      makeSession({ sessionId: 'c2', status: 'closed', pendingRepo: true }), // still excluded
    ];
    const m = buildMomentCountsSection(sessions);
    expect(m.needsYou).toBe(2); // wn + in
    expect(m.working).toBe(3);  // w1 + ac + an
    expect(m.idle).toBe(1);     // i1
  });
});

describe('aggregator-snapshot · buildUpcomingSchedulesSection', () => {
  it('drops disabled tasks + past nextRunAt, sorts ascending, truncates, totalCount = pre-truncation eligible count', () => {
    const schedules: OverviewScheduleInput[] = [
      makeSchedule({ id: 'past',     nextRunAt: new Date(FIXED_NOW - 1_000).toISOString() }),
      makeSchedule({ id: 'future-3', nextRunAt: new Date(FIXED_NOW + 30 * 60_000).toISOString() }),
      makeSchedule({ id: 'future-1', nextRunAt: new Date(FIXED_NOW + 5 * 60_000).toISOString() }),
      makeSchedule({ id: 'future-2', nextRunAt: new Date(FIXED_NOW + 10 * 60_000).toISOString() }),
      makeSchedule({ id: 'disabled', enabled: false, nextRunAt: new Date(FIXED_NOW + 60_000).toISOString() }),
      makeSchedule({ id: 'noNext',   nextRunAt: undefined }),
    ];
    const out = buildUpcomingSchedulesSection(schedules, { now: FIXED_NOW });
    expect(out.rows.map(r => r.id)).toEqual(['future-1', 'future-2', 'future-3']);
    expect(out.totalCount).toBe(3);

    const limited = buildUpcomingSchedulesSection(schedules, { now: FIXED_NOW, limit: 2 });
    expect(limited.rows.map(r => r.id)).toEqual(['future-1', 'future-2']);
    expect(limited.totalCount).toBe(3);
  });
});

describe('aggregator-snapshot · buildOverviewSnapshot composition', () => {
  it('composes all 6 sections from a realistic input and honors custom limits', () => {
    const sessions = [
      makeSession({ sessionId: 'a1', status: 'working',   lastMessageAt: FIXED_NOW - 10_000 }),
      makeSession({ sessionId: 'a2', status: 'analyzing', lastMessageAt: FIXED_NOW - 20_000 }),
      makeSession({ sessionId: 'p1', status: 'idle', pendingRepo: true, lastMessageAt: FIXED_NOW - 30_000 }),
    ];
    const schedules: OverviewScheduleInput[] = [
      makeSchedule({ id: 'f1', nextRunAt: new Date(FIXED_NOW + 60_000).toISOString() }),
      makeSchedule({ id: 'f2', nextRunAt: new Date(FIXED_NOW + 120_000).toISOString() }),
    ];
    const bots = [
      makeBot({ larkAppId: 'cli_claude', online: true }),
      makeBot({ larkAppId: 'cli_codex',  online: false }),
    ];
    const groups = [makeGroup('oc_x')];

    const snap = buildOverviewSnapshot({
      sessions, schedules, bots, groups,
      now: FIXED_NOW,
      limit: { attention: 1, active: 1, upcoming: 1 },
    });
    expect(snap.hero.workingCount).toBe(2); // a1 (working) + a2 (analyzing) — both busy and not needs-you
    expect(snap.hero.needsYouCount).toBe(1);
    expect(snap.hero.onlineBotCount).toBe(1);
    expect(snap.hero.totalBotCount).toBe(2);
    expect(snap.hero.groupCount).toBe(1);
    expect(snap.aiTeam.totalCount).toBe(2);
    expect(snap.attention.rows.length).toBe(1);
    expect(snap.attention.limit).toBe(1);
    expect(snap.activeSessions.rows.length).toBe(1);
    expect(snap.activeSessions.limit).toBe(1);
    expect(snap.upcomingSchedules.rows.length).toBe(1);
    expect(snap.upcomingSchedules.limit).toBe(1);
    expect(snap.momentCounts.needsYou).toBe(1);
    expect(snap.momentCounts.working).toBe(2); // a1 (working) + a2 (analyzing) — both active states
    expect(snap.momentCounts.idle).toBe(0);
  });

  it('empty inputs yield zero-count DTOs across all sections without throwing', () => {
    const snap = buildOverviewSnapshot({ sessions: [], schedules: [], bots: [], groups: [] });
    expect(snap.hero).toEqual({ workingCount: 0, needsYouCount: 0, onlineBotCount: 0, totalBotCount: 0, groupCount: 0 });
    expect(snap.aiTeam).toEqual({ bots: [], onlineCount: 0, totalCount: 0 });
    expect(snap.attention.rows).toEqual([]);
    expect(snap.attention.totalCount).toBe(0);
    expect(snap.activeSessions.rows).toEqual([]);
    expect(snap.activeSessions.totalCount).toBe(0);
    expect(snap.momentCounts).toEqual({ needsYou: 0, working: 0, idle: 0 });
    expect(snap.upcomingSchedules.rows).toEqual([]);
    expect(snap.upcomingSchedules.totalCount).toBe(0);
  });
});

describe('aggregator-snapshot · invariants', () => {
  it('does not mutate input arrays', () => {
    const sessions = [
      makeSession({ sessionId: 'a', status: 'working', lastMessageAt: FIXED_NOW - 1 }),
      makeSession({ sessionId: 'b', status: 'idle',    lastMessageAt: FIXED_NOW - 2 }),
    ];
    const schedules = [makeSchedule({ id: 'a', nextRunAt: new Date(FIXED_NOW + 60_000).toISOString() })];
    const bots = [makeBot({ larkAppId: 'cli_x' })];
    const groups = [makeGroup('oc_x')];

    const frozenSess = Object.freeze(sessions.slice());
    const frozenSch  = Object.freeze(schedules.slice());
    const frozenBots = Object.freeze(bots.slice());
    const frozenGr   = Object.freeze(groups.slice());

    const before = [
      frozenSess.map(s => s.sessionId),
      frozenSch.map(s => s.id),
      frozenBots.map(b => b.larkAppId),
      frozenGr.map(g => g.chatId),
    ];

    buildOverviewSnapshot({
      sessions: frozenSess, schedules: frozenSch, bots: frozenBots, groups: frozenGr, now: FIXED_NOW,
    });

    expect(frozenSess.map(s => s.sessionId)).toEqual(before[0]);
    expect(frozenSch.map(s => s.id)).toEqual(before[1]);
    expect(frozenBots.map(b => b.larkAppId)).toEqual(before[2]);
    expect(frozenGr.map(g => g.chatId)).toEqual(before[3]);
  });

  it('snapshot DTO is JSON-serialisable round-trip', () => {
    const snap = buildOverviewSnapshot({
      sessions: [makeSession({ sessionId: 's1', status: 'working' })],
      schedules: [makeSchedule({ id: 'a', nextRunAt: new Date(FIXED_NOW + 1000).toISOString() })],
      bots: [makeBot({ larkAppId: 'cli_x' })],
      groups: [makeGroup('oc_x')],
      now: FIXED_NOW,
    });
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });
});
