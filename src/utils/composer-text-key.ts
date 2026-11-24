/**
 * Key for comparing a command botmux typed with what a terminal shows for it.
 *
 * Terminal cells are not a faithful copy of the typed text: a composer wraps
 * long lines at arbitrary cells, and tmux draws `⚠️` (U+26A0 U+FE0F) as
 * blank cells (traecli 0.216.0 composer, recorded). Ignore whitespace and that
 * exact proven-unreadable sequence. Every other visible or invisible codepoint
 * remains significant: deleting pictographs, modifiers, joiners or variation
 * selectors wholesale could equate an edited user draft with our command and
 * submit it with the recovery Enter. An undrawable sequence we do not know
 * about fails closed as `occupied`, ready for a person to submit explicitly.
 */
export function composerTextKey(text: string): string {
  return text.replaceAll('⚠️', '').replace(/\s/gu, '');
}
