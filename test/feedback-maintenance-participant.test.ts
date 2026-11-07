import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import { isFeedbackMaintenanceBusy } from '../src/core/feedback-maintenance-health.js';
import { withBotTurnAdmission } from '../src/core/bot-turn-mutation-gate.js';
import {
  assertFeedbackAdmission, beginFeedbackMaintenance, freezeFeedbackSource,
  inspectFeedbackMaintenance, restoreFeedbackSource, startFeedbackMaintenanceParticipant,
} from '../src/services/feedback-maintenance.js';
import { SkillFeedbackStore, getSkillFeedbackStore, __testOnly_closeSkillFeedbackStores } from '../src/services/skill-feedback-store.js';
import { openDatabaseSync } from '../src/services/sqlite-compat.js';
import { normalizeFeedbackPolicy } from '../src/services/feedback-policy.js';
import { enqueueTurnTerminal, getTurnTerminalPersistenceHealth, __testOnly_reopenTurnTerminalAdmission } from '../src/services/turn-completion-events.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(
  beforeOutboxStopped: () => Promise<void> = async () => {},
  options: { session?: DaemonSession; persistence?: () => { pending: number; failed: number } } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-participant-'));
  const store = await SkillFeedbackStore.open(directory);
  cleanups.push(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  await beginFeedbackMaintenance(directory, 'participant-test');
  // Control only the participant's periodic clock. Config/storage filesystem
  // operations and condition polling keep their real I/O timers on Node/Bun.
  let tick!: () => void;
  const clock = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
    tick = callback as () => void;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  });
  const realNow = Date.now.bind(Date);
  let lastNow = realNow();
  // Every receipt gets a distinct heartbeat, so polling cannot accept an old
  // matching report and start another asynchronous tick during cleanup.
  const heartbeatClock = vi.spyOn(Date, 'now').mockImplementation(() => {
    lastNow = Math.max(realNow(), lastNow + 1);
    return lastNow;
  });
  const session = options.session ?? { session: { status: 'active', backendType: 'tmux' }, worker: null } as DaemonSession;
  const persistence = { pending: 0, failed: 0 };
  let outboxRunning = true;
  const stop = startFeedbackMaintenanceParticipant(
    directory,
    () => ({ busy: isFeedbackMaintenanceBusy('participant-test', [session]), ...(options.persistence?.() ?? persistence) }),
    async () => { await beforeOutboxStopped(); outboxRunning = false; },
    async () => { outboxRunning = true; },
  );
  cleanups.push(async () => { stop(); clock.mockRestore(); heartbeatClock.mockRestore(); });
  async function checkpoint(ready: boolean, blockers: string[] = []) {
    const previous = (await inspectFeedbackMaintenance(directory, 'participant-test')).participants[0] as { updatedAt?: number } | undefined;
    tick();
    await vi.waitFor(async () => {
      const report = await inspectFeedbackMaintenance(directory, 'participant-test');
      expect(report.participants).toHaveLength(1);
      expect((report.participants[0] as unknown as { updatedAt: number }).updatedAt).toBeGreaterThan(previous?.updatedAt ?? 0);
      expect(report.participants[0]).toMatchObject({ ready, migrationId: 'participant-test' });
      for (const blocker of blockers) expect(report.blockers).toContain(blocker);
      if (ready) expect(report.blockers).toEqual([]);
    });
  }
  return { directory, store, session, persistence, checkpoint, tick: () => tick(), outboxRunning: () => outboxRunning };
}

describe('feedback maintenance participant with runtime health', () => {
  it.each(['riff', 'mojo', 'remote-runner'])('does not freeze legacy %s execution without a backend stamp', async cliId => {
    const f = await fixture(undefined, {
      session: { session: { status: 'active', cliId }, worker: null } as DaemonSession,
    });
    await f.checkpoint(false, ['active_turns']);
    expect(f.outboxRunning()).toBe(true);
    await expect(freezeFeedbackSource(f.directory, 'participant-test')).rejects.toThrow('active_turns');
    f.session.lastScreenStatus = 'idle';
    await f.checkpoint(true);
  });

  // The original predicate leaves this real participant blocked forever.
  it('freezes dormant sessions after delivery and terminal persistence drain, then resumes on cancel', async () => {
    const f = await fixture();
    f.session.finalOutputDeliveriesInFlight = new Set([Promise.resolve()]);
    await f.checkpoint(false, ['active_turns']);
    expect(f.outboxRunning()).toBe(true);
    await expect(freezeFeedbackSource(f.directory, 'participant-test')).rejects.toThrow('active_turns');

    f.session.finalOutputDeliveriesInFlight.clear();
    // A live worker with background tasks stays busy; a stale count left behind
    // after local worker loss must not wedge the drain.
    f.session.worker = { killed: false } as DaemonSession['worker'];
    f.session.backgroundTaskCount = 1;
    await f.checkpoint(false, ['active_turns']);
    f.session.backgroundTaskCount = 0;
    f.session.worker = null;
    f.persistence.pending = 1;
    await f.checkpoint(false, ['pending_terminal_writes']);
    f.persistence.pending = 0;
    f.persistence.failed = 1;
    await f.checkpoint(false, ['failed_terminal_writes']);
    f.persistence.failed = 0;
    await f.checkpoint(true);
    expect(f.outboxRunning()).toBe(false);
    await freezeFeedbackSource(f.directory, 'participant-test');
    expect(() => assertFeedbackAdmission(f.directory)).toThrow('feedback_storage_maintenance');
    expect(() => f.store.createResponse({ interactionId: 'frozen', content: 'blocked' })).toThrow('feedback_source_frozen');
    await restoreFeedbackSource(f.directory, 'participant-test');
    await f.checkpoint(false);
    expect(f.outboxRunning()).toBe(true);
    expect(() => assertFeedbackAdmission(f.directory)).not.toThrow();
    expect(f.store.createResponse({ interactionId: 'restored', content: 'safe' })).toHaveProperty('responseId');
  });

  it('keeps pre-worker preparation blocked across ticks and releases it when the admitted action settles', async () => {
    const f = await fixture();
    let finish!: () => void;
    const preparation = withBotTurnAdmission('participant-test', () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await f.checkpoint(false, ['active_turns']);
      await f.checkpoint(false, ['active_turns']);
      expect(f.outboxRunning()).toBe(true);
    } finally {
      finish();
      await preparation;
    }
    await f.checkpoint(true);
    expect(f.outboxRunning()).toBe(false);
  });

  it('cancels during preparation without freezing storage when the admitted action later settles', async () => {
    const f = await fixture();
    let finish!: () => void;
    const preparation = withBotTurnAdmission('participant-test', () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      await f.checkpoint(false, ['active_turns']);
      await restoreFeedbackSource(f.directory, 'participant-test');
      await f.checkpoint(false);
      expect(() => assertFeedbackAdmission(f.directory)).not.toThrow();
    } finally {
      finish();
      await preparation;
    }
    await f.checkpoint(false);
    expect(f.outboxRunning()).toBe(true);
    expect(f.store.createResponse({ interactionId: 'cancelled', content: 'resumed' })).toHaveProperty('responseId');
  });

  it('blocks a partially recorded turn after a real SQLite write failure and drains after recovery', async () => {
    __testOnly_reopenTurnTerminalAdmission();
    const f = await fixture(undefined, {
      // A live worker with no idle screen keeps the session busy during setup,
      // so the first ticks never stop the outbox before the failed write.
      session: { session: { status: 'active', backendType: 'tmux' }, worker: { killed: false }, backgroundTaskCount: 1 } as DaemonSession,
      persistence: getTurnTerminalPersistenceHealth,
    });
    cleanups.push(async () => {
      await __testOnly_closeSkillFeedbackStores();
      __testOnly_reopenTurnTerminalAdmission();
    });
    const store = await getSkillFeedbackStore(f.directory);
    await store.recordTurnDelivery({
      botAppId: 'participant-test', sessionId: 'session', turnId: 'partial',
      platform: 'lark', platformAppId: 'participant-test', platformMessageId: 'message',
      chatId: 'chat', topicRootId: 'topic', content: 'delivered', cliId: 'claude-code',
      cardMode: 'feedback', status: 'delivered', policy: normalizeFeedbackPolicy({ enabled: true }),
    });
    const blocker = await openDatabaseSync(join(f.directory, 'botmux-feedback.sqlite'));
    blocker.exec('BEGIN IMMEDIATE');
    const terminal = {
      dataDir: f.directory, botAppId: 'participant-test', sessionId: 'session',
      terminal: { turnId: 'partial', status: 'completed' as const }, maxAttempts: 1,
    };
    try {
      await enqueueTurnTerminal(terminal);
      f.session.backgroundTaskCount = 0;
      expect(getTurnTerminalPersistenceHealth()).toMatchObject({ pending: 0, failed: 1 });
      await f.checkpoint(false, ['failed_terminal_writes']);
      await expect(freezeFeedbackSource(f.directory, 'participant-test')).rejects.toThrow('failed_terminal_writes');
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    // The failed write drained: simulate the worker going away (crash/lazy
    // refork) — with no live local worker and no stale signal, the participant
    // is allowed to finish.
    f.session.worker = null;
    await enqueueTurnTerminal(terminal);
    expect(getTurnTerminalPersistenceHealth()).toMatchObject({ pending: 0, failed: 0 });
    expect(await store.listTurnCompletionEvents()).toHaveLength(1);
    await f.checkpoint(true);
  });

  it('does not publish readiness or overlap quiesce operations while a slow outbox stop spans several ticks', async () => {
    let finish!: () => void;
    const pendingStop = new Promise<void>(resolve => { finish = resolve; });
    let stopsStarted = 0;
    const f = await fixture(async () => { stopsStarted++; await pendingStop; });
    try {
      await vi.waitFor(() => expect(stopsStarted).toBe(1));
      for (let tick = 0; tick < 5; tick++) f.tick();
      expect(stopsStarted).toBe(1);
      expect(f.outboxRunning()).toBe(true);
      expect((await inspectFeedbackMaintenance(f.directory, 'participant-test')).participants).toEqual([]);
    } finally {
      finish();
    }
    await f.checkpoint(true);
    expect(f.outboxRunning()).toBe(false);
  });
});
