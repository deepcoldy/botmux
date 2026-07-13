import type { CliId } from '../../adapters/cli/types.js';
import { readGlobalConfig } from '../../global-config.js';
import { readSkillRegistry } from '../../services/skill-registry-store.js';
import type { BotSkillPolicy, SessionSkillManifest, SkillPackage } from './types.js';
import { discoverProjectSkills } from './discovery.js';
import { removeSessionSkillManifest, writeSessionSkillManifest } from './manifest-store.js';
import { renderSkillCatalogBlock } from './prompt.js';
import { resolveSessionSkillManifest } from './session-resolver.js';

export interface PreparedSessionSkillPrompt {
  prompt: string;
  manifest: SessionSkillManifest | null;
}

export function prepareSessionSkillPrompt(opts: {
  sessionId: string;
  cliId: CliId;
  workingDir: string;
  prompt: string;
  botPolicy: BotSkillPolicy | undefined;
  pluginSkills?: SkillPackage[];
}): PreparedSessionSkillPrompt {
  if (!opts.botPolicy && !opts.pluginSkills?.length) {
    removeSessionSkillManifest(opts.sessionId);
    return { prompt: opts.prompt, manifest: null };
  }
  const globalSkills = readGlobalConfig().skills;
  const manifest = resolveSessionSkillManifest({
    sessionId: opts.sessionId,
    cliId: opts.cliId,
    workingDir: opts.workingDir,
    botPolicy: opts.botPolicy,
    pluginSkills: opts.pluginSkills,
    globalProjectSkills: globalSkills?.trustProjectSkills,
    globalDelivery: globalSkills?.delivery,
    registrySkills: Object.values(readSkillRegistry().skills),
    projectSkills: discoverProjectSkills(opts.workingDir),
  });
  if (!manifest || manifest.prioritySkills.length === 0) {
    removeSessionSkillManifest(opts.sessionId);
    return { prompt: opts.prompt, manifest };
  }
  writeSessionSkillManifest(manifest);
  if (opts.prompt.trim().length === 0 || opts.prompt.includes('<botmux_skills')) {
    return { prompt: opts.prompt, manifest };
  }
  return {
    prompt: `${opts.prompt}\n\n${renderSkillCatalogBlock(manifest)}`,
    manifest,
  };
}
