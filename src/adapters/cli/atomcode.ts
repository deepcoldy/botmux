import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { resolveCommandReal } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { writeRunnerInput } from './runner-input.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';
import { atomcodeDataDir, detectAtomcodeModels } from '../../services/atomcode-models.js';
import type { CliAdapter } from './types.js';

export { atomcodeDataDir } from '../../services/atomcode-models.js';

/** Long-lived framed runner driving native `atomcode acp` per turn. Native ACP
 *  session IDs are persisted through the runner control channel and restored
 *  via `session/resume`. */
export function createAtomcodeAdapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'atomcode';
  let cachedBin: string | undefined;
  let dataDir = atomcodeDataDir();
  const nativeBin = () => (cachedBin ??= resolveCommandReal(rawBin));

  return {
    id: 'atomcode',
    resolvedBin: process.execPath,
    get authPaths() {
      return [dataDir];
    },
    get skillsDir() {
      return join(dataDir, 'skills');
    },
    allowExtraArgs: false,
    sandboxExtraExecPaths() {
      return [nativeBin()];
    },
    buildArgs({
      resume,
      resumeSessionId,
      workingDir,
      model,
      reasoningEffort,
      disableCliBypass,
      turnTimeoutMs,
      forkSession,
      env,
    }) {
      if (resume && forkSession) {
        throw new Error('AtomCode ACP does not support session forks; create a new topic instead.');
      }
      const nativeEnv = { ...process.env, ...env };
      dataDir = atomcodeDataDir(nativeEnv);
      mkdirSync(dataDir, { recursive: true });
      // Inside bwrap, authPaths are bound at their canonical realpath. Passing the
      // canonical path to --data-dir ensures ATOMCODE_HOME resolves on symlinked homes.
      try { dataDir = realpathSync(dataDir); } catch { /* keep resolved path */ }
      const args = [
        runnerArgv0('atomcode-runner', resolveRunnerPath('atomcode-runner.js', {
          testOverrideEnv: 'BOTMUX_TEST_ATOMCODE_RUNNER_PATH',
          fallback: 'dist',
        })),
        '--atomcode-bin', nativeBin(),
        '--data-dir', dataDir,
      ];
      if (workingDir) args.push('--cwd', workingDir);
      if (resume && resumeSessionId) args.push('--native-session-id', resumeSessionId);
      if (model?.trim()) args.push('--model', model.trim());
      if (reasoningEffort) args.push('--effort', reasoningEffort);
      args.push('--permission', disableCliBypass ? 'smart' : 'full');
      if (turnTimeoutMs && turnTimeoutMs > 0) args.push('--turn-timeout-ms', String(turnTimeoutMs));
      return args;
    },
    resumeRequiresCliSessionId: true,
    buildResumeCommand({ cliSessionId }) {
      if (!cliSessionId) return null;
      // ACP wire IDs carry an `acp-` prefix; interactive `atomcode resume` expects the bare native ID.
      const nativeId = cliSessionId.replace(/^acp-/, '');
      return `atomcode resume '${nativeId.replace(/'/g, "'\\''")}'`;
    },
    writeInput(pty, content, context) {
      return writeRunnerInput(
        pty,
        '::botmux-atomcode:',
        content,
        undefined,
        context?.turnId,
        undefined,
        undefined,
        context?.dispatchAttempt,
      );
    },
    runnerFramedInput: true,
    reliableTurnTerminal: true,
    supportsTypeAhead: false,
    readyPattern: /^›\r?$/m,
    staticBusyPattern: /\[AtomCode\] running…/,
    staticBusyClearPattern: /^›\r?$/m,
    deferFirstPromptTimeoutUntilReady: true,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
    modelChoices: CLI_MODEL_CHOICES.atomcode,
    detectModels(options) {
      return detectAtomcodeModels(options);
    },
  };
}
