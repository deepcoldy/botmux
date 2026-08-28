import { existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createEbsdInputWriter } from './ebsd-input.js';
import { resolveCommand } from './registry.js';
import type { CliAdapter } from './types.js';

function validateSessionId(sessionId: string): string {
  if (
    !sessionId
    || sessionId === '.'
    || sessionId === '..'
    || /[/\\\0\r\n]/.test(sessionId)
    || Buffer.byteLength(sessionId, 'utf8') > 255
  ) {
    throw new Error(`Invalid BotMux session id for ebsd: ${sessionId}`);
  }
  return sessionId;
}

/** ebsd service sessions and BotMux must resolve one fixed ~/.ebsd tree. */
export function assertEbsdPerBotEnv(env: Readonly<Record<string, string>>): void {
  if (Object.prototype.hasOwnProperty.call(env, 'HOME')) {
    throw new Error('ebsd does not allow a per-bot HOME override');
  }
}

export function ebsdBotmuxSessionDir(sessionId: string): string {
  const lexicalHome = homedir();
  let canonicalHome = lexicalHome;
  try { canonicalHome = realpathSync(lexicalHome); } catch { /* lexical fallback */ }
  return join(canonicalHome, '.ebsd', 'agent', 'sessions', 'botmux', validateSessionId(sessionId));
}

export function ebsdBotmuxTranscriptPath(sessionId: string): string | null {
  const dir = ebsdBotmuxSessionDir(sessionId);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => {
      const path = join(dir, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
  return candidates[0]?.path ?? null;
}

export function createEbsdAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'ebsd';
  let cachedBin: string | undefined;
  const writeInput = createEbsdInputWriter();
  return {
    id: 'ebsd',
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },
    authPaths: ['~/.ebsd'],
    sandboxReadonlyPaths(env = process.env) {
      return [env.EBSD_BOTMUX_REPOSITORY_ROOT]
        .map(path => path?.trim())
        .filter((path): path is string => !!path);
    },
    sandboxSecretReadonlyPaths(env = process.env) {
      return [
        env.EBSD_BOTMUX_DIAG_TOKEN_FILE,
        env.EBSD_BOTMUX_BYTECLOUD_ACCESS_KEY_FILE,
        env.EBSD_BOTMUX_BYTECLOUD_SECRET_KEY_FILE,
      ]
        .map(path => path?.trim())
        .filter((path): path is string => !!path);
    },
    spawnEnv: { EBSD_NO_UPDATE_CHECK: '1' },

    buildArgs({ sessionId, resume }) {
      const args = [
        'botmux',
        '--session-id', validateSessionId(sessionId),
        '--auth-mode', 'service',
      ];
      if (resume) args.push('--resume');
      return args;
    },

    checkResumeTargetExists({ sessionId }) {
      return ebsdBotmuxTranscriptPath(sessionId) !== null;
    },

    passesInitialPromptViaArgs: false,
    writeInput,
    completionPattern: undefined,
    readyPattern: undefined,
    busyPattern: /Working(?:\.\.\.|…)/,
    supportsTypeAhead: false,
    reliableTurnTerminal: true,
    systemHints: [],
    inputEnvelope: 'service-user',
    allowExtraArgs: false,
    altScreen: true,
  };
}

export const create = createEbsdAdapter;
