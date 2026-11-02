import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabaseSyncOrThrow, type DatabaseSyncLike } from '../src/services/sqlite-compat.js';
import * as sqliteCompat from '../src/services/sqlite-compat.js';
import { readLatestAntigravityRuntime } from '../src/services/antigravity-usage.js';
import { startAntigravityCot, stopAllAntigravityCot, stopAntigravityCot } from '../src/services/antigravity-cot.js';
import { withCardRuntimeIdentity } from '../src/core/card-runtime-identity.js';
import { buildReplyCardFooter } from '../src/im/lark/md-card.js';
import { antigravityModelMetadata } from './helpers/antigravity-metadata.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

let root: string;
let brainDir: string;
let conversationsDir: string;
const writers: DatabaseSyncLike[] = [];
function database(id: string, model?: string): DatabaseSyncLike {
  mkdirSync(conversationsDir, { recursive: true });
  const db = openDatabaseSyncOrThrow(join(conversationsDir, `${id}.db`));
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  writers.push(db);
  if (model !== undefined) insert(db, 1, model);
  return db;
}
function insert(db: DatabaseSyncLike, idx: number, model: string): void {
  db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(idx, antigravityModelMetadata(model));
}
function transcript(id: string): string {
  const dir = join(brainDir, id, '.system_generated', 'logs'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'transcript.jsonl'); writeFileSync(path, ''); return path;
}
const read = (id: string) => readLatestAntigravityRuntime(id, { conversationsDir });

beforeEach(() => {
  vi.useFakeTimers(); root = mkdtempSync(join(tmpdir(), 'agy-runtime-'));
  brainDir = join(root, 'native', 'brain'); conversationsDir = join(root, 'native', 'conversations');
});
afterEach(() => {
  stopAllAntigravityCot();
  for (const db of writers.splice(0)) db.close();
  vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});

describe('Antigravity native runtime model', () => {
  it('reads the newest model for the exact conversation, without token metrics', () => {
    const db = database('native-a', 'model-first'); insert(db, 4, 'model-current'); insert(db, 5, '');
    database('native-b', 'other-conversation');
    expect(read('native-a')).toEqual({ model: 'model-current' });
    expect(read('native-b')).toEqual({ model: 'other-conversation' });
  });

  it('keeps identity unknown when evidence is unavailable or the id is unsafe', () => {
    database('empty'); expect(read('empty')).toEqual({});
    for (const id of ['missing', '../native-a', '..', '', '/native-a']) expect(read(id)).toEqual({});
    expect(existsSync(join(conversationsDir, 'missing.db'))).toBe(false);
    writeFileSync(join(conversationsDir, 'invalid.db'), 'not sqlite'); expect(read('invalid')).toEqual({});
  });

  it('observes committed WAL model switches without relying on transcript writes', () => {
    const db = database('native-a'); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    insert(db, 1, 'model-first'); expect(read('native-a')).toEqual({ model: 'model-first' });
    insert(db, 2, 'model-next'); expect(read('native-a')).toEqual({ model: 'model-next' });
  });

  it('reports an initial model and DB-only changes even before a transcript exists', async () => {
    const db = database('native-a', 'model-first'); const onRuntime = vi.fn(); const onEntries = vi.fn();
    startAntigravityCot('native-a', onEntries, { brainDir, onRuntime, pollIntervalMs: 10 });
    expect(onRuntime).toHaveBeenLastCalledWith({ model: 'model-first' }); expect(onEntries).not.toHaveBeenCalled();
    insert(db, 2, 'model-next'); await vi.advanceTimersByTimeAsync(20);
    expect(onRuntime).toHaveBeenLastCalledWith({ model: 'model-next' }); expect(onEntries).not.toHaveBeenCalled();
  });

  it('does not reopen SQLite for an unchanged model, but sees WAL-only commits', async () => {
    const db = database('native-a'); db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    insert(db, 1, 'model-first'); const opened = vi.spyOn(sqliteCompat, 'openDatabaseSyncNow'); const onRuntime = vi.fn();
    startAntigravityCot('native-a', () => {}, { brainDir, onRuntime, pollIntervalMs: 10 });
    const initial = opened.mock.calls.length; expect(initial).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(100); expect(opened).toHaveBeenCalledTimes(initial);
    insert(db, 2, 'model-next'); await vi.advanceTimersByTimeAsync(20);
    expect(onRuntime).toHaveBeenLastCalledWith({ model: 'model-next' });
    expect(opened).toHaveBeenCalledTimes(initial + 1);
  });

  it('retries a transient failed read without requiring another file change', async () => {
    const db = database('native-a', 'model-first'); const opened = vi.spyOn(sqliteCompat, 'openDatabaseSyncNow'); const onRuntime = vi.fn();
    startAntigravityCot('native-a', () => {}, { brainDir, onRuntime, pollIntervalMs: 10 });
    insert(db, 2, 'model-next'); opened.mockReturnValueOnce(null);
    await vi.advanceTimersByTimeAsync(10); expect(onRuntime).toHaveBeenLastCalledWith({ model: 'model-first' });
    await vi.advanceTimersByTimeAsync(10); expect(onRuntime).toHaveBeenLastCalledWith({ model: 'model-next' });
  });

  it('keeps tool/thinking delivery working if the cosmetic model callback fails', async () => {
    database('native-a', 'model-first'); const path = transcript('native-a'); const entries = vi.fn();
    startAntigravityCot('native-a', entries, { brainDir, onRuntime: () => { throw new Error('cosmetic callback failure'); }, pollIntervalMs: 10 });
    appendFileSync(path, JSON.stringify({ type: 'PLANNER_RESPONSE', thinking: 'new thinking' }) + '\n');
    await vi.advanceTimersByTimeAsync(20);
    expect(entries).toHaveBeenCalledWith([{ kind: 'thinking', text: 'new thinking' }]);
  });

  it('wires the real worker model publisher to a footer without configured model, usage or turn authority', async () => {
    database('native-a', 'model-first'); const send = vi.fn(); const callbacks = new Map<string, (runtime: { model: string }) => void>();
    const scope: Record<string, any> = {
      antigravityCotReaderSessionId: undefined, stopAntigravityCot,
      startAntigravityCot: (id: string, entries: any, opts: any) => {
        callbacks.set(id, opts.onRuntime);
        return startAntigravityCot(id, entries, { ...opts, brainDir, pollIntervalMs: 10 });
      },
      currentBotmuxTurnId: undefined, currentBotmuxDispatchAttempt: undefined,
      lastInitConfig: { cliId: 'antigravity' }, observeCotEntries: vi.fn(), log: vi.fn(), send,
      activeRuntimePublished: false, publishedActiveRuntime: {},
      publishedAutoModelVariant: undefined, publishedAutoModelStateKey: undefined,
      traexAutoModelRuntimeEligible: () => false,
    };
    scope.publishActiveRuntime = loadWorkerFunction('publishActiveRuntime', scope);
    const ensure = loadWorkerFunction<(id: string) => void>('ensureAntigravityCotReader', scope);
    const latest = () => send.mock.calls.filter(([m]) => m.type === 'active_runtime').at(-1)![0];
    ensure('native-a'); expect(latest()).toMatchObject({ model: 'model-first' });
    const ds: any = { session: { cliId: 'antigravity' }, activeModel: latest().model };
    const usage = withCardRuntimeIdentity(ds, { context: null, tokens: null }, 'antigravity');
    expect(buildReplyCardFooter({ usage, presentation: { footerPreferences: { replyFooterUsage: false } } })?.content).toContain('model-first');
    expect(buildReplyCardFooter({ usage, presentation: { footerPreferences: { replyFooterModel: false } } })?.content).not.toContain('model-first');
    const count = send.mock.calls.length; await vi.advanceTimersByTimeAsync(20); expect(send).toHaveBeenCalledTimes(count);
    expect(scope.currentBotmuxTurnId).toBeUndefined(); expect(scope.observeCotEntries).not.toHaveBeenCalled();

    // A /new with no model evidence must clear the preceding identity. A late
    // callback from the retired reader cannot overwrite its successor.
    ensure('native-b'); expect(latest().model).toBeNull();
    callbacks.get('native-a')!({ model: 'retired-model' }); expect(latest().model).toBeNull();
    const next = database('native-b', 'model-next'); await vi.advanceTimersByTimeAsync(20);
    expect(latest().model).toBe('model-next');
    stopAntigravityCot('native-b'); insert(next, 2, 'model-after-stop');
    await vi.advanceTimersByTimeAsync(20); expect(latest().model).toBe('model-next');

    scope.lastInitConfig = { cliId: 'codex' };
    scope.publishActiveRuntime({ model: 'other-cli-model', reasoningEffort: 'high' });
    const beforeLateCallback = send.mock.calls.length;
    callbacks.get('native-b')!({ model: 'late-agy-model' });
    expect(send).toHaveBeenCalledTimes(beforeLateCallback);
    expect(latest()).toMatchObject({ model: 'other-cli-model', reasoningEffort: 'high' });
  });
});
