import { resolveCommand } from './registry.js';
import type { CliAdapter } from './types.js';

/**
 * Thin adapter paired with RemoteRunnerBackend.
 *
 * The backend owns the structured JSONL protocol and receives turns through
 * SessionBackend.submitTurn(). This adapter only supplies the provider binary
 * and ordinary launch args; its terminal write fallback rejects instead of
 * silently degrading a structured turn into keystrokes.
 */
export function createRemoteRunnerAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'botmux-remote-runner';
  let cachedBin: string | undefined;
  return {
    id: 'remote-runner',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    allowExtraArgs: true,
    buildArgs() { return []; },
    buildResumeCommand() { return null; },
    async writeInput() {
      return {
        submitted: false,
        submissionDisposition: 'untouched' as const,
        failureReason: 'remote-runner requires a structured backend turn channel',
      };
    },
    supportsTypeAhead: false,
    reliableTurnTerminal: true,
    completionPattern: undefined,
    systemHints: [],
    altScreen: false,
  };
}

export const create = createRemoteRunnerAdapter;
