import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexSessionIdFromRolloutPath, drainCodexRollout, findCodexRolloutBySessionId } from '../src/services/codex-transcript.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { codexConsumedRolloutEvents, codexEventsWithStableIds } from '../src/services/codex-rollout-replay.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';

const SID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
let home: string;
const line = (value: unknown) => JSON.stringify(value) + '\n';
const meta = (sid = SID) => line({ type: 'session_meta', payload: { id: sid } });

function metaWithByteLength(id: string, bytes: number): string {
  const record = { type: 'session_meta', payload: { id, base_instructions: { text: '' } } };
  record.payload.base_instructions.text = 'x'.repeat(bytes - Buffer.byteLength(line(record)));
  return line(record);
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'codex-generation-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function rollout(day: string, suffix = '', sid = SID, content = meta(sid)): string {
  const dir = join(home, 'sessions', '2026', '09', day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-${day}T01-00-00-${sid}${suffix}.jsonl`);
  writeFileSync(path, content);
  return path;
}

function index(path: string): void {
  const db = openDatabaseSyncOrThrow(join(home, 'state_5.sqlite'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?)').run(SID, path);
  } finally { db.close(); }
}

describe('Codex rollout generations', () => {
  it('extracts the original session id from a suffixed filename, never the generation id', () => {
    const path = rollout('30', `_${GENERATION}`);
    expect(codexSessionIdFromRolloutPath(path)).toBe(SID);
    expect(codexSessionIdFromRolloutPath(path.replace('.jsonl', '_bad.jsonl'))).toBeUndefined();
    expect(codexSessionIdFromRolloutPath(join(path, 'unrelated.jsonl'))).toBeUndefined();
    expect(findCodexRolloutBySessionId(GENERATION, { codexHome: home })).toBeUndefined();
  });

  it('prefers the exact indexed path even over a later filename or mtime', () => {
    const active = rollout('29', `_${GENERATION}`);
    const stale = rollout('30');
    utimesSync(stale, new Date('2030-01-01'), new Date('2030-01-01'));
    index(active);
    expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(active);
    index(stale);
    expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(stale);
  });

  it.each([65_535, 65_536, 65_537, 70 * 1024])(
    'keeps the indexed generation authoritative with a %i-byte session_meta line', bytes => {
      // A large base_instructions payload is still a valid session_meta row.
      // The index may point at an older filename, as in the small-header case.
      const active = rollout('29', `_${GENERATION}`, SID, metaWithByteLength(SID, bytes));
      rollout('30');
      index(active);
      expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(active);
    },
  );

  it.each([false, true])(
    'rejects a conflicting session_meta id even in a large header (noFollow=%s)', noFollow => {
      const owned = rollout('29');
      const foreign = rollout('30', `_${GENERATION}`, SID, metaWithByteLength(FOREIGN, 70 * 1024));
      index(foreign);
      expect(findCodexRolloutBySessionId(SID, { codexHome: home, noFollow })).toBe(owned);
    },
  );

  it.each(['absent', 'corrupt', 'missing table', 'missing file'])('falls back when the index is %s', state => {
    const old = rollout('29');
    const active = rollout('30', `_${GENERATION}`);
    utimesSync(old, new Date('2030-01-01'), new Date('2030-01-01'));
    if (state === 'corrupt') writeFileSync(join(home, 'state_5.sqlite'), 'not sqlite');
    if (state === 'missing table') openDatabaseSyncOrThrow(join(home, 'state_5.sqlite')).close();
    if (state === 'missing file') index(join(home, 'missing.jsonl'));
    expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(active);
  });

  it('rejects a foreign session even when the index points to it', () => {
    const active = rollout('29');
    index(rollout('30', `_${GENERATION}`, FOREIGN));
    expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(active);
    index(rollout('30', `_${GENERATION}`, SID, meta(FOREIGN)));
    expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(active);
  });

  it('rejects an indexed path outside this home and skips symlink traversal in noFollow mode', () => {
    const active = rollout('29');
    const outside = join(home, `rollout-2026-09-30T01-00-00-${SID}_${GENERATION}.jsonl`);
    writeFileSync(outside, meta());
    index(outside);
    expect(findCodexRolloutBySessionId(SID, { codexHome: home })).toBe(active);
    symlinkSync(outside, join(home, 'sessions', `rollout-2026-09-30T01-00-00-${SID}_${GENERATION}.jsonl`));
    expect(findCodexRolloutBySessionId(SID, { codexHome: home, noFollow: true })).toBe(active);
  });

  it('resolves suffixed files in noFollow BOT_HOME without opening an untrusted SQLite index', () => {
    const old = rollout('29');
    const active = rollout('30', `_${GENERATION}`);
    index(old);
    expect(findCodexRolloutBySessionId(SID, { codexHome: home, noFollow: true })).toBe(active);
  });
});

const start = (turn: string, timestamp: string) => line({ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turn } });
const user = (text: string, timestamp: string) => line({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const final = (turn: string, text: string, timestamp: string) => line({ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: text } });
const T0 = '2026-09-30T01:00:00Z';
const T1 = '2026-09-30T01:00:01Z';
const T2 = '2026-09-30T01:00:02Z';

describe('Codex bridge replay across file generations', () => {
  it.each(['missing', 'invalid', 'valid'] as const)(
    'does not create a blocking local turn when replaying history with %s timestamps', timestampCase => {
      const timestamp = timestampCase === 'missing' ? undefined
        : timestampCase === 'invalid' ? 'not-a-timestamp' : T0;
      const history = line({ timestamp, type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'completed work' }],
      } }) + line({ timestamp, type: 'event_msg', payload: {
        type: 'task_complete', turn_id: 'completed-turn', last_agent_message: 'finished',
      } });
      const old = rollout('29', '', SID, meta() + history);
      const next = rollout('30', `_${GENERATION}`, SID, meta() + history);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(T0));
      try {
        const q = new CodexBridgeQueue();
        q.setLocalTurns(true, Date.parse(T0));
        const consumed = drainCodexRollout(old, 0);
        q.ingest(codexEventsWithStableIds(old, consumed.events));
        expect(q.drainEmittable().map(turn => turn.finalText)).toEqual(['finished']);
        expect(q.hasBlockingTurn()).toBe(false);
        q.absorb(codexConsumedRolloutEvents(old, consumed.newOffset));

        // Real polling drains happen at different wall-clock times. The same
        // copied records must remain historical across those drains, including
        // the parser's supported missing/invalid-timestamp fallback path.
        clock.mockReturnValue(Date.parse(T0) + 1_000);
        q.ingest(codexEventsWithStableIds(next, drainCodexRollout(next, 0).events));
        expect(q.drainEmittable()).toEqual([]);
        expect(q.hasBlockingTurn()).toBe(false);
        expect(q.peek()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('keeps a collecting turn and emits its new final exactly once despite copied user/start records', () => {
    const q = new CodexBridgeQueue();
    q.mark('delivery', 'continue work', Date.parse(T0));
    const history = start('native-turn', T0) + user('continue work', T1);
    const old = rollout('29', '', SID, meta() + history);
    q.ingest(codexEventsWithStableIds(old, drainCodexRollout(old, 0).events));
    expect(q.peek()[0].started).toBe(true);
    const next = rollout('30', `_${GENERATION}`, SID, meta() + '\n' + history + final('native-turn', 'finished', T2));
    const events = codexEventsWithStableIds(next, drainCodexRollout(next, 0).events);
    q.ingest(events);
    expect(q.drainEmittable()).toEqual([expect.objectContaining({ turnId: 'delivery', finalText: 'finished' })]);
    q.ingest(events);
    expect(q.drainEmittable()).toEqual([]);
    expect(q.peek()).toEqual([]);
  });

  it('suppresses baseline history but does not absorb a terminal beyond the consumed cursor', () => {
    const q = new CodexBridgeQueue();
    q.setLocalTurns(true, 0);
    const history = start('old', T0) + user('previous', T0) + final('old', 'old answer', T1);
    const old = rollout('29', '', SID, meta() + history);
    const offset = drainCodexRollout(old, 0).newOffset;
    const live = start('new', T2) + user('new work', T2) + final('new', 'new answer', T2);
    appendFileSync(old, live);
    q.absorb(codexConsumedRolloutEvents(old, offset));
    const next = rollout('30', `_${GENERATION}`, SID, meta() + history + live);
    q.ingest(codexEventsWithStableIds(next, drainCodexRollout(next, 0).events));
    expect(q.drainEmittable().map(turn => turn.finalText)).toEqual(['new answer']);
  });

  it('keeps event identities separate for sibling sessions and repeated text at different timestamps', () => {
    const first = rollout('29', '', SID, user('same text', T0) + user('same text', T1));
    const sibling = rollout('30', '', FOREIGN, user('same text', T0));
    const a = codexEventsWithStableIds(first, drainCodexRollout(first, 0).events);
    const b = codexEventsWithStableIds(sibling, drainCodexRollout(sibling, 0).events);
    expect(new Set([...a, ...b].map(event => event.uuid)).size).toBe(3);
  });

  it('does not lose a final whose incomplete old line completes in the new generation', () => {
    const q = new CodexBridgeQueue();
    q.mark('delivery', 'work', Date.parse(T0));
    const history = start('turn', T0) + user('work', T1);
    const terminal = final('turn', 'done', T2);
    const old = rollout('29', '', SID, meta() + history + terminal.slice(0, -1));
    const consumed = drainCodexRollout(old, 0);
    q.ingest(codexEventsWithStableIds(old, consumed.events));
    q.absorb(codexConsumedRolloutEvents(old, consumed.newOffset));
    const next = rollout('30', `_${GENERATION}`, SID, meta() + history + terminal);
    q.ingest(codexEventsWithStableIds(next, drainCodexRollout(next, 0).events));
    expect(q.drainEmittable()).toEqual([expect.objectContaining({ turnId: 'delivery', finalText: 'done' })]);
  });

  it('deduplicates previously ingested events even if the retired file has been removed', () => {
    const q = new CodexBridgeQueue();
    q.setLocalTurns(true, 0);
    const history = start('old', T0) + user('work', T0) + final('old', 'done', T1);
    const old = rollout('29', '', SID, meta() + history);
    const consumed = drainCodexRollout(old, 0);
    q.ingest(codexEventsWithStableIds(old, consumed.events));
    expect(q.drainEmittable()).toHaveLength(1);
    rmSync(old);
    q.absorb(codexConsumedRolloutEvents(old, consumed.newOffset));
    const next = rollout('30', `_${GENERATION}`, SID, meta() + history);
    q.ingest(codexEventsWithStableIds(next, drainCodexRollout(next, 0).events));
    expect(q.drainEmittable()).toEqual([]);
    expect(q.peek()).toEqual([]);
  });
});
