import type { CodexBridgeEvent } from './codex-transcript.js';

export interface HermesSessionFilterDrop {
  uuid: string;
  kind: CodexBridgeEvent['kind'];
  sourceSessionId?: string;
  expectedSourceSessionId?: string;
  reason: 'unbound' | 'foreign_source' | 'missing_source';
}

export interface HermesSessionFilterResult {
  events: CodexBridgeEvent[];
  boundSourceSessionId?: string;
  /** Every native source this call newly bound, in order. A single drain can
   *  bind more than one source when the worker starts unbound and Hermes
   *  `/clear`-rotates mid-batch; the worker must announce each to the daemon so
   *  a completed turn from an earlier source is not dropped as unauthorized. */
  newlyBoundSourceSessionIds: string[];
  drops: HermesSessionFilterDrop[];
}

/** Keep Hermes' global state.db scoped to the native session that belongs to
 *  this botmux worker. The binding row is the Hermes user row containing the
 *  botmux-injected `<session_id>...` marker. Before that row appears we must
 *  not queue assistant finals from the shared DB, otherwise a sibling Hermes
 *  process can close this worker's pending Lark turn. */
export function filterHermesEventsForBotmuxSession(
  events: readonly CodexBridgeEvent[],
  opts: { botmuxSessionId: string; boundSourceSessionId?: string },
): HermesSessionFilterResult {
  let boundSourceSessionId = opts.boundSourceSessionId;
  const newlyBoundSourceSessionIds: string[] = [];
  const marker = `<session_id>${opts.botmuxSessionId}</session_id>`;
  const kept: CodexBridgeEvent[] = [];
  const drops: HermesSessionFilterDrop[] = [];

  const bindSource = (source: string): void => {
    boundSourceSessionId = source;
    if (!newlyBoundSourceSessionIds.includes(source)) newlyBoundSourceSessionIds.push(source);
  };

  for (const ev of events) {
    const sourceSessionId = ev.sourceSessionId?.trim() || undefined;
    const markerSource = ev.kind === 'user' && sourceSessionId && ev.text.includes(marker)
      ? sourceSessionId
      : undefined;

    if (!boundSourceSessionId) {
      if (markerSource) {
        bindSource(markerSource);
      } else {
        drops.push({
          uuid: ev.uuid,
          kind: ev.kind,
          sourceSessionId,
          reason: sourceSessionId ? 'unbound' : 'missing_source',
        });
        continue;
      }
    } else if (markerSource && markerSource !== boundSourceSessionId) {
      bindSource(markerSource);
    }

    if (!sourceSessionId || sourceSessionId !== boundSourceSessionId) {
      drops.push({
        uuid: ev.uuid,
        kind: ev.kind,
        sourceSessionId,
        expectedSourceSessionId: boundSourceSessionId,
        reason: sourceSessionId ? 'foreign_source' : 'missing_source',
      });
      continue;
    }

    kept.push(ev);
  }

  return { events: kept, boundSourceSessionId, newlyBoundSourceSessionIds, drops };
}
