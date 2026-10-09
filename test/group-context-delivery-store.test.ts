import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindGroupContextDelivery,
  confirmGroupContextDelivery,
  getDeliveredGroupContextSeqs,
  readGroupContextDeliveryBinding,
  readPreparedGroupContext,
  recordNativeGroupContextDelivery,
  promoteGroupContextDeliveryEpoch,
  bindGroupContextWorkerGeneration,
  writePreparedGroupContext,
  type GroupContextDeliveryBinding,
  type PreparedGroupContext,
} from '../src/services/group-context-delivery-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { spawnSyncTsEvalWithRepoImports, spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const roots: string[] = [];
const DAY = 86_400_000;

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-group-context-delivery-'));
  roots.push(dir);
  return dir;
}

function bundle(overrides: Partial<PreparedGroupContext> = {}): PreparedGroupContext {
  return {
    appId: 'app-one', chatId: 'chat-one', turnId: 'turn-one',
    createdAt: Date.now(), body: '<shared_group_context>Frozen excerpt</shared_group_context>',
    includedSeqs: [2, 5], throughSeq: 9, incomplete: true,
    ...overrides,
  };
}

function binding(overrides: Partial<GroupContextDeliveryBinding> = {}): GroupContextDeliveryBinding {
  return {
    appId: 'app-one', chatId: 'chat-one', turnId: 'turn-one',
    sessionId: 'session-one', epoch: 'native-one', ...overrides,
  };
}

function delivered(dir: string, overrides: Partial<GroupContextDeliveryBinding> = {}): number[] {
  const value = binding(overrides);
  return getDeliveredGroupContextSeqs(value.appId, value.chatId, value.sessionId, value.epoch, dir);
}

describe('group context frozen bundles', () => {
  it('freezes same-turn snapshots independently for replacement native epochs and keeps old coverage', () => {
    const dir = dataDir();
    const first = bundle({ epoch: 'native-one', body: '', includedSeqs: [], throughSeq: 0, nativeInputSeqs: [11] });
    writePreparedGroupContext(first, dir);
    bindGroupContextDelivery(binding(), dir);
    recordNativeGroupContextDelivery(binding(), [12], dir);
    confirmGroupContextDelivery(binding(), dir);
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir, 'native-two')).toBeUndefined();
    const replacement = bundle({ epoch: 'native-two', body: 'Full history for a new native session', nativeInputSeqs: [21] });
    expect(writePreparedGroupContext(replacement, dir)).toEqual(replacement);
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir, 'native-one')).toEqual(first);
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir, 'native-two')).toEqual(replacement);
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding(first.appId, first.chatId, first.turnId, dir)).toBeUndefined();
    const next = binding({ epoch: 'native-two' });
    bindGroupContextDelivery(next, dir);
    recordNativeGroupContextDelivery(next, [22], dir);
    confirmGroupContextDelivery(next, dir);
    expect(delivered(dir)).toEqual([11, 12]);
    expect(delivered(dir, next)).toEqual([2, 5, 21, 22]);
    expect(readGroupContextDeliveryBinding(first.appId, first.chatId, first.turnId, dir, 'native-one')).toEqual(binding());
    expect(readGroupContextDeliveryBinding(first.appId, first.chatId, first.turnId, dir, 'native-two')).toEqual(next);
  });

  it('falls back to legacy unscoped input only before binding or for its matching consumer', () => {
    const dir = dataDir();
    const input = bundle();
    writePreparedGroupContext(input, dir);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir, 'native-one')).toEqual(input);
    bindGroupContextDelivery(binding(), dir);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir, 'native-one')).toEqual(input);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir, 'native-two')).toBeUndefined();
    expect(() => bindGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toThrow();
    const next = bundle({ epoch: 'native-two', body: 'Replacement history' });
    expect(writePreparedGroupContext(next, dir)).toEqual(next);
  });

  it('resolves a promoted consumer to its immutable provisional snapshot without mixing replacements', () => {
    const dir = dataDir();
    const provisional = binding({ epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']), workerGeneration: 1 });
    const first = bundle({ epoch: provisional.epoch });
    writePreparedGroupContext(first, dir);
    bindGroupContextDelivery(provisional, dir);
    const promoted = promoteGroupContextDeliveryEpoch(provisional, 'native-one', 1, dir)!;
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir, promoted.epoch)).toEqual(first);
    expect(writePreparedGroupContext(bundle({ epoch: promoted.epoch, body: 'Must stay frozen' }), dir)).toEqual(first);
    const replacement = bundle({ epoch: JSON.stringify(['session-one', 'codex', 'native-two']), body: 'Replacement history' });
    expect(writePreparedGroupContext(replacement, dir)).toEqual(replacement);
    expect(recordNativeGroupContextDelivery(provisional, [20], dir)).toBe(true);
    expect(confirmGroupContextDelivery(promoted, dir)).toBe(true);
    expect(delivered(dir, promoted)).toEqual([2, 5, 20]);
    expect(delivered(dir, { epoch: replacement.epoch! })).toEqual([]);
  });

  it('returns empty for missing bundles and coverage without creating a store', () => {
    const dir = dataDir();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps the first persisted body and attachments when a retry changes the input', () => {
    const dir = dataDir();
    const first = bundle({ attachments: [{ type: 'file', path: '/tmp/source.pdf', name: 'source.pdf', resourceKey: 'original' }] });
    expect(writePreparedGroupContext(first, dir)).toEqual(first);
    expect(writePreparedGroupContext(bundle({
      body: 'Recomputed body', includedSeqs: [6], throughSeq: 6,
      attachments: [{ type: 'image', path: '/tmp/new.png', name: 'new.png' }],
    }), dir)).toEqual(first);
    expect(readPreparedGroupContext(first.appId, first.chatId, first.turnId, dir)).toEqual(first);
  });

  it('does not expose mutable in-memory aliases of a persisted bundle', () => {
    const dir = dataDir();
    const input = bundle();
    const expected = structuredClone(input);
    const written = writePreparedGroupContext(input, dir);
    input.includedSeqs.push(7);
    written.includedSeqs.push(8);
    written.body = 'Mutated';
    const read = readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)!;
    expect(read).toEqual(expected);
    read.includedSeqs.length = 0;
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(expected);
  });

  it('deduplicates sequence identities deterministically without filling holes', () => {
    const dir = dataDir();
    expect(writePreparedGroupContext(bundle({ includedSeqs: [5, 2, 5, 2] }), dir).includedSeqs).toEqual([2, 5]);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5]);
  });

  it('uses config.session.dataDir when the final argument is omitted', () => {
    const dir = dataDir();
    vi.stubEnv('SESSION_DATA_DIR', dir);
    try {
      const input = bundle();
      writePreparedGroupContext(input);
      bindGroupContextDelivery(binding());
      expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId)).toEqual(input);
      expect(readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId)).toEqual(binding());
      expect(confirmGroupContextDelivery(binding())).toBe(true);
      expect(getDeliveredGroupContextSeqs(input.appId, input.chatId, 'session-one', 'native-one')).toEqual([2, 5]);
      expect(existsSync(join(dir, 'group-context-delivery'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never incorporates application, chat, session, or turn IDs into paths', () => {
    const dir = dataDir();
    const input = bundle({ appId: '../app', chatId: '../chat', turnId: '../turn' });
    const consumer = binding({ ...input, sessionId: '../session', epoch: '../epoch' });
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(consumer, dir);
    expect(confirmGroupContextDelivery(consumer, dir)).toBe(true);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(input);
    expect(readdirSync(dir)).toEqual(['group-context-delivery']);
    expect(readdirSync(join(dir, 'group-context-delivery')).every(name => !/app|chat|session|turn/.test(name))).toBe(true);
    expect(statSync(join(dir, 'group-context-delivery')).mode & 0o777).toBe(0o700);
  });
});

describe('group context delivery coverage', () => {
  it.each([undefined, 0, 2])('fences a dispatched turn to its actual reserved worker generation from %s', oldGeneration => {
    const dir = dataDir();
    const before = binding({ workerGeneration: oldGeneration });
    const actualGeneration = (oldGeneration ?? 0) + 1;
    const actual = { ...before, workerGeneration: actualGeneration };
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(before, dir);
    recordNativeGroupContextDelivery(before, [20], dir);
    expect(bindGroupContextWorkerGeneration(before, actualGeneration, dir)).toEqual(actual);
    expect(readGroupContextDeliveryBinding(before.appId, before.chatId, before.turnId, dir)).toEqual(actual);
    expect(recordNativeGroupContextDelivery(before, [21], dir)).toBe(false);
    expect(confirmGroupContextDelivery(before, dir)).toBe(false);
    expect(recordNativeGroupContextDelivery(actual, [22], dir)).toBe(true);
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(actual, dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5, 22]);
  });

  it('preserves idempotent dispatch reservations and rejects generation changes after confirmation', () => {
    const dir = dataDir();
    const consumer = binding({ workerGeneration: 2 });
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(consumer, dir);
    recordNativeGroupContextDelivery(consumer, [20], dir);
    expect(bindGroupContextWorkerGeneration(consumer, 2, dir)).toEqual(consumer);
    expect(bindGroupContextWorkerGeneration(consumer, 1, dir)).toBeUndefined();
    expect(confirmGroupContextDelivery(consumer, dir)).toBe(true);
    expect(bindGroupContextWorkerGeneration(consumer, 3, dir)).toBeUndefined();
    expect(bindGroupContextWorkerGeneration(consumer, 2, dir)).toEqual(consumer);
    expect(delivered(dir)).toEqual([2, 5, 20]);
  });

  it('clears a previous worker promotion predecessor when a replacement worker reserves the turn', () => {
    const dir = dataDir();
    const initial = binding({ epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']), workerGeneration: 1 });
    writePreparedGroupContext(bundle({ epoch: initial.epoch }), dir);
    bindGroupContextDelivery(initial, dir);
    const promoted = promoteGroupContextDeliveryEpoch(initial, 'native-new', 1, dir)!;
    recordNativeGroupContextDelivery(initial, [20], dir);
    const replacement = bindGroupContextWorkerGeneration(promoted, 2, dir)!;
    expect(replacement).toEqual({ ...promoted, workerGeneration: 2 });
    expect(recordNativeGroupContextDelivery(initial, [21], dir)).toBe(false);
    expect(recordNativeGroupContextDelivery(promoted, [22], dir)).toBe(false);
    expect(recordNativeGroupContextDelivery(replacement, [23], dir)).toBe(true);
    expect(confirmGroupContextDelivery(replacement, dir)).toBe(true);
    expect(delivered(dir, replacement)).toEqual([2, 5, 23]);
  });

  it('rejects unprepared, mismatched, or invalid dispatch generation reservations', () => {
    const dir = dataDir();
    const consumer = binding({ workerGeneration: 1 });
    expect(bindGroupContextWorkerGeneration(consumer, 2, dir)).toBeUndefined();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(consumer, dir);
    for (const patch of [{ sessionId: 'other' }, { turnId: 'other' }, { epoch: 'other' }, { workerGeneration: 0 }]) {
      expect(bindGroupContextWorkerGeneration({ ...consumer, ...patch }, 2, dir)).toBeUndefined();
    }
    for (const generation of [0, -1, 1.5, Number.NaN]) {
      expect(bindGroupContextWorkerGeneration(consumer, generation, dir)).toBeUndefined();
    }
    expect(readGroupContextDeliveryBinding(consumer.appId, consumer.chatId, consumer.turnId, dir)).toEqual(consumer);
  });

  it.each([0, 1])('accepts a delayed output ACK captured before provisional promotion (%s)', generation => {
    const dir = dataDir();
    const original = binding({ epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']), workerGeneration: generation });
    // No prepared epoch: promotion provenance must come from the exact bound
    // consumer, not a guess derived from optional frozen payload metadata.
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(original, dir);
    const promoted = promoteGroupContextDeliveryEpoch(original, 'native-new', 1, dir)!;
    expect(recordNativeGroupContextDelivery(original, [20], dir)).toBe(true);
    expect(delivered(dir, promoted)).toEqual([]);
    expect(confirmGroupContextDelivery(original, dir)).toBe(false);
    expect(confirmGroupContextDelivery(promoted, dir)).toBe(true);
    expect(recordNativeGroupContextDelivery(original, [21], dir)).toBe(true);
    expect(recordNativeGroupContextDelivery({ ...original, workerGeneration: generation + 1 }, [22], dir)).toBe(false);
    expect(recordNativeGroupContextDelivery({ ...original, epoch: JSON.stringify(['session-one', 'other-cli', 'fresh:turn-one']) }, [22], dir)).toBe(false);
    expect(recordNativeGroupContextDelivery({ ...original, sessionId: 'replacement-session' }, [22], dir)).toBe(false);
    expect(delivered(dir, original)).toEqual([]);
    expect(delivered(dir, promoted)).toEqual([2, 5, 20, 21]);
  });

  it('rejects an invented provisional predecessor for a turn originally bound to a real native session', () => {
    const dir = dataDir();
    const real = binding({ epoch: JSON.stringify(['session-one', 'codex', 'native-new']), workerGeneration: 1 });
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(real, dir);
    confirmGroupContextDelivery(real, dir);
    const invented = { ...real, epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']) };
    expect(recordNativeGroupContextDelivery(invented, [20], dir)).toBe(false);
    expect(delivered(dir, real)).toEqual([2, 5]);
  });

  it.each([0, 1, 3])('promotes a provisional native epoch with a matching generation fence (%s)', generation => {
    const dir = dataDir();
    const provisional = binding({ epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']), workerGeneration: generation });
    const nativeEpoch = JSON.stringify(['session-one', 'codex', 'native-new']);
    const input = bundle({ epoch: provisional.epoch, nativeInputSeqs: [11] });
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(provisional, dir);
    expect(readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId, dir)).toEqual(provisional);
    recordNativeGroupContextDelivery(provisional, [13], dir);
    const promoted = { ...provisional, epoch: nativeEpoch, workerGeneration: generation || 1 };
    expect(promoteGroupContextDeliveryEpoch(provisional, 'native-new', generation || 1, dir)).toEqual(promoted);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(input);
    expect(readGroupContextDeliveryBinding(input.appId, input.chatId, input.turnId, dir)).toEqual(promoted);
    expect(promoteGroupContextDeliveryEpoch(provisional, 'another-native', generation || 1, dir)).toBeUndefined();
    expect(promoteGroupContextDeliveryEpoch(promoted, 'another-native', generation || 1, dir)).toBeUndefined();
    expect(delivered(dir, promoted)).toEqual([]);
    expect(confirmGroupContextDelivery(provisional, dir)).toBe(false);
    expect(confirmGroupContextDelivery(promoted, dir)).toBe(true);
    expect(delivered(dir, provisional)).toEqual([]);
    expect(delivered(dir, promoted)).toEqual([2, 5, 11, 13]);
    expect(() => bindGroupContextDelivery(promoted, dir)).not.toThrow();
  });

  it.each([
    { stored: undefined, actual: 1 }, { stored: 1, actual: 2 }, { stored: 2, actual: 1 },
    { stored: 0, actual: 2 }, { stored: 0, actual: 0 }, { stored: 1, actual: -1 }, { stored: 1, actual: 1.5 },
  ])('rejects unproven worker-generation promotion: %j', ({ stored, actual }) => {
    const dir = dataDir();
    const provisional = binding({ epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']), workerGeneration: stored });
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(provisional, dir);
    expect(promoteGroupContextDeliveryEpoch(provisional, 'native-new', actual, dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding(provisional.appId, provisional.chatId, provisional.turnId, dir)).toEqual(provisional);
  });

  it.each([
    { epoch: JSON.stringify(['session-one', 'codex', 'existing-native']) },
    { epoch: JSON.stringify(['session-one', 'codex', 'fresh:other-turn']) },
    { epoch: 'malformed' },
  ])('refuses to promote a non-matching provisional epoch: %j', patch => {
    const dir = dataDir();
    const initial = binding({ ...patch, workerGeneration: 1 });
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(initial, dir);
    expect(promoteGroupContextDeliveryEpoch(initial, 'native-new', 1, dir)).toBeUndefined();
  });

  it('rejects missing, conflicting, confirmed, or re-promoted epoch bindings', () => {
    const dir = dataDir();
    const provisional = binding({ epoch: JSON.stringify(['session-one', 'codex', 'fresh:turn-one']), workerGeneration: 1 });
    expect(promoteGroupContextDeliveryEpoch(provisional, 'native-new', 1, dir)).toBeUndefined();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(provisional, dir);
    for (const patch of [{ sessionId: 'other' }, { turnId: 'other' }, { appId: 'other' }, { chatId: 'other' },
      { epoch: JSON.stringify(['session-one', 'claude', 'fresh:turn-one']) }, { workerGeneration: undefined }, { workerGeneration: 2 }]) {
      expect(promoteGroupContextDeliveryEpoch({ ...provisional, ...patch }, 'native-new', 1, dir)).toBeUndefined();
    }
    expect(promoteGroupContextDeliveryEpoch(provisional, '', 1, dir)).toBeUndefined();
    expect(promoteGroupContextDeliveryEpoch(provisional, 'fresh:other', 1, dir)).toBeUndefined();
    confirmGroupContextDelivery(provisional, dir);
    expect(promoteGroupContextDeliveryEpoch(provisional, 'native-new', 1, dir)).toBeUndefined();
  });

  it('freezes native input identities independently of history bounds and covers them only after confirmation', () => {
    const dir = dataDir();
    const input = bundle({ nativeInputSeqs: [12, 10, 12] });
    const expected = { ...input, nativeInputSeqs: [10, 12] };
    expect(writePreparedGroupContext(input, dir)).toEqual(expected);
    expect(writePreparedGroupContext(bundle({ nativeInputSeqs: [99] }), dir)).toEqual(expected);
    bindGroupContextDelivery(binding(), dir);
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5, 10, 12]);
  });

  it('records native outputs before or after confirmation without mutating frozen input', () => {
    const dir = dataDir();
    const input = bundle({ nativeInputSeqs: [10] });
    writePreparedGroupContext(input, dir);
    expect(recordNativeGroupContextDelivery(binding(), [20], dir)).toBe(false);
    bindGroupContextDelivery(binding(), dir);
    expect(recordNativeGroupContextDelivery(binding(), [20, 18, 20], dir)).toBe(true);
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5, 10, 18, 20]);
    expect(recordNativeGroupContextDelivery(binding(), [23, 20], dir)).toBe(true);
    expect(recordNativeGroupContextDelivery(binding(), [23, 20], dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5, 10, 18, 20, 23]);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(input);
  });

  it.each(['appId', 'chatId', 'turnId', 'sessionId', 'epoch'] as const)('rejects native outputs with a different %s', key => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(recordNativeGroupContextDelivery(binding({ [key]: 'other' }), [20], dir)).toBe(false);
    confirmGroupContextDelivery(binding(), dir);
    expect(delivered(dir)).toEqual([2, 5]);
  });

  it('unions exact native identities across out-of-order turns without filling holes or crossing epochs', () => {
    const dir = dataDir();
    for (const [turnId, inputSeq, outputSeq] of [['old', 11, 15], ['new', 21, 25]] as const) {
      writePreparedGroupContext(bundle({ turnId, includedSeqs: [], throughSeq: 0, nativeInputSeqs: [inputSeq] }), dir);
      bindGroupContextDelivery(binding({ turnId }), dir);
      recordNativeGroupContextDelivery(binding({ turnId }), [outputSeq], dir);
    }
    confirmGroupContextDelivery(binding({ turnId: 'new' }), dir);
    expect(delivered(dir)).toEqual([21, 25]);
    confirmGroupContextDelivery(binding({ turnId: 'old' }), dir);
    expect(delivered(dir)).toEqual([11, 15, 21, 25]);
    expect(delivered(dir, { epoch: 'new-native' })).toEqual([]);
    expect(delivered(dir, { sessionId: 'new-session' })).toEqual([]);
  });

  it('does not cover queued, prepared, or bound input before confirmation', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    bindGroupContextDelivery(binding(), dir);
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toEqual(binding());
    expect(delivered(dir)).toEqual([]);
  });

  it('confirms only explicit included sources and treats matching retries as idempotent', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5]);
  });

  it.each(['appId', 'chatId', 'turnId', 'sessionId', 'epoch'] as const)('rejects confirmation with a different %s', key => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding({ [key]: 'other' }), dir)).toBe(false);
    expect(delivered(dir)).toEqual([]);
    expect(delivered(dir, { [key]: 'other' })).toEqual([]);
  });

  it('does not allow retries to rebind a frozen turn to another consumer', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(() => bindGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toThrow();
    expect(() => bindGroupContextDelivery(binding({ sessionId: 'session-two' }), dir)).toThrow();
    expect(confirmGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toBe(false);
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toEqual(binding());
  });

  it('requires a prepared bundle and enforces an explicitly prepared native epoch', () => {
    const dir = dataDir();
    expect(() => bindGroupContextDelivery(binding(), dir)).toThrow();
    writePreparedGroupContext(bundle({ epoch: 'native-one' }), dir);
    expect(() => bindGroupContextDelivery(binding({ epoch: 'native-two' }), dir)).toThrow();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
  });

  it('isolates applications, groups, sessions, and native epochs with reused turn IDs', () => {
    const dir = dataDir();
    const scopes = [
      binding(), binding({ appId: 'app-two' }), binding({ chatId: 'chat-two' }),
      binding({ sessionId: 'session-two', turnId: 'turn-two' }),
      binding({ epoch: 'native-two', turnId: 'turn-three' }),
    ];
    scopes.forEach((scope, index) => {
      writePreparedGroupContext(bundle({ appId: scope.appId, chatId: scope.chatId, turnId: scope.turnId, includedSeqs: [index + 1] }), dir);
      bindGroupContextDelivery(scope, dir);
      confirmGroupContextDelivery(scope, dir);
    });
    scopes.forEach((scope, index) => expect(delivered(dir, scope)).toEqual([index + 1]));
  });

  it('retains newer bundles when an older turn completes after them', () => {
    const dir = dataDir();
    const older = bundle({ turnId: 'older', includedSeqs: [2], throughSeq: 3 });
    const newer = bundle({ turnId: 'newer', includedSeqs: [8], throughSeq: 9 });
    writePreparedGroupContext(older, dir);
    writePreparedGroupContext(newer, dir);
    bindGroupContextDelivery(binding({ turnId: 'older' }), dir);
    bindGroupContextDelivery(binding({ turnId: 'newer' }), dir);
    expect(confirmGroupContextDelivery(binding({ turnId: 'newer' }), dir)).toBe(true);
    expect(delivered(dir)).toEqual([8]);
    expect(confirmGroupContextDelivery(binding({ turnId: 'older' }), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 8]);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'newer', dir)).toEqual(newer);
  });

  it('reopens both frozen input and delivery evidence in a new process', () => {
    const dir = dataDir();
    const input = bundle({ nativeInputSeqs: [11] });
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(binding(), dir);
    recordNativeGroupContextDelivery(binding(), [13], dir);
    confirmGroupContextDelivery(binding(), dir);
    const result = spawnSyncTsEvalWithRepoImports(`
      import { readPreparedGroupContext, readGroupContextDeliveryBinding, getDeliveredGroupContextSeqs } from './src/services/group-context-delivery-store.js';
      const dir = process.env.DELIVERY_TEST_DIR;
      console.log(JSON.stringify({
        prepared: readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir),
        binding: readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir),
        seqs: getDeliveredGroupContextSeqs('app-one', 'chat-one', 'session-one', 'native-one', dir),
      }));
    `, { cwd: process.cwd(), env: { ...process.env, DELIVERY_TEST_DIR: dir }, encoding: 'utf8' });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout).trim())).toEqual({ prepared: input, binding: binding(), seqs: [2, 5, 11, 13] });
  });

  it('serializes competing processes so every retry receives the same first bundle', async () => {
    const dir = dataDir();
    const input = bundle();
    const outputs = await Promise.all([1, 2, 3].map(index => new Promise<PreparedGroupContext>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(`
        import { writePreparedGroupContext } from './src/services/group-context-delivery-store.js';
        console.log(JSON.stringify(writePreparedGroupContext(JSON.parse(process.env.DELIVERY_TEST_INPUT), process.env.DELIVERY_TEST_DIR)));
      `, {
        cwd: process.cwd(),
        env: { ...process.env, DELIVERY_TEST_DIR: dir, DELIVERY_TEST_INPUT: JSON.stringify({ ...input, body: `Writer ${index}` }) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', data => { stdout += String(data); });
      child.stderr!.on('data', data => { stderr += String(data); });
      child.once('error', reject);
      child.once('exit', code => {
        if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`));
        else {
          try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
        }
      });
    })));
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir)).toEqual(outputs[0]);
  });
});

describe('group context delivery validation and retention', () => {
  it('does not extend existing confirmed source retention when a newer turn covers the same source again', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const older = binding({ turnId: 'older' });
    writePreparedGroupContext(bundle({ turnId: 'older', createdAt: now - 29 * DAY, includedSeqs: [2], throughSeq: 2 }), dir);
    bindGroupContextDelivery(older, dir);
    confirmGroupContextDelivery(older, dir);
    const newer = binding({ turnId: 'newer' });
    writePreparedGroupContext(bundle({ turnId: 'newer' }), dir);
    bindGroupContextDelivery(newer, dir);
    confirmGroupContextDelivery(newer, dir);
    expect(delivered(dir)).toEqual([2, 5]);
    clock.mockReturnValue(now + DAY);
    expect(delivered(dir)).toEqual([5]);
  });

  it('migrates the old turn-only primary key without changing frozen payload or losing confirmed outputs', () => {
    const dir = dataDir();
    const input = bundle({ nativeInputSeqs: [11] });
    const payload = JSON.stringify(input, null, 2);
    mkdirSync(join(dir, 'group-context-delivery'));
    const path = join(dir, 'group-context-delivery', 'store.db');
    const old = openDatabaseSyncOrThrow(path);
    try {
      old.exec(`CREATE TABLE prepared_contexts (
        app_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL,
        session_id TEXT, epoch TEXT, confirmed_at INTEGER, PRIMARY KEY (app_id, chat_id, turn_id));
        CREATE TABLE native_output_sequences (
          app_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, seq INTEGER NOT NULL,
          PRIMARY KEY (app_id, chat_id, turn_id, seq), FOREIGN KEY (app_id, chat_id, turn_id)
            REFERENCES prepared_contexts(app_id, chat_id, turn_id) ON DELETE CASCADE);`);
      old.prepare('INSERT INTO prepared_contexts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.appId, input.chatId, input.turnId, input.createdAt, input.createdAt + 30 * DAY, payload,
          'session-one', 'native-one', input.createdAt);
      old.prepare('INSERT INTO native_output_sequences VALUES (?, ?, ?, ?)').run(input.appId, input.chatId, input.turnId, 20);
    } finally { old.close(); }
    expect(delivered(dir)).toEqual([2, 5, 11, 20]);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir, 'native-one')).toEqual(input);
    expect(readPreparedGroupContext(input.appId, input.chatId, input.turnId, dir, 'native-two')).toBeUndefined();
    const replacement = bundle({ epoch: 'native-two', body: 'New epoch history' });
    expect(writePreparedGroupContext(replacement, dir)).toEqual(replacement);
    expect(delivered(dir)).toEqual([2, 5, 11, 20]);
    const migrated = openDatabaseSyncOrThrow(path);
    try {
      expect(migrated.prepare('SELECT payload FROM prepared_contexts WHERE snapshot_epoch = ?').get('native-one')).toEqual({ payload });
      expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(migrated.prepare('SELECT snapshot_epoch, seq FROM native_output_sequences').all()).toEqual([{ snapshot_epoch: 'native-one', seq: 20 }]);
    } finally { migrated.close(); }
  });

  it('expires each same-turn epoch snapshot and its outputs independently', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    writePreparedGroupContext(bundle({ epoch: 'native-one' }), dir);
    bindGroupContextDelivery(binding(), dir);
    recordNativeGroupContextDelivery(binding(), [20], dir);
    confirmGroupContextDelivery(binding(), dir);
    clock.mockReturnValue(now + DAY);
    const next = binding({ epoch: 'native-two' });
    writePreparedGroupContext(bundle({ epoch: 'native-two' }), dir);
    bindGroupContextDelivery(next, dir);
    recordNativeGroupContextDelivery(next, [30], dir);
    confirmGroupContextDelivery(next, dir);
    clock.mockReturnValue(now + 30 * DAY);
    expect(delivered(dir)).toEqual([]);
    expect(delivered(dir, next)).toEqual([2, 5, 30]);
    expect(readPreparedGroupContext(next.appId, next.chatId, next.turnId, dir, 'native-two')).toBeDefined();
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      expect(db.prepare('SELECT snapshot_epoch, seq FROM native_output_sequences').all()).toEqual([{ snapshot_epoch: 'native-two', seq: 30 }]);
    } finally { db.close(); }
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ['2'], [Number.MAX_SAFE_INTEGER + 1], Array(10_001).fill(1)])(
    'rejects invalid native sequence data (%#)', seqs => {
      const dir = dataDir();
      expect(() => writePreparedGroupContext(bundle({ nativeInputSeqs: seqs as number[] }), dir)).toThrow();
      writePreparedGroupContext(bundle(), dir);
      bindGroupContextDelivery(binding(), dir);
      expect(recordNativeGroupContextDelivery(binding(), seqs as number[], dir)).toBe(false);
      confirmGroupContextDelivery(binding(), dir);
      expect(delivered(dir)).toEqual([2, 5]);
    },
  );

  it('bounds cumulative native outputs per turn, preserves idempotent retries, and accepts large sequence IDs', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle({ nativeInputSeqs: [100_001] }), dir);
    bindGroupContextDelivery(binding(), dir);
    const seqs = Array.from({ length: 10_000 }, (_, index) => index + 200_000);
    expect(recordNativeGroupContextDelivery(binding(), seqs, dir)).toBe(true);
    expect(recordNativeGroupContextDelivery(binding(), [seqs[0]], dir)).toBe(true);
    expect(recordNativeGroupContextDelivery(binding(), [900_000], dir)).toBe(false);
    confirmGroupContextDelivery(binding(), dir);
    expect(delivered(dir)).toEqual([2, 5, 100_001, ...seqs]);
  });

  it('expires native output identities with the prepared turn without extending TTL on output publication', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    writePreparedGroupContext(bundle({ nativeInputSeqs: [10] }), dir);
    bindGroupContextDelivery(binding(), dir);
    recordNativeGroupContextDelivery(binding(), [20], dir);
    confirmGroupContextDelivery(binding(), dir);
    clock.mockReturnValue(now + 29 * DAY);
    expect(recordNativeGroupContextDelivery(binding(), [25], dir)).toBe(true);
    clock.mockReturnValue(now + 30 * DAY);
    expect(recordNativeGroupContextDelivery(binding(), [30], dir)).toBe(false);
    expect(delivered(dir)).toEqual([]);
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM native_output_sequences').get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it('migrates pre-output stores on read and preserves their confirmed history coverage', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    confirmGroupContextDelivery(binding(), dir);
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      db.exec(`DROP TABLE native_output_sequences;
        ALTER TABLE prepared_contexts DROP COLUMN worker_generation;
        ALTER TABLE prepared_contexts DROP COLUMN promoted_from_epoch;
        ALTER TABLE prepared_contexts DROP COLUMN promoted_from_worker_generation`);
    } finally { db.close(); }
    expect(delivered(dir)).toEqual([2, 5]);
    expect(recordNativeGroupContextDelivery(binding(), [20], dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5, 20]);
  });

  it.each([
    { includedSeqs: [0] }, { includedSeqs: [-1] }, { includedSeqs: [1.5] },
    { includedSeqs: [Number.NaN] }, { includedSeqs: [Number.MAX_SAFE_INTEGER + 1] },
    { includedSeqs: ['2'] }, { includedSeqs: [10], throughSeq: 9 },
    { throughSeq: -1 }, { throughSeq: 0.5 }, { createdAt: Number.NaN },
    { body: null }, { incomplete: 'true' }, { appId: '' }, { epoch: '' },
    { attachments: [{ type: 'file', name: 'bad' }] }, { attachments: 'bad' },
  ])('rejects invalid bundle data: %j', patch => {
    const dir = dataDir();
    expect(() => writePreparedGroupContext(bundle(patch as Partial<PreparedGroupContext>), dir)).toThrow();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
  });

  it('rejects empty consumer identities', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    expect(() => bindGroupContextDelivery(binding({ epoch: '' }), dir)).toThrow();
    expect(() => bindGroupContextDelivery(binding({ sessionId: '' }), dir)).toThrow();
    expect(confirmGroupContextDelivery(binding({ epoch: '' }), dir)).toBe(false);
    expect(delivered(dir, { epoch: '' })).toEqual([]);
  });

  it('accepts an empty context without inventing covered sources', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle({ body: '', includedSeqs: [], throughSeq: 0 }), dir);
    bindGroupContextDelivery(binding(), dir);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([]);
  });

  it('expires input and coverage after 30 days without extending TTL on retry or confirmation', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const input = bundle();
    writePreparedGroupContext(input, dir);
    bindGroupContextDelivery(binding(), dir);
    clock.mockReturnValue(now + 29 * DAY);
    expect(writePreparedGroupContext(bundle({ body: 'Retry' }), dir)).toEqual(input);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(true);
    expect(delivered(dir)).toEqual([2, 5]);
    clock.mockReturnValue(now + 30 * DAY);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    expect(delivered(dir)).toEqual([]);
  });

  it('clamps future timestamps so they cannot bypass 30-day retention', () => {
    const dir = dataDir();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    writePreparedGroupContext(bundle({ createdAt: now + 365 * DAY }), dir);
    clock.mockReturnValue(now + 30 * DAY);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
  });

  it('caps retention at 1,000 bundles and refuses to report an unretained old insertion as frozen', () => {
    const dir = dataDir();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const original = bundle({ turnId: 'turn-0', createdAt: now - 1_000 });
    writePreparedGroupContext(original, dir);
    bindGroupContextDelivery(binding({ turnId: 'turn-0' }), dir);
    recordNativeGroupContextDelivery(binding({ turnId: 'turn-0' }), [20], dir);
    confirmGroupContextDelivery(binding({ turnId: 'turn-0' }), dir);
    // Seed an already populated store, then exercise the public insertion path.
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare(`INSERT INTO prepared_contexts (app_id, chat_id, turn_id, created_at, expires_at, payload)
        VALUES (?, ?, ?, ?, ?, ?)`);
      for (let index = 1; index < 1_000; index++) {
        const input = bundle({ turnId: `turn-${index}`, createdAt: now - 1_000 + index });
        insert.run(input.appId, input.chatId, input.turnId, input.createdAt, input.createdAt + 30 * DAY, JSON.stringify(input));
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const newest = bundle({ turnId: 'newest' });
    expect(writePreparedGroupContext(newest, dir)).toEqual(newest);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-0', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([2, 5, 20]);
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-1', dir)).toBeDefined();
    expect(() => writePreparedGroupContext(bundle({ turnId: 'too-old', createdAt: now - DAY }), dir)).toThrow();
    expect(readPreparedGroupContext('app-one', 'chat-one', 'newest', dir)).toEqual(newest);
    const reopened = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM prepared_contexts').get()).toEqual({ count: 1_000 });
      expect(reopened.prepare('SELECT COUNT(*) AS count FROM native_output_sequences').get()).toEqual({ count: 0 });
    } finally {
      reopened.close();
    }
  });

  it('fails closed on a corrupted database and refuses to overwrite it', () => {
    const dir = dataDir();
    mkdirSync(join(dir, 'group-context-delivery'));
    const file = join(dir, 'group-context-delivery', 'store.db');
    writeFileSync(file, 'not a SQLite database');
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
    expect(() => writePreparedGroupContext(bundle(), dir)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('not a SQLite database');
  });

  it('fails closed when a persisted bundle has invalid source sequences', () => {
    const dir = dataDir();
    writePreparedGroupContext(bundle(), dir);
    bindGroupContextDelivery(binding(), dir);
    confirmGroupContextDelivery(binding(), dir);
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    try {
      db.prepare('UPDATE prepared_contexts SET payload = ?').run(JSON.stringify(bundle({ includedSeqs: [-1] })));
    } finally {
      db.close();
    }
    expect(readPreparedGroupContext('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(readGroupContextDeliveryBinding('app-one', 'chat-one', 'turn-one', dir)).toBeUndefined();
    expect(delivered(dir)).toEqual([]);
    expect(confirmGroupContextDelivery(binding(), dir)).toBe(false);
  });
});
