import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

const OMP_INPUT_CHUNK_CHARS = 512;
const OMP_INPUT_THROTTLE_MS = 20;

function chunkTextByCodePoint(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (current.length >= maxChars) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function typeText(pty: PtyHandle, content: string): Promise<boolean> {
  const chunks = chunkTextByCodePoint(content, OMP_INPUT_CHUNK_CHARS);
  for (const chunk of chunks) {
    try {
      if (pty.sendText) {
        if (pty.sendText(chunk) === false) return false;
      } else {
        pty.write(chunk);
      }
    } catch {
      return false;
    }
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
      // OMP collapses large bracketed pastes into a `[Paste #N]` placeholder.
      // A programmatic Enter immediately after that placeholder can be ignored,
      // leaving the message stranded until a human presses Enter. Type literal
      // text instead: OMP preserves embedded newlines in the composer, and the
      // final real Enter submits one user message. Chunking avoids tmux/PTY input
      // buffer pressure on long botmux briefs.
      const typed = await typeText(pty, content);
      if (!typed) return { submitted: false };
      if (!submitEnter(pty)) return { submitted: false };
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
