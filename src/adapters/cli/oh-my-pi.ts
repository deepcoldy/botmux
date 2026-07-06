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
    // buildResumeCommand handles resume separately. Do NOT pass Lark prompts
    // as positional launch args: OMP deposits those in the TUI composer but
    // does not auto-submit them. Route prompts through writeInput, where botmux
    // controls the final submit key.
    buildArgs({ model, workingDir, disableCliBypass }) {
      const args = [
        '--tools', 'read,bash,edit,write,browser,web_search,ast_grep,ast_edit,lsp,debug,find,eval,search,task,ask',
        '--no-title',
      ];
      if (!disableCliBypass) {
        args.push('--approval-mode', 'yolo');
      }
      if (model?.trim()) args.push('--model', model.trim());
      if (workingDir) args.push('--cwd', workingDir);
      return args;
    },

    // OMP positional prompts are not an auto-submit channel; stdin injection is
    // the reliable path.
    passesInitialPromptViaArgs: false,

    // --continue resumes the latest local session.  No precise session-id
    // mapping exists (gemini/opencode share this limitation), so this is
    // best-effort convenience rather than guaranteed per-session resume.
    buildResumeCommand() {
      return 'omp --continue';
    },

    async writeInput(pty: PtyHandle, content: string) {
      // OMP's editor submits on a plain LF (`\n`) in current releases; tmux's
      // symbolic Enter / CR can leave the text sitting in the composer. Use LF
      // for both the tmux paste path and raw PTY fallback so every dispatched
      // Leader→OMP message is actually submitted, not just pasted.
      if (pty.pasteText) {
        pty.pasteText(content);
        await delay(200);
        pty.write('\n');
      } else {
        pty.write(`\x1b[200~${content}\x1b[201~`);
        await delay(1000);
        pty.write('\n');
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
