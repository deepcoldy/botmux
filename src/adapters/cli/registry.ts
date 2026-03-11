import { execSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CliAdapter, CliId } from './types.js';

/** Resolve a command name to its absolute path via login-shell `which`. */
export function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  const shell = process.env.SHELL || '/bin/zsh';
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i);
  for (const sh of shells) {
    try {
      return execSync(`${sh} -lc 'which ${cmd}'`, { encoding: 'utf-8', timeout: 5_000 }).trim();
    } catch { /* try next shell */ }
  }
  return cmd;
}

// Lazy-loaded adapter modules to avoid circular deps
const adapterFactories: Record<CliId, () => Promise<{ create: (pathOverride?: string) => CliAdapter }>> = {
  'claude-code': () => import('./claude-code.js'),
  'aiden': () => import('./aiden.js'),
  'coco': () => import('./coco.js'),
  'codex': () => import('./codex.js'),
};

const adapterCache = new Map<string, CliAdapter>();

export async function createCliAdapter(id: CliId, pathOverride?: string): Promise<CliAdapter> {
  const key = `${id}:${pathOverride ?? ''}`;
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const factory = adapterFactories[id];
  if (!factory) throw new Error(`Unknown CLI adapter: ${id}`);
  const mod = await factory();
  const adapter = mod.create(pathOverride);
  adapterCache.set(key, adapter);
  return adapter;
}

/** Synchronous version for use in worker process (adapters already imported). */
import { createClaudeCodeAdapter } from './claude-code.js';
import { createAidenAdapter } from './aiden.js';
import { createCocoAdapter } from './coco.js';
import { createCodexAdapter } from './codex.js';
export { createClaudeCodeAdapter, createAidenAdapter, createCocoAdapter, createCodexAdapter };

export function createCliAdapterSync(id: CliId, pathOverride?: string): CliAdapter {
  switch (id) {
    case 'claude-code': return createClaudeCodeAdapter(pathOverride);
    case 'aiden': return createAidenAdapter(pathOverride);
    case 'coco': return createCocoAdapter(pathOverride);
    case 'codex': return createCodexAdapter(pathOverride);
    default: throw new Error(`Unknown CLI adapter: ${id}`);
  }
}
