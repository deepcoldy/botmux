import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

export function createAidenAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'aiden';
  let cachedBin: string | undefined;
  return {
    id: 'aiden',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, disableCliBypass }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      }
      // Aiden auto-generates session id for new sessions
      if (!disableCliBypass) args.push('--permission-mode', 'agentFull');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      // Aiden uses botmux's sessionId directly — no rotation, no separate
      // CLI-native id, so cliSessionId isn't consulted.
      return `aiden --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,  // quiescence only
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createAidenAdapter;
