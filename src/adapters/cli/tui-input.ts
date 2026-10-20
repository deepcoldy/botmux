import type { PtyHandle } from './types.js';
import { delay } from '../../utils/timing.js';

/**
 * 交互式 TUI 适配器共用的输入原语。
 *
 * 之前每个适配器各自抄一份：`BRACKETED_PASTE_START/END` 在 dsh-tui / ebsd-input / kimi /
 * oh-my-pi 各定义一遍，gemini / aiden / copilot / mtr 的 `writeInput` 逐字相同。
 */

/** xterm bracketed paste 起止序列：TUI 把两者之间的内容当作一次粘贴，不逐键解析。 */
export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';

/** 把整段文本包成一次 bracketed paste。 */
export function wrapBracketedPaste(content: string): string {
  return `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;
}

/**
 * 「先写文本、等一拍、再回车」的最朴素提交序列。
 *
 * - 有 `sendText` + `sendSpecialKeys`（tmux / herdr 等持久化后端）：文本和 Enter 分两次 send-keys，
 *   间隔 200ms 让 TUI 先处理完文本再收到提交。
 * - 否则退回裸 PTY：`write(content)`、等 1s、`write('\r')`（Ink TUI 的 TextInput 有异步启动阶段，
 *   太早的 CR 会被吞）。
 *
 * 不做提交校验、不返回 `submitted` —— 只适用于没有可验证提交信号的 CLI
 * （aiden / copilot / gemini / mtr）。
 */
export async function writeTextThenEnter(pty: PtyHandle, content: string): Promise<void> {
  if (pty.sendText && pty.sendSpecialKeys) {
    pty.sendText(content);
    await delay(200);
    pty.sendSpecialKeys('Enter');
  } else {
    pty.write(content);
    await delay(1000);
    pty.write('\r');
  }
}
