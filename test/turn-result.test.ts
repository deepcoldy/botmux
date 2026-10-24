import { describe, expect, it, vi } from 'vitest';
import { TurnResultStore } from '../src/services/turn-result-store.js';
import type { TurnResultBinding, TurnResult, TurnDeliveryReceipt } from '../src/services/turn-result.js';
import { createTurnResultRuntime } from '../src/core/turn-result-runtime.js';

const binding: TurnResultBinding = {
  ref: { botId: 'app_result', sessionId: 'session_result', turnId: 'om_result' },
  source: { kind: 'im', platform: 'lark', chatId: 'oc_result', messageId: 'om_result' },
  workerGeneration: 1,
};
const execution: TurnResult['execution'] = { status: 'completed', completedAt: '2026-10-13T00:00:00Z', durationMs: 1200 };
const output: TurnResult['output'] = { status: 'available', format: 'markdown', content: 'Action\n完整正文与证据 https://example.com/evidence', source: 'transcript' };
const receipt: TurnDeliveryReceipt = {
  channel: 'im', platform: 'lark', chatId: 'oc_result', parentMessageId: 'om_result',
  status: 'delivered', messages: [{ kind: 'primary', messageId: 'om_reply' }, { kind: 'attachment', messageId: 'om_file' }],
};

function complete(store: TurnResultStore, current = binding, content = output.content!) {
  store.begin(current);
  store.recordDelivery(current, { ...output, content }, receipt);
  store.recordTerminal(current, execution);
}

describe('ordinary turn result snapshots', () => {
  it.each(['turn_budget_exhausted', 'execution_failed', 'cancelled'])('retains %s in result execution metadata', errorCode => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordDelivery(binding, output, receipt);
    store.recordTerminal(binding, { status: errorCode === 'cancelled' ? 'cancelled' : 'failed', errorCode });
    expect(store.read(binding.ref)).toMatchObject({ status: 'ready', result: {
      execution: { status: errorCode === 'cancelled' ? 'cancelled' : 'failed', errorCode },
      output: { status: 'unavailable' },
    } });
  });
  it.each(['terminal', 'delivery'])('joins terminal and delivery when %s arrives first', first => {
    const store = new TurnResultStore();
    store.begin(binding);
    if (first === 'terminal') store.recordTerminal(binding, execution);
    else store.recordDelivery(binding, output, receipt);
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    if (first === 'terminal') store.recordDelivery(binding, output, receipt);
    else store.recordTerminal(binding, execution);
    expect(store.read(binding.ref)).toEqual({
      status: 'ready',
      result: { version: 1, ref: binding.ref, source: binding.source, execution, output, deliveries: [receipt] },
    });
  });

  it('keeps model completion separate from partial or unknown delivery', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordTerminal(binding, execution);
    store.recordDelivery(binding, output, { ...receipt, status: 'partial', messages: [{ kind: 'attachment', messageId: 'om_file' }], reason: 'primary_unknown' });
    const lookup = store.read(binding.ref);
    expect(lookup.status).toBe('ready');
    if (lookup.status !== 'ready') throw new Error('Expected ready snapshot');
    expect(lookup.result.execution.status).toBe('completed');
    expect(lookup.result.deliveries[0]).toEqual({
      ...receipt, status: 'partial', messages: [{ kind: 'attachment', messageId: 'om_file' }], reason: 'primary_unknown',
    });
  });

  it.each(['failed', 'partial'] as const)(
    'lets a later delivered final replace a provisional %s attempt before terminal',
    status => {
      const store = new TurnResultStore();
      store.begin(binding);
      store.recordDelivery(binding, { status: 'unavailable', reason: 'trusted_plugin_delivery' }, {
        ...receipt,
        status,
        messages: status === 'partial' ? [{ kind: 'primary', messageId: 'om_plugin_partial' }] : [],
        reason: 'trusted_plugin_delivery_failed',
      });
      expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
      store.recordDelivery(binding, output, {
        ...receipt,
        messages: [{ kind: 'primary', messageId: 'om_fallback_final' }],
      });
      store.recordTerminal(binding, execution);
      expect(store.read(binding.ref)).toEqual({
        status: 'ready',
        result: {
          version: 1,
          ref: binding.ref,
          source: binding.source,
          execution,
          output,
          deliveries: [{
            ...receipt,
            messages: [{ kind: 'primary', messageId: 'om_fallback_final' }],
          }],
        },
      });
    },
  );

  it('keeps the first delivered receipt immutable against a later delivered attempt', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordDelivery(binding, output, receipt);
    store.recordDelivery(binding, { ...output, content: 'later output' }, {
      ...receipt,
      messages: [{ kind: 'primary', messageId: 'om_later' }],
    });
    store.recordTerminal(binding, execution);
    const lookup = store.read(binding.ref);
    expect(lookup).toEqual({
      status: 'ready',
      result: {
        version: 1,
        ref: binding.ref,
        source: binding.source,
        execution,
        output,
        deliveries: [receipt],
      },
    });
  });

  it('isolates bot, turn, attempt and worker generation without selecting latest', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordDelivery({ ...binding, workerGeneration: 2 }, output, receipt);
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    complete(store);
    for (const ref of [
      { ...binding.ref, botId: 'app_other' }, { ...binding.ref, turnId: 'om_other' },
      { ...binding.ref, dispatchAttempt: 0 },
    ]) expect(store.read(ref)).toEqual({ status: 'not_found' });
    complete(store, { ...binding, ref: { ...binding.ref, dispatchAttempt: 1 } }, 'second attempt');
    const first = store.read(binding.ref);
    expect(first.status === 'ready' && first.result.output.content).toBe(output.content);
    const second = store.read({ ...binding.ref, dispatchAttempt: 1 });
    expect(second.status === 'ready' && second.result.output.content).toBe('second attempt');
  });

  it('rejects a conflicting source or terminal rather than replacing authoritative facts', () => {
    const store = new TurnResultStore();
    complete(store);
    store.recordDelivery({ ...binding, source: { ...binding.source, chatId: 'oc_other' } }, { ...output, content: 'wrong' }, receipt);
    store.recordTerminal(binding, { status: 'failed' });
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.execution.status).toBe('completed');
    expect(lookup.status === 'ready' && lookup.result.output.content).toBe(output.content);
  });

  it('returns a detached snapshot that cannot alter later reads', () => {
    const store = new TurnResultStore();
    complete(store);
    const lookup = store.read(binding.ref);
    if (lookup.status !== 'ready') throw new Error('Expected ready snapshot');
    try { lookup.result.output.content = 'tampered'; } catch {}
    try { lookup.result.deliveries[0].messages.push({ kind: 'primary', messageId: 'om_bad' }); } catch {}
    const reread = store.read(binding.ref);
    expect(reread.status === 'ready' && reread.result.output.content).toBe(output.content);
    expect(reread.status === 'ready' && reread.result.deliveries[0].messages).toHaveLength(2);
  });

  it('does not infer empty output from completion without positive silence evidence', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordTerminal(binding, execution);
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    const silent = { ...binding, ref: { ...binding.ref, turnId: 'om_silent' } };
    store.begin(silent);
    store.recordTerminal(silent, execution, true);
    const lookup = store.read(silent.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'empty' });
  });

  it('does not expose a partial answer on failed execution', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordDelivery(binding, output, receipt);
    store.recordTerminal(binding, { status: 'failed' });
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'unavailable', reason: 'execution_failed' });
  });

  it.each(['failed', 'cancelled', 'ambiguous'] as const)('waits for final delivery after %s terminal', status => {
    const store = new TurnResultStore();
    store.begin(binding);
    store.recordTerminal(binding, { status });
    expect(store.read(binding.ref)).toEqual({ status: 'not_ready' });
    store.recordDelivery(binding, output, { ...receipt, status: 'partial' });
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'unavailable', reason: `execution_${status}` });
    expect(lookup.status === 'ready' && lookup.result.deliveries[0].messages).toEqual(receipt.messages);
  });

  it('bounds pending and ready entries by count', () => {
    const store = new TurnResultStore();
    store.begin(binding);
    for (let index = 0; index < 128; index++) complete(store, {
      ...binding, ref: { ...binding.ref, turnId: `om_${index}` },
    });
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    expect(store.read({ ...binding.ref, turnId: 'om_127' }).status).toBe('ready');
  });

  it('bounds cached payload bytes without letting reads extend retention', () => {
    const store = new TurnResultStore();
    for (let index = 0; index < 18; index++) complete(store, {
      ...binding, ref: { ...binding.ref, turnId: `om_large_${index}` },
    }, '字'.repeat(340000));
    expect(store.read({ ...binding.ref, turnId: 'om_large_0' })).toEqual({ status: 'not_found' });
    expect(store.read({ ...binding.ref, turnId: 'om_large_17' }).status).toBe('ready');
  });

  it('releases missing final evidence at the pending deadline and expires ready results', () => {
    let now = 0;
    const store = new TurnResultStore({ now: () => now });
    store.begin(binding);
    store.recordTerminal(binding, execution);
    now = 300000;
    expect(store.read(binding.ref)).toEqual({ status: 'unavailable', reason: 'result_not_settled' });
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    complete(store);
    now += 899999;
    expect(store.read(binding.ref).status).toBe('ready');
    now++;
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
  });

  it('keeps receipts without pretending an oversized answer is complete or truncated', () => {
    const store = new TurnResultStore();
    complete(store, binding, '字'.repeat(400000));
    const lookup = store.read(binding.ref);
    expect(lookup.status === 'ready' && lookup.result.output).toEqual({ status: 'unavailable', reason: 'result_too_large' });
    expect(lookup.status === 'ready' && lookup.result.deliveries).toEqual([receipt]);
  });

  it('bounds the complete serialized result including its execution envelope', () => {
    const store = new TurnResultStore();
    const longExecution = { ...execution, completedAt: '2026-10-13T00:00:00.000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000Z' };
    store.begin(binding);
    store.recordDelivery(binding, { ...output, content: 'x'.repeat(1047900) }, receipt);
    store.recordTerminal(binding, longExecution);
    const lookup = store.read(binding.ref);
    expect(lookup.status).toBe('ready');
    if (lookup.status !== 'ready') throw new Error('Expected result');
    expect(Buffer.byteLength(JSON.stringify(lookup.result))).toBeLessThanOrEqual(1048576);
  });

  it('clears only the disabled bot and does not reconstruct cleared results', () => {
    const store = new TurnResultStore();
    complete(store);
    const other = { ...binding, ref: { ...binding.ref, botId: 'app_other' } };
    complete(store, other);
    store.clearBot(binding.ref.botId);
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    expect(store.read(other.ref).status).toBe('ready');
  });

  it('forgets only an exact reference and ignores invalid or missing references', () => {
    const store = new TurnResultStore();
    const otherSession = { ...binding, ref: { ...binding.ref, sessionId: 'session_other' } };
    const otherAttempt = { ...binding, ref: { ...binding.ref, dispatchAttempt: 1 } };
    complete(store);
    complete(store, otherSession);
    complete(store, otherAttempt);
    store.forget({ ...binding.ref, dispatchAttempt: -1 });
    store.forget({ ...binding.ref, turnId: '' });
    store.forget({ ...binding.ref, turnId: 'om_missing' });
    expect(store.read(binding.ref).status).toBe('ready');
    store.forget(binding.ref);
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    expect(store.read(otherSession.ref).status).toBe('ready');
    expect(store.read(otherAttempt.ref).status).toBe('ready');
    store.forget(binding.ref);
    expect(store.read(otherSession.ref).status).toBe('ready');
  });
});

describe('authorized turn result observers', () => {
  it('publishes only a ready snapshot and isolates observer failures from result reads', async () => {
    const received: TurnResult[] = [];
    const errors: string[] = [];
    const runtime = createTurnResultRuntime({
      store: new TurnResultStore(), enabled: () => true, eligible: () => true, owns: () => true,
      onTurnResult: result => { received.push(result); throw new Error('secret error content'); },
      onObserverError: (_ref, code) => { errors.push(code); },
    });
    runtime.begin(binding);
    runtime.terminal(binding, execution);
    expect(received).toEqual([]);
    runtime.delivery(binding, output, receipt);
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toHaveLength(1);
    expect(received[0].output.content).toBe(output.content);
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId).status).toBe('ready');
    expect(errors).toEqual(['observer_failed']);
  });

  it('clears disabled content and refuses stale or ineligible facts', () => {
    let enabled = true;
    let owns = true;
    const runtime = createTurnResultRuntime({
      store: new TurnResultStore(), enabled: () => enabled, eligible: () => true, owns: () => owns,
    });
    runtime.begin(binding);
    owns = false;
    runtime.delivery(binding, output, receipt);
    runtime.terminal(binding, execution);
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'not_ready' });
    owns = true;
    runtime.delivery(binding, output, receipt);
    runtime.terminal(binding, execution);
    enabled = false;
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'unavailable', reason: 'disabled' });
    enabled = true;
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'not_found' });
  });

  it('withdraws result readability when its source mode is no longer eligible', () => {
    let eligible = true;
    const runtime = createTurnResultRuntime({
      store: new TurnResultStore(), enabled: () => true, eligible: () => eligible, owns: () => true,
    });
    runtime.begin(binding);
    runtime.delivery(binding, output, receipt);
    runtime.terminal(binding, execution);
    eligible = false;
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({
      status: 'unavailable', reason: 'unsupported_mode',
    });
    eligible = true;
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'not_found' });
  });

  it.each(['enabled', 'eligible'])('forgets retained output when collection observes revoked %s', gate => {
    let allowed = true;
    const runtime = createTurnResultRuntime({
      store: new TurnResultStore(), enabled: () => gate === 'enabled' ? allowed : true,
      eligible: () => gate === 'eligible' ? allowed : true, owns: () => true,
    });
    runtime.begin(binding);
    runtime.delivery(binding, output, receipt);
    runtime.terminal(binding, execution);
    allowed = false;
    runtime.terminal(binding, execution);
    allowed = true;
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'not_found' });
  });

  it.each(['begin', 'terminal', 'delivery'] as const)(
    'preserves another session when %s rejects an unadmitted binding',
    observation => {
      const rejected = { ...binding, ref: { ...binding.ref, sessionId: 'session_unsupported', turnId: 'synthetic_turn' } };
      const runtime = createTurnResultRuntime({
        store: new TurnResultStore(), enabled: () => true,
        eligible: current => current.ref.sessionId !== rejected.ref.sessionId, owns: () => true,
      });
      runtime.begin(binding);
      runtime.delivery(binding, output, receipt);
      runtime.terminal(binding, execution);
      if (observation === 'begin') runtime.begin(rejected);
      else if (observation === 'terminal') runtime.terminal(rejected, execution);
      else runtime.delivery(rejected, output, receipt);
      expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toMatchObject({
        status: 'ready', result: { output },
      });
      expect(runtime.read(rejected.ref.botId, rejected.ref.sessionId, rejected.ref.turnId)).toEqual({ status: 'not_found' });
      runtime.close();
    },
  );

  it.each(['terminal', 'delivery', 'read'] as const)(
    'withdraws only the ineligible attempt on %s',
    observation => {
      const otherAttempt = { ...binding, ref: { ...binding.ref, dispatchAttempt: 1 } };
      const otherSession = { ...binding, ref: { ...binding.ref, sessionId: 'session_other' } };
      let revoked = false;
      const runtime = createTurnResultRuntime({
        store: new TurnResultStore(), enabled: () => true, owns: () => true,
        eligible: current => !revoked || current.ref.sessionId !== binding.ref.sessionId
          || current.ref.dispatchAttempt !== undefined,
      });
      for (const current of [binding, otherAttempt, otherSession]) {
        runtime.begin(current);
        runtime.delivery(current, output, receipt);
        runtime.terminal(current, execution);
      }
      revoked = true;
      if (observation === 'terminal') runtime.terminal(binding, execution);
      else if (observation === 'delivery') runtime.delivery(binding, output, receipt);
      else expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({
        status: 'unavailable', reason: 'unsupported_mode',
      });
      revoked = false;
      expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'not_found' });
      expect(runtime.read(otherAttempt.ref.botId, otherAttempt.ref.sessionId, otherAttempt.ref.turnId, 1).status).toBe('ready');
      expect(runtime.read(otherSession.ref.botId, otherSession.ref.sessionId, otherSession.ref.turnId).status).toBe('ready');
      runtime.close();
    },
  );

  it('withdraws all sessions when bot enablement is revoked', () => {
    let enabled = true;
    const otherSession = { ...binding, ref: { ...binding.ref, sessionId: 'session_other' } };
    const store = new TurnResultStore();
    const runtime = createTurnResultRuntime({
      store, enabled: () => enabled, eligible: () => true, owns: () => true,
    });
    for (const current of [binding, otherSession]) {
      runtime.begin(current);
      runtime.delivery(current, output, receipt);
      runtime.terminal(current, execution);
    }
    enabled = false;
    runtime.terminal(binding, execution);
    expect(store.read(binding.ref)).toEqual({ status: 'not_found' });
    expect(store.read(otherSession.ref)).toEqual({ status: 'not_found' });
    runtime.close();
  });

  it('reports an observer deadline without changing the completed result', async () => {
    vi.useFakeTimers();
    try {
      const errors: string[] = [];
      const runtime = createTurnResultRuntime({
        store: new TurnResultStore(), enabled: () => true, eligible: () => true, owns: () => true,
        onTurnResult: () => new Promise<void>(() => {}),
        onObserverError: (_ref, code) => { errors.push(code); },
      });
      runtime.begin(binding);
      runtime.delivery(binding, output, receipt);
      runtime.terminal(binding, execution);
      await vi.advanceTimersByTimeAsync(10000);
      expect(errors).toEqual(['observer_timeout']);
      expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId).status).toBe('ready');
      runtime.close();
    } finally { vi.useRealTimers(); }
  });

  it('does not publish an incomplete cache entry as a notification', async () => {
    const received: TurnResult[] = [];
    const runtime = createTurnResultRuntime({
      store: new TurnResultStore(), enabled: () => true, eligible: () => false, owns: () => true,
      onTurnResult: result => { received.push(result); },
    });
    runtime.begin(binding);
    runtime.delivery(binding, output, receipt);
    runtime.terminal(binding, execution);
    await Promise.resolve();
    expect(received).toEqual([]);
    expect(runtime.read(binding.ref.botId, binding.ref.sessionId, binding.ref.turnId)).toEqual({ status: 'not_found' });
  });
});
