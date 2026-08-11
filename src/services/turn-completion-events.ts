import type { WorkerToDaemon } from '../types.js';
import type { Session } from '../types.js';
import {
  getSkillFeedbackStore,
  type SkillFeedbackStore,
  type TurnCompletionEventPayload,
} from './skill-feedback-store.js';

export async function persistTurnTerminal(input: {
  dataDir: string;
  botAppId: string;
  session: Pick<Session, 'sessionId'>;
  terminal: Pick<Extract<WorkerToDaemon, { type: 'turn_terminal' }>, 'turnId' | 'dispatchAttempt' | 'status'>;
  store?: SkillFeedbackStore;
}): Promise<TurnCompletionEventPayload | undefined> {
  const store = input.store ?? await getSkillFeedbackStore(input.dataDir);
  return store.recordTurnTerminal({
    botAppId: input.botAppId,
    sessionId: input.session.sessionId,
    turnId: input.terminal.turnId,
    dispatchAttempt: input.terminal.dispatchAttempt,
    status: input.terminal.status,
  });
}
