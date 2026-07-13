import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

import { delay } from '../../utils/timing.js';

const TRUSTED_CORE_TOOLS = 'read,write,shell';
const sessionIdRequestedPtys = new WeakSet<PtyHandle>();

async function requestSessionIdOnce(pty: PtyHandle): Promise<void> {
  if (sessionIdRequestedPtys.has(pty)) return;
  sessionIdRequestedPtys.add(pty);
  if (pty.sendText && pty.sendSpecialKeys) {
    pty.sendText('/session-id');
    await delay(200);
    pty.sendSpecialKeys('Enter');
  } else {
    pty.write('/session-id\r');
  }
  await delay(200);
}

export function createKiroCliAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'kiro-cli';
  let cachedBin: string | undefined;
  return {
    id: 'kiro-cli',
    authPaths: ['~/.kiro'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ resume, resumeSessionId, disableCliBypass }) {
      const args = ['chat'];
      if (!disableCliBypass) {
        // Avoid --trust-all-tools: Kiro's terminal UI shows a risk-confirmation
        // gate for that flag. Trust the documented core tools directly instead.
        args.push(`--trust-tools=${TRUSTED_CORE_TOOLS}`);
      }
      if (resume && resumeSessionId) {
        args.push('--resume-id', resumeSessionId);
      }
      return args;
    },

    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      return `kiro-cli chat --resume-id ${cliSessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      await requestSessionIdOnce(pty);
      if (pty.sendText && pty.sendSpecialKeys) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 0) pty.sendText(lines[i]);
          if (i < lines.length - 1) {
            pty.sendSpecialKeys('C-j');
            await delay(50);
          }
        }
        await delay(200);
        pty.sendSpecialKeys('Enter');
      } else {
        pty.write(content.replace(/\n/g, '\x0a'));
        await delay(1000);
        pty.write('\r');
      }
    },

    completionPattern: undefined,
    readyPattern: undefined,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.kiro/skills',
  };
}

export const create = createKiroCliAdapter;
