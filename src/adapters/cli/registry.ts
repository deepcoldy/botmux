import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { locateExecutable } from '../../utils/executable.js';
import type { CliAdapter, CliId } from './types.js';
import { createClaudeCodeAdapter } from './claude-code.js';
import { createSeedAdapter } from './seed.js';
import { createRelayAdapter } from './relay.js';
import { createAidenAdapter } from './aiden.js';
import { createCocoAdapter } from './coco.js';
import { createCodexAdapter } from './codex.js';
import { createCodexAppAdapter } from './codex-app.js';
import { createCursorAdapter } from './cursor.js';
import { createGeminiAdapter } from './gemini.js';
import { createGeniusAdapter } from './genius.js';
import { createOpenCodeAdapter } from './opencode.js';
import { createAntigravityAdapter } from './antigravity.js';
import { createMtrAdapter } from './mtr.js';
import { createHermesAdapter } from './hermes.js';
import { createMiraAdapter } from './mira.js';
import { createMirAdapter } from './mir.js';
import { createTraexAdapter } from './traex.js';
import { createPiAdapter } from './pi.js';
import { createCopilotAdapter } from './copilot.js';
import { createOhMyPiAdapter } from './oh-my-pi.js';
import { createKimiAdapter } from './kimi.js';
import { createGrokAdapter } from './grok.js';

/** Resolve a command name to its absolute path via shell `which`.
 *  Tries login shell first (-lc), then interactive shell (-ic) for tools
 *  whose installers add PATH entries to .bashrc/.zshrc only. */
export function resolveCommand(cmd: string): string {
  if (isAbsolute(cmd)) return cmd;
  const shell = process.env.SHELL || '/bin/zsh';
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i);
  // `setsid` (util-linux) runs the probe in its own session with NO controlling
  // terminal. Absent on macOS — there the tty-free stdio below is the safeguard.
  const setsidBin = existsSync('/usr/bin/setsid') ? '/usr/bin/setsid' : null;
  // -lc: login shell (sources .profile/.zprofile) — covers npm/nvm/fnm installs
  // -ic: interactive shell (sources .bashrc/.zshrc) — covers installers like opencode
  for (const flags of ['-lc', '-ic']) {
    for (const sh of shells) {
      // Harden the probe so it can't disturb the caller's terminal:
      //  - stdio ['ignore','pipe','ignore'] → stdin & stderr are /dev/null, so a
      //    `read` in the user's rc gets EOF instead of blocking, and the
      //    interactive `-ic` shell sees no tty on its fds → it won't enable job
      //    control or tcsetpgrp the controlling terminal;
      //  - `setsid` (when present) gives it its own session with no controlling
      //    tty, so even rc that pokes /dev/tty directly can't grab it or
      //    SIGTTIN-suspend us.
      // Without this, probing a CLI during `botmux setup` could silently
      // suspend setup (the reported "[1]+ Stopped" with no error). `-ic` is
      // kept so rc-only installs are still found.
      const argv = setsidBin
        ? [setsidBin, '-w', sh, flags, `which ${cmd}`]
        : [sh, flags, `which ${cmd}`];
      const result = spawnSync(argv[0]!, argv.slice(1), {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const found = (result.stdout ?? '').trim();
      if (found && isAbsolute(found)) return found;
    }
  }
  if (process.platform === 'darwin' && cmd === 'codex') {
    const bundledCodexCandidates = [
      '/Applications/Codex.app/Contents/Resources/codex',
      join(homedir(), 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex'),
    ];
    for (const candidate of bundledCodexCandidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return cmd;
}

/**
 * Locate an executable the way `execvp` will at spawn time: an absolute path is
 * checked directly, a bare name is searched across the current process's PATH.
 * Returns the resolved absolute path, or null when nothing runnable is found.
 *
 * Used by the worker as a pre-flight before spawning the CLI, so a missing
 * binary becomes one clear, reproducible message to the user instead of a
 * silent crash-loop. Cheap and shell-free (no rc side effects).
 */
export function locateOnPath(cmd: string): string | null {
  return locateExecutable(cmd);
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

export { createClaudeCodeAdapter, createSeedAdapter, createRelayAdapter, createAidenAdapter, createCocoAdapter, createCodexAdapter, createCodexAppAdapter, createCursorAdapter, createGeminiAdapter, createGeniusAdapter, createOpenCodeAdapter, createAntigravityAdapter, createMtrAdapter, createHermesAdapter, createMiraAdapter, createMirAdapter, createTraexAdapter, createPiAdapter, createCopilotAdapter, createOhMyPiAdapter, createKimiAdapter, createGrokAdapter };

/** Synchronous version for use in worker process. */
export function createCliAdapterSync(id: CliId, pathOverride?: string): CliAdapter {
  switch (id.toLowerCase() as CliId) {
    case 'claude-code': return createClaudeCodeAdapter(pathOverride);
    case 'seed': return createSeedAdapter(pathOverride);
    case 'relay': return createRelayAdapter(pathOverride);
    case 'aiden': return createAidenAdapter(pathOverride);
    case 'coco': return createCocoAdapter(pathOverride);
    case 'codex': return createCodexAdapter(pathOverride);
    case 'codex-app': return createCodexAppAdapter(pathOverride);
    case 'cursor': return createCursorAdapter(pathOverride);
    case 'gemini': return createGeminiAdapter(pathOverride);
    case 'genius': return createGeniusAdapter(pathOverride);
    case 'opencode': return createOpenCodeAdapter(pathOverride);
    case 'antigravity': return createAntigravityAdapter(pathOverride);
    case 'mtr': return createMtrAdapter(pathOverride);
    case 'hermes': return createHermesAdapter(pathOverride);
    case 'mira': return createMiraAdapter(pathOverride);
    case 'mir': return createMirAdapter(pathOverride);
    case 'traex': return createTraexAdapter(pathOverride);
    case 'pi': return createPiAdapter(pathOverride);
    case 'copilot': return createCopilotAdapter(pathOverride);
    case 'oh-my-pi': return createOhMyPiAdapter(pathOverride);
    case 'kimi': return createKimiAdapter(pathOverride);
    case 'grok': return createGrokAdapter(pathOverride);
    default: throw new Error(`Unknown CLI adapter: ${id}`);
  }
}
