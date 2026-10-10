import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommandReal } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { writeRunnerInput } from './runner-input.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import type { CliAdapter } from './types.js';

/** MCode owns config.yaml, OAuth, SQLite and native sessions under this root.
 * Match the official CLI's override precedence; bind the entire persistent root. */
export function minimaxDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim();
  if (configured) return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(configured);
  return join(homedir(), '.minimax');
}

function runnerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(here, '..', '..', 'minimax-runner.js');
  if (existsSync(sibling)) return sibling;
  return resolve(here, '..', '..', '..', 'dist', 'minimax-runner.js');
}

/** Keep the stable minimax ID/setup number, replacing mmx completely.
 * A long-lived runner drives native `mcode exec` per turn. Native Session IDs
 * from stream-json are persisted through the runner control channel; every
 * later turn uses --session, never the shared/racy --continue shortcut.
 * Headless execution preserves file/shell tools and native skills/plugins. */
export function createMinimaxAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'mcode';
  let cachedBin: string | undefined;
  let dataDir = minimaxDataDir();
  const nativeBin = () => (cachedBin ??= resolveCommandReal(rawBin));
  const installRoot = () => {
    const root = dirname(dirname(nativeBin()));
    return existsSync(join(root, 'install.json')) ? root : undefined;
  };
  return {
    id: 'minimax',
    resolvedBin: process.execPath,
    get authPaths() {
      const root = installRoot();
      return [dataDir, ...(root ? [join(root, '.mcode-active')] : [])];
    },
    get skillsDir() { return join(dataDir, 'skills'); },
    allowExtraArgs: false,
    sandboxExtraExecPaths: () => [nativeBin()],
    sandboxReadonlyPaths() {
      // Official launchers in <install>/bin read sibling current/releases and
      // the managed Node runtime; the bin directory alone is insufficient.
      const root = installRoot();
      return root ? [root] : [];
    },
    buildArgs({ resume, resumeSessionId, workingDir, model, reasoningEffort, disableCliBypass, turnTimeoutMs, forkSession, env }) {
      if (resume && forkSession) throw new Error('MiniMax Code exec does not support session forks; create a new topic instead.');
      dataDir = minimaxDataDir({ ...process.env, ...env });
      mkdirSync(dataDir, { recursive: true });
      // Official installer tracks active processes outside the data directory.
      // Keep only this marker directory writable; releases/runtime stay read-only.
      const root = installRoot();
      if (root) mkdirSync(join(root, '.mcode-active'), { recursive: true });
      const args = [runnerArgv0('minimax-runner', runnerPath()), '--mcode-bin', nativeBin(), '--data-dir', dataDir];
      if (workingDir) args.push('--cwd', workingDir);
      if (resume && resumeSessionId) args.push('--native-session-id', resumeSessionId);
      if (model?.trim()) {
        // Existing mmx bots used bare MiniMax model names. Custom providers
        // already use MCode's provider/model syntax and pass through unchanged.
        const selected = model.trim();
        args.push('--model', selected.startsWith('MiniMax-') ? `minimax/${selected}` : selected);
      }
      if (reasoningEffort) args.push('--effort', reasoningEffort);
      args.push('--permission', disableCliBypass ? 'smart' : 'full');
      if (turnTimeoutMs && turnTimeoutMs > 0) args.push('--turn-timeout-ms', String(turnTimeoutMs));
      return args;
    },
    resumeRequiresCliSessionId: true,
    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      return `mcode --session '${cliSessionId.replace(/'/g, "'\\''")}'`;
    },
    writeInput(pty, content, context) {
      return writeRunnerInput(pty, '::botmux-minimax:', content, undefined, context?.turnId);
    },
    supportsTypeAhead: false,
    readyPattern: /^›\r?$/m,
    staticBusyPattern: /\[MiniMax Code\] running…/,
    staticBusyClearPattern: /^›\r?$/m,
    deferFirstPromptTimeoutUntilReady: true,
    // Keep the normal inline routing/identity envelope: mcode can execute
    // botmux send and shell commands, unlike mmx's tool-less REPL.
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
    modelChoices: CLI_MODEL_CHOICES.minimax,
  };
}

export const create = createMinimaxAdapter;
