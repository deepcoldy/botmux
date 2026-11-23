/**
 * Why the worker refused an unattended maintenance write (keep-alive, auto /
 * idle `/compact`) — the reasons promptCacheKeepaliveRefusal() returns, kept in
 * a dependency-free module so the daemon can read them off an IPC message
 * without loading the worker-side screen recognizers.
 */
export const UNATTENDED_INPUT_REFUSALS = [
  'no_backend',
  'restarting',
  'prompt_not_ready',
  'tui_prompt_open',
  'bare_shell',
  'input_pending',
  'no_screen_evidence',
  'action_prompt_open',
  'prompt_not_framed',
  'composer_not_empty',
  'away_summary_pending',
] as const;

export type PromptCacheKeepaliveRefusal = typeof UNATTENDED_INPUT_REFUSALS[number];

/** A reason from another process: anything this build does not know is undefined. */
export function parseUnattendedInputRefusal(value: unknown): PromptCacheKeepaliveRefusal | undefined {
  return typeof value === 'string' && (UNATTENDED_INPUT_REFUSALS as readonly string[]).includes(value)
    ? value as PromptCacheKeepaliveRefusal
    : undefined;
}
