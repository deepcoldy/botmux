import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from '../../core/cli-launch-mode.js';
import { delay } from '../../utils/timing.js';
import { resolveCommand, resolveCommandReal } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { wrapBracketedPaste } from './tui-input.js';
import type { CliAdapter } from './types.js';

/** The official installer keeps this launcher stable across runtime upgrades. */
export function defaultCodemExecutable(): string {
  const launcher = join(homedir(), '.codem', 'bin', 'codem');
  return existsSync(launcher) ? launcher : 'codem';
}

export function createCodemAdapter(pathOverride?: string): CliAdapter {
  let cachedBin: string | undefined;
  return {
    id: 'codem',
    // Auth, runtime, SQLite state and session JSONL must persist together.
    authPaths: ['~/.codem'],
    get resolvedBin(): string {
      return (cachedBin ??= resolveCommand(pathOverride ?? defaultCodemExecutable()));
    },
    // The installer launcher invokes Node even when Botmux itself is a Bun binary.
    sandboxExtraExecPaths: () => [resolveCommandReal('node')],

    buildArgs({ sessionId, resume, resumeSessionId, model, disableCliBypass }) {
      const args: string[] = [];
      if (!disableCliBypass) args.push('--yolo');
      if (model?.trim()) args.push('--model', model.trim());
      // CodeM separates preset-model intelligence from provider-native effort;
      // inherit its own settings instead of imposing Botmux's effort vocabulary.
      // --session creates once and subsequently reopens THIS topic's history.
      // Imported/native sessions use strict --resume; never select "latest".
      return resume && resumeSessionId
        ? [...args, '--resume', resumeSessionId]
        : [...args, '--session', sessionId];
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      return `codem --resume ${shellQuote(cliSessionId || sessionId)}`;
    },

    async writeInput(pty, content) {
      let written: void | boolean;
      if (pty.sendBracketedPaste) written = pty.sendBracketedPaste(content);
      else if (pty.pasteText && pty.sendSpecialKeys) written = pty.pasteText(content);
      else written = pty.write(wrapBracketedPaste(content));
      if (written === false) return { submitted: false };
      await delay(200);
      const entered = pty.sendSpecialKeys ? pty.sendSpecialKeys('Enter') : pty.write('\r');
      if (entered === false) return { submitted: false };
    },

    systemHints: BOTMUX_SHELL_HINTS,
    // Hold the first send until CodeM has mounted its input widget.
    readyPattern: /Type a task or use \/ @ ! for commands/,
    altScreen: true,
    // Inherit CodeM's authenticated model configuration; no Kimi model defaults.
  };
}
