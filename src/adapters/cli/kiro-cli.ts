import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

export function createKiroCliAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'kiro-cli';
  let cachedBin: string | undefined;
  return {
    id: 'kiro-cli',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs() {
      // Kiro CLI flags are intentionally not inferred here. Start the native
      // interactive command as-is; cliPathOverride still lets deployments wrap it.
      return [];
    },

    buildResumeCommand() {
      return null;
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
  };
}

export const create = createKiroCliAdapter;
