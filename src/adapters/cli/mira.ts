import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CliAdapter, PtyHandle } from './types.js';

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'mira-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'mira-runner.js');
  if (existsSync(builtFromSourceTree)) return builtFromSourceTree;
  return compiledSibling;
}

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

function encodeInput(content: string): string {
  return Buffer.from(JSON.stringify({ type: 'message', content }), 'utf8').toString('base64');
}

export function createMiraAdapter(_pathOverride?: string): CliAdapter {
  return {
    id: 'mira',
    resolvedBin: process.execPath,

    buildArgs({ sessionId, resume, resumeSessionId, botName, botOpenId, locale }) {
      const args = [
        runnerPath(),
        '--session-id', sessionId,
      ];
      if (resume && resumeSessionId) args.push('--mira-session-id', resumeSessionId);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      return args;
    },

    buildResumeCommand() {
      // Mira sessions resume through botmux using the persisted Mira session id.
      // There is no stable user-facing CLI command equivalent.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string) {
      const line = `::botmux-mira:${encodeInput(content)}`;
      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          pty.sendText(line);
          pty.sendSpecialKeys('Enter');
        } else {
          pty.write(line + '\r');
        }
      } catch {
        return { submitted: false };
      }
      return { submitted: true };
    },

    completionPattern: undefined,
    readyPattern: /›/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
  };
}

export const create = createMiraAdapter;
