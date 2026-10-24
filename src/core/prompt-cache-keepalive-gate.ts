/**
 * Worker-side write gate for the prompt-cache keep-alive (pure, unit-tested).
 *
 * A keep-alive is typed and submitted with Enter while nobody is watching, so
 * "idle" is not enough: Claude's permission dialog and AskUserQuestion picker
 * are static screens that match the adapter's readyPattern (`❯`) and read as
 * idle, and an Enter there selects the highlighted choice — an unattended
 * approval. The keep-alive is therefore written only with POSITIVE screen
 * evidence that the cursor sits in the real composer (a prompt framed by input
 * box rules above and below), and fails closed whenever that evidence is
 * missing: a skipped ping costs one cache refresh, a wrong one approves a tool.
 *
 * The composer must also be EMPTY: a half-typed draft left in the web or local
 * terminal still sits between the two rules, and the keep-alive would be
 * appended to it and submitted as a real turn.
 *
 * The caller passes `screen: undefined` for backends whose viewport is not
 * authoritative (zmx can carry stale scrollback), so they are refused here on
 * purpose rather than relying on how far a whole-screen scan happens to reach.
 */
import { claudeActionPrompt } from '../services/claude-action-prompt.js';
import { screenShowsFramedPrompt } from '../utils/input-gate.js';

export interface PromptCacheKeepaliveWriteProbe {
  hasBackend: boolean;
  restarting: boolean;
  promptReady: boolean;
  /** A botmux-managed TUI prompt (picker / ask) is open. */
  tuiPromptOpen: boolean;
  bareShell: boolean;
  /** Any queued or in-flight user message, raw input, injection or rename. */
  inputPending: boolean;
  /** Current viewport rendered WITH box-drawing characters preserved;
   *  undefined when this backend has no authoritative screen. */
  screen?: string;
  readyPattern?: RegExp;
}

export type PromptCacheKeepaliveRefusal =
  | 'no_backend'
  | 'restarting'
  | 'prompt_not_ready'
  | 'tui_prompt_open'
  | 'bare_shell'
  | 'input_pending'
  | 'no_screen_evidence'
  | 'action_prompt_open'
  | 'prompt_not_framed'
  | 'composer_not_empty';

/** Why the keep-alive must not be written now; undefined = safe to write. */
export function promptCacheKeepaliveRefusal(probe: PromptCacheKeepaliveWriteProbe): PromptCacheKeepaliveRefusal | undefined {
  if (!probe.hasBackend) return 'no_backend';
  if (probe.restarting) return 'restarting';
  if (!probe.promptReady) return 'prompt_not_ready';
  if (probe.tuiPromptOpen) return 'tui_prompt_open';
  if (probe.bareShell) return 'bare_shell';
  if (probe.inputPending) return 'input_pending';
  if (!probe.screen || !probe.readyPattern) return 'no_screen_evidence';
  if (claudeActionPrompt(probe.screen)) return 'action_prompt_open';
  if (!screenShowsFramedPrompt(probe.screen, probe.readyPattern)) return 'prompt_not_framed';
  // Same line screenShowsFramedPrompt anchored on: the LAST readyPattern hit.
  // An empty composer renders as `❯` plus (non-breaking) spaces; anything else
  // after the prompt is an unsent draft.
  const promptLine = probe.screen.split('\n').reverse().find(line => probe.readyPattern!.test(line)) ?? '';
  if (promptLine.replace(probe.readyPattern, '').trim() !== '') return 'composer_not_empty';
  return undefined;
}
