import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PI_INITIAL_PROMPT_COMMAND,
  PI_INITIAL_PROMPT_FILE_ENV,
} from './pi-initial-prompt-extension.js';

export const PI_INITIAL_PROMPT_ARG_BYTE_LIMIT = 4096;

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function safeSessionFileStem(sessionId: string): string {
  if (SAFE_SESSION_ID.test(sessionId) && !/^\.+$/.test(sessionId)) return sessionId;
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
}

export function piInitialPromptNeedsFile(prompt: string | undefined): boolean {
  return !!prompt && Buffer.byteLength(prompt, 'utf8') > PI_INITIAL_PROMPT_ARG_BYTE_LIMIT;
}

export function piInitialPromptRootDir(sessionDataDir: string): string {
  return join(sessionDataDir, 'pi-initial-prompts');
}

export function piInitialPromptDir(sessionDataDir: string, sessionId: string): string {
  return join(piInitialPromptRootDir(sessionDataDir), safeSessionFileStem(sessionId));
}

export function piInitialPromptFilePath(sessionDataDir: string, sessionId: string): string {
  return join(piInitialPromptDir(sessionDataDir, sessionId), 'initial.prompt.md');
}

function piInitialPromptExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = resolve(here, 'pi-initial-prompt-extension.js');
  if (existsSync(compiled)) return compiled;
  return resolve(here, 'pi-initial-prompt-extension.ts');
}

export function preparePiInitialPromptArg(opts: {
  prompt: string;
  sessionId: string;
  sessionDataDir?: string;
}): {
  initialPromptArg: string;
  filePath?: string;
  readonlyRoot?: string;
  cleanupDir?: string;
  deferredInput?: {
    content: string;
    additionalArgs: string[];
    env: Record<string, string>;
  };
} {
  if (!piInitialPromptNeedsFile(opts.prompt)) {
    return { initialPromptArg: opts.prompt };
  }

  const sessionDataDir = opts.sessionDataDir?.trim();
  if (!sessionDataDir) {
    throw new Error('Pi long initial prompt requires SESSION_DATA_DIR for @file delivery; refusing TUI paste fallback');
  }

  const dir = piInitialPromptDir(sessionDataDir, opts.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = piInitialPromptFilePath(sessionDataDir, opts.sessionId);
  writeFileSync(filePath, opts.prompt, { encoding: 'utf8', mode: 0o600 });
  return {
    initialPromptArg: `@${filePath}`,
    filePath,
    readonlyRoot: dir,
    cleanupDir: dir,
    deferredInput: {
      content: PI_INITIAL_PROMPT_COMMAND,
      additionalArgs: ['--extension', piInitialPromptExtensionPath()],
      env: { [PI_INITIAL_PROMPT_FILE_ENV]: filePath },
    },
  };
}
