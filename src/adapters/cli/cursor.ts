import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/** PTYs that have already received a writeInput. The first write lands while
 *  cursor-agent's TUI is still doing its startup render, so it needs a longer
 *  settle + throttle than later writes. Tracked by identity so the warmup state
 *  is shared across adapter instances. Mirrors claude-code's first-write guard. */
const cursorFirstWriteSeen = new WeakSet<PtyHandle>();

export function createCursorAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'cursor-agent';
  let cachedBin: string | undefined;
  return {
    id: 'cursor',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ resume, resumeSessionId, model, disableCliBypass }) {
      // --force skips approvals so the model can act inside the topic without
      // every shell/edit bouncing back to Lark for confirmation — same posture
      // as codex's --dangerously-bypass-approvals-and-sandbox and claude-code's
      // --dangerously-skip-permissions.
      const base = disableCliBypass ? [] : ['--force'];
      if (model && model.trim()) {
        base.push('--model', model.trim());
      }
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
      // Emit line-by-line instead of writing the whole message at once.
      // cursor-agent's paste detector folds a multi-line chunk that arrives in
      // one burst into a `[Pasted text +N lines]` placeholder the model can't
      // read; typing each line with a throttle between keeps it under that
      // threshold so the text lands verbatim. Covers both backends — tmux
      // (send-keys) and raw PTY (write only). Never use bracketed-paste markers
      // (\x1b[200~ … \x1b[201~): they trigger the fold.
      //
      // Soft-newline differs per backend because the detector counts LF (0x0a)
      // bytes arriving densely:
      //   - tmux: Ctrl+J, cursor's native soft-newline — renders cleanly and
      //     send-keys spaces the bytes out enough to never fold.
      //   - raw PTY: a fast write('\n') folds, so send `\` + CR; cursor eats the
      //     backslash-before-CR as a soft-newline (not part of the submitted
      //     text) and no LF byte hits the stream, making it fold-immune. Costs a
      //     cosmetic trailing `\` in the local TUI render only.
      // Submit is always a bare Enter (\r). No on-disk submit verification —
      // cursor's transcript path isn't documented, so the worker relies on
      // idle detection + the bridge fallback timer.
      const useKeys = !!(pty.sendText && pty.sendSpecialKeys);
      const emitText = (s: string) => (useKeys ? pty.sendText!(s) : pty.write(s));
      const emitSoftNewline = () => {
        if (useKeys) {
          pty.sendSpecialKeys!('C-j');
        } else {
          pty.write('\\');
          pty.write('\r');
        }
      };
      const emitEnter = () => (useKeys ? pty.sendSpecialKeys!('Enter') : pty.write('\r'));

      const isFirstWrite = !cursorFirstWriteSeen.has(pty);
      if (isFirstWrite) {
        cursorFirstWriteSeen.add(pty);
        await delay(200);
      }
      const throttleMs = isFirstWrite ? 80 : 30;
      const tick = () => delay(throttleMs);

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          emitText(lines[i]);
          await tick();
        }
        if (i < lines.length - 1) {
          emitSoftNewline();
          await tick();
        }
      }
      await delay(200);
      emitEnter();
    },

    completionPattern: undefined,
    skillsDir: '~/.cursor/skills',
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    modelChoices: ['auto', 'claude-4-sonnet', 'claude-4-opus', 'gpt-5'],
  };
}

export const create = createCursorAdapter;
