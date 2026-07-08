import { join } from 'node:path';

export const ATTEMPT_TERMINAL_SIDECAR = 'terminal.json';
export const ATTEMPT_TERMINAL_SCHEMA_VERSION = 1;

export type AttemptTerminalStatus = 'live' | 'closed';

export type AttemptTerminalSidecar = {
  schemaVersion: typeof ATTEMPT_TERMINAL_SCHEMA_VERSION;
  sessionId: string;
  /** CLI-native resume id when available (Claude/Codex/etc.). */
  cliSessionId?: string;
  webPort: number;
  status: AttemptTerminalStatus;
  larkAppId?: string;
  botName?: string;
  cliId?: string;
  workingDir?: string;
  sandbox?: boolean;
  sandboxHidePaths?: string[];
  sandboxReadonlyPaths?: string[];
  sandboxNetwork?: boolean;
  logPath?: string;
  startedAt: number;
  updatedAt: number;
  closedAt?: number;
};

export function attemptTerminalSidecarPath(
  runDir: string,
  activityId: string,
  attemptId: string,
): string {
  return join(runDir, 'attempts', activityId, attemptId, ATTEMPT_TERMINAL_SIDECAR);
}
