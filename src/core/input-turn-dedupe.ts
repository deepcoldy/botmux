export type InputTurnState = 'inflight' | 'committed';

/**
 * Worker-local idempotency fence for daemon retries.
 *
 * A retry can arrive while the first IPC handler is still committing the same
 * turn. Keep that distinct from a committed duplicate: inflight duplicates are
 * ignored and wait for the original ACK, while committed duplicates re-ACK
 * without entering the CLI input queue again.
 */
export class InputTurnDeduper {
  private readonly states = new Map<string, InputTurnState>();

  constructor(private readonly maxCommitted = 256) {}

  begin(turnId: string): 'new' | InputTurnState {
    const current = this.states.get(turnId);
    if (current) return current;
    this.states.set(turnId, 'inflight');
    return 'new';
  }

  commit(turnId: string): void {
    // ACKs for adopt / durable-dispatch turns share the same worker helper but
    // are outside this ordinary-IM fence. Do not let those unrelated turn IDs
    // evict committed ordinary messages from the bounded replay window.
    if (!this.states.has(turnId)) return;
    this.states.delete(turnId);
    this.states.set(turnId, 'committed');
    this.pruneCommitted();
  }

  release(turnId: string): void {
    if (this.states.get(turnId) === 'inflight') this.states.delete(turnId);
  }

  state(turnId: string): InputTurnState | undefined {
    return this.states.get(turnId);
  }

  private pruneCommitted(): void {
    let committed = 0;
    for (const state of this.states.values()) {
      if (state === 'committed') committed += 1;
    }
    if (committed <= this.maxCommitted) return;
    for (const [turnId, state] of this.states) {
      if (state !== 'committed') continue;
      this.states.delete(turnId);
      committed -= 1;
      if (committed <= this.maxCommitted) break;
    }
  }
}
