import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { delay, scaleMs } from '../../utils/timing.js';
import type { CliAdapter, PtyHandle } from './types.js';

const ACE_DIR = join(homedir(), '.ace');

function aceProjectSlug(cwd: string): string | undefined {
  const projectsPath = join(ACE_DIR, 'projects.json');
  if (!existsSync(projectsPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(projectsPath, 'utf8')) as { projects?: Record<string, string> };
    const projects = parsed.projects ?? {};
    const candidates = [cwd, resolve(cwd)];
    try { candidates.push(realpathSync(cwd)); } catch { /* best effort */ }
    for (const key of candidates) {
      if (projects[key]) return projects[key];
    }
  } catch { /* corrupt projects.json */ }
  return undefined;
}

export function aceLogsPath(cwd: string): string {
  const slug = aceProjectSlug(cwd);
  if (!slug) return join(ACE_DIR, 'tmp', '_unknown', 'logs.json');
  return join(ACE_DIR, 'tmp', slug, 'logs.json');
}

function readUserMessages(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry?.type === 'user' && typeof entry?.message === 'string')
      .map((entry) => entry.message as string);
  } catch {
    return [];
  }
}

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function logsContainNewUserMessage(path: string, beforeCount: number, prefix: string): boolean {
  const messages = readUserMessages(path);
  if (messages.length <= beforeCount) return false;
  return messages.slice(beforeCount).some((msg) => msg.startsWith(prefix));
}

async function waitForLogsAppend(
  path: string, beforeCount: number, prefix: string, timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + scaleMs(timeoutMs);
  while (Date.now() < deadline) {
    if (logsContainNewUserMessage(path, beforeCount, prefix)) return true;
    await delay(100);
  }
  return false;
}

function submitPrefix(content: string): string {
  return content.slice(0, 40);
}

export function createAceAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'ace';
  let cachedBin: string | undefined;
  let activeWorkingDir: string | undefined;
  let spawnEnvForNext: Readonly<Record<string, string>> = {
    ACE_NETWORK_TYPE: 'office',
    ACE_ACP_SINGLE_PROVIDER: '1',
  };

  return {
    id: 'ace',
    authPaths: ['~/.ace/oauth_creds.json'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ workingDir, initialPrompt, model, disableCliBypass }) {
      if (workingDir) activeWorkingDir = workingDir;
      spawnEnvForNext = {
        ACE_NETWORK_TYPE: 'office',
        // Match ACP serve.ts: avoid modelhub fallback with openai/gpt-5.5 (400 product not right).
        ACE_ACP_SINGLE_PROVIDER: '1',
        ...(model?.trim() ? { AIDP_MODEL: model.trim() } : {}),
      };

      const args: string[] = [];
      if (!disableCliBypass) args.push('-y');
      // Ace manages sessions internally; CLI --resume is not wired yet.
      if (initialPrompt) args.push(initialPrompt);
      return args;
    },

    get spawnEnv(): Readonly<Record<string, string>> {
      return spawnEnvForNext;
    },

    passesInitialPromptViaArgs: true,

    async writeInput(pty: PtyHandle, content: string) {
      const logsPath = aceLogsPath(pty.cliCwd ?? activeWorkingDir ?? process.cwd());
      const beforeCount = readUserMessages(logsPath).length;
      const prefix = submitPrefix(content);
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          return false;
        }
      };

      try {
        if (pty.pasteText) {
          pty.pasteText(content);
        } else if (pty.sendText && pty.sendSpecialKeys) {
          pty.sendText(content);
        } else {
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
      } catch {
        return { submitted: false };
      }

      await delay(submitDelay);
      if (!trySendEnter()) return { submitted: false };

      if (!existsSync(logsPath) && beforeCount === 0) {
        if (await waitForLogsAppend(logsPath, beforeCount, prefix, 1200)) {
          return undefined;
        }
        if (!existsSync(logsPath)) {
          return undefined;
        }
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForLogsAppend(logsPath, beforeCount, prefix, 800)) {
          return undefined;
        }
        if (!trySendEnter()) return { submitted: false };
      }
      if (await waitForLogsAppend(logsPath, beforeCount, prefix, 800)) {
        return undefined;
      }

      const recheck = (): boolean => logsContainNewUserMessage(logsPath, beforeCount, prefix);
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    readyPattern: /Type your message|Action Required/,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,
    skillsDir: '~/.ace/skills',
    modelChoices: ['openai/gpt-5.5', 'openai/gpt-4.1'],
  };
}

export const create = createAceAdapter;
