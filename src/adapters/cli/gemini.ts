import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createGeminiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'gemini');
  return {
    id: 'gemini',
    resolvedBin: bin,

    buildArgs({ initialPrompt }) {
      // Gemini CLI manages sessions internally (--resume takes "latest" or
      // an index/UUID, not our daemon session IDs).  We always start fresh.
      const args = ['--yolo'];
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
    systemHints: [],
    altScreen: true,                // Ink renders in alternate screen buffer by default
    skillsDir: '~/.gemini/skills',
  };
}

export const create = createGeminiAdapter;
