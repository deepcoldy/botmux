/**
 * Complete dynamic foreground/background/cursor-color queries do not change
 * terminal cells. TRAE polls OSC 11 about once a second with a Web viewer
 * attached, which must not perpetually restart its screen-quiescence timer.
 *
 * Deliberately not an ANSI stripper: cursor moves, erases, color assignments,
 * unknown OSC, mixed drawing, and incomplete/fractured sequences all retain
 * their existing activity semantics. Bytes still reach the renderer/viewer.
 */
export function isTerminalColorQueryOnly(data: string): boolean {
  return /^(?:(?:\x1b\]|\x9d)(?:10|11|12);\?(?:\x07|\x1b\\|\x9c))+$/.test(data);
}
