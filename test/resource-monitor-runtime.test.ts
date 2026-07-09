import { describe, expect, it } from 'vitest';
import { buildRuntimeMonitorSummary, sessionRuntimeBucket } from '../src/core/resource-monitor/runtime.js';
import type { ResourceBotCurrent, ResourceSessionCurrent } from '../src/core/resource-monitor/types.js';

function session(overrides: Partial<ResourceSessionCurrent> & { sessionId: string; status: string }): ResourceSessionCurrent {
  return {
    sessionId: overrides.sessionId,
    larkAppId: overrides.larkAppId ?? 'app-a',
    botName: overrides.botName ?? 'AI',
    title: overrides.title ?? overrides.sessionId,
    status: overrides.status,
    spawnedAt: overrides.spawnedAt,
    lastMessageAt: overrides.lastMessageAt,
    agentAttention: overrides.agentAttention,
    current: {
      rssBytes: 0,
      cpuPct: 0,
      cpu1mPct: 0,
      cpu5mPct: 0,
      rssGrowth5mBytes: 0,
    },
    tracked: false,
    rankReasons: [],
    confidence: overrides.confidence ?? 'unknown',
    pids: { sampledPids: 0 },
  };
}

function bot(overrides: Partial<ResourceBotCurrent> & { larkAppId: string }): ResourceBotCurrent {
  return {
    larkAppId: overrides.larkAppId,
    botName: overrides.botName ?? overrides.larkAppId,
    daemonPid: overrides.daemonPid,
    daemonStatus: overrides.daemonStatus ?? 'unknown',
    daemon: { rssBytes: 0, cpuPct: 0 },
    sessions: { rssBytes: 0, cpuPct: 0, count: 0 },
    runtime: overrides.runtime ?? {
      daemonStatus: overrides.daemonStatus ?? 'unknown',
      sessions: { total: 0, working: 0, starting: 0, waiting: 0 },
    },
    total: { rssBytes: 0, cpuPct: 0 },
  };
}

describe('runtime monitor helpers', () => {
  it('classifies live session runtime buckets', () => {
    expect(sessionRuntimeBucket(session({ sessionId: 's1', status: 'working' }))).toBe('working');
    expect(sessionRuntimeBucket(session({ sessionId: 's2', status: 'queued' }))).toBe('starting');
    expect(sessionRuntimeBucket(session({ sessionId: 's3', status: 'idle' }))).toBe('idle');
    expect(sessionRuntimeBucket(session({ sessionId: 's4', status: 'active', agentAttention: { kind: 'blocked', reason: 'need input', at: 10_000 } }))).toBe('waiting');
    expect(sessionRuntimeBucket(session({ sessionId: 's5', status: 'mystery' }))).toBe('unknown');
    expect(sessionRuntimeBucket(session({ sessionId: 's6', status: 'waiting' }))).toBe('waiting');
    expect(sessionRuntimeBucket(session({ sessionId: 's7', status: 'analyzing' }))).toBe('working');
    expect(sessionRuntimeBucket(session({ sessionId: 's8', status: 'active' }))).toBe('working');
    expect(sessionRuntimeBucket(session({ sessionId: 's9', status: 'dormant' }))).toBe('idle');
  });

  it('builds fresh runtime summary with daemon and session pressure', () => {
    const summary = buildRuntimeMonitorSummary({
      supported: true,
      sampledAt: 100_000,
      intervalMs: 10_000,
      nowMs: 110_000,
      bots: [
        bot({ larkAppId: 'app-a', daemonPid: 111, daemonStatus: 'online' }),
        bot({ larkAppId: 'app-b', daemonStatus: 'offline' }),
      ],
      sessions: [
        session({ sessionId: 'run', status: 'working', spawnedAt: 20_000, confidence: 'marker' }),
        session({ sessionId: 'wait', status: 'active', spawnedAt: 60_000, agentAttention: { kind: 'blocked', reason: 'need input', at: 80_000 }, confidence: 'unknown' }),
        session({ sessionId: 'start', status: 'starting', spawnedAt: 90_000, confidence: 'unknown' }),
      ],
    });

    expect(summary.sampleHealth.status).toBe('fresh');
    expect(summary.daemons).toEqual({ total: 2, online: 1, offline: 1 });
    expect(summary.sessions).toMatchObject({
      total: 3,
      working: 1,
      starting: 1,
      idle: 0,
      waiting: 1,
      unknown: 0,
      unattributed: 2,
    });
    expect(summary.sessions.longestRunning).toMatchObject({ sessionId: 'run', durationMs: 90_000 });
    expect(summary.sessions.longestWaiting).toMatchObject({ sessionId: 'wait', durationMs: 30_000 });
  });

  it('uses the longest live session as longest running even when it is idle', () => {
    const summary = buildRuntimeMonitorSummary({
      supported: true,
      sampledAt: 100_000,
      intervalMs: 10_000,
      nowMs: 110_000,
      bots: [],
      sessions: [
        session({ sessionId: 'idle-old', status: 'idle', spawnedAt: 10_000 }),
        session({ sessionId: 'working-new', status: 'working', spawnedAt: 80_000 }),
      ],
    });

    expect(summary.sessions.longestRunning).toMatchObject({ sessionId: 'idle-old', durationMs: 100_000 });
  });

  it('marks stale and unsupported samples explicitly', () => {
    expect(buildRuntimeMonitorSummary({
      supported: true,
      sampledAt: 10_000,
      intervalMs: 10_000,
      nowMs: 50_001,
      bots: [],
      sessions: [],
    }).sampleHealth.status).toBe('stale');

    expect(buildRuntimeMonitorSummary({
      supported: false,
      sampledAt: 10_000,
      intervalMs: 10_000,
      nowMs: 11_000,
      bots: [],
      sessions: [],
    }).sampleHealth.status).toBe('unsupported');
  });

  it('uses last message and spawn times as waiting duration fallbacks', () => {
    const summary = buildRuntimeMonitorSummary({
      supported: true,
      sampledAt: 100_000,
      intervalMs: 10_000,
      nowMs: 110_000,
      bots: [],
      sessions: [
        session({ sessionId: 'last-message', status: 'waiting', lastMessageAt: 80_000 }),
        session({ sessionId: 'spawned', status: 'waiting', spawnedAt: 60_000 }),
      ],
    });

    expect(summary.sessions.longestWaiting).toMatchObject({ sessionId: 'spawned', durationMs: 50_000 });
  });
});
