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
      // --trust pre-answers the "Workspace Trust Required" startup dialog.
      // Without it, the first spawn in a never-trusted directory (= every
      // fresh-worktree topic) blocks on that dialog; the dialog sits silent,
      // so quiescence-based idle fires and the worker types the first prompt
      // INTO it — the first literal `a` in the text answers [a] Trust (a `q`
      // would quit the CLI outright) and everything typed before the composer
      // renders scatters into scrollback, truncating the prompt head.
      // Deliberately NOT gated by disableCliBypass: this is a startup gate no
      // headless spawn can answer, orthogonal to --force's approval bypass
      // (--force alone does not suppress the dialog — verified empirically).
      const base = ['--trust'];
      // --force skips approvals so the model can act inside the topic without
      // every shell/edit bouncing back to Lark for confirmation — same posture
      // as codex's --dangerously-bypass-approvals-and-sandbox and claude-code's
      // --dangerously-skip-permissions.
      if (!disableCliBypass) base.push('--force');
      if (model && model.trim()) {
        base.push('--model', model.trim());
      }
      if (!resume) return base;
      if (resumeSessionId) return [...base, '--resume', resumeSessionId];
      // No persisted chat id: start FRESH, never `--continue`. Cursor's
      // `--continue` (= `--resume=-1`) resumes the globally most recent chat,
      // which is shared across every botmux session of this bot (same Cursor
      // config home). A worker restart whose cliSessionId was never captured
      // would then silently load a SIBLING session's conversation — e.g. a
      // topic group's context leaking into a private chat. Losing this
      // session's context is the lesser evil; matches reasonix/antigravity,
      // which reject `--continue` for the same "most recent is racy" reason.
      return base;
    },

    buildResumeCommand({ cliSessionId }) {
      // Cursor's chat id is opaque and not derivable from botmux's sessionId;
      // without one we can't print a precise one-liner, so let the closed-session
      // card fall back to its generic note.
      if (!cliSessionId) return null;
      return `cursor-agent --resume ${cliSessionId}`;
    },

    // buildArgs can only resume a precise id (no --continue fallback — it
    // would resume the globally most recent chat, a sibling-context leak).
    // Tells the worker to demote resume-without-id to a fresh launch + notify.
    resumeRequiresCliSessionId: true,

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
      // Submit is always a bare Enter (\r). No adapter-side on-disk submit
      // verification; the worker relies on idle detection plus the structured
      // transcript bridge (agent-transcripts JSONL, see cursor-transcript.ts)
      // for turn attribution and the send-less fallback.
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
