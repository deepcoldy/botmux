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
  newlyBoundSourceSessionId?: string;
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
  let newlyBoundSourceSessionId: string | undefined;
  const marker = `<session_id>${opts.botmuxSessionId}</session_id>`;
  const kept: CodexBridgeEvent[] = [];
  const drops: HermesSessionFilterDrop[] = [];

  for (const ev of events) {
    const sourceSessionId = ev.sourceSessionId?.trim() || undefined;

    if (!boundSourceSessionId) {
      if (ev.kind === 'user' && sourceSessionId && ev.text.includes(marker)) {
        boundSourceSessionId = sourceSessionId;
        newlyBoundSourceSessionId = sourceSessionId;
      } else {
        drops.push({
          uuid: ev.uuid,
          kind: ev.kind,
          sourceSessionId,
          reason: sourceSessionId ? 'unbound' : 'missing_source',
        });
        continue;
      }
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

  return { events: kept, boundSourceSessionId, newlyBoundSourceSessionId, drops };
}
