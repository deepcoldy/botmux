import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/** GitHub Copilot CLI adapter (`@github/copilot`).
 *
 *  Copilot CLI is an Ink-based interactive agent shipped as the `copilot`
 *  binary (npm `@github/copilot`). It manages sessions internally — botmux's
 *  `sessionId` cannot be forced as the CLI session id, so we always start
 *  fresh and rely on `--resume <id>` (or `--continue`) for resume. */
export function createCopilotAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'copilot';
  let cachedBin: string | undefined;
  return {
    id: 'copilot',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ resume, resumeSessionId, model, disableCliBypass }) {
      // --allow-all-tools puts Copilot in the same "act without per-tool
      // approval" posture as cursor's --force / claude-code's
      // --dangerously-skip-permissions. Without it every shell/edit bounces
      // back to the TUI for confirmation, which the user can't see in Lark.
      const args: string[] = disableCliBypass ? [] : ['--allow-all-tools'];
      if (model && model.trim()) {
        args.push('--model', model.trim());
      }
      if (!resume) return args;
      if (resumeSessionId) return [...args, '--resume', resumeSessionId];
      // No id on hand — fall back to "most recent session" so the user's
      // context isn't lost. --continue is Copilot's shorthand for
      // resume-latest.
      return [...args, '--continue'];
    },

    buildResumeCommand({ cliSessionId }) {
      // Copilot session ids are opaque and not derivable from botmux's
      // sessionId; without one we can't print a precise one-liner — let the
      // closed-session card fall back to its generic note.
      if (!cliSessionId) return null;
      return `copilot --resume ${cliSessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Copilot's Ink TUI behaves like Gemini/OpenCode: the TextInput
      // component has an async startup phase; writing during that window can
      // be silently lost. Once the prompt is rendered, sendText + Enter is
      // reliable. No documented bracketed-paste fold (unlike cursor), so the
      // simple write+Enter path mirrors the gemini adapter.
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
    readyPattern: undefined,        // Ink TUI prompt is too generic to match reliably
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // Ink renders in the alternate screen buffer
    // Curated model list per Copilot CLI docs: default is Claude Sonnet 4;
    // Sonnet 4.5 / GPT-5 available via /model. Setup always appends a free-form
    // "Other" option, so this is curation only.
    modelChoices: ['claude-sonnet-4', 'claude-sonnet-4.5', 'gpt-5'],
  };
}

export const create = createCopilotAdapter;
