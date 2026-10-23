import { loadWorkerFunction } from './helpers/worker-function-harness.js';
import { describe, expect, it, vi } from 'vitest';
import { CliProgressNotifier, cliProgressNoticeCard, type CliProgressNotice, type CliProgressNoticeDeps } from '../src/services/cli-progress-notice.js';
import { normalizeNoProgressNotifyPolicy } from '../src/services/no-progress-notify-policy.js';

function harness(records: CliProgressNotice[] = []) {
  let now = 0, allowed = true, waiting = false;
  const deps: CliProgressNoticeDeps = {
    records, now: () => now, persist: vi.fn(), allowed: () => allowed, waiting: () => waiting,
    timeout: () => 300_000,
    send: vi.fn(async (_r, level, guard) => { guard(); return `notice-${level}`; }),
    update: vi.fn(async (_r, _id, guard) => { guard(); }), error: vi.fn(),
  };
  const n = new CliProgressNotifier(deps);
  return { n, deps, records, time: (v: number) => { now = v; },
    allow: (v: boolean) => { allowed = v; }, wait: (v: boolean) => { waiting = v; },
    begin: () => n.begin('om_turn', undefined, 'ou_original', 1) };
}

describe('daemon-owned CLI silence notices', () => {
  it('fires without any model callback at 5min, escalates once at 15min, never repeats', async () => {
    const h = harness(); h.begin();
    h.time(299_999); await h.n.poll(); expect(h.deps.send).not.toHaveBeenCalled();
    h.time(300_000); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(1);
    h.time(899_999); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(1);
    h.time(900_000); await h.n.poll(); h.time(9_000_000); await h.n.poll();
    expect(h.deps.send).toHaveBeenCalledTimes(2);
  });
  it('does not monitor a queued turn before an execution start', async () => {
    const h = harness(); h.time(9_000_000); await h.n.poll(); expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('progress resets quiet time; recovery and terminal patch the same cards without new mentions', async () => {
    const h = harness(); h.begin(); h.time(240_000);
    h.n.progress('om_turn', undefined, 1, 'tool_started');
    h.time(300_000); await h.n.poll(); expect(h.deps.send).not.toHaveBeenCalled();
    h.time(540_000); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(1);
    h.n.progress('om_turn', undefined, 1, 'tool_returned'); await h.n.poll();
    expect(h.deps.update).toHaveBeenCalledTimes(1);
    expect(cliProgressNoticeCard(h.records[0], 540_000)).not.toContain('<at');
    h.n.finish('om_turn'); await h.n.poll(); expect(h.deps.update).toHaveBeenCalledTimes(2);
    h.time(9_000_000); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(1);
  });
  it('waits for user/approval without warning; starts a fresh window after the wait', async () => {
    const h = harness(); h.begin(); h.wait(true); h.time(900_000); await h.n.poll();
    expect(h.deps.send).not.toHaveBeenCalled(); h.wait(false); await h.n.poll();
    h.time(1_199_999); await h.n.poll(); expect(h.deps.send).not.toHaveBeenCalled();
    h.time(1_200_000); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(1);
  });
  it('persisted receipts survive reconnect and do not change original initiator', async () => {
    const h = harness(); h.begin(); h.time(300_000); await h.n.poll(); h.n.dispose();
    const restored = harness(JSON.parse(JSON.stringify(h.records)));
    restored.n.begin('om_turn', undefined, 'ou_followup', 2); restored.time(300_001); await restored.n.poll();
    expect(restored.deps.send).not.toHaveBeenCalled(); expect(restored.records[0].caller).toBe('ou_original');
    restored.time(900_000); await restored.n.poll(); expect(restored.deps.send).toHaveBeenCalledTimes(1);
  });
  it('does not revive final turns on duplicate starts', async () => {
    const h = harness(); h.begin(); h.n.reply('om_turn', true); h.begin();
    h.time(900_000); await h.n.poll(); expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('fences stale generations and attempts; disposal prevents future writes', async () => {
    const h = harness(); h.begin(); h.time(200_000);
    h.n.progress('om_turn', undefined, 0, 'tool_returned');
    h.n.progress('om_turn', 2, 1, 'tool_returned'); h.n.finish('om_turn', 2);
    expect(h.records[0].progressAt).toBe(0); h.time(300_000); h.allow(false); await h.n.poll();
    expect(h.deps.send).not.toHaveBeenCalled(); h.allow(true); h.n.dispose(); await h.n.poll();
    expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('claims durably before transport and never blindly resends an ambiguous send, including escalation', async () => {
    const h = harness(); h.begin();
    h.deps.send = vi.fn(async () => { expect(h.records[0].claimed).toBe(1); throw new Error('ACK lost'); });
    h.time(300_000); await h.n.poll(); h.time(900_000); await h.n.poll();
    expect(h.deps.send).toHaveBeenCalledTimes(1);
    const restored = harness(JSON.parse(JSON.stringify(h.records))); restored.time(900_001); restored.begin();
    await restored.n.poll(); expect(restored.deps.send).not.toHaveBeenCalled();
  });
  it('does not escalate a claimed send left without an ACK by a daemon crash', async () => {
    const h = harness(); h.begin(); h.records[0].claimed = 1; h.records[0].deliveryPending = true;
    const restored = harness(JSON.parse(JSON.stringify(h.records))); restored.time(900_000); restored.begin();
    await restored.n.poll(); expect(restored.deps.send).not.toHaveBeenCalled();
  });
  it('fails closed when the durable claim cannot be saved', async () => {
    const h = harness(); h.begin(); h.deps.persist = () => { throw new Error('disk'); };
    h.time(300_000); await expect(h.n.poll()).rejects.toThrow('disk'); expect(h.deps.send).not.toHaveBeenCalled();
  });
  it('rechecks ownership and terminal state immediately before the external write', async () => {
    const h = harness(); h.begin(); const writes = vi.fn();
    h.deps.send = async (_r, _level, guard) => { h.n.finish('om_turn'); guard(); writes(); return 'id'; };
    h.time(300_000); await h.n.poll(); expect(writes).not.toHaveBeenCalled();
  });
  it('serializes polls and patches a progress event that raced the send ACK', async () => {
    const h = harness(); h.begin(); let resolve!: (id: string) => void;
    h.deps.send = vi.fn(async (_r, _level, guard) => { guard(); return new Promise<string>(r => { resolve = r; }); });
    h.time(300_000); const poll = h.n.poll(); await h.n.poll();
    h.n.progress('om_turn', undefined, 1, 'model_output'); resolve('id'); await poll; await h.n.poll();
    expect(h.deps.send).toHaveBeenCalledTimes(1); expect(h.deps.update).toHaveBeenCalledTimes(1);
  });
  it('periodically persists continuous same-stage progress (not only stage transitions)', () => {
    const h = harness(); h.begin(); const initial = vi.mocked(h.deps.persist).mock.calls.length;
    for (let i = 1; i <= 60; i++) { h.time(i * 1000); h.n.progress('om_turn', undefined, 1, 'model_output'); }
    expect(vi.mocked(h.deps.persist).mock.calls.length - initial).toBeGreaterThanOrEqual(6);
    expect(vi.mocked(h.deps.persist).mock.calls.length - initial).toBeLessThan(10);
  });
  it('renders a passive schema 2 card mentioning only the recorded caller, without tool payloads', () => {
    const h = harness(); h.begin(); h.records[0].stalled = true; h.records[0].stage = 'tool_started';
    const card = JSON.parse(cliProgressNoticeCard(h.records[0], 300_000));
    const text = card.body.elements[0].content;
    expect(text).toContain('<at id="ou_original">');
    expect(card.schema).toBe('2.0');
    expect(card.body.elements.map((e: { tag: string }) => e.tag)).toEqual(['markdown']);
  });
  it('retries a failed terminal PATCH to the same message without another POST', async () => {
    const h = harness(); h.begin(); h.time(300_000); await h.n.poll(); h.n.finish('om_turn');
    vi.mocked(h.deps.update).mockRejectedValueOnce(new Error('temporary outage'));
    await h.n.poll(); expect(h.records[0].dirty).toBe(true);
    h.time(315_000); await h.n.poll(); await h.n.poll();
    expect(h.deps.update).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.deps.update).mock.calls.map(call => call[1])).toEqual(['notice-1', 'notice-1']);
    expect(h.records[0].dirty).toBe(false); expect(h.deps.send).toHaveBeenCalledTimes(1);
  });
  it('does not turn a pending recovery retry back into an @ warning after a new stall', async () => {
    const h = harness(); h.begin(); h.time(300_000); await h.n.poll();
    h.n.progress('om_turn', undefined, 1, 'tool_returned');
    vi.mocked(h.deps.update).mockRejectedValue(new Error('temporary outage')); await h.n.poll();
    h.time(1_200_000); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(2);
    expect(h.records[0].stalled).toBe(true);
    await h.n.poll(); expect(h.deps.update).toHaveBeenCalledTimes(2);
    h.n.finish('om_turn'); vi.mocked(h.deps.update).mockResolvedValue(undefined);
    await h.n.poll(); expect(h.deps.update).toHaveBeenCalledTimes(4);
    expect(h.records[0].dirty).toBe(false);
  });
  it('bounds PATCH failures across restore, but a new terminal state gets a fresh budget', async () => {
    const h = harness(); h.begin(); h.time(300_000); await h.n.poll();
    h.n.progress('om_turn', undefined, 1, 'tool_returned');
    vi.mocked(h.deps.update).mockRejectedValue(new Error('persistent outage'));
    await h.n.poll(); await h.n.poll(); h.n.dispose();
    const restored = harness(JSON.parse(JSON.stringify(h.records)));
    vi.mocked(restored.deps.update).mockRejectedValue(new Error('persistent outage'));
    for (let i = 0; i < 10; i++) await restored.n.poll();
    expect(h.deps.update).toHaveBeenCalledTimes(2); expect(restored.deps.update).toHaveBeenCalledTimes(1);
    expect(restored.records[0].dirty).toBe(false); expect(restored.deps.send).not.toHaveBeenCalled();
    vi.mocked(restored.deps.update).mockResolvedValue(undefined); restored.n.finish('om_turn');
    await restored.n.poll(); expect(restored.deps.update).toHaveBeenCalledTimes(2);
    expect(restored.records[0].dirty).toBe(false);
  });
  it('keeps a pending PATCH durable and retries it after interruption', async () => {
    const h = harness(); h.begin(); h.time(300_000); await h.n.poll(); h.n.finish('om_turn');
    let resolve!: () => void;
    h.deps.update = vi.fn(async () => new Promise<void>(r => { resolve = r; }));
    const pending = h.n.poll();
    const restored = harness(JSON.parse(JSON.stringify(h.records))); h.n.dispose();
    await restored.n.poll(); expect(restored.deps.update).toHaveBeenCalledTimes(1);
    expect(restored.records[0].dirty).toBe(false); expect(restored.deps.send).not.toHaveBeenCalled();
    resolve(); await pending;
  });
  it('an in-flight recovery PATCH cannot overwrite a newer terminal state or consume its budget', async () => {
    const h = harness(); h.begin(); h.time(300_000); await h.n.poll();
    h.n.progress('om_turn', undefined, 1, 'tool_returned');
    let resolve!: () => void; let guard!: () => void;
    h.deps.update = vi.fn(async (_r, _id, beforeWrite) => {
      guard = beforeWrite; return new Promise<void>(r => { resolve = r; });
    });
    const pending = h.n.poll(); h.n.finish('om_turn');
    expect(() => guard()).toThrow(); resolve(); await pending;
    expect(h.records[0].dirty).toBe(true); expect(h.records[0].patchAttempts).toBe(0);
    vi.mocked(h.deps.update).mockResolvedValue(undefined); await h.n.poll();
    expect(h.deps.update).toHaveBeenCalledTimes(2); expect(h.records[0].dirty).toBe(false);
  });
  it('claimed fences escalation when an ACK cleared pending but saving the receipt failed', async () => {
    const h = harness(); h.begin(); let failed = false;
    h.deps.persist = vi.fn(() => {
      if (!failed && h.records[0].messages.length) { failed = true; throw new Error('receipt save failed'); }
    });
    h.time(300_000); await h.n.poll(); expect(h.records[0].deliveryPending).toBe(false);
    const restored = harness(JSON.parse(JSON.stringify(h.records))); restored.time(900_000); restored.begin();
    await restored.n.poll(); expect(restored.deps.send).not.toHaveBeenCalled();
    h.time(900_000); await h.n.poll(); expect(h.deps.send).toHaveBeenCalledTimes(1);
  });
  it('CLI is opt-in and does not change the existing App policy defaults', () => {
    expect(normalizeNoProgressNotifyPolicy({})).toEqual({ enabled: true });
    expect(normalizeNoProgressNotifyPolicy({ cliEnabled: true })).toEqual({ enabled: true, cliEnabled: true });
    expect(normalizeNoProgressNotifyPolicy({ enabled: false, cliEnabled: true })).toEqual({ enabled: false, cliEnabled: true });
    expect(() => normalizeNoProgressNotifyPolicy({ cliEnabled: 'yes' })).toThrow();
  });
});


describe('worker progress observation independent of display cap', () => {
  it.each([
    ['codex', true, 'tool_call', 'tool_started'],
    ['codex', true, 'tool_result', 'tool_returned'],
    ['codex', true, 'thinking', 'model_output'],
    ['codex', false, 'tool_call', null],
    ['codex-app', true, 'tool_call', null],
  ])('%s opt-in %s: %s', (cliId, cliEnabled, kind, stage) => {
    const send = vi.fn();
    const scope = {
      lastInitConfig: { cliId, noProgressNotify: { cliEnabled } }, send,
      thinkingTurnKey: 'om_turn|', thinkingTotalChars: 60_000,
      THINKING_ACCUMULATED_CAP: 60_000, thinkingCapNoted: true,
    };
    const observe = loadWorkerFunction('observeCotEntries', scope);
    observe([{ kind, text: 'private-content', args: 'private-arguments', result: 'private-result' }], { turnId: 'om_turn' });
    if (stage) expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'turn_progress', turnId: 'om_turn', stage });
    else expect(send).not.toHaveBeenCalled();
  });
});
