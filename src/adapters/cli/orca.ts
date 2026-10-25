import type { CliAdapter, CliId } from './types.js';
import { runnerArgv0 } from '../../core/self-spawn.js';
import { resolveRunnerPath } from './runner-path.js';

export function createOrcaAdapter(id: CliId, pathOverride?: string): CliAdapter {
  if (pathOverride) throw new Error('Orca uses its authenticated runtime; configure ORCA_USER_DATA_PATH to select a profile');
  return {
    id, resolvedBin: process.execPath,
    allowExtraArgs: false,
    injectsSessionContext: true,
    supportsTypeAhead: false,
    reliableTurnTerminal: true,
    systemHints: [],
    altScreen: false,
    buildResumeCommand() { return null; },
    async writeInput() {
      return { submitted: false, submissionDisposition: 'untouched', failureReason: 'Orca requires a structured backend turn' };
    },
    buildArgs() {
      return [runnerArgv0('orca-runner', resolveRunnerPath('orca-runner.js')), id === 'orca-claude' ? 'claude' : 'codex'];
    },
  };
}
