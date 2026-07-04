import type { CliAdapter } from '../../adapters/cli/types.js';
import type { SessionSkillManifest } from './types.js';
import { prepareClaudeSkillPlugin } from './claude-plugin-delivery.js';

export interface PreparedSkillDelivery {
  prompt: boolean;
  pluginDir?: string;
  readonlyRoots: string[];
  diagnostics: string[];
  fatal?: boolean;
}

export function prepareSkillDelivery(
  adapter: CliAdapter,
  manifest: SessionSkillManifest | null,
  requested: 'auto' | 'prompt' | 'native',
): PreparedSkillDelivery {
  if (!manifest || manifest.prioritySkills.length === 0) {
    return { prompt: false, readonlyRoots: [], diagnostics: [] };
  }
  if (requested === 'prompt') return { prompt: true, readonlyRoots: [], diagnostics: [] };
  if (adapter.skillDelivery?.nativeKind === 'claude-plugin') {
    const prepared = prepareClaudeSkillPlugin(manifest);
    return { prompt: true, pluginDir: prepared.pluginDir, readonlyRoots: [prepared.pluginDir], diagnostics: [] };
  }
  if (requested === 'native') {
    return {
      prompt: false,
      readonlyRoots: [],
      diagnostics: ['native_skill_delivery_not_supported'],
      fatal: true,
    };
  }
  return { prompt: true, readonlyRoots: [], diagnostics: [] };
}
