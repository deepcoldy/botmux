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
    // Hermes can take minutes to finish cold-start initialization before its
    // real composer appears. Keep the soft first-prompt timeout from flushing
    // into startup screens, while preserving the worker's hard cap so the first
    // queued Lark message is not stranded forever if prompt detection regresses
    // (readyPattern suppresses the IdleDetector's quiescence fallback, so a
    // stale ❯ pattern would otherwise strand it with no recovery path).
    deferFirstPromptTimeoutUntilReady: true,
    // Two effects (input-gate.ts / releaseFirstPromptTimeout): the hard cap
    // above only flushes for type-ahead adapters, AND mid-turn Lark messages
    // are written immediately instead of queuing until idle. The contract this
    // asserts: input submitted while Hermes is busy is not dropped. Upstream
    // advertises non-blocking input + interrupt-and-redirect for the TUI, and
    // the classic prompt_toolkit CLI consumes tty type-ahead at its next
    // prompt. If Hermes users report mid-turn messages vanishing or sitting
    // unsubmitted in the composer, revisit this flag first.
    supportsTypeAhead: true,
    altScreen: false,
  };
}

export const create = createHermesAdapter;
