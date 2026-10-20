/**
 * Native input consumption receipts for shared group background.
 *
 * Proven production defect: coverage was recorded only at the completed
 * terminal, so a daemon restart or an in-flight follow-up before that terminal
 * re-supplied the same sources to the same native conversation. These tests pin
 * the earlier receipt: once the CLI evidenced that the dispatched input entered
 * its conversation, the next turn in that native epoch must skip those sources,
 * while a replacement worker, another native conversation or a never-bound turn
 * still fails closed.
 *
 * Run: bun x vitest run --project unit test/group-context-native-input-receipt.test.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writePreparedGroupContext, bindGroupContextDelivery, bindGroupContextWorkerGeneration,
  confirmGroupContextDelivery, confirmGroupContextNativeInput, getDeliveredGroupContextSeqs,
  readGroupContextDeliveryReceipt, recordNativeGroupContextDelivery, promoteGroupContextDeliveryEpoch,
  type GroupContextDeliveryBinding,
} from '../src/services/group-context-delivery-store.js';
import { openDatabaseSyncOrThrow } from '../src/services/sqlite-compat.js';
import { groupContextEpoch } from '../src/services/group-context-prompt.js';
import { confirmNativeGroupContextInput, confirmNativeGroupContextTurn } from '../src/services/group-context-native.js';
import { commitGroupContextDispatchIntoPayload } from '../src/services/group-context-prompt.js';
import { createGroupContextPreparer } from '../src/services/group-context.js';
import type { GroupContextRenderMessage } from '../src/services/group-context-render.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'group-context-native-input-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const base = { appId: 'cli_a', chatId: 'oc_room', sessionId: 'session_a', cliId: 'codex' };
const proof = { kind: 'codex_history_match' as const };

function prepareBound(turnId: string, opts: { nativeId?: string; workerGeneration?: number; includedSeqs?: number[]; nativeInputSeqs?: number[] } = {}): GroupContextDeliveryBinding {
  const epoch = groupContextEpoch(base.sessionId, opts.nativeId, base.cliId, turnId);
  writePreparedGroupContext({
    appId: base.appId, chatId: base.chatId, turnId, createdAt: Date.now(), body: '',
    includedSeqs: opts.includedSeqs ?? [1, 2], nativeInputSeqs: opts.nativeInputSeqs ?? [3],
    throughSeq: 9, incomplete: false, epoch,
  }, dir);
  const binding: GroupContextDeliveryBinding = { appId: base.appId, chatId: base.chatId, turnId, sessionId: base.sessionId, epoch };
  bindGroupContextDelivery(binding, dir);
  const reserved = bindGroupContextWorkerGeneration(binding, opts.workerGeneration ?? 1, dir);
  if (!reserved) throw new Error('reservation failed');
  return reserved;
}

function covered(nativeId: string | undefined, turnId: string): number[] {
  return getDeliveredGroupContextSeqs(base.appId, base.chatId, base.sessionId, groupContextEpoch(base.sessionId, nativeId, base.cliId, turnId), dir);
}

describe('native input consumption receipt (store)', () => {
  it('covers frozen sources at consumption, before any terminal, and stays idempotent', () => {
    const binding = prepareBound('om_turn', { nativeId: 'native_known' });
    expect(covered('native_known', 'om_turn')).toEqual([]);
    expect(confirmGroupContextNativeInput(binding, proof, dir)).toBe(true);
    expect(covered('native_known', 'om_turn')).toEqual([1, 2, 3]);
    expect(confirmGroupContextNativeInput(binding, { kind: 'codex_rpc_turn_start', nativeTurnId: 'later' }, dir)).toBe(true);
    const receipt = readGroupContextDeliveryReceipt(base.appId, base.chatId, 'om_turn', dir, binding.epoch);
    expect(receipt?.proof).toEqual(proof);
    expect(receipt?.nativeConsumedAt).toBeGreaterThan(0);
    expect(receipt?.confirmedAt).toBeUndefined();
    // The terminal fallback remains a separate, compatible receipt.
    expect(confirmGroupContextDelivery(binding, dir)).toBe(true);
    expect(covered('native_known', 'om_turn')).toEqual([1, 2, 3]);
    expect(readGroupContextDeliveryReceipt(base.appId, base.chatId, 'om_turn', dir, binding.epoch)?.confirmedAt).toBeGreaterThan(0);
  });

  it('keeps coverage across a worker replacement that never reaches a terminal', () => {
    const binding = prepareBound('om_turn', { nativeId: 'native_known' });
    expect(confirmGroupContextNativeInput(binding, proof, dir)).toBe(true);
    // The daemon restarts; a replacement generation re-dispatches the same turn.
    expect(bindGroupContextWorkerGeneration(binding, 2, dir)).toBeUndefined();
    expect(confirmGroupContextDelivery({ ...binding, workerGeneration: 2 }, dir)).toBe(false);
    expect(covered('native_known', 'om_turn')).toEqual([1, 2, 3]);
  });

  it('rejects receipts from another generation, an unbound turn, or another native epoch', () => {
    const binding = prepareBound('om_turn', { nativeId: 'native_known' });
    expect(confirmGroupContextNativeInput({ ...binding, workerGeneration: 2 }, proof, dir)).toBe(false);
    expect(confirmGroupContextNativeInput({ ...binding, workerGeneration: undefined }, proof, dir)).toBe(false);
    expect(confirmGroupContextNativeInput({ ...binding, epoch: groupContextEpoch(base.sessionId, 'other', base.cliId, 'om_turn') }, proof, dir)).toBe(false);
    expect(confirmGroupContextNativeInput({ ...binding, sessionId: 'session_b' }, proof, dir)).toBe(false);
    expect(confirmGroupContextNativeInput(binding, { kind: 'queue_enqueued' as any }, dir)).toBe(false);
    expect(confirmGroupContextNativeInput(binding, { kind: 'codex_history_match', nativeTurnId: '' }, dir)).toBe(false);
    expect(covered('native_known', 'om_turn')).toEqual([]);
    // Never bound to a consumer: nothing can be consumed.
    writePreparedGroupContext({ appId: base.appId, chatId: base.chatId, turnId: 'om_unbound', createdAt: Date.now(), body: '', includedSeqs: [7], throughSeq: 7, incomplete: false }, dir);
    expect(confirmGroupContextNativeInput({ appId: base.appId, chatId: base.chatId, turnId: 'om_unbound', sessionId: base.sessionId, epoch: 'e', workerGeneration: 1 }, proof, dir)).toBe(false);
  });

  it('appends later native outputs to a consumed turn and blocks re-promotion', () => {
    const binding = prepareBound('om_turn', { nativeId: 'native_known' });
    expect(confirmGroupContextNativeInput(binding, proof, dir)).toBe(true);
    expect(recordNativeGroupContextDelivery(binding, [8], dir)).toBe(true);
    expect(covered('native_known', 'om_turn')).toEqual([1, 2, 3, 8]);
    const fresh = prepareBound('om_fresh');
    expect(confirmGroupContextNativeInput(fresh, proof, dir)).toBe(true);
    expect(promoteGroupContextDeliveryEpoch(fresh, 'native_late', 1, dir)).toBeUndefined();
  });

  it('migrates an existing store without receipt columns and preserves confirmed coverage', () => {
    const binding = prepareBound('om_old', { nativeId: 'native_known' });
    expect(confirmGroupContextDelivery(binding, dir)).toBe(true);
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    // Rebuild the pre-receipt column layout (SQLite cannot drop CHECK-referenced columns).
    db.exec(`CREATE TABLE prepared_contexts_legacy (
        app_id TEXT NOT NULL, chat_id TEXT NOT NULL, turn_id TEXT NOT NULL, snapshot_epoch TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL, session_id TEXT, epoch TEXT,
        worker_generation INTEGER, promoted_from_epoch TEXT, promoted_from_worker_generation INTEGER, confirmed_at INTEGER,
        PRIMARY KEY (app_id, chat_id, turn_id, snapshot_epoch));
      INSERT INTO prepared_contexts_legacy SELECT app_id, chat_id, turn_id, snapshot_epoch, created_at, expires_at, payload,
        session_id, epoch, worker_generation, promoted_from_epoch, promoted_from_worker_generation, confirmed_at FROM prepared_contexts;
      DROP TABLE prepared_contexts; ALTER TABLE prepared_contexts_legacy RENAME TO prepared_contexts;`);
    expect((db.prepare('PRAGMA table_info(prepared_contexts)').all() as { name: string }[]).some(c => c.name === 'native_consumed_at')).toBe(false);
    db.close();
    expect(covered('native_known', 'om_old')).toEqual([1, 2, 3]);
    const next = prepareBound('om_new', { nativeId: 'native_known' });
    expect(confirmGroupContextNativeInput(next, proof, dir)).toBe(true);
    expect(covered('native_known', 'om_new')).toEqual([1, 2, 3]);
  });

  it('fails closed on a tampered receipt instead of trusting coverage', () => {
    const binding = prepareBound('om_turn', { nativeId: 'native_known' });
    expect(confirmGroupContextNativeInput(binding, proof, dir)).toBe(true);
    const db = openDatabaseSyncOrThrow(join(dir, 'group-context-delivery', 'store.db'));
    db.exec(`UPDATE prepared_contexts SET native_consumed_proof = '{"kind":"ipc_arrival"}'`);
    db.close();
    expect(covered('native_known', 'om_turn')).toEqual([]);
    expect(readGroupContextDeliveryReceipt(base.appId, base.chatId, 'om_turn', dir, binding.epoch)).toBeUndefined();
  });
});

describe('native input consumption receipt (session resolution)', () => {
  const identity = (turnId: string, extra: { nativeSessionId?: string; workerGeneration: number; sessionId?: string }) => ({
    appId: base.appId, chatId: base.chatId, turnId, sessionId: extra.sessionId ?? base.sessionId, cliId: base.cliId,
    nativeSessionId: extra.nativeSessionId, workerGeneration: extra.workerGeneration,
  });

  it('promotes a cold first turn with the worker-reported native id and covers it immediately', () => {
    prepareBound('om_first');
    expect(confirmNativeGroupContextInput(identity('om_first', { nativeSessionId: 'native_first', workerGeneration: 1 }), { kind: 'claude_transcript_user_record' }, dir)).toBe(true);
    expect(covered('native_first', 'om_first')).toEqual([1, 2, 3]);
    // The eventual terminal is a compatible no-op, not a second coverage.
    expect(confirmNativeGroupContextTurn(identity('om_first', { nativeSessionId: 'native_first', workerGeneration: 1 }), dir)).toBe(true);
    expect(covered('native_first', 'om_first')).toEqual([1, 2, 3]);
  });

  it('does not accept a receipt without a native identity for a provisional turn, nor from a replacement generation', () => {
    prepareBound('om_first');
    expect(confirmNativeGroupContextInput(identity('om_first', { workerGeneration: 1 }), proof, dir)).toBe(false);
    expect(confirmNativeGroupContextInput(identity('om_first', { nativeSessionId: 'native_first', workerGeneration: 2 }), proof, dir)).toBe(false);
    expect(covered('native_first', 'om_first')).toEqual([]);
  });

  it('never rebinds an established native conversation to another id or session', () => {
    prepareBound('om_turn', { nativeId: 'native_known' });
    expect(confirmNativeGroupContextInput(identity('om_turn', { nativeSessionId: 'native_other', workerGeneration: 1 }), proof, dir)).toBe(false);
    expect(confirmNativeGroupContextInput(identity('om_turn', { nativeSessionId: 'native_known', workerGeneration: 1, sessionId: 'session_b' }), proof, dir)).toBe(false);
    expect(confirmNativeGroupContextInput(identity('om_turn', { nativeSessionId: 'native_known', workerGeneration: 1 }), proof, dir)).toBe(true);
  });

  it('refuses a binding whose dispatch generation was never reserved', () => {
    const epoch = groupContextEpoch(base.sessionId, 'native_known', base.cliId, 'om_turn');
    writePreparedGroupContext({ appId: base.appId, chatId: base.chatId, turnId: 'om_turn', createdAt: Date.now(), body: '', includedSeqs: [1], throughSeq: 1, incomplete: false, epoch }, dir);
    bindGroupContextDelivery({ appId: base.appId, chatId: base.chatId, turnId: 'om_turn', sessionId: base.sessionId, epoch }, dir);
    expect(confirmNativeGroupContextInput(identity('om_turn', { nativeSessionId: 'native_known', workerGeneration: 1 }), proof, dir)).toBe(false);
    expect(covered('native_known', 'om_turn')).toEqual([]);
  });
});

describe('next-turn preparation after a consumed input', () => {
  function message(seq: number, messageId: string, text: string): GroupContextRenderMessage {
    return { seq, messageId, chatId: base.chatId, senderId: 'ou_user', senderType: 'user', senderName: 'u', msgType: 'text', text, createTime: String(1_000 + seq), resourceRefs: [], conversationScope: 'main' } as GroupContextRenderMessage;
  }
  const history = [message(1, 'om_a', 'first topic'), message(2, 'om_b', 'second topic')];
  const preparer = (store: GroupContextRenderMessage[]) => createGroupContextPreparer({
    settings: () => ({ enabled: true, maxContextChars: 24_000 }),
    readPrepared: () => undefined,
    writePrepared: value => writePreparedGroupContext(value, dir),
    backfill: async () => ({ messages: [], incomplete: false }),
    ingest: () => true,
    readLocal: () => ({ messages: store, incomplete: false }),
    deliveredSeqs: (appId, chatId, sessionId, epoch) => getDeliveredGroupContextSeqs(appId, chatId, sessionId, epoch, dir),
    timeoutMs: 1_000,
  });

  it('skips sources consumed by a still-running turn and by a turn interrupted by a restart', async () => {
    const prepare = preparer(history);
    const nativeId = 'native_known';
    const epochA = groupContextEpoch(base.sessionId, nativeId, base.cliId, 'om_first_turn');
    const first = await prepare({ appId: base.appId, chatId: base.chatId, turnId: 'om_first_turn', query: 'q', createTime: 5_000, sessionId: base.sessionId, epoch: epochA, scope: 'main' });
    expect(first?.includedSeqs).toEqual([1, 2]);
    const binding: GroupContextDeliveryBinding = { appId: base.appId, chatId: base.chatId, turnId: 'om_first_turn', sessionId: base.sessionId, epoch: epochA };
    bindGroupContextDelivery(binding, dir);
    const reserved = bindGroupContextWorkerGeneration(binding, 12, dir)!;
    // The input really crosses the delivery boundary with the frozen background embedded.
    expect(commitGroupContextDispatchIntoPayload({ content: `${first!.body}\n\nq` }, { ...binding, workerGeneration: 12 }, dir)?.dispatched.includedSeqs).toEqual([1, 2]);
    // Input accepted by the CLI; the turn is still executing (no terminal).
    expect(confirmNativeGroupContextInput({ appId: base.appId, chatId: base.chatId, turnId: 'om_first_turn', sessionId: base.sessionId, cliId: base.cliId, nativeSessionId: nativeId, workerGeneration: 12 }, proof, dir)).toBe(true);
    // Immediate follow-up in the same native conversation, prepared mid-turn.
    const epochB = groupContextEpoch(base.sessionId, nativeId, base.cliId, 'om_follow_up');
    const followUp = await prepare({ appId: base.appId, chatId: base.chatId, turnId: 'om_follow_up', query: 'q', createTime: 6_000, sessionId: base.sessionId, epoch: epochB, scope: 'main' });
    expect(followUp?.includedSeqs).toEqual([]);
    // A deployment restart replaces the worker generation before any terminal.
    expect(bindGroupContextWorkerGeneration(reserved, 13, dir)).toBeUndefined();
    const afterRestart = await prepare({ appId: base.appId, chatId: base.chatId, turnId: 'om_after_restart', query: 'q', createTime: 7_000, sessionId: base.sessionId, epoch: groupContextEpoch(base.sessionId, nativeId, base.cliId, 'om_after_restart'), scope: 'main' });
    expect(afterRestart?.includedSeqs).toEqual([]);
    // A genuinely new source still appears; a new native conversation gets everything.
    const withNew = await preparer([...history, message(3, 'om_c', 'third topic')])({ appId: base.appId, chatId: base.chatId, turnId: 'om_new_source', query: 'q', createTime: 8_000, sessionId: base.sessionId, epoch: groupContextEpoch(base.sessionId, nativeId, base.cliId, 'om_new_source'), scope: 'main' });
    expect(withNew?.includedSeqs).toEqual([3]);
    const otherNative = await prepare({ appId: base.appId, chatId: base.chatId, turnId: 'om_other_native', query: 'q', createTime: 9_000, sessionId: base.sessionId, epoch: groupContextEpoch(base.sessionId, 'native_other', base.cliId, 'om_other_native'), scope: 'main' });
    expect(otherNative?.includedSeqs).toEqual([1, 2]);
  });
});
