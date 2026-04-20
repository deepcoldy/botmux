import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createOpenCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'opencode');
  return {
    id: 'opencode',
    resolvedBin: bin,

    buildArgs({ initialPrompt }) {
      // OpenCode manages sessions internally (SQLite store).
      // Resume not supported — always start fresh.  --continue exits
      // immediately (code 0) when there is no prior session, causing a
      // crash-loop in the daemon auto-restart path.
      const args: string[] = [];
      // Use --prompt for the initial prompt.  OpenCode's Bubble Tea TUI
      // has an async startup phase; writing to stdin during this window
      // may be lost.  --prompt injects it once the TUI is ready.
      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
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
    readyPattern: undefined,        // Bubble Tea TUI — no reliable prompt indicator; rely on quiescence + spinner guard
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Bubble Tea renders in alternate screen buffer
    skillsDir: '~/.config/opencode/skills',
  };
}

export const create = createOpenCodeAdapter;
