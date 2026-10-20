import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommandReal } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { writeRunnerInput } from './runner-input.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';
import { locateExecutable } from '../../utils/executable.js';
import type { CliAdapter } from './types.js';
import { minimaxDataDir } from '../../services/minimax-paths.js';
export { minimaxDataDir } from '../../services/minimax-paths.js';

/** npm's bin symlink resolves inside the package. Bind that package, including
 * its chunks/assets/native dependencies, rather than the shared global prefix.
 * Stop at the nearest manifest: an unrelated wrapper/package is not MCode. */
function npmPackageRoot(bin: string): string | undefined {
  if (!isAbsolute(bin)) return undefined;
  for (let dir = dirname(bin); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf8')).name === '@minimax-ai/code' ? dir : undefined;
      } catch { return undefined; }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Official installers may reuse Node outside the installation root. Their
 * launcher pins nodeExecutable, so that runtime also needs an executable bind. */
function officialNodeExecutable(root: string): string | undefined {
  try {
    const node: unknown = JSON.parse(readFileSync(join(root, 'install.json'), 'utf8')).nodeExecutable;
    return typeof node === 'string' && isAbsolute(node) && locateExecutable(node)
      ? realpathSync(node) : undefined;
  } catch { return undefined; }
}

/** The adapter's buildArgs entry also prepares persistent bind sources before
 * the worker existence-filters authPaths. Moving this into the in-sandbox
 * runner would lose first-run data on the disposable tmpfs root. */
function prepareNativeDirectories(dataDir: string, officialRoot?: string): void {
  mkdirSync(dataDir, { recursive: true });
  if (officialRoot) mkdirSync(join(officialRoot, '.mcode-active'), { recursive: true });
}

/** Keep the stable minimax ID/setup number, replacing mmx completely.
 * A long-lived runner drives native `mcode acp` per turn. Native Session IDs
 * from ACP are persisted through the runner control channel; every
 * later turn uses --session, never the shared/racy --continue shortcut.
 * ACP preserves file/shell tools and bridges native questions to Lark. */
export function createMinimaxAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'mcode';
  let cachedBin: string | undefined;
  let dataDir = minimaxDataDir();
  let nodeBin: string | undefined;
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
    sandboxExtraExecPaths() {
      const root = installRoot();
      const runtime = root ? officialNodeExecutable(root) : nodeBin;
      return [nativeBin(), ...(runtime ? [runtime] : [])];
    },
    sandboxReadonlyPaths() {
      // Official launchers in <install>/bin read sibling current/releases and
      // the managed Node runtime; the bin directory alone is insufficient.
      const root = installRoot();
      const npmRoot = root ? undefined : npmPackageRoot(nativeBin());
      return root ? [root] : npmRoot ? [npmRoot] : [];
    },
    buildArgs({ resume, resumeSessionId, workingDir, model, reasoningEffort, disableCliBypass, turnTimeoutMs, forkSession, env }) {
      if (resume && forkSession) throw new Error('MiniMax Code exec does not support session forks; create a new topic instead.');
      const nativeEnv = { ...process.env, ...env };
      dataDir = minimaxDataDir(nativeEnv);
      // Official installer tracks active processes outside the data directory.
      // Keep only this marker directory writable; releases/runtime stay read-only.
      const root = installRoot();
      prepareNativeDirectories(dataDir, root);
      nodeBin = undefined;
      if (!root && npmPackageRoot(nativeBin())) {
        const node = locateExecutable('node', nativeEnv);
        if (!node) throw new Error('MiniMax Code npm installation requires node on PATH.');
        nodeBin = realpathSync(node);
      }
      const args = [runnerArgv0('minimax-runner', resolveRunnerPath('minimax-runner.js', { fallback: 'dist' })), '--mcode-bin', nativeBin(), '--data-dir', dataDir];
      if (nodeBin) args.push('--node-bin', nodeBin);
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
