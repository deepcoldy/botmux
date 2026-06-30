import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

export function createKimiAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'kimi';
  let cachedBin: string | undefined;
  return {
    id: 'kimi',
    authPaths: ['~/.kimi-code/credentials', '~/.kimi-code/oauth'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ resume, resumeSessionId, model, disableCliBypass }) {
      const args: string[] = [];
      if (!disableCliBypass) {
        args.push('--yolo');
      }
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (!resume) return args;
      if (resumeSessionId) return [...args, '--resume', resumeSessionId];
      return [...args, '--continue'];
    },

    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      return `kimi --resume ${cliSessionId}`;
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
    altScreen: true,
    modelChoices: [
      'kimi-k2.5',
      'kimi-k2.5-code',
      'kimi-k2.7-code',
    ],
  };
}

export const create = createKimiAdapter;
