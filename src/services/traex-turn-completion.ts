import type { CodexBridgeEvent } from './codex-transcript.js';

/** Native turns include terminal input that has no Botmux queue mark. A replay
 * of an older final must never close such a newer native turn. */
export class TraexTurnCompletionTracker {
  private generation: number | undefined;
  private seen = new Set<string>();
  private latest?: { turnId: string; sessionId?: string; startedAtMs: number; closed: boolean };

  observe(events: readonly CodexBridgeEvent[], generation: number): { started: boolean; completed: boolean } {
    if (this.generation !== generation) {
      this.generation = generation;
      this.seen.clear();
      this.latest = undefined;
    }
    const result = { started: false, completed: false };
    for (const event of events) {
      if (event.kind !== 'user' && event.kind !== 'assistant_final') continue;
      const identity = event.rawId ? `raw:${event.rawId}` : event.uuid;
      if (!identity || this.seen.has(identity)) continue;
      this.seen.add(identity);
      if (this.seen.size > 4_096) this.seen.delete(this.seen.values().next().value!);
      if (event.kind === 'user') {
        if (this.latest && event.timestampMs < this.latest.startedAtMs) continue;
        if (event.sourceTurnId === this.latest?.turnId && this.latest?.closed) continue;
        result.started = true;
        result.completed = false;
        this.latest = event.sourceTurnId ? {
          turnId: event.sourceTurnId, sessionId: event.sourceSessionId,
          startedAtMs: event.timestampMs, closed: false,
        } : undefined;
      } else if (this.latest && !this.latest.closed && event.sourceTurnId === this.latest.turnId
        && (!event.sourceSessionId || !this.latest.sessionId || event.sourceSessionId === this.latest.sessionId)
        && event.timestampMs >= this.latest.startedAtMs) {
        this.latest.closed = true;
        result.completed = true;
      }
    }
    return result;
  }
}
