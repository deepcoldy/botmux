import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { preparePiInitialPromptArg } from './pi-initial-prompt.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

/** Adapter for Pi coding-agent's native TUI (`pi`).
 *
 *  ## Type-ahead (re-enabled 2026-08; first tried b2c2ba67, reverted next day
 *  b7dfa0c0 because Pi then had NO turn boundary at all — only the screen marker
 *  `Working...` — so merging multiple busy-period inputs mis-attributed the
 *  final reply / crossed Lark cards).
 *
 *  What changed since the revert: PR #327 (2026-06-30) added Pi's per-session
 *  JSONL transcript bridge (`services/pi-transcript.ts`). Pi's `AssistantMessage`
 *  carries a `stopReason` (`@earendil-works/pi-ai`:
 *  `"stop" | "length" | "toolUse" | "error" | "aborted"`), and `drainPiTranscript`
 *  emits an `assistant_final` on every terminal stopReason (incl. empty
 *  error/aborted turns). That gives CodexBridgeQueue a per-turn user/final pair
 *  to attribute the reply for ordinary turns — enough for type-ahead.
 *
 *  Pi's Message Queue is an active-turn STEER (verified on 0.80.6 — the TUI
 *  shows "Steering: …" + "Alt+Up to edit all queued messages"): a message
 *  submitted while a turn runs is pulled into that same turn, which emits one
 *  merged final (transcript: user1 → tools → user2 → assistant_final, user2
 *  written at dequeue time). This is the identical shape Codex/Grok produce, and
 *  CodexBridgeQueue's HOL-block-drop + dequeue-time markTimeMs override attribute
 *  the single final to the newest matching Lark turn. We deliberately do NOT set
 *  `mergeQueuedInput`: each Lark message keeps its own botmux turn / card, and
 *  the steer merge is reconciled by the bridge queue rather than by pre-squashing
 *  the queue (which the revert-era code did, collapsing distinct cards).
 *
 *  ## Why NOT `reliableTurnTerminal` (type-ahead does not need it)
 *  Type-ahead is gated on `supportsTypeAhead` alone (input-gate.ts); reply
 *  attribution rides the structured-bridge allowlist (pi is in it), not this
 *  flag. `reliableTurnTerminal` is a STRONGER promise — an authoritative,
 *  always-on-disk end-of-turn boundary — that Pi cannot honestly make (verified
 *  on 0.80.6, PR #710 review):
 *    1. Pi's SessionManager writes the JSONL with short-lived `appendFileSync`
 *       (open→append→close); the process holds NO fd on the session file, even
 *       mid-turn (empirically: /proc/<pid>/fd + lsof show nothing across a whole
 *       turn). So a pid→session follow can't track `/new`/`/resume`/fork
 *       rotation, and durable meeting delivery has no reliable boundary.
 *    2. A custom tool returning `terminate:true` ends the agent right after the
 *       toolResult with the last assistant record being `toolUse` (not a
 *       terminal stopReason), and `terminate` is not persisted — so that turn
 *       has no on-disk end marker.
 *  Setting `reliableTurnTerminal` would (a) claim VC-meeting delivery eligibility
 *  Pi can't honor, (b) suppress the busy-marker idle probe Pi actually relies on,
 *  and (c) make `structuredRateLimitAuthoritative` suppress Pi's screen `rate`
 *  verdict with no structured replacement (real 429s vanish). Leaving it unset
 *  keeps Pi on its proven quiescence + `Working...` busy-marker idle path.
 *
 *  ## Idle detection
 *  Pi is a pure-quiescence adapter (no `readyPattern`, no `injectsReadyHook`).
 *  Without `reliableTurnTerminal` the worker keeps the post-submit busy-marker
 *  idle probe and the reattach probe (`scheduleReattachIdleProbe`, gated on
 *  `busyPattern`), so a turn — and a reattached persistent pane with no new PTY
 *  output — is marked ready via the `Working...` marker exactly as before this
 *  change. `assistant_final` events additionally fire idle when they land. */
export function createPiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'pi');
  return {
    id: 'pi',
    authPaths: ['~/.pi/agent/auth.json'],
    resolvedBin: bin,

    buildArgs({ sessionId, initialPrompt }) {
      const args = [
        '--session-id', sessionId,
      ];
      // Pi's interactive mode processes positional initial messages after TUI
      // startup, avoiding stdin races while keeping the native TUI visible.
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `pi --session-id ${sessionId}`;
    },

    prepareInitialPromptArg({ initialPrompt, sessionId, sessionDataDir }) {
      const prepared = preparePiInitialPromptArg({
        prompt: initialPrompt,
        sessionId,
        sessionDataDir,
      });
      return {
        initialPrompt: prepared.initialPromptArg,
        readonlyRoots: prepared.readonlyRoot ? [prepared.readonlyRoot] : undefined,
        cleanupPaths: prepared.filePath ? [prepared.filePath] : undefined,
        cleanupDirs: prepared.cleanupDir ? [prepared.cleanupDir] : undefined,
        deferredInput: prepared.deferredInput,
      };
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
    busyPattern: /Working\.\.\./,
    readyPattern: undefined,
    // Pi's native Message Queue parks/steers submit-while-busy input; the JSONL
    // transcript bridge (drainPiTranscript) + the `Working...` busy marker are
    // enough to attribute the reply per turn. No mergeQueuedInput: one card per
    // Lark turn. No reliableTurnTerminal: Pi holds no session fd and a
    // custom-terminate turn has no on-disk boundary — see the header for why
    // that stronger promise is unsafe (and why type-ahead does not need it).
    supportsTypeAhead: true,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.pi/agent/skills',
  };
}

export const create = createPiAdapter;
