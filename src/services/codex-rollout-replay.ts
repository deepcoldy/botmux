import { codexGenerationSessionIdFromRolloutPath, drainCodexRollout, type CodexBridgeEvent } from './codex-transcript.js';

/** A resumed rollout can copy the entire conversation to a new generation
 *  file. Scope event identities to the native session plus the originating
 *  raw record, so the bridge queue recognizes copied lines even when their
 *  byte offsets differ. Identity must NOT depend on parsed fallbacks such as
 *  the Date.now() timestamp used for missing/invalid timestamps — one
 *  persisted record would otherwise hash differently on every drain and be
 *  replayed as a fresh local turn. Events without a backing record keep
 *  their path/offset uuid (intra-file stability only). */
export function codexEventsWithStableIds(path: string, events: CodexBridgeEvent[]): CodexBridgeEvent[] {
  const sid = codexGenerationSessionIdFromRolloutPath(path)?.toLowerCase();
  if (!sid) return events;
  return events.map(event => (event.rawId
    ? { ...event, uuid: `codex:${sid}:${event.rawId}` }
    : event));
}

/** Baseline attaches skip parsing history. Before rotating, register just the
 * consumed prefix as seen too; never absorb a terminal beyond the old cursor
 * or an incomplete line. Already ingested events have the same stable ids.
 * If the old file was removed, live events remain deduplicated by the queue. */
export function codexConsumedRolloutEvents(path: string, offset: number): CodexBridgeEvent[] {
  const prefix = `${path}:`;
  const consumed = drainCodexRollout(path, 0).events.filter(event =>
    event.uuid.startsWith(prefix) && Number(event.uuid.slice(prefix.length)) < offset,
  );
  return codexEventsWithStableIds(path, consumed);
}
