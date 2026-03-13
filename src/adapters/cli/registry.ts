import { execSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { CliAdapter, CliId } from './types.js';
import { createClaudeCodeAdapter } from './claude-code.js';
import { createAidenAdapter } from './aiden.js';
import { createCocoAdapter } from './coco.js';
import { createCodexAdapter } from './codex.js';
import { createGeminiAdapter } from './gemini.js';
import { createOpenCodeAdapter } from './opencode.js';

/** Resolve a command name to its absolute path via shell `which`.
 *  Tries login shell first (-lc), then interactive shell (-ic) for tools
 *  whose installers add PATH entries to .bashrc/.zshrc only. */
export function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  const shell = process.env.SHELL || '/bin/zsh';
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i);
  // -lc: login shell (sources .profile/.zprofile) — covers npm/nvm/fnm installs
  // -ic: interactive shell (sources .bashrc/.zshrc) — covers installers like opencode
  for (const flags of ['-lc', '-ic']) {
    for (const sh of shells) {
      try {
        const result = execSync(`${sh} ${flags} 'which ${cmd}' 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 5_000,
        }).trim();
        if (result && isAbsolute(result)) return result;
      } catch { /* try next */ }
    }
  }
  return cmd;
}

const adapterCache = new Map<string, CliAdapter>();

/** Async adapter factory (uses dynamic import for lazy loading in daemon process). */
export async function createCliAdapter(id: CliId, pathOverride?: string): Promise<CliAdapter> {
  const normalized = id.toLowerCase() as CliId;
  const key = `${normalized}:${pathOverride ?? ''}`;
  if (adapterCache.has(key)) return adapterCache.get(key)!;
  const adapter = createCliAdapterSync(normalized, pathOverride);
  adapterCache.set(key, adapter);
  return adapter;
}

export { createClaudeCodeAdapter, createAidenAdapter, createCocoAdapter, createCodexAdapter, createGeminiAdapter, createOpenCodeAdapter };

/** Synchronous version for use in worker process. */
export function createCliAdapterSync(id: CliId, pathOverride?: string): CliAdapter {
  switch (id.toLowerCase() as CliId) {
    case 'claude-code': return createClaudeCodeAdapter(pathOverride);
    case 'aiden': return createAidenAdapter(pathOverride);
    case 'coco': return createCocoAdapter(pathOverride);
    case 'codex': return createCodexAdapter(pathOverride);
    case 'gemini': return createGeminiAdapter(pathOverride);
    case 'opencode': return createOpenCodeAdapter(pathOverride);
    default: throw new Error(`Unknown CLI adapter: ${id}`);
  }
}
