import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';
import { hermesSessionExists } from '../../services/hermes-transcript.js';

export function createHermesAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'hermes';
  let cachedBin: string | undefined;
  return {
    id: 'hermes',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, disableCliBypass }) {
      const args: string[] = [];
      if (resume) args.push('--resume', resumeSessionId ?? sessionId);
      if (!disableCliBypass) args.push('--yolo', '--accept-hooks');
      args.push('--pass-session-id');
      return args;
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      return `hermes --resume ${cliSessionId ?? sessionId}`;
    },

    checkResumeTargetExists({ sessionId, cliSessionId, stateDbPath }) {
      return hermesSessionExists(cliSessionId ?? sessionId, stateDbPath);
    },

    async writeInput(pty: PtyHandle, content: string) {
      // Bracketed paste on every backend that supports it. Hermes' prompt_toolkit
      // TUI binds Keys.BracketedPaste (cli_tui_mixin._tui_handle_paste), so a
      // single paste event inserts the whole multiline prompt as CONTENT while
      // embedded \n stay inert; only the Enter afterwards submits.
      //
      // The old path used sendText (tmux `send-keys -l`), which replays the text
      // as individual literal keystrokes and turns every embedded \n into an
      // Enter key. On a cold start those keystrokes sit in the tty input queue
      // while the TUI renders, then drain in a burst together with botmux's
      // trailing Enter. Hermes' anti-paste guard (_RAPID_INPUT_ENTER_WINDOW_S,
      // 50ms since the last buffer change, hermes-agent issue #10994) then
      // classifies that Enter as a pasted newline: the whole opening prompt
      // strands in the composer until a human presses Enter. pasteText is one
      // O(1) event (tmux load-buffer + paste-buffer -d -p), so the last buffer
      // change settles long before the 200ms-delayed Enter. Prompts past
      // Hermes' paste-collapse threshold (>=5 newlines or >=2000 chars) become
      // a `[Pasted text #n: … -> file]` placeholder that Hermes expands back
      // to the full content at submit (cli._expand_paste_references), so the
      // large opening envelope botmux sends is preserved verbatim.
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

    // Hermes TUI's prompt_symbol (from skin_engine.py) is "❯" — match it so
    // the IdleDetector can fire idle the moment the input box appears, instead
    // of waiting for 2s quiescence + 3s spinner-guard on every turn. Without
    // this, parallel sessions (and even cold starts) take 2-3 minutes to be
    // recognized as ready because the only fallback is quiescence, which gets
    // re-armed on every spinner-bearing output (Hermes shows ⟪▲ wings during
    // API calls but those chars are NOT in the SPINNER_RE, so lastSpinnerAt
    // stays at 0 and the detector should fire immediately — yet empirically
    // it doesn't, because the underlying tmux backend's pipe coalesces small
    // writes and re-feeds data in chunks that re-trigger the timer).
    //
    // Mirrors what claude-code (`/❯/`), codex (`/›|\d+% left/`), and codex-app
    // (`/›/`) already do. See test/idle-detector.test.ts for the readypattern
    // contract. Keep this list narrow — Hermes TUI uses ❯ exclusively; if the
    // upstream renderer changes the prompt symbol this PR will need updating.
    readyPattern: /❯/,
    completionPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    // Do NOT arm Botmux's ready-gate for Hermes. #353 set injectsReadyHook here
    // on the premise that Hermes shell-executes BOTMUX_READY_COMMAND once its
    // prompt_toolkit composer renders — a cross-repo contract the shipped Hermes
    // never honored: `grep BOTMUX_READY_COMMAND` across hermes-agent 0.18.x is
    // empty, and Hermes exposes no composer-ready hook at all (its shell-hooks
    // fire only at turn boundaries — on_session_start emits from
    // conversation_loop AFTER the first prompt is already submitted, too late to
    // gate the first prompt on). So the signal never arrives and the gate always
    // falls through its 45s READY_SIGNAL_TIMEOUT_MS, delaying the FIRST cold-start
    // message by ~45s even though the real ❯ composer is up in ~3.6s.
    //
    // Empirically the ❯ readyPattern above IS the earliest reliable readiness
    // signal: a PTY probe of the real binary shows the fully-chromed input box
    // (border + status bar + "/help for commands") at ~3.6s, and Hermes has NO
    // cjadk-style startup selector that would make ❯ a false positive. So we rely
    // on the IdleDetector's ❯ match + deferFirstPromptTimeoutUntilReady (queue
    // the first message until the real ❯ appears, 90s hard cap). Do NOT opt into
    // type-ahead: before the first prompt Hermes can silently drop input typed
    // during TUI initialization (see #342).
    deferFirstPromptTimeoutUntilReady: true,
    altScreen: false,
  };
}

export const create = createHermesAdapter;
