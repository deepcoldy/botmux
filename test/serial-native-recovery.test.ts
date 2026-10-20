import { describe, it, expect } from 'vitest';
import { prepareCodexAppDispatch, bindSerialDispatchNativeStart, serialDispatchOwnsRecovery, serialDispatchBlocksInput } from '../src/utils/codex-app-dispatch-ledger.js';
import { serialDispatchRecoveryMark, settleFencedSerialDispatch } from '../src/services/codex-adopt-recovery.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import type { CodexAppDispatchLedgerEntry } from '../src/types.js';

const accepted = (): CodexAppDispatchLedgerEntry => ({
  dispatchId: 'dispatch-1', turnId: 'request-1', state: 'accepted', executionPolicy: 'serial',
  content: 'execute once', origin: { atMostOnce: true },
});
const basis = { markTimeMs: 1_000, fingerprint: 'execute once', jsonlPath: '/original.jsonl', offsetAtMark: 120 };
const proof = { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', startedAtMs: 1_100,
  proofKind: 'codex_transcript_start' as const };
const prepared = () => {
  const result = prepareCodexAppDispatch([accepted()], { ...accepted(), serialRecovery: basis });
  if (!result.ok) throw new Error(result.error);
  return result.ledger;
};
describe('native serial recovery from the original durable admission', () => {
  it('keeps the first prewrite frontier even after receipt loss and repeated prepare', () => {
    const first = prepared();
    const repeat = prepareCodexAppDispatch(JSON.parse(JSON.stringify(first)), {
      ...accepted(), serialRecovery: { ...basis, offsetAtMark: 900, markTimeMs: 9_000 },
    });
    expect(repeat).toMatchObject({ ok: true, ledger: [{ serialRecovery: basis }] });
  });
  it('binds only the prepared head and refuses a second native execution identity', () => {
    expect(() => bindSerialDispatchNativeStart([accepted()], accepted(), proof)).toThrow('serial_prepared_head_mismatch');
    const bound = bindSerialDispatchNativeStart(prepared(), accepted(), proof);
    expect(bindSerialDispatchNativeStart(bound, accepted(), { ...proof, startedAtMs: 8_000 })[0].serialNativeStart).toEqual(proof);
    expect(() => bindSerialDispatchNativeStart(bound, accepted(), { ...proof, nativeTurnId: 'other' })).toThrow('serial_native_identity_conflict');
    expect(() => bindSerialDispatchNativeStart(bound, { ...accepted(), dispatchAttempt: 2 }, proof)).toThrow('serial_prepared_head_mismatch');
  });
  it('restores a drained result after process death without a new native input, including exact attempt', () => {
    const entry = { ...bindSerialDispatchNativeStart(prepared(), accepted(), proof)[0], dispatchAttempt: 7 };
    const reopened = JSON.parse(JSON.stringify(entry));
    const mark = serialDispatchRecoveryMark(reopened, '/original.jsonl', 'native-session')!;
    expect(mark).toMatchObject({ turnId: 'request-1', dispatchAttempt: 7, offsetAtMark: 120 });
    const queue = new CodexBridgeQueue(() => 2_000);
    queue.restorePendingTurns([mark]);
    queue.ingest([{ kind: 'assistant_final', uuid: 'original:150', text: 'original result', timestampMs: 1_500,
      sourceSessionId: 'foreign', sourceTurnId: 'native-turn' }]);
    expect(queue.drainEmittable()).toHaveLength(0);
    queue.ingest([{ kind: 'assistant_final', uuid: 'original:200', text: 'original result', timestampMs: 1_600,
      sourceSessionId: 'native-session', sourceTurnId: 'native-turn' }]);
    expect(queue.drainEmittable()).toMatchObject([{ turnId: 'request-1', dispatchAttempt: 7, finalText: 'original result' }]);
  });
  it('does not borrow another transcript or treat unknown path/time as replay permission', () => {
    const entry = bindSerialDispatchNativeStart(prepared(), accepted(), proof)[0];
    expect(serialDispatchRecoveryMark(entry, '/other.jsonl', 'native-session')).toBeUndefined();
    expect(serialDispatchRecoveryMark(entry, '/original.jsonl', 'other-session')).toBeUndefined();
    expect(serialDispatchRecoveryMark({ ...entry, serialNativeStart: undefined,
      serialRecovery: { markTimeMs: 1_000, fingerprint: basis.fingerprint } }, '/original.jsonl', 'native-session')).toBeUndefined();
    expect(serialDispatchRecoveryMark({ ...entry, serialResult: { terminal: { type: 'turn_terminal',
      sessionId: 's', turnId: 'request-1', status: 'completed' } } }, '/original.jsonl', 'native-session')).toBeUndefined();
  });
  it('preserves only unambiguous owned serial recovery rather than every stale IPC lease', () => {
    expect(serialDispatchOwnsRecovery([accepted()], 'request-1')).toBe(true);
    expect(serialDispatchOwnsRecovery(prepared(), 'request-1')).toBe(true);
    // Missing readback evidence is still owned unknown work, never permission
    // to quarantine the whole session and discard accepted successors.
    expect(serialDispatchOwnsRecovery([{ ...accepted(), state: 'prepared' }], 'request-1')).toBe(true);
    expect(serialDispatchOwnsRecovery([{ ...accepted(), origin: {} }], 'request-1')).toBe(false);
    expect(serialDispatchOwnsRecovery([{ ...accepted(), executionPolicy: undefined }], 'request-1')).toBe(false);
    expect(serialDispatchOwnsRecovery([accepted(), accepted()], 'request-1')).toBe(false);
  });
});

describe('serial ownership across native resets and fencing', () => {
  it('holds successors after volatile authority resets until exact terminal receipt retires the head', () => {
    const ledger = prepared();
    expect(serialDispatchBlocksInput(ledger, { turnId: 'request-2' })).toBe(true);
    expect(serialDispatchBlocksInput(ledger, { turnId: 'request-1', dispatchAttempt: 2 })).toBe(true);
    expect(serialDispatchBlocksInput(ledger, { turnId: 'request-1' })).toBe(false);
    ledger[0].serialResult = { terminal: { type: 'turn_terminal', sessionId: 's', turnId: 'request-1', status: 'completed' } };
    expect(serialDispatchBlocksInput(ledger, { turnId: 'request-1' })).toBe(true);
    expect(serialDispatchBlocksInput([], { turnId: 'request-2' })).toBe(false);
  });
  it.each(['live', 'unknown'] as const)('does not settle or read a %s old backing as if it were dead', backing => {
    const calls: string[] = [];
    expect(settleFencedSerialDispatch({ backing, hasTerminal: () => false,
      readback: () => { calls.push('read'); }, ambiguous: () => { calls.push('ambiguous'); },
    })).toBe('held');
    expect(calls).toEqual([]);
  });
  it('lets original native completion win after a proven fence', () => {
    const calls: string[] = [];
    let completed = false;
    expect(settleFencedSerialDispatch({ backing: 'gone', hasTerminal: () => completed,
      readback: () => { calls.push('read'); completed = true; },
      ambiguous: () => { calls.push('ambiguous'); },
    })).toBe('terminal');
    expect(calls).toEqual(['read']);
  });
  it('distinguishes unreadable evidence from a drained transcript without pretending either succeeded', () => {
    for (const fails of [false, true]) {
      const codes: string[] = [];
      expect(settleFencedSerialDispatch({ backing: 'gone', hasTerminal: () => false,
        readback: () => { if (fails) throw new Error('EACCES'); }, ambiguous: code => { codes.push(code); },
      })).toBe('ambiguous');
      expect(codes).toEqual([fails ? 'serial_recovery_readback_unavailable' : 'serial_backing_exited']);
    }
  });
});
