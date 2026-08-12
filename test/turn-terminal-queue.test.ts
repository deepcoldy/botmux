import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueTurnTerminal,
  drainTurnTerminalQueue,
  __testOnly_pendingTurnTerminalCount,
  __testOnly_reopenTurnTerminalAdmission,
} from '../src/services/turn-completion-events.ts';
import {
  getSkillFeedbackStore,
  SkillFeedbackStore,
  __testOnly_closeSkillFeedbackStores,
} from '../src/services/skill-feedback-store.ts';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'botmux-tt-queue-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  __testOnly_reopenTurnTerminalAdmission();
  await __testOnly_closeSkillFeedbackStores();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function delivery(store: SkillFeedbackStore, dir: string, over: Partial<Record<string, unknown>> = {}) {
  return store.recordTurnDelivery({
    botAppId: 'app', sessionId: 'sess', turnId: 'turn-1', nativeSessionId: 'ns', dispatchAttempt: 0,
    platform: 'lark', platformAppId: 'app', platformMessageId: 'om_a', chatId: 'oc', topicRootId: 'om_root',
    content: 'final answer', cliId: 'claude-code', cardMode: 'feedback', status: 'delivered',
    requesterSubjectId: 'ou_req', policy: { enabled: true } as any,
    ...over,
  } as any);
}

describe('turn-terminal nonblocking queue', () => {
  it('persists a terminal via the queue and resolves', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    await enqueueTurnTerminal({
      dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' },
    });
    expect(__testOnly_pendingTurnTerminalCount()).toBe(0);
    const events = store.listTurnCompletionEvents();
    expect(events.length).toBe(1);
    expect(events[0].payload.status).toBe('completed');
  });

  it('dedupes concurrent enqueues of the same turn into one in-flight item and one event', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    const a = enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess', terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' } });
    const b = enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess', terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' } });
    expect(a).toBe(b); // same promise returned for the duplicate
    await Promise.all([a, b]);
    expect(store.listTurnCompletionEvents().length).toBe(1);
  });

  it('terminal-before-delivery: queue records the terminal, later delivery reconciles it (one event)', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    // Terminal first — no delivery yet, so no completion event is emitted at terminal time.
    await enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess', terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' } });
    expect(store.listTurnCompletionEvents().length).toBe(0);
    // Delivery arrives afterward and reconciles against the recorded terminal.
    delivery(store, dir);
    const events = store.listTurnCompletionEvents();
    expect(events.length).toBe(1);
    expect(events[0].payload.status).toBe('completed');
  });

  it('delivery-before-terminal: delivery recorded first, queued terminal reconciles it (one event)', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    expect(store.listTurnCompletionEvents().length).toBe(0);
    await enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess', terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' } });
    expect(store.listTurnCompletionEvents().length).toBe(1);
  });

  it('retries on a busy lock held by another connection, then succeeds (does not block inline)', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    // Hold the write lock from a SECOND independent connection to force BUSY.
    const blocker = await SkillFeedbackStore.open(dir);
    (blocker as any).db.exec('BEGIN IMMEDIATE;');

    let resolved = false;
    const p = enqueueTurnTerminal({
      dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' },
      retryBaseMs: 20, maxRetryMs: 40, maxAttempts: 50,
    }).then(() => { resolved = true; });

    // While the lock is held, the queue must be retrying (pending), NOT resolved,
    // and crucially the event loop keeps turning (this timer fires on schedule).
    await new Promise(r => setTimeout(r, 120));
    expect(resolved).toBe(false);
    expect(__testOnly_pendingTurnTerminalCount()).toBe(1);

    // Release the lock; the next retry should land.
    (blocker as any).db.exec('COMMIT;');
    await p;
    expect(resolved).toBe(true);
    expect(store.listTurnCompletionEvents().length).toBe(1);
    blocker.close();
  });

  it('drainTurnTerminalQueue awaits in-flight work and reports 0 when drained', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    // Enqueue but do not await — then drain.
    void enqueueTurnTerminal({ dataDir: dir, botAppId: 'app', sessionId: 'sess', terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' } });
    const remaining = await drainTurnTerminalQueue(3000);
    expect(remaining).toBe(0);
    expect(store.listTurnCompletionEvents().length).toBe(1);
  });

  it('drain reports a nonzero count when work cannot finish within the bound', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    const blocker = await SkillFeedbackStore.open(dir);
    (blocker as any).db.exec('BEGIN IMMEDIATE;'); // hold lock so the queued write stays busy

    void enqueueTurnTerminal({
      dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' },
      retryBaseMs: 50, maxRetryMs: 100, maxAttempts: 100,
    });
    const remaining = await drainTurnTerminalQueue(150); // bound shorter than the lock hold
    expect(remaining).toBeGreaterThan(0);

    // Cleanup: release and let it settle so afterEach can close cleanly.
    (blocker as any).db.exec('COMMIT;');
    await drainTurnTerminalQueue(3000);
    blocker.close();
  });

  it('closes admission on drain: a terminal enqueued after drain begins is refused, not silently dropped', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    // Drain with an empty queue closes admission immediately and returns 0.
    const remaining = await drainTurnTerminalQueue(500);
    expect(remaining).toBe(0);
    // A post-drain enqueue must be refused (surfaced via onError, resolves), so
    // it cannot be a lost write that a naive snapshot-drain would have missed.
    const errors: unknown[] = [];
    await enqueueTurnTerminal({
      dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-late', dispatchAttempt: 0, status: 'completed' },
      onError: e => errors.push(e),
    });
    expect(__testOnly_pendingTurnTerminalCount()).toBe(0);
    expect(String(errors[0])).toContain('turn_terminal_persist_refused_shutdown');
  });

  it('retries a transient store-open failure instead of permanently losing the terminal', async () => {
    // Point the store at a path that is initially unopenable (a FILE where the
    // dataDir should be a directory), then repair it mid-retry. A naive "finish
    // on any error" queue would drop the terminal; the bounded retry recovers.
    const parent = freshDir();
    const dataDir = join(parent, 'store');
    // Create a regular file at dataDir so mkdirSync/open throws (EEXIST/ENOTDIR).
    const { writeFileSync, rmSync: rm } = await import('node:fs');
    writeFileSync(dataDir, 'blocker');

    const errors: unknown[] = [];
    const p = enqueueTurnTerminal({
      dataDir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' },
      onError: e => errors.push(e), retryBaseMs: 40, maxRetryMs: 80, maxAttempts: 50,
    });
    // Let a couple of attempts fail while the path is blocked.
    await new Promise(r => setTimeout(r, 120));
    expect(__testOnly_pendingTurnTerminalCount()).toBe(1); // still retrying, not dropped
    // Repair: remove the blocking file so the next attempt can create the dir + DB.
    rm(dataDir, { force: true });
    await p;
    expect(__testOnly_pendingTurnTerminalCount()).toBe(0);
    // A delivery + terminal now both exist; the completion event is present.
    const store = await getSkillFeedbackStore(dataDir);
    delivery(store, dataDir);
    expect(store.listTurnCompletionEvents().length).toBe(1);
    expect(errors.length).toBeGreaterThan(0); // transient failures were surfaced
  });

  it('surfaces a conflict when the same key is re-enqueued with a different status', async () => {
    const dir = freshDir();
    const store = await getSkillFeedbackStore(dir);
    delivery(store, dir);
    const errors: unknown[] = [];
    // First enqueue (completed) — hold it in flight by blocking the write lock.
    const blocker = await SkillFeedbackStore.open(dir);
    (blocker as any).db.exec('BEGIN IMMEDIATE;');
    const first = enqueueTurnTerminal({
      dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'completed' },
      retryBaseMs: 30, maxRetryMs: 60, maxAttempts: 100,
    });
    // Same key, different status → must surface a conflict, not silently reuse.
    const second = enqueueTurnTerminal({
      dataDir: dir, botAppId: 'app', sessionId: 'sess',
      terminal: { turnId: 'turn-1', dispatchAttempt: 0, status: 'failed' },
      onError: e => errors.push(e),
    });
    expect(second).toBe(first); // dedup still returns the in-flight promise
    expect(String(errors[0])).toContain('turn_terminal_status_conflict_enqueue');
    (blocker as any).db.exec('COMMIT;');
    await first;
    blocker.close();
  });
});
