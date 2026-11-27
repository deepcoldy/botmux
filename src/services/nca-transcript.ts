import type { CodexBridgeEvent } from './codex-transcript.js';
import { scanJsonlFromOffset } from './jsonl-cursor.js';

interface NcaTranscriptRecord {
  version?: number;
  session?: string;
  recorded_at?: number;
  event?: {
    type?: string;
    turn?: string;
    attempt?: string;
    status?: string;
    message?: { text?: string };
    outcome?: { output?: { text?: { text?: string }; calls?: unknown[] } };
  };
}

interface NcaTranscriptState {
  attempt?: { turn: string; id: string; text: string };
  accepted?: { turn: string; text: string };
}

/** The default NCA loop records intermediate model attempts alongside the
 * final answer. Forward only the accepted text at the native turn boundary. */
export function drainNcaTranscript(path: string, offset: number, previous?: NcaTranscriptState) {
  const state: NcaTranscriptState = { ...previous };
  const events: CodexBridgeEvent[] = [];
  const cursor = scanJsonlFromOffset(path, offset, {
    onLine(line, lineStart) {
      let record: NcaTranscriptRecord | undefined;
      try { record = JSON.parse(line) ?? undefined; } catch { return; }
      if (record?.version !== 1 || !record.event || !Number.isFinite(record.recorded_at)) return;
      const event = record.event;
      const base = {
        uuid: `${path}:${lineStart}`,
        timestampMs: record.recorded_at!,
        sourceSessionId: record.session,
      };
      const turn = typeof event.turn === 'string' ? event.turn : undefined;
      switch (event.type) {
        case 'input-admitted': {
          const text = event.message?.text;
          if (typeof text === 'string' && text.trim()) events.push({ ...base, kind: 'user', text });
          break;
        }
        case 'turn-started':
          if (turn) events.push({ ...base, kind: 'turn_bind', text: '', sourceTurnId: turn });
          break;
        case 'attempt-finished': {
          const output = event.outcome?.output;
          const text = output?.calls?.length ? undefined : output?.text?.text;
          if (turn && event.status === 'completed' && typeof event.attempt === 'string') {
            state.attempt = { turn, id: event.attempt, text: typeof text === 'string' ? text : '' };
          }
          break;
        }
        case 'model-accepted':
          if (turn && state.attempt?.turn === turn && state.attempt.id === event.attempt) {
            state.accepted = { turn, text: state.attempt.text };
          }
          break;
        case 'turn-ended': {
          if (!turn) break;
          const completed = event.status === 'completed';
          const failed = event.status === 'failed';
          // This record closes the turn even if the TUI never redraws its empty
          // composer. Use the structured final edge with no assistant text.
          events.push({
            ...base,
            kind: 'assistant_final',
            text: completed && state.accepted?.turn === turn ? state.accepted.text : '',
            sourceTurnId: turn,
            ...(!completed && {
              terminalStatus: failed ? 'failed' : 'ambiguous',
              terminalErrorCode: failed ? 'nca_turn_failed' : 'nca_turn_aborted',
            }),
          });
          if (state.attempt?.turn === turn) delete state.attempt;
          if (state.accepted?.turn === turn) delete state.accepted;
          break;
        }
      }
    },
  });
  return { ...(cursor ?? { newOffset: offset, pendingTail: '' }), state, events };
}
