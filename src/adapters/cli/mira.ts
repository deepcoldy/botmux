import type { CliAdapter, PtyHandle } from './types.js';
import { writeRunnerInput } from './runner-input.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';

function pushOpt(args: string[], key: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return;
  args.push(key, value);
}

export function createMiraAdapter(_pathOverride?: string): CliAdapter {
  return {
    id: 'mira',
    resolvedBin: process.execPath,

    buildArgs({ sessionId, resume, resumeSessionId, botName, botOpenId, locale }) {
      const args = [
        runnerArgv0('mira-runner', resolveRunnerPath('mira-runner.js')),
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
      // Chunked + throttled stdin injection (see runner-input.ts) — avoids the
      // single-giant-send-keys drop that wedged sessions on large messages.
      return writeRunnerInput(pty, '::botmux-mira:', content);
    },

    completionPattern: undefined,
    readyPattern: /›/,
    systemHints: [],
    injectsSessionContext: true,
    altScreen: false,
  };
}
