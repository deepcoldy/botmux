import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createAidenAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'aiden');
  return {
    id: 'aiden',
    resolvedBin: bin,

    buildArgs({ sessionId, resume }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      }
      // Aiden auto-generates session id for new sessions
      args.push('--permission-mode', 'agentFull');
      return args;
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
    systemHints: [],
    altScreen: false,
  };
}

export const create = createAidenAdapter;
