import { createHash } from 'node:crypto';
import { codexSessionIdFromRolloutPath, drainCodexRollout, type CodexBridgeEvent } from './codex-transcript.js';

/** A resumed rollout can copy the entire conversation to a new filename.
 * Scope event identities to the native session and persisted event content,
 * so the bridge queue recognizes copies even when their byte offsets differ.
 * Other readers keep the drainer's path/offset cursor contract unchanged. */
export function codexEventsWithStableIds(path: string, events: CodexBridgeEvent[]): CodexBridgeEvent[] {
  const sid = codexSessionIdFromRolloutPath(path)?.toLowerCase();
  if (!sid) return events;
  return events.map(event => {
    const { uuid: _uuid, ...content } = event;
    const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
    return { ...event, uuid: `codex:${sid}:${hash}` };
  });
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
