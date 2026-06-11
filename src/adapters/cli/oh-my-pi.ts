import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/** Adapter for oh-my-pi coding agent's native TUI (`omp`). */
export function createOhMyPiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'omp');
  return {
    id: 'oh-my-pi',
    authPaths: ['~/.omp/agent/auth.json'],
    resolvedBin: bin,

    // oh-my-pi has no --session-id; sessions are managed internally.
    // buildResumeCommand handles resume separately.
    buildArgs({ initialPrompt, model, workingDir, disableCliBypass }) {
      const args = [
        '--tools', 'read,bash,edit,write,browser,web_search,ast_grep,ast_edit,lsp,debug,find,eval,search,task,ask',
        '--no-title',
      ];
      if (!disableCliBypass) {
        args.push('--approval-mode', 'yolo');
      }
      if (model?.trim()) args.push('--model', model.trim());
      if (workingDir) args.push('--cwd', workingDir);
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    // --continue resumes the latest local session.  No precise session-id
    // mapping exists (gemini/opencode share this limitation), so this is
    // best-effort convenience rather than guaranteed per-session resume.
    buildResumeCommand() {
      return 'omp --continue';
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
    skillsDir: '~/.omp/agent/skills',
  };
}

export const create = createOhMyPiAdapter;
