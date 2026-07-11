import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

const OMP_INPUT_CHUNK_CHARS = 512;
const OMP_INPUT_CHUNK_NEWLINES = 9;
const OMP_INPUT_THROTTLE_MS = 20;
const OMP_CLEAR_COOLDOWN_MS = 550;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/** Match OMP's paste semantics before putting content on a key-event path. */
function normalizeOmpInput(text: string): string {
  return text
    // Strip ANSI/VT sequences as whole units so removing ESC does not leave
    // printable tails such as `[31m` in pasted terminal logs.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/\t/g, '   ')
    // Literal terminal input would interpret these as keys (Backspace, DEL,
    // Escape, etc.). Newlines are preserved and delivered inside paste mode.
    .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
}

/** Keep every paste below OMP's `[Paste #N]` thresholds (>1000 chars or >10 lines). */
function chunkOmpInput(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let newlines = 0;
  for (const ch of text) {
    if (
      current &&
      (current.length + ch.length > OMP_INPUT_CHUNK_CHARS ||
        (ch === '\n' && newlines >= OMP_INPUT_CHUNK_NEWLINES))
    ) {
      chunks.push(current);
      current = '';
      newlines = 0;
    }
    current += ch;
    if (ch === '\n') newlines++;
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
  const chunks = chunkOmpInput(content);
  for (const chunk of chunks) {
    // Emit the markers ourselves instead of relying on backend pasteText():
    // tmux/zellij implement bracketed paste, while herdr's pasteText is only a
    // literal write. One explicit wire format keeps every backend equivalent.
    if (!sendLiteral(pty, `${BRACKETED_PASTE_START}${chunk}${BRACKETED_PASTE_END}`)) return false;
    await delay(OMP_INPUT_THROTTLE_MS);
  }
  return true;
}

function submitEnter(pty: PtyHandle, attempts = 3): boolean {
  for (let i = 0; i < attempts; i++) {
    try {
      if (pty.sendSpecialKeys) {
        if (pty.sendSpecialKeys('Enter') !== false) return true;
      } else {
        pty.write('\r');
        return true;
      }
    } catch {
      // retry below
    }
  }
  return false;
}

/** Adapter for oh-my-pi coding agent's native TUI (`omp`). */
export function createOhMyPiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'omp');
  let composerDirty = false;
  let lastClearAttemptAt = 0;

  const clearComposer = async (pty: PtyHandle): Promise<boolean> => {
    // OMP treats a second Ctrl+C within 500 ms as exit. Keep recovery clears
    // outside that window even when consecutive terminal writes fail quickly.
    const waitMs = OMP_CLEAR_COOLDOWN_MS - (Date.now() - lastClearAttemptAt);
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

  return {
    id: 'oh-my-pi',
    authPaths: ['~/.omp/agent/auth.json'],
    resolvedBin: bin,

    // oh-my-pi has no --session-id; sessions are managed internally.
    // buildResumeCommand handles resume separately. Do NOT pass Lark prompts
    // as positional launch args: OMP deposits those in the TUI composer but
    // does not auto-submit them. Route prompts through writeInput, where botmux
    // controls the final submit key.
    buildArgs({ model, workingDir, disableCliBypass }) {
      const args = [
        '--tools', 'read,bash,edit,write,browser,web_search,ast_grep,ast_edit,lsp,debug,find,eval,search,task,ask',
        '--no-title',
      ];
      if (!disableCliBypass) {
        args.push('--approval-mode', 'yolo');
      }
      if (model?.trim()) args.push('--model', model.trim());
      if (workingDir) args.push('--cwd', workingDir);
      return args;
    },

    // OMP positional prompts are not an auto-submit channel; stdin injection is
    // the reliable path.
    passesInitialPromptViaArgs: false,

    // --continue resumes the latest local session.  No precise session-id
    // mapping exists (gemini/opencode share this limitation), so this is
    // best-effort convenience rather than guaranteed per-session resume.
    buildResumeCommand() {
      return 'omp --continue';
    },

    async writeInput(pty: PtyHandle, content: string) {
      const normalized = normalizeOmpInput(content);
      if (!normalized) {
        return {
          submitted: false,
          failureReason: 'OMP 输入清理控制字符后为空，未发送空消息。',
        };
      }

      // A previous best-effort clear may itself have been dropped. Never append
      // a new message to that unknown buffer: clear it successfully first.
      if (composerDirty) {
        if (!(await clearComposer(pty))) {
          return {
            submitted: false,
            failureReason: 'OMP 输入框可能残留未完整消息，自动清理失败；请在终端按 Ctrl+C 清空后重试。',
          };
        }
        composerDirty = false;
      }

      // OMP collapses a single large bracketed paste into `[Paste #N]`, whose
      // immediately-following programmatic Enter can be ignored. Preserve paste
      // sanitization (so tabs/newlines/control bytes are text, not key events),
      // but split below both placeholder thresholds before the final real Enter.
      const pasted = await pasteTextInSafeChunks(pty, normalized);
      if (!pasted) {
        composerDirty = !(await clearComposer(pty));
        return { submitted: false };
      }
      if (!submitEnter(pty)) {
        composerDirty = !(await clearComposer(pty));
        return { submitted: false };
      }
      composerDirty = false;
      return { submitted: true };
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.omp/agent/skills',
  };
}

export const create = createOhMyPiAdapter;
