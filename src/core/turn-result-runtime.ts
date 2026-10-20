import type { TurnResult, TurnResultBinding, TurnDeliveryReceipt, TurnResultLookup } from '../services/turn-result.js';
import { TurnResultStore } from '../services/turn-result-store.js';

export interface TurnResultRuntimeDeps {
  store: TurnResultStore;
  enabled(botId: string): boolean;
  eligible(binding: TurnResultBinding): boolean;
  owns(binding: TurnResultBinding): boolean;
  onTurnResult?(result: Readonly<TurnResult>): void | Promise<void>;
  onObserverError?(ref: TurnResult['ref'], code: string): void;
}

export function createTurnResultRuntime(deps: TurnResultRuntimeDeps) {
  let closed = false;
  const bots = new Set<string>();
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const allowed = (binding: TurnResultBinding): boolean => {
    if (closed) return false;
    if (!deps.enabled(binding.ref.botId)) {
      deps.store.clearBot(binding.ref.botId);
      return false;
    }
    if (!deps.eligible(binding)) {
      deps.store.forget(binding.ref);
      return false;
    }
    return deps.owns(binding);
  };
  const notify = (binding: TurnResultBinding, before: TurnResultLookup): void => {
    if (before.status === 'ready' || !deps.onTurnResult || !allowed(binding)) return;
    const lookup = deps.store.read(binding.ref);
    if (lookup.status !== 'ready') return;
    let finished = false;
    const finish = (code?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pending.delete(timer);
      if (code) {
        try { deps.onObserverError?.(binding.ref, code); } catch {}
      }
    };
    const timer = setTimeout(() => finish('observer_timeout'), 10000);
    timer.unref?.();
    pending.add(timer);
    void Promise.resolve().then(() => {
      if (!allowed(binding)) return;
      return deps.onTurnResult?.(lookup.result);
    }).then(() => finish(), () => finish('observer_failed'));
  };
  return {
    begin(binding: TurnResultBinding): void {
      if (!allowed(binding)) return;
      bots.add(binding.ref.botId);
      deps.store.begin(binding);
    },
    terminal(binding: TurnResultBinding, execution: TurnResult['execution'], empty?: boolean): void {
      if (!allowed(binding)) return;
      const before = deps.store.read(binding.ref);
      deps.store.recordTerminal(binding, execution, empty);
      notify(binding, before);
    },
    delivery(binding: TurnResultBinding, output: TurnResult['output'], receipt: TurnDeliveryReceipt): void {
      if (!allowed(binding)) return;
      const before = deps.store.read(binding.ref);
      deps.store.recordDelivery(binding, output, receipt);
      notify(binding, before);
    },
    read(botId: string, sessionId: string, turnId: string, dispatchAttempt?: number): TurnResultLookup {
      if (closed || !deps.enabled(botId)) {
        deps.store.clearBot(botId);
        return { status: 'unavailable', reason: 'disabled' };
      }
      const ref = { botId, sessionId, turnId, ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }) };
      const lookup = deps.store.read(ref);
      const binding = deps.store.readBinding(ref);
      if (binding && !deps.eligible(binding)) {
        deps.store.forget(ref);
        return { status: 'unavailable', reason: 'unsupported_mode' };
      }
      return lookup;
    },
    close(): void {
      closed = true;
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
      for (const botId of bots) deps.store.clearBot(botId);
      bots.clear();
    },
    clearBot(botId: string): void { deps.store.clearBot(botId); },
    forget(botId: string, sessionId: string, turnId: string, dispatchAttempt?: number): void {
      deps.store.forget({ botId, sessionId, turnId, ...(dispatchAttempt === undefined ? {} : { dispatchAttempt }) });
    },
  };
}

export type TurnResultRuntime = ReturnType<typeof createTurnResultRuntime>;
let runtime: TurnResultRuntime | undefined;

export function setTurnResultRuntime(value: TurnResultRuntime | undefined): void {
  runtime?.close();
  runtime = value;
}

export function getTurnResultRuntime(): TurnResultRuntime | undefined { return runtime; }
