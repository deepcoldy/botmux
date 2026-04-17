import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCodexAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex',
    resolvedBin: bin,

    buildArgs() {
      // Codex manages its own session IDs internally — we cannot pass ours.
      // Resume is not supported; daemon always starts a fresh Codex session.
      return [
        '--dangerously-bypass-approvals-and-sandbox',
        '--no-alt-screen',
      ];
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
    readyPattern: /›|\d+% left/,  // › for input box, or status bar pattern (e.g. "97% left")
    systemHints: [],
    altScreen: false,   // --no-alt-screen disables alternate screen
  };
}

export const create = createCodexAdapter;
