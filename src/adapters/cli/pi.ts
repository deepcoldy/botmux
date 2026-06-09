import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/** Adapter for Pi coding-agent's native TUI (`pi`). */
export function createPiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'pi');
  return {
    id: 'pi',
    resolvedBin: bin,

    buildArgs({ sessionId, initialPrompt }) {
      const args = [
        '--session-id', sessionId,
        '--tools', 'read,bash,edit,write,grep,find,ls',
      ];
      // Pi's interactive mode processes positional initial messages after TUI
      // startup, avoiding stdin races while keeping the native TUI visible.
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `pi --session-id ${sessionId}`;
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.pasteText && pty.sendSpecialKeys) {
        pty.pasteText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(`\x1b[200~${content}\x1b[201~`);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.pi/agent/skills',
  };
}

export const create = createPiAdapter;
