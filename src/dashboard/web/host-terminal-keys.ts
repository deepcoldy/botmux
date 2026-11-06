// 「终端」页触屏快捷键行的按键编码。纯模块（不碰 DOM / xterm），便于单测。

/** 快捷键行能发的键。 */
export type HostTerminalKey = 'esc' | 'tab' | 'shiftTab' | 'ctrlC' | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageUp' | 'pageDown';

const KEY_BYTES: Record<Exclude<HostTerminalKey, keyof typeof CURSOR_FINAL>, string> = {
  esc: '\x1b', tab: '\t', shiftTab: '\x1b[Z', ctrlC: '\x03',
  pageUp: '\x1b[5~', pageDown: '\x1b[6~',
};
/** 受 DECCKM 影响的键：方向键与 Home / End（xterm-256color 的 terminfo 在 keypad 模式下是 SS3）。 */
const CURSOR_FINAL = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' } as const;

/** 光标类键按 DECCKM（应用光标键模式，vim / less / curses keypad 会打开）取 SS3，否则 CSI——和真键盘一致。 */
export function hostTerminalKeyBytes(key: HostTerminalKey, applicationCursorKeys: boolean): string {
  if (key in CURSOR_FINAL) {
    const final = CURSOR_FINAL[key as keyof typeof CURSOR_FINAL];
    return applicationCursorKeys ? `\x1bO${final}` : `\x1b[${final}`;
  }
  return KEY_BYTES[key as keyof typeof KEY_BYTES];
}

/** 粘滞 Ctrl 之后敲的单个字符 → 控制字符（a→^A，[→ESC，?→DEL…）；不是可映射字符返回 null。 */
export function ctrlChord(ch: string): string | null {
  if (ch.length !== 1) return null;
  if (ch === '?') return '\x7f';
  if (ch === ' ' || ch === '2') return '\x00';
  const code = ch.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code & 0x1f) : null;
}
