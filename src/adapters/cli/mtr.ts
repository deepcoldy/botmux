import { createHash } from 'node:crypto';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

import { delay } from '../../utils/timing.js';

function isMtrSessionId(value: string | undefined): value is string {
  return typeof value === 'string' && /^ses_[0-9A-Za-z]+$/.test(value);
}

export function mtrSessionIdForBotmuxSession(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest();
  const timeHex = digest.subarray(0, 6).toString('hex');
  let suffix = '';
  for (let i = 6; i < 20; i++) {
    suffix += BASE62[digest[i]! % BASE62.length];
  }
  return `ses_${timeHex}${suffix}`;
}

function nativeSessionId(sessionId: string, cliSessionId?: string): string {
  return isMtrSessionId(cliSessionId) ? cliSessionId : mtrSessionIdForBotmuxSession(sessionId);
}

export function createMtrAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'mtr';
  let cachedBin: string | undefined;
  return {
    id: 'mtr',
    authPaths: ['~/.local/share/opencode/auth.json'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId, initialPrompt }) {
      const mtrSessionId = nativeSessionId(sessionId, resumeSessionId);
      const args = resume
        ? ['--session', mtrSessionId]
        : ['--set-session', mtrSessionId];

      if (initialPrompt) {
        args.push('--prompt', initialPrompt);
      }
      return args;
    },

    buildResumeCommand({ sessionId, cliSessionId }) {
      return `mtr --session ${nativeSessionId(sessionId, cliSessionId)}`;
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      if (pty.sendText && pty.sendSpecialKeys) {
        pty.sendText(content);
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content);
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.config/opencode/skills',
  };
}

export const create = createMtrAdapter;
