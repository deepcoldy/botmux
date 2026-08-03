import type { CliId } from '../../adapters/cli/types.js';
import type { BotSkillPolicy, SessionSkillManifest, SkillPackage, SkillPack } from './types.js';
import { resolveSkillPolicy } from './policy.js';

export function resolveSessionSkillManifest(opts: {
  sessionId: string;
  cliId: CliId;
  workingDir: string;
  botPolicy: BotSkillPolicy | undefined;
  pluginSkills?: SkillPackage[];
  globalProjectSkills?: 'off' | 'trusted' | 'all';
  globalDelivery?: 'auto' | 'prompt' | 'native';
  registrySkills: SkillPackage[];
  projectSkills: SkillPackage[];
  packs?: Record<string, SkillPack>;
  now?: () => string;
}): SessionSkillManifest | null {
  const resolved = resolveSkillPolicy({
    registrySkills: opts.registrySkills,
    projectSkills: opts.projectSkills,
    pluginSkills: opts.pluginSkills,
    globalProjectSkills: opts.globalProjectSkills,
    globalDelivery: opts.globalDelivery,
    botPolicy: opts.botPolicy,
    workingDir: opts.workingDir,
    packs: opts.packs,
  });
  if (!resolved.enabled) return null;
  return {
    sessionId: opts.sessionId,
    cliId: opts.cliId,
    workingDir: opts.workingDir,
    policyMode: resolved.mode,
    delivery: resolved.delivery,
    prioritySkills: resolved.prioritySkills,
    diagnostics: resolved.diagnostics,
    generatedAt: opts.now ? opts.now() : new Date().toISOString(),
  };
}
