import type { SubmitRecheckResult } from '../adapters/cli/types.js';

interface ReceiptWatch {
  recheck: () => SubmitRecheckResult | Promise<SubmitRecheckResult>;
  isCurrent: () => boolean;
  onConfirmed: (result: SubmitRecheckResult) => void;
}

/** The activation journal outlives the bounded submit-warning chain. Observe
 * its original receipt until confirmation or cancellation without ever typing
 * input again. One timer per token; replacement/restart also fences in-flight
 * asynchronous reads, not just timers that have yet to fire. */
export function createQueuedActivationReceiptObserver(intervalMs: number) {
  type Entry = { timer?: ReturnType<typeof setTimeout> };
  const entries = new Map<string, Entry>();

  const cancel = (token: string): void => {
    const entry = entries.get(token);
    if (entry?.timer) clearTimeout(entry.timer);
    entries.delete(token);
  };

  return {
    cancel,
    size: () => entries.size,
    clear(): void {
      for (const token of entries.keys()) cancel(token);
    },
    watch(token: string, watch: ReceiptWatch): void {
      cancel(token);
      const entry: Entry = {};
      entries.set(token, entry);
      const owns = (): boolean => entries.get(token) === entry;
      const current = (): boolean => {
        if (!owns()) return false;
        if (watch.isCurrent()) return true;
        cancel(token);
        return false;
      };
      const arm = (): void => {
        entry.timer = setTimeout(() => { void poll(); }, intervalMs);
        entry.timer.unref?.();
      };
      const poll = async (): Promise<void> => {
        if (!current()) return;
        let result: SubmitRecheckResult = false;
        try { result = await watch.recheck(); }
        catch { /* A temporarily unreadable receipt does not authorize replay. */ }
        if (!current()) return;
        const confirmed = typeof result === 'boolean' ? result : result.submitted === true;
        if (confirmed) {
          cancel(token);
          watch.onConfirmed(result);
          return;
        }
        arm();
      };
      arm();
    },
  };
}
