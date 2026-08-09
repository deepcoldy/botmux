import type { WorkerToDaemon } from '../types.js';

export interface CliSessionIdPublisherInput {
  cliSessionId: string;
  sessionId: string | undefined;
  initConfig: { cliSessionId?: string } | null | undefined;
  turnId: string | undefined;
  dispatchAttempt: number | undefined;
  send: (message: WorkerToDaemon) => void;
}

/**
 * Publish CLI-native identity to the daemon without writing sessions.json.
 *
 * The daemon owns the authoritative in-memory Session and persists this IPC
 * patch. A worker-side full-row write can be based on an older projection and
 * overwrite a newer Riff lineage committed by another process.
 */
export function publishCliSessionIdToDaemon(input: CliSessionIdPublisherInput): boolean {
  if (!input.cliSessionId || !input.sessionId) return false;
  if (input.initConfig) input.initConfig.cliSessionId = input.cliSessionId;
  input.send({
    type: 'cli_session_id',
    cliSessionId: input.cliSessionId,
    turnId: input.turnId,
    dispatchAttempt: input.dispatchAttempt,
  });
  return true;
}
