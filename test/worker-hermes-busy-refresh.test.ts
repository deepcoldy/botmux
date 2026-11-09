import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drainHermesStateDb } from '../src/services/hermes-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

/** Execute the production one-second Hermes branch with a real queue. Only
 * external clock, transcript availability and CLI screen readiness are faked. */
function harness(options: { ready?: boolean; adopt?: boolean } = {}) {
  let now = 0;
  let timer: (() => void) | undefined;
  const queue = new CodexBridgeQueue(() => now);
  const dropped: string[] = [];
  const emitted: string[] = [];
  const logs: string[] = [];
  let pendingEvents: CodexBridgeEvent[] = [];
  const prune = () => {
    const removed = queue.pruneExpiredPreStartHeads();
    dropped.push(...removed.map(turn => turn.turnId));
    return removed.length > 0;
  };
  const scope: Record<string, unknown> = {
    codexBridgeTimer: undefined,
    codexBridgeQueue: queue,
    structuredBridgeIs: (id: string) => id === 'hermes',
    hermesBridgeBaselineDone: true,
    isPromptReady: options.ready ?? false,
    lastInitConfig: { cliId: 'hermes', adoptMode: options.adopt ?? false },
    CURSOR_BUSY_REFRESH_MAX_MS: 120_000,
    Date: { now: () => now },
    setInterval: (callback: () => void, interval: number) => {
      expect(interval).toBe(1_000);
      timer = callback;
      return 1;
    },
    // Hermes ingest has its own prune, BEFORE the tick's finally prune. This
    // catches refreshes mistakenly placed after the ingestion boundary.
    hermesBridgeIngest: () => {
      queue.ingest(pendingEvents);
      pendingEvents = [];
      prune();
    },
    pruneExpiredStructuredHeadsAndEmit: prune,
    emitReadyCodexTurns: () => emitted.push(...queue.drainEmittable().map(turn => turn.finalText ?? '')),
    log: (message: string) => { logs.push(message); },
  };
  loadWorkerFunction<() => void>('codexBridgeStartTimer', scope)();
  logs.length = 0;
  return {
    queue, dropped, emitted, scope,
    tick(at: number, events: CodexBridgeEvent[] = []) {
      now = at;
      pendingEvents = events;
      if (!timer) throw new Error('Worker ticker was not registered');
      timer();
      expect(logs).toEqual([]);
    },
  };
}

function mark(h: ReturnType<typeof harness>, confirmed: boolean) {
  h.queue.mark('synthetic-turn', 'synthetic complete prompt', 0);
  if (confirmed) h.queue.confirmPendingTurn('synthetic-turn', 0);
  else {
    h.queue.beginSubmitVerification('synthetic-turn', 0);
    h.queue.finishSubmitVerification('synthetic-turn', 0);
  }
}

describe('worker Hermes busy refresh with the real attribution queue', () => {
  for (const confirmed of [true, false]) {
    it(`keeps a ${confirmed ? 'confirmed' : 'attribution-only'} full prompt through a delayed busy transcript flush`, () => {
      const h = harness();
      mark(h, confirmed);
      // First observable tick is late as well: refresh must precede the prune
      // performed by hermesBridgeIngest, not only the ticker's finally block.
      h.tick(37_000);
      expect(h.dropped).toEqual([]);
      expect(h.queue.hasPendingTurn('synthetic-turn')).toBe(true);
      h.scope.isPromptReady = true;
      h.tick(45_000, [
        { kind: 'user', text: 'synthetic complete prompt', uuid: 'synthetic-user', timestampMs: 45_000, sourceSessionId: 'synthetic-native' },
        { kind: 'assistant_final', text: 'synthetic completion', uuid: 'synthetic-final', timestampMs: 45_001, sourceSessionId: 'synthetic-native' },
      ]);
      expect(h.dropped).toEqual([]);
      expect(h.emitted).toEqual(['synthetic completion']);
    });
  }

  it('keeps the ordinary twenty-second expiry when the CLI is ready but has no transcript turn', () => {
    const h = harness({ ready: true });
    mark(h, true);
    h.tick(20_000);
    expect(h.dropped).toEqual([]);
    h.tick(20_001);
    expect(h.dropped).toEqual(['synthetic-turn']);
  });

  it('does not change adopt timing or keep a false busy screen alive forever', () => {
    const adopt = harness({ adopt: true });
    mark(adopt, true);
    adopt.tick(20_001);
    expect(adopt.dropped).toEqual(['synthetic-turn']);

    const busy = harness();
    mark(busy, true);
    for (let at = 1_000; at <= 200_000; at += 1_000) busy.tick(at);
    expect(busy.dropped).toEqual(['synthetic-turn']);
    expect(busy.queue.peek()).toEqual([]);
  });

  it('stops refreshing after 120 seconds but preserves the final twenty-second tail lease', () => {
    const h = harness();
    mark(h, true);
    for (let at = 1_000; at <= 120_000; at += 1_000) h.tick(at);
    expect(h.queue.peek()[0]?.submitConfirmedAtMs).toBe(120_000);
    h.tick(120_001);
    expect(h.queue.peek()[0]?.submitConfirmedAtMs).toBe(120_000);
    expect(h.dropped).toEqual([]);
    h.tick(140_000);
    expect(h.dropped).toEqual([]);
    h.tick(140_001);
    expect(h.dropped).toEqual(['synthetic-turn']);
  });

  const sqliteAvailable = spawnSync('python3', ['-c', 'import sqlite3']).status === 0;
  for (const drainAt of [0, 37_000]) {
    (sqliteAvailable ? it : it.skip)(`keeps an already committed full user row until the first assistant response (drain at ${drainAt}ms)`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'hermes-busy-db-'));
      const db = join(dir, 'state.db');
      const prompt = '<session_id>synthetic-worker</session_id>\nsynthetic complete prompt';
      const append = (role: string, text: string, at: number) => {
        const proc = spawnSync('python3', ['-c', `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT)")
conn.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, ?, ?, ?, ?)",
             ('synthetic-native', sys.argv[2], sys.argv[3], float(sys.argv[4]) / 1000, 'stop' if sys.argv[2] == 'assistant' else None))
conn.commit()
conn.close()
`, db, role, text, String(at)], { encoding: 'utf8' });
        expect(proc.status).toBe(0);
      };
      try {
        const h = harness();
        h.queue.mark('synthetic-turn', prompt, 0);
        h.queue.confirmPendingTurn('synthetic-turn', 0);
        append('user', prompt, 0);
        // DB persistence and queue observation are distinct: the row is already
        // committed, with no assistant row. Only the drain may be delayed.
        const committed = drainHermesStateDb(0, db);
        expect(committed.events.map(event => event.kind)).toEqual(['user']);
        expect(committed.events[0]?.text).toBe(prompt);
        if (drainAt > 0) h.tick(20_001);
        h.tick(drainAt, drainHermesStateDb(0, db).events);
        expect(h.queue.peek()[0]?.started).toBe(true);
        expect(h.emitted).toEqual([]);
        for (let at = drainAt + 1_000; at < 234_000; at += 1_000) h.tick(at);
        expect(h.dropped).toEqual([]);
        expect(h.emitted).toEqual([]);
        expect(h.queue.hasPendingTurn('synthetic-turn')).toBe(true);
        append('assistant', 'synthetic delayed first response', 234_000);
        const response = drainHermesStateDb(committed.newOffset, db);
        h.scope.isPromptReady = true;
        h.tick(234_000, response.events);
        expect(h.emitted).toEqual(['synthetic delayed first response']);
        expect(h.dropped).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
