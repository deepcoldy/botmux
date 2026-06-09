import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

export function createGeminiAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'gemini';
  let cachedBin: string | undefined;
  return {
    id: 'gemini',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ initialPrompt, model, disableCliBypass }) {
      // Gemini CLI manages sessions internally (--resume takes "latest" or
      // an index/UUID, not our daemon session IDs).  We always start fresh.
      const args = disableCliBypass ? [] : ['--yolo'];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      // Use -i (prompt-interactive) for the initial prompt.  Gemini's Ink TUI
      // has a startup phase where the TextInput component isn't mounted yet
      // (auth, model loading, extensions).  Writing to stdin during this phase
      // is silently lost.  -i injects the prompt inside the session so Gemini
      // processes it once the TUI is fully ready.
      if (initialPrompt) {
        args.push('-i', initialPrompt);
      }
      return args;
    },

    passesInitialPromptViaArgs: true,

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

    completionPattern: undefined,   // quiescence only — no explicit completion marker
    readyPattern: undefined,        // Ink TUI — '>' is too generic; rely on quiescence + spinner guard
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Ink renders in alternate screen buffer by default
    skillsDir: '~/.gemini/skills',
    modelChoices: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  };
}

export const create = createGeminiAdapter;
