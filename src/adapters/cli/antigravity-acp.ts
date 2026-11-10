/** Opt-in Antigravity ACP adapter; native terminal sessions keep their existing adapter. */
import { detectModelsViaExec } from './model-catalog-json.js';
import { parseAntigravityModels } from './antigravity-models.js';
import { resolveCommandReal } from './registry.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';
import { writeRunnerInput } from './runner-input.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import { AntigravitySessionLog } from '../../services/antigravity-session-fork.js';
import type { CliAdapter } from './types.js';

/** Create a framed-input adapter with no history polling or native TUI injection. */
export function createAntigravityAcpAdapter(pathOverride?: string): CliAdapter {
  let nativeBin: string | undefined;
  const executable = (): string => (nativeBin ??= resolveCommandReal(pathOverride ?? 'agy'));
  return {
    id: 'antigravity',
    resolvedBin: process.execPath,
    authPaths: ['~/.gemini'],
    sandboxExtraExecPaths: () => [executable()],
    allowExtraArgs: false,
    buildArgs({ sessionId, resume, resumeSessionId, workingDir, model, reasoningEffort, disableCliBypass, forkSession }) {
      if (disableCliBypass) throw new Error('Antigravity ACP currently requires auto-approved tools; use terminal transport for interactive permissions.');
      if (forkSession) throw new Error('Antigravity ACP does not support forks; use terminal transport or a new session.');
      // A warm reattach can predate the first native session id (empty-start
      // topic, or a first turn that failed before session/new returned). The
      // worker demotes cold resumes to fresh via missingExactResumeId; here we
      // only omit the flag so the surviving runner starts session/new on its
      // next turn instead of killing the reattach — same shape as minimax.
      const args = [runnerArgv0('antigravity-runner', resolveRunnerPath('antigravity-runner.js', {
        testOverrideEnv: 'BOTMUX_TEST_ANTIGRAVITY_RUNNER_PATH', fallback: 'dist',
      })), '--agy-bin', executable(), '--log-file', new AntigravitySessionLog(sessionId).path];
      if (workingDir) args.push('--cwd', workingDir);
      if (resume && resumeSessionId) args.push('--native-session-id', resumeSessionId);
      if (model?.trim()) args.push('--model', model.trim());
      if (reasoningEffort) args.push('--effort', reasoningEffort);
      return args;
    },
    resumeRequiresCliSessionId: true,
    buildResumeCommand({ cliSessionId }) { return cliSessionId ? `agy --conversation '${cliSessionId.replace(/'/g, "'\\''")}'` : null; },
    writeInput(pty, content, context) {
      if (!context?.turnId) return Promise.resolve({ submitted: false, submissionDisposition: 'untouched' as const });
      return writeRunnerInput(pty, '::botmux-antigravity:', content, undefined, context.turnId);
    },
    runnerFramedInput: true,
    reliableTurnTerminal: true,
    supportsTypeAhead: false,
    readyPattern: /^›\r?$/m,
    staticBusyPattern: /\[Antigravity ACP\] running…/,
    staticBusyClearPattern: /^›\r?$/m,
    deferFirstPromptTimeoutUntilReady: true,
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,
    modelChoices: CLI_MODEL_CHOICES.antigravity,
    /** Discover account-visible models without starting a conversation. */
    async detectModels(options) {
      return detectModelsViaExec(executable(), ['models'], parseAntigravityModels, options?.env);
    },
  };
}
