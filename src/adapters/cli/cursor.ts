import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createCursorAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'cursor-agent');
  return {
    id: 'cursor',
    resolvedBin: bin,

    buildArgs({ resume, resumeSessionId }) {
      // --force skips approvals so the model can act inside the topic without
      // every shell/edit bouncing back to Lark for confirmation — same posture
      // as codex's --dangerously-bypass-approvals-and-sandbox and claude-code's
      // --dangerously-skip-permissions.
      const base = ['--force'];
      if (!resume) return base;
      if (resumeSessionId) return [...base, '--resume', resumeSessionId];
      // No id on hand — fall back to "last chat" so we at least don't drop
      // the user's context. --continue is cursor's shorthand for --resume=-1.
      return [...base, '--continue'];
    },

    buildResumeCommand({ cliSessionId }) {
      // Cursor's chat id is opaque and not derivable from botmux's sessionId;
      // without one we can't print a precise one-liner, so let the closed-session
      // card fall back to its generic note.
      if (!cliSessionId) return null;
      return `cursor-agent --resume ${cliSessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // No on-disk submit verification yet — cursor stores transcripts as
      // JSONL but the path isn't documented. Treat like aiden: paste the
      // text, brief settle, send Enter. Worker still gets quiescence-based
      // idle and the bridge fallback timer if the model never replies.
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
    skillsDir: '~/.cursor/skills',
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
  };
}

export const create = createCursorAdapter;
