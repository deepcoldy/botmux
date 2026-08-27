/**
 * ebsd-only OMP TUI input writer.
 *
 * Keep this implementation local to the ebsd adapter. It intentionally mirrors
 * OMP's current bracketed-paste behavior without changing or importing the
 * existing oh-my-pi adapter implementation.
 */
import type { PtyHandle, SubmitRecheckResult, WriteInputContext } from './types.js';
import { TERMINAL_CANCEL_COOLDOWN_MS } from '../backend/critical-control-key.js';
import { delay } from '../../utils/timing.js';

const EBSD_INPUT_CHUNK_CHARS = 512;
const EBSD_INPUT_CHUNK_NEWLINES = 9;
const EBSD_INPUT_THROTTLE_MS = 20;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

function normalizeEbsdInput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/\t/g, '   ')
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
}

function chunkEbsdInput(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let newlines = 0;
  for (const character of text) {
    if (
      current
      && (current.length + character.length > EBSD_INPUT_CHUNK_CHARS
        || (character === '\n' && newlines >= EBSD_INPUT_CHUNK_NEWLINES))
    ) {
      chunks.push(current);
      current = '';
      newlines = 0;
    }
    current += character;
    if (character === '\n') newlines += 1;
  }
  if (current) chunks.push(current);
  return chunks;
}

function sendLiteral(pty: PtyHandle, text: string): boolean {
  try {
    if (pty.sendText) return pty.sendText(text) !== false;
    pty.write(text);
    return true;
  } catch {
    return false;
  }
}

async function pasteTextInSafeChunks(pty: PtyHandle, content: string): Promise<boolean> {
  for (const chunk of chunkEbsdInput(content)) {
    if (!sendLiteral(pty, `${BRACKETED_PASTE_START}${chunk}${BRACKETED_PASTE_END}`)) return false;
    await delay(EBSD_INPUT_THROTTLE_MS);
  }
  return true;
}

function submitEnter(pty: PtyHandle, attempts = 3): boolean {
  for (let index = 0; index < attempts; index += 1) {
    try {
      if (pty.sendSpecialKeys) {
        if (pty.sendSpecialKeys('Enter') !== false) return true;
      } else {
        pty.write('\r');
        return true;
      }
    } catch {
      // Retry a bounded number of times below.
    }
  }
  return false;
}

export type EbsdInputWriter = (
  pty: PtyHandle,
  content: string,
  context?: WriteInputContext,
) => Promise<void | {
  submitted: boolean;
  cliSessionId?: string;
  failureReason?: string;
  recheck?: () => SubmitRecheckResult | Promise<SubmitRecheckResult>;
}>;

export function createEbsdInputWriter(): EbsdInputWriter {
  let composerDirty = false;
  let lastClearAttemptAt = 0;

  const clearComposer = async (pty: PtyHandle): Promise<boolean> => {
    const mostRecentCancelAt = Math.max(lastClearAttemptAt, pty.lastInjectedCancelAt ?? 0);
    const waitMs = TERMINAL_CANCEL_COOLDOWN_MS - (Date.now() - mostRecentCancelAt);
    if (waitMs > 0) await delay(waitMs);
    lastClearAttemptAt = Date.now();
    try {
      if (pty.sendSpecialKeys) return pty.sendSpecialKeys('C-c') !== false;
      pty.write('\x03');
      return true;
    } catch {
      return false;
    }
  };

  return async (pty: PtyHandle, content: string) => {
    const normalized = normalizeEbsdInput(content);
    if (!normalized) {
      return {
        submitted: false,
        failureReason: 'ebsd 输入清理控制字符后为空，未发送空消息。',
      };
    }
    if (composerDirty) {
      if (!(await clearComposer(pty))) {
        return {
          submitted: false,
          failureReason: 'ebsd 输入框可能残留未完整消息，自动清理失败；请在终端按 Ctrl+C 清空后重试。',
        };
      }
      composerDirty = false;
    }
    if (!(await pasteTextInSafeChunks(pty, normalized))) {
      composerDirty = !(await clearComposer(pty));
      return { submitted: false };
    }
    if (!submitEnter(pty)) {
      composerDirty = !(await clearComposer(pty));
      return { submitted: false };
    }
    composerDirty = false;
    return { submitted: true };
  };
}
