import type { CliAdapter, CliId } from '../../adapters/cli/types.js';
import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { prepareSkillDelivery } from '../skills/delivery.js';
import { renderSkillCatalogBlock } from '../skills/prompt.js';
import { prepareSessionSkillPrompt } from '../skills/session-runtime.js';
import type { SessionSkillManifest } from '../skills/types.js';
import { refreshSessionPluginManifest, type SessionPluginManifest } from './session-manifest.js';
import { resolvePluginSkillPackages } from './skills.js';

export interface CliPluginGenerationResult {
  pluginManifest: SessionPluginManifest;
  prompt: string;
  /** Catalog bytes appended to prompt (or deferred when prompt is empty).
   * Structured transports use this copy as hidden application context. */
  skillCatalog?: string;
  skillPluginDir?: string;
  skillReadonlyRoots?: string[];
  deferredSkillCatalog?: string;
  diagnostics: string[];
  fatal?: boolean;
}

function renderReplacementCatalog(manifest: SessionSkillManifest | null): string {
  const catalog = renderSkillCatalogBlock(manifest)
    || '<botmux_skills mode="priority"></botmux_skills>';
  return [
    '<botmux_skills_refresh>',
    '  <instruction>This catalog replaces every earlier botmux_skills catalog in this conversation. Skills not listed here are no longer available.</instruction>',
    catalog,
    '</botmux_skills_refresh>',
  ].join('\n');
}

/** Prepare the shared Skills/MCP snapshot immediately before a real CLI spawn. */
export function prepareCliPluginGeneration(opts: {
  sessionId: string;
  bot: Pick<BotConfig, 'larkAppId' | 'name' | 'plugins' | 'skills'>;
  global?: Pick<GlobalConfig, 'plugins'>;
  dataDir?: string;
  cliId: CliId;
  adapter: CliAdapter;
  workingDir: string;
  prompt: string;
  replacesPriorGeneration: boolean;
  now?: () => string;
}): CliPluginGenerationResult {
  const pluginManifest = refreshSessionPluginManifest({
    sessionId: opts.sessionId,
    bot: opts.bot,
    global: opts.global,
    dataDir: opts.dataDir,
    now: opts.now,
  });
  const pluginSkills = resolvePluginSkillPackages(pluginManifest.pluginIds);
  const preparedSkills = prepareSessionSkillPrompt({
    sessionId: opts.sessionId,
    cliId: opts.cliId,
    workingDir: opts.workingDir,
    prompt: opts.replacesPriorGeneration ? '' : opts.prompt,
    botPolicy: opts.bot.skills,
    pluginSkills: pluginSkills.skills,
  });
  const delivery = prepareSkillDelivery(
    opts.adapter,
    preparedSkills.manifest,
    preparedSkills.manifest?.delivery ?? 'auto',
  );
  const catalog = opts.replacesPriorGeneration
    ? renderReplacementCatalog(preparedSkills.manifest)
    : renderSkillCatalogBlock(preparedSkills.manifest);
  const prompt = opts.replacesPriorGeneration && opts.prompt.trim().length > 0
    ? `${opts.prompt}\n\n${catalog}`
    : preparedSkills.prompt;

  return {
    pluginManifest,
    prompt,
    skillCatalog: catalog || undefined,
    skillPluginDir: delivery.pluginDir,
    skillReadonlyRoots: delivery.readonlyRoots.length > 0 ? delivery.readonlyRoots : undefined,
    deferredSkillCatalog: prompt.trim().length === 0 && catalog ? catalog : undefined,
    diagnostics: [
      ...pluginSkills.diagnostics.map(value => `plugin_skill:${value}`),
      ...delivery.diagnostics.map(value => `skill_delivery:${value}`),
    ],
    fatal: delivery.fatal,
  };
}
