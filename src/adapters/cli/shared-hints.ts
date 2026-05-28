/**
 * Shared botmux routing hints injected into non-Claude CLIs' initial prompt.
 *
 * Claude Code has its own `--append-system-prompt` text baked into
 * `claude-code.ts`; this constant is only consumed by CLIs that don't expose
 * a system-prompt flag (coco / codex / gemini / opencode / aiden / mtr / hermes).
 *
 * Each array element becomes one line inside the `<botmux_routing>` XML block
 * rendered by `buildNewTopicPrompt` in `session-manager.ts`.
 */
import { t, type Locale } from '../../i18n/index.js';

export function buildBotmuxShellHints(locale?: Locale): string[] {
  return [
    t('ai.shell.intro', undefined, locale),
    t('ai.shell.commands_are_shell', undefined, locale),
    t('ai.shell.how_to_send', undefined, locale),
    t('ai.shell.multiline_heredoc', undefined, locale),
    t('ai.shell.heredoc_example', undefined, locale),
    t('ai.shell.helpers', undefined, locale),
    t('ai.shell.when_to_send', undefined, locale),
    t('ai.shell.mention_gate', undefined, locale),
  ];
}

/** @deprecated Use `buildBotmuxShellHints(locale)` instead. Kept for any external callers. */
export const BOTMUX_SHELL_HINTS: string[] = buildBotmuxShellHints();
