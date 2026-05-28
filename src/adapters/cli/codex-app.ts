import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiledSibling = resolve(here, '..', '..', 'codex-app-runner.js');
  if (existsSync(compiledSibling)) return compiledSibling;
  const builtFromSourceTree = resolve(here, '..', '..', '..', 'dist', 'codex-app-runner.js');
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

export function createCodexAppAdapter(pathOverride?: string): CliAdapter {
  const codexBin = resolveCommand(pathOverride ?? 'codex');
  return {
    id: 'codex-app',
    resolvedBin: process.execPath,

    buildArgs({ sessionId, resume, resumeSessionId, workingDir, botName, botOpenId, locale }) {
      const args = [
        runnerPath(),
        '--session-id', sessionId,
        '--codex-bin', codexBin,
      ];
      if (resume && resumeSessionId) args.push('--thread-id', resumeSessionId);
      pushOpt(args, '--cwd', workingDir);
      pushOpt(args, '--bot-name', botName);
      pushOpt(args, '--bot-open-id', botOpenId);
      pushOpt(args, '--locale', locale);
      return args;
    },

    buildResumeCommand() {
      // Codex App threads are resumed through the app-server protocol by
      // botmux. There is not yet a stable user-facing CLI deeplink for a
      // precise desktop thread.
      return null;
    },

    async writeInput(pty: PtyHandle, content: string) {
      const line = `::botmux-codex-app:${encodeInput(content)}`;
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

export const create = createCodexAppAdapter;
