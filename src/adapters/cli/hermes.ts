import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

export function createHermesAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'hermes';
  let cachedBin: string | undefined;
  return {
    id: 'hermes',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, disableCliBypass }) {
      const args: string[] = [];
      if (resume) args.push('--resume', sessionId);
      if (!disableCliBypass) args.push('--yolo', '--accept-hooks');
      args.push('--pass-session-id');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `hermes --resume ${sessionId}`;
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
    // Hermes emits an explicit BOTMUX_READY_COMMAND once prompt_toolkit's real
    // input composer has rendered.  Arm Botmux's ready-gate so the first queued
    // Lark prompt waits for that true-ready signal instead of relying on the
    // screen-level ❯ marker alone.  Do not opt into type-ahead: before the first
    // prompt Hermes can silently drop input typed during TUI initialization.
    injectsReadyHook: true,
    deferFirstPromptTimeoutUntilReady: true,
    altScreen: false,
  };
}

export const create = createHermesAdapter;
