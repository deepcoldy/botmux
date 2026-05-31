import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createHermesAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'hermes');
  return {
    id: 'hermes',
    resolvedBin: bin,

    buildArgs({ sessionId, resume, disableCliBypass }) {
      const args: string[] = [];
      if (resume) args.push('--resume', sessionId);
      if (!disableCliBypass) args.push('--yolo', '--accept-hooks');
      args.push('--pass-session-id');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `hermes --resume ${sessionId}`;
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

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
  };
}

export const create = createHermesAdapter;
