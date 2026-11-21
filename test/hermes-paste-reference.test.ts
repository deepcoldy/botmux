import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hermesTranscript from '../src/services/hermes-transcript.js';
import { filterHermesEventsForBotmuxSession } from '../src/services/hermes-session-filter.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const pythonAvailable = spawnSync('python3', ['-c', 'import sqlite3']).status === 0;
const sqliteTest = pythonAvailable ? it : it.skip;
const posixTest = pythonAvailable && process.platform !== 'win32' ? it : it.skip;

// Operator escape hatches a non-UTF-8 daemon locale used to rely on. -I implies
// -E and would ignore them; -X utf8 on the argv must restore UTF-8 regardless.
// The case only means something when this host actually selects a non-UTF-8
// codec for the hostile locale — minimal images with just C/C.utf8 skip it.
function hostileLocaleSelectable(): boolean {
  const proc = spawnSync('python3', ['-I', '-c', 'import sys; print(sys.stdout.encoding)'], {
    encoding: 'utf8',
    env: { ...process.env, LANG: '', LC_ALL: 'en_US.iso885915', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  return proc.status === 0 && !proc.stdout.trim().toLowerCase().startsWith('utf');
}
const localeTest = pythonAvailable && process.platform !== 'win32' && hostileLocaleSelectable() ? it : it.skip;

function withHostileLocale<T>(fn: () => T): T {
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, PYTHONUTF8: process.env.PYTHONUTF8, PYTHONIOENCODING: process.env.PYTHONIOENCODING };
  process.env.LANG = '';
  process.env.LC_ALL = 'en_US.iso885915';
  process.env.PYTHONUTF8 = '1';
  process.env.PYTHONIOENCODING = 'utf-8';
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const dirs: string[] = [];
const epoch = 1_700_000_000_000;
const marker = '<session_id>synthetic-worker-a</session_id>';
const question = Array.from({ length: 8 }, (_, i) => `synthetic question line ${i}: preserve the full prompt`).join('\n');
const request = marker + '\n' + question;

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FixtureRow {
  session: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  finish?: string;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-paste-reference-'));
  dirs.push(dir);
  const home = join(dir, 'profile');
  mkdirSync(join(home, 'pastes'), { recursive: true });
  const db = join(home, 'state.db');
  const proc = spawnSync('python3', ['-c', `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, finish_reason TEXT)")
conn.commit()
conn.close()
`, db], { encoding: 'utf8' });
  if (proc.status !== 0) throw new Error('SQLite fixture setup failed');
  return { dir, home, db };
}

function insert(db: string, rows: FixtureRow[]): void {
  const proc = spawnSync('python3', ['-c', `
import sqlite3, json, sys
conn = sqlite3.connect(sys.argv[1])
for row in json.load(sys.stdin):
    conn.execute("INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, ?, ?, ?, ?)",
                 (row['session'], row['role'], row['content'], row['timestamp'], row.get('finish')))
conn.commit()
conn.close()
`, db], { input: JSON.stringify(rows), encoding: 'utf8' });
  if (proc.status !== 0) throw new Error('SQLite fixture insertion failed');
}

function ref(path: string, text: string, number = 1) {
  return `[Pasted text #${number}: ${text.split('\n').length} lines → ${path}]`;
}

function paste(home: string, text: string, number = 1, bom = false) {
  const path = join(home, 'pastes', `paste_${number}_120000.txt`);
  writeFileSync(path, (bom ? '\ufeff' : '') + text, 'utf8');
  return ref(path, text, number);
}

/** Real raw SQLite/filter binding, not a recovered marker or filename guess. */
function initialBinding(f: ReturnType<typeof fixture>) {
  insert(f.db, [{ session: 'native-a', role: 'user', content: marker + '\nprevious synthetic input', timestamp: epoch / 1000 - 1 }]);
  const raw = hermesTranscript.drainHermesStateDb(0, f.db);
  const filtered = filterHermesEventsForBotmuxSession(raw.events, { botmuxSessionId: 'synthetic-worker-a' });
  expect(filtered.boundSourceSessionId).toBe('native-a');
  return { offset: raw.newOffset, bound: filtered.boundSourceSessionId };
}

/** Execute the real Hermes worker consumer with actual SQLite/filter/queue.
 * Clock and outbound IPC are the only external boundaries substituted. */
function worker(f: ReturnType<typeof fixture>, binding?: ReturnType<typeof initialBinding>, expected = question) {
  let now = epoch;
  const queue = new CodexBridgeQueue(() => now);
  queue.mark('synthetic-turn-a', expected, now);
  queue.confirmPendingTurn('synthetic-turn-a', now);
  const ingest = vi.spyOn(queue, 'ingest');
  const bound: string[] = [];
  const scope: Record<string, unknown> = {
    ...hermesTranscript,
    hermesBridgeBaselineDone: true,
    hermesBridgeOffset: binding?.offset ?? 0,
    hermesBridgeSourceSessionId: binding?.bound,
    currentHermesBridgeDbPath: () => f.db,
    sessionId: 'synthetic-worker-a',
    filterHermesEventsForBotmuxSession,
    codexBridgeQueue: queue,
    persistCliSessionId: (id: string) => bound.push(id),
    send: vi.fn(),
    log: vi.fn(),
    Date: { now: () => now },
    pruneExpiredStructuredHeadsAndEmit: () => queue.pruneExpiredPreStartHeads().length > 0,
    idleDetector: undefined,
  };
  const run = loadWorkerFunction<() => void>('hermesBridgeIngest', scope);
  return { queue, scope, bound, ingest, run, advance: (ms: number) => { now += ms; } };
}

describe('Hermes: raw source authorization precedes paste recovery', () => {
  posixTest('restores a folded user from an already raw-bound source and preserves mark time through its final', () => {
    const f = fixture();
    const h = worker(f, initialBinding(f));
    insert(f.db, [{ session: 'native-a', role: 'user', content: paste(f.home, request), timestamp: epoch / 1000 }]);
    h.run();
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(request);
    expect(h.queue.peek()[0]?.started).toBe(true);
    expect(h.queue.peek()[0]?.markTimeMs).toBe(epoch);
    h.advance(30_000);
    expect(h.queue.pruneExpiredPreStartHeads()).toEqual([]);
    insert(f.db, [{ session: 'native-a', role: 'assistant', content: 'synthetic final answer', timestamp: epoch / 1000 + 30, finish: 'stop' }]);
    h.run();
    expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.finalText, turn.markTimeMs])).toEqual([
      ['synthetic-turn-a', 'synthetic final answer', epoch],
    ]);
    expect(h.scope.hermesBridgeOffset).toBe(3);
    h.run();
    expect(h.queue.drainEmittable()).toEqual([]);
  });

  posixTest('binds an inline raw marker before restoring BOM and JSON-wrapped multiple references', () => {
    const f = fixture();
    const one = paste(f.home, 'first\nsecond', 1, true);
    const two = paste(f.home, 'third\nfourth', 2);
    const text = `${marker}\nprefix\n${one}\nseparator\n${two}\nsuffix`;
    const expected = `${marker}\nprefix\nfirst\nsecond\nseparator\nthird\nfourth\nsuffix`;
    const h = worker(f, undefined, 'first\nsecond');
    insert(f.db, [{ session: 'native-a', role: 'user', content: String.fromCharCode(0) + 'json:' + JSON.stringify([{ text }]), timestamp: epoch / 1000 }]);
    h.run();
    expect(h.bound).toEqual(['native-a']);
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(expected);
    expect(h.queue.peek()[0]?.started).toBe(true);
  });

  posixTest('never rebinds from a recovered marker when a foreign native row copies a valid owned paste reference', () => {
    const f = fixture();
    const binding = initialBinding(f);
    const stolen = paste(f.home, request);
    const h = worker(f, binding);
    insert(f.db, [
      { session: 'native-b', role: 'user', content: stolen, timestamp: epoch / 1000 },
      { session: 'native-b', role: 'assistant', content: 'foreign synthetic answer', timestamp: epoch / 1000 + 1, finish: 'stop' },
    ]);
    h.run();
    expect(h.scope.hermesBridgeSourceSessionId).toBe('native-a');
    expect(h.bound).toEqual([]);
    expect(h.ingest.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(h.queue.peek()[0]?.started).toBe(false);
    expect(h.queue.drainEmittable()).toEqual([]);
  });

  sqliteTest('fails closed for an unbound first turn whose entire marker is folded', () => {
    const f = fixture();
    const h = worker(f);
    insert(f.db, [
      { session: 'native-a', role: 'user', content: paste(f.home, request), timestamp: epoch / 1000 },
      { session: 'native-a', role: 'assistant', content: 'unproven synthetic final', timestamp: epoch / 1000 + 1, finish: 'stop' },
    ]);
    h.run();
    expect(h.scope.hermesBridgeSourceSessionId).toBeUndefined();
    expect(h.bound).toEqual([]);
    expect(h.queue.drainEmittable()).toEqual([]);
  });

  for (const invalid of ['outside', 'sibling-profile', 'dot-dot', 'prefix-sibling', 'directory-symlink', 'world-writable', 'fifo', 'symlink', 'hardlink', 'wrong-counter', 'wrong-lines', 'missing', 'oversize', 'invalid-utf8']) {
    posixTest(`preserves the whole original user on ${invalid} references without starting a truncated match`, () => {
      const f = fixture();
      const h = worker(f, initialBinding(f));
      const ordinary = join(f.home, 'pastes', 'paste_1_120000.txt');
      writeFileSync(ordinary, request);
      let path = ordinary;
      let value = ref(path, request);
      if (invalid === 'outside' || invalid === 'sibling-profile') {
        const folder = join(f.dir, invalid);
        mkdirSync(folder);
        path = join(folder, 'paste_1_120000.txt');
        writeFileSync(path, request);
        value = ref(path, request);
      } else if (invalid === 'dot-dot') value = ref(join(f.home, 'pastes') + '/../pastes/paste_1_120000.txt', request);
      else if (invalid === 'prefix-sibling') {
        const sibling = join(f.home, 'pastes-other');
        mkdirSync(sibling);
        path = join(sibling, 'paste_1_120000.txt');
        writeFileSync(path, request);
        value = ref(path, request);
      } else if (invalid === 'directory-symlink') {
        const foreign = join(f.dir, 'foreign-pastes');
        mkdirSync(foreign);
        writeFileSync(join(foreign, 'paste_1_120000.txt'), request);
        rmSync(join(f.home, 'pastes'), { recursive: true });
        symlinkSync(foreign, join(f.home, 'pastes'));
      } else if (invalid === 'world-writable') chmodSync(ordinary, 0o666);
      else if (invalid === 'fifo') {
        rmSync(ordinary);
        const created = spawnSync('python3', ['-c', 'import os,sys; os.mkfifo(sys.argv[1], 0o600)', ordinary]);
        expect(created.status).toBe(0);
      } else if (invalid === 'symlink' || invalid === 'hardlink') {
        const linked = join(f.home, 'pastes', 'paste_2_120000.txt');
        if (invalid === 'symlink') symlinkSync(ordinary, linked);
        else linkSync(ordinary, linked);
        value = ref(linked, request, 2);
      } else if (invalid === 'wrong-counter') value = ref(ordinary, request, 2);
      else if (invalid === 'wrong-lines') value = value.replace('9 lines', '8 lines');
      else if (invalid === 'missing') { rmSync(ordinary); }
      else if (invalid === 'oversize') writeFileSync(ordinary, 'x'.repeat(1024 * 1024 + 1));
      else if (invalid === 'invalid-utf8') writeFileSync(ordinary, Buffer.from([0xff, 0xfe]));
      insert(f.db, [{ session: 'native-a', role: 'user', content: value, timestamp: epoch / 1000 }]);
      h.run();
      expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(value);
      expect(h.queue.peek()[0]?.started).toBe(false);
    });
  }

  posixTest('does not publish partial recovery when a later required reference is missing', () => {
    const f = fixture();
    const h = worker(f, initialBinding(f));
    const valid = paste(f.home, question, 1);
    const missing = ref(join(f.home, 'pastes', 'paste_2_120000.txt'), 'absent', 2);
    const original = `${valid}\n${missing}`;
    insert(f.db, [{ session: 'native-a', role: 'user', content: original, timestamp: epoch / 1000 }]);
    h.run();
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(original);
    expect(h.queue.peek()[0]?.started).toBe(false);
  });

  posixTest('accepts the exact one-MiB file cap without truncating its content', () => {
    const f = fixture();
    const h = worker(f, initialBinding(f));
    const text = request + 'x'.repeat(1024 * 1024 - Buffer.byteLength(request));
    insert(f.db, [{ session: 'native-a', role: 'user', content: paste(f.home, text), timestamp: epoch / 1000 }]);
    h.run();
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(text);
    expect(h.queue.peek()[0]?.started).toBe(true);
  });

  posixTest('rejects too many references and an oversized expanded user as whole inputs', () => {
    for (const mode of ['references', 'bytes']) {
      const f = fixture();
      const h = worker(f, initialBinding(f));
      const text = mode === 'bytes' ? question + 'x'.repeat(1024 * 1024 - Buffer.byteLength(question)) : question;
      const count = mode === 'bytes' ? 5 : 9;
      const original = Array.from({ length: count }, (_, i) => paste(f.home, text, i + 1)).join('\n');
      insert(f.db, [{ session: 'native-a', role: 'user', content: original, timestamp: epoch / 1000 }]);
      h.run();
      expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(original);
      expect(h.queue.peek()[0]?.started).toBe(false);
    }
  });

  posixTest('preserves legitimate raw-marker source rotation and both sources\' final attribution', () => {
    const f = fixture();
    const h = worker(f, initialBinding(f));
    const fresh = 'fresh synthetic question after source rotation';
    h.queue.mark('synthetic-rotated', fresh, epoch);
    h.queue.confirmPendingTurn('synthetic-rotated', epoch);
    insert(f.db, [
      { session: 'native-a', role: 'user', content: paste(f.home, request, 1), timestamp: epoch / 1000 },
      { session: 'native-a', role: 'assistant', content: 'answer a', timestamp: epoch / 1000 + 1, finish: 'stop' },
      { session: 'native-c', role: 'user', content: `${marker}\n${paste(f.home, fresh, 2)}`, timestamp: epoch / 1000 + 2 },
      { session: 'native-c', role: 'assistant', content: 'answer c', timestamp: epoch / 1000 + 3, finish: 'stop' },
    ]);
    h.run();
    expect(h.bound).toEqual(['native-c']);
    expect(h.scope.hermesBridgeSourceSessionId).toBe('native-c');
    expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.finalText, turn.sourceSessionId])).toEqual([
      ['synthetic-turn-a', 'answer a', 'native-a'], ['synthetic-rotated', 'answer c', 'native-c'],
    ]);
  });

  posixTest('does not execute modules planted in the session working directory (python -I)', () => {
    const f = fixture();
    const h = worker(f, initialBinding(f));
    const hostile = mkdtempSync(join(tmpdir(), 'hermes-paste-hostile-'));
    dirs.push(hostile);
    const canary = join(hostile, 'pwned');
    // The worker runs with cwd = the user-controlled session project dir.
    // A shadow stdlib module there must never execute inside the unsandboxed
    // recovery process. It stays transparent (re-exports the real json) so a
    // regression reaches the canary without a different failure shape.
    writeFileSync(join(hostile, 'json.py'), [
      'import os, sys',
      `open(${JSON.stringify(canary)}, 'w').write('executed ' + __file__)`,
      "sys.path[:] = [p for p in sys.path if p not in ('', os.getcwd())]",
      "del sys.modules['json']",
      'import json as _real_json',
      'loads, dumps = _real_json.loads, _real_json.dumps',
      '',
    ].join('\n'));
    insert(f.db, [{ session: 'native-a', role: 'user', content: paste(f.home, request), timestamp: epoch / 1000 }]);
    const previousCwd = process.cwd();
    process.chdir(hostile);
    try {
      h.run();
    } finally {
      process.chdir(previousCwd);
    }
    expect(existsSync(canary)).toBe(false);
    // Positive control: isolated mode must not break normal recovery.
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(request);
    expect(h.queue.peek()[0]?.started).toBe(true);
  });

  localeTest('drains non-ASCII rows under a non-UTF-8 locale despite -I ignoring PYTHONUTF8 (-X utf8)', () => {
    const f = fixture();
    insert(f.db, [{ session: 'native-a', role: 'user', content: '绑定行：中文用户消息', timestamp: epoch / 1000 }]);
    // master relied on PYTHONUTF8/PYTHONIOENCODING here; -I implies -E, so only
    // the CLI-forced UTF-8 mode keeps this print from killing the whole drain.
    const drained = withHostileLocale(() => hermesTranscript.drainHermesStateDb(0, f.db));
    expect(drained.events[0]?.text).toBe('绑定行：中文用户消息');
  });

  localeTest('restores a non-ASCII folded paste under a non-UTF-8 locale (arrow argv + stdout)', () => {
    const f = fixture();
    const chinese = '中文问题：请保留完整正文\n第二行尾';
    const requestCn = marker + '\n' + chinese;
    const h = worker(f, initialBinding(f), chinese);
    insert(f.db, [{ session: 'native-a', role: 'user', content: paste(f.home, requestCn), timestamp: epoch / 1000 }]);
    // Without -X utf8 the U+2192 literal in the -c script cannot be decoded
    // from argv and the process exits 1: the whole turn silently keeps its
    // placeholder and never matches.
    withHostileLocale(() => h.run());
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(requestCn);
    expect(h.queue.peek()[0]?.started).toBe(true);
  });

  posixTest('does not recursively restore recovered references or read assistant references', () => {
    const f = fixture();
    const inner = paste(f.home, question, 2);
    const outer = paste(f.home, inner, 1);
    const h = worker(f, initialBinding(f));
    insert(f.db, [{ session: 'native-a', role: 'user', content: outer, timestamp: epoch / 1000 }]);
    h.run();
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(inner);
    expect(h.queue.peek()[0]?.started).toBe(false);
    insert(f.db, [{ session: 'native-a', role: 'assistant', content: inner, timestamp: epoch / 1000 + 1, finish: 'stop' }]);
    h.run();
    expect(h.ingest.mock.calls.at(-1)?.[0][0]?.text).toBe(inner);
  });

  posixTest('restores a budget-valid user when JSON escaping exceeds ten MiB', () => {
    const f = fixture();
    const firstPrefix = 'synthetic escaped payload must keep its attribution\n';
    const first = firstPrefix + '\u0000'.repeat(1024 * 1024 - Buffer.byteLength(firstPrefix));
    const second = '\u0000'.repeat(1024 * 1024);
    const expected = first + '\n' + second;
    // Valid UTF-8 controls cost one recovered byte but six JSON wire bytes.
    // The original capture cap must not silently discard this valid recovery.
    expect(Buffer.byteLength(expected)).toBeLessThan(4 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(10 * 1024 * 1024);
    const h = worker(f, initialBinding(f), expected);
    const original = paste(f.home, first, 1) + '\n' + paste(f.home, second, 2);
    insert(f.db, [{ session: 'native-a', role: 'user', content: original, timestamp: epoch / 1000 }]);
    h.run();
    expect(h.scope.hermesBridgeOffset).toBe(2);
    const recovered = h.ingest.mock.calls.at(-1)?.[0][0]?.text ?? '';
    // Digest/length keep a regression failure from logging megabytes of data.
    expect(Buffer.byteLength(recovered)).toBe(Buffer.byteLength(expected));
    expect(createHash('sha256').update(recovered).digest('hex'))
      .toBe(createHash('sha256').update(expected).digest('hex'));
    expect(h.queue.peek()[0]?.started).toBe(true);
    h.advance(30_000);
    expect(h.queue.pruneExpiredPreStartHeads()).toEqual([]);
    insert(f.db, [{ session: 'native-a', role: 'assistant', content: 'synthetic escaped payload completion', timestamp: epoch / 1000 + 30, finish: 'stop' }]);
    h.run();
    expect(h.queue.drainEmittable().map(turn => [turn.turnId, turn.finalText])).toEqual([
      ['synthetic-turn-a', 'synthetic escaped payload completion'],
    ]);
  });
});
