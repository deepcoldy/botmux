import { createOpenCodeLikeAdapter } from './opencode.js';
import { CLI_MODEL_CHOICES } from './model-choices.js';
import {
  mimocodeCachePath,
  mimocodeConfigPath,
  mimocodeDataPath,
  mimocodeDbPath,
  mimocodeStatePath,
} from '../../services/mimocode-paths.js';

export function createMiMoCodeAdapter(pathOverride?: string) {
  return createOpenCodeLikeAdapter(pathOverride, {
    id: 'mimocode',
    defaultBin: 'mimo',
    dataRoot: mimocodeDataPath(),
    authPaths: [
      mimocodeConfigPath(),
      mimocodeDataPath(),
      mimocodeStatePath(),
      mimocodeCachePath(),
    ],
    dbPath: mimocodeDbPath,
    skillsDir: `${mimocodeConfigPath()}/skills`,
    hookConfigPath: `${mimocodeConfigPath()}/plugin/botmux-ask.js`,
    modelListArgs: ['models'],
    startupArgs: ['--trust'],
    modelChoices: CLI_MODEL_CHOICES['mimocode'],
  });
}

export const create = createMiMoCodeAdapter;
