import { describe, expect, it } from 'vitest';
import {
  IDLE_CLEANUP_HOUR_OPTIONS,
  cleanupIdleSessions,
  parseIdleCleanupHours,
  selectIdleCleanupCandidates,
} from '../src/dashboard/session-cleanup.js';

const NOW = Date.UTC(2026, 5, 22, 12, 0, 0);
const hour = 60 * 60 * 1000;

function row(id: string, patch: Record<string, unknown> = {}) {
  return {
    sessionId: id,
    status: 'idle',
    lastMessageAt: NOW - 25 * hour,
    ...patch,
  };
}

describe('dashboard idle session cleanup selection', () => {
  it('accepts only the supported cleanup thresholds', () => {
    expect(IDLE_CLEANUP_HOUR_OPTIONS).toEqual([24, 72, 168]);
    expect(parseIdleCleanupHours(24)).toBe(24);
    expect(parseIdleCleanupHours('72')).toBe(72);
    expect(parseIdleCleanupHours('7d')).toBe(168);
    expect(parseIdleCleanupHours('168')).toBe(168);

    expect(parseIdleCleanupHours(12)).toBeNull();
    expect(parseIdleCleanupHours('24h')).toBeNull();
    expect(parseIdleCleanupHours('bad')).toBeNull();
  });

  it('selects idle sessions older than the threshold and skips unsafe statuses', () => {
    const candidates = selectIdleCleanupCandidates([
      row('old-idle'),
      row('new-idle', { lastMessageAt: NOW - 23 * hour }),
      row('working', { status: 'working', lastMessageAt: NOW - 48 * hour }),
      row('starting', { status: 'starting', lastMessageAt: NOW - 48 * hour }),
      row('closed', { status: 'closed', lastMessageAt: NOW - 48 * hour }),
      row('pending-repo', { pendingRepo: true, lastMessageAt: NOW - 48 * hour }),
      row('tui-prompt', { tuiPromptActive: true, lastMessageAt: NOW - 48 * hour }),
      row('agent-attention', { agentAttention: { kind: 'blocked', reason: 'needs input', at: NOW - 48 * hour } }),
      row('missing-time', { lastMessageAt: undefined }),
    ], 24, NOW);

    expect(candidates.map(s => s.sessionId)).toEqual(['old-idle']);
  });

  it('treats the seven-day option as 168 hours', () => {
    const candidates = selectIdleCleanupCandidates([
      row('six-days', { lastMessageAt: NOW - 6 * 24 * hour }),
      row('eight-days', { lastMessageAt: NOW - 8 * 24 * hour }),
    ], 168, NOW);

    expect(candidates.map(s => s.sessionId)).toEqual(['eight-days']);
  });

  it('closes only selected cleanup candidates and reports partial failures', async () => {
    const closed: string[] = [];
    const result = await cleanupIdleSessions([
      row('old-idle'),
      row('new-idle', { lastMessageAt: NOW - 2 * hour }),
      row('old-working', { status: 'working', lastMessageAt: NOW - 48 * hour }),
      row('fails', { lastMessageAt: NOW - 48 * hour }),
    ], 24, async (candidate) => {
      if (candidate.sessionId === 'fails') return { sessionId: candidate.sessionId, ok: false, error: 'close_failed' };
      closed.push(candidate.sessionId);
      return { sessionId: candidate.sessionId, ok: true };
    }, NOW);

    expect(closed).toEqual(['old-idle']);
    expect(result).toEqual({
      ok: false,
      olderThanHours: 24,
      cutoffMs: NOW - 24 * hour,
      matched: 2,
      closed: 1,
      failed: 1,
      results: [
        { sessionId: 'old-idle', ok: true },
        { sessionId: 'fails', ok: false, error: 'close_failed' },
      ],
    });
  });
});
