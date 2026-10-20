import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let tempDir: string;
vi.mock('../../config.js', () => ({ config: { session: { get dataDir() { return tempDir; } } } }));
vi.mock('../../utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { recordPending, recordInputCommit, recordCompleted, recordInterruptedStrict, recordFailedStrict,
  recordTerminalFailureStrict, recordSteerParked, supersedePendingTriggerByCompletedSuccessorStrict, lookupStrict } from '../../services/async-trigger-store.js';
import { projectTriggerInputCommit } from '../trigger-input-commit.js';
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'trigger-input-proof-')); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('exact native HTTP input commit', () => {
  function fixture() {
    recordPending('sid', 'trg_next', 1000, 'cli_owner');
    const session = { sessionId: 'sid', larkAppId: 'cli_owner', chatId: 'oc_chat', workerGeneration: 3 };
    const result = { ok: true, triggerId: 'trg_next', target: { kind: 'turn', sessionId: 'sid', chatId: 'oc_chat' } };
    const input = { ownerLarkAppId: 'cli_owner', sessionId: 'sid', triggerId: 'trg_next', session, result };
    return { session, result, input, read: () => lookupStrict('sid', 'trg_next') };
  }
  it('waits for an ACK and preserves the first generation on repeated observation', () => {
    const f = fixture();
    expect(projectTriggerInputCommit({ ...f.input, persisted: f.read() }).state).toBe('unknown');
    expect(recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 2000)).toBe(true);
    expect(recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 3000)).toBe(true);
    expect(recordInputCommit('sid', 'trg_next', 'cli_owner', 4, 4000)).toBe(false);
    expect(f.read()?.result.inputCommit).toEqual({ workerGeneration: 3, observedAt: 2000 });
    expect(projectTriggerInputCommit({ ...f.input, persisted: f.read() })).toEqual({ schemaVersion: 1, state: 'observed',
      larkAppId: 'cli_owner', sessionId: 'sid', chatId: 'oc_chat', triggerId: 'trg_next',
      workerGeneration: 3, committedAt: '1970-01-01T00:00:02.000Z' });
  });
  it('requires exact owner, trigger, session, chat and current Worker generation', () => {
    const f = fixture(); recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 2000);
    const original = readFileSync(join(tempDir, 'async-triggers/sid.json'));
    expect(recordInputCommit('sid', 'other', 'cli_owner', 3, 3000)).toBe(false);
    expect(recordInputCommit('sid', 'trg_next', 'cli_foreign', 3, 3000)).toBe(false);
    expect(readFileSync(join(tempDir, 'async-triggers/sid.json'))).toEqual(original);
    const input = { ...f.input, persisted: f.read() };
    for (const changed of [{ ownerLarkAppId: '' }, { ownerLarkAppId: 'cli_foreign' },
      { sessionId: 'other' }, { triggerId: 'trg_other' }, { triggerId: undefined },
      { session: undefined }, { session: { ...f.session, workerGeneration: 4 } },
      { persisted: undefined }, { result: { ...f.result, ok: false } },
      { result: { ...f.result, triggerId: 'trg_other' } },
      { result: { ...f.result, target: { ...f.result.target, sessionId: 'other' } } },
      { result: { ...f.result, target: { ...f.result.target, chatId: 'other' } } }]) {
      expect(projectTriggerInputCommit({ ...input, ...changed }).state).toBe('unknown');
    }
  });
  it('preserves the original queue fact across every terminal writer and cold reads', () => {
    const writers = [() => recordCompleted('sid', 'trg_next', 'done', 3000, 'cli_owner'),
      () => recordInterruptedStrict('sid', 'trg_next', 3000, 'cli_owner'),
      () => recordFailedStrict('sid', 'trg_next', 3000, 'cli_owner'),
      () => recordTerminalFailureStrict('sid', 'trg_next', 3000, 'cli_owner', 'test_terminal')];
    for (const finish of writers) {
      const f = fixture(); recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 2000); finish();
      const value = JSON.parse(readFileSync(join(tempDir, 'async-triggers/sid.json'), 'utf8'));
      expect(value.results.trg_next.inputCommit).toEqual({ workerGeneration: 3, observedAt: 2000 });
      expect(f.read()?.result.inputCommit).toEqual(value.results.trg_next.inputCommit);
    }
  });
  it('retains the exact source ACK when parked or superseded by another result', () => {
    fixture(); recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 2000);
    recordSteerParked('sid', 'trg_next', 'trg_successor', 2500, 'cli_owner');
    expect(lookupStrict('sid', 'trg_next')?.result.inputCommit?.observedAt).toBe(2000);
    fixture(); recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 2000);
    recordPending('sid', 'trg_successor', 2500, 'cli_owner');
    recordCompleted('sid', 'trg_successor', 'done', 3000, 'cli_owner');
    expect(supersedePendingTriggerByCompletedSuccessorStrict('sid', 'trg_next', 'trg_successor', 4000, 'cli_owner')).toBe('superseded');
    expect(lookupStrict('sid', 'trg_next')?.result.inputCommit?.observedAt).toBe(2000);
  });
  it('does not manufacture late acceptance for a terminal or corrupt record', () => {
    fixture(); recordCompleted('sid', 'trg_next', 'done', 3000, 'cli_owner');
    expect(recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 4000)).toBe(false);
    writeFileSync(join(tempDir, 'async-triggers/sid.json'), '{broken');
    expect(() => recordInputCommit('sid', 'trg_next', 'cli_owner', 3, 4000)).toThrow();
    expect(readFileSync(join(tempDir, 'async-triggers/sid.json'), 'utf8')).toBe('{broken');
  });
});
