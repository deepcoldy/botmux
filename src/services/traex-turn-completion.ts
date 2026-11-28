import type { CodexBridgeEvent } from './codex-transcript.js';

interface NativeTurn {
  turnId?: string;
  sessionId?: string;
  startedAtMs: number;
  closed: boolean;
}

const sameSession = (left?: string, right?: string) => !left || !right || left === right;

/** Native turns include terminal input that has no Botmux queue mark. Track
 * every open native turn: finals may complete type-ahead turns out of order,
 * and a replay of an older final must never close a newer native turn. */
export class TraexTurnCompletionTracker {
  private generation: number | undefined;
  private seen = new Set<string>();
  private open = new Set<NativeTurn>();
  private latest?: NativeTurn;

  observe(events: readonly CodexBridgeEvent[], generation: number): { started: boolean; completed: boolean } {
    if (this.generation !== generation) {
      this.generation = generation;
      this.seen.clear();
      this.open.clear();
      this.latest = undefined;
    }
    const result = { started: false, completed: false };
    for (const event of events) {
      if (event.kind !== 'user' && event.kind !== 'assistant_final' && event.kind !== 'turn_bind') continue;
      // TRAE synthesizes turn_bind and assistant_final from the same raw line.
      // They carry different lifecycle meanings and must not dedup each other.
      const identity = event.kind === 'turn_bind'
        ? `bind:${event.uuid}`
        : event.rawId ? `raw:${event.rawId}` : event.uuid;
      if (!identity || this.seen.has(identity)) continue;
      this.seen.add(identity);
      if (this.seen.size > 4_096) this.seen.delete(this.seen.values().next().value!);

      if (event.kind === 'turn_bind') {
        if (!event.sourceTurnId) continue;
        const alreadyBound = [...this.open].some(turn => turn.turnId === event.sourceTurnId
          && sameSession(turn.sessionId, event.sourceSessionId));
        if (alreadyBound) continue;
        // A legacy user can receive its provider id only at the terminal. Bind
        // the oldest compatible id-less open turn; an ambiguous/wrong bind
        // leaves another turn open and therefore fails closed below.
        const candidate = [...this.open].find(turn => !turn.turnId
          && sameSession(turn.sessionId, event.sourceSessionId)
          && event.timestampMs >= turn.startedAtMs);
        if (!candidate) continue;
        candidate.turnId = event.sourceTurnId;
        candidate.sessionId ??= event.sourceSessionId;
        continue;
      }

      if (event.kind === 'user') {
        if (this.latest && event.timestampMs < this.latest.startedAtMs) continue;
        if (event.sourceTurnId === this.latest?.turnId && this.latest?.closed) continue;
        result.started = true;
        result.completed = false;
        if (!event.sourceTurnId) {
          // A new-uuid mirror of an id-less user must not leave duplicate open
          // placeholders. Later turn_bind can still bind this same object.
          const current = this.latest && !this.latest.closed && !this.latest.turnId
            && sameSession(this.latest.sessionId, event.sourceSessionId)
            ? this.latest : undefined;
          if (current) {
            current.startedAtMs = Math.max(current.startedAtMs, event.timestampMs);
            current.sessionId ??= event.sourceSessionId;
            this.latest = current;
            continue;
          }
        } else {
          const matches = [...this.open].filter(turn => turn.turnId === event.sourceTurnId
            && sameSession(turn.sessionId, event.sourceSessionId));
          if (matches.length > 1) {
            // Ambiguous duplicate native ids cannot provide completion evidence.
            this.latest = undefined;
            continue;
          }
          const current = matches[0];
          if (current) {
            if (event.timestampMs < current.startedAtMs) continue;
            current.startedAtMs = Math.max(current.startedAtMs, event.timestampMs);
            current.sessionId ??= event.sourceSessionId;
            this.latest = current;
            continue;
          }
        }
        const turn: NativeTurn = {
          turnId: event.sourceTurnId,
          sessionId: event.sourceSessionId,
          startedAtMs: event.timestampMs,
          closed: false,
        };
        this.open.add(turn);
        this.latest = turn;
        continue;
      }

      if (!event.sourceTurnId) continue;
      const matches = [...this.open].filter(turn => turn.turnId === event.sourceTurnId
        && sameSession(turn.sessionId, event.sourceSessionId));
      if (matches.length !== 1) continue;
      const turn = matches[0]!;
      if (event.timestampMs < turn.startedAtMs) continue;
      turn.closed = true;
      turn.sessionId ??= event.sourceSessionId;
      this.open.delete(turn);
      // A newer final is not terminal evidence while an older native turn is
      // still open. The delayed oldest final can complete the batch later.
      if (this.open.size === 0 && this.latest?.closed) result.completed = true;
    }
    return result;
  }
}
