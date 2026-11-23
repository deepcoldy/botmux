/**
 * Key for comparing a command botmux typed with what a terminal shows for it.
 *
 * Terminal cells are not a faithful copy of the typed text: a composer wraps
 * long lines at arbitrary cells, and tmux draws an emoji whose presentation
 * depends on a variation selector (`⚠️` = U+26A0 U+FE0F) as blank cells
 * (traecli 0.216.0 composer, recorded) while other pictographs and ZWJ
 * sequences survive. Whitespace, pictographs, variation selectors and
 * invisible format characters therefore carry no evidence either way; every
 * other character must match.
 */
export function composerTextKey(text: string): string {
  return text.replace(
    /[\s\p{Extended_Pictographic}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{20E3}]/gu,
    '',
  );
}
