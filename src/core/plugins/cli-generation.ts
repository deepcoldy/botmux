import type { CliAdapter, CliId } from '../../adapters/cli/types.js';
import { createHash } from 'node:crypto';
import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { prepareSkillDelivery } from '../skills/delivery.js';
import { renderSkillCatalogBlock } from '../skills/prompt.js';
import { prepareSessionSkillPrompt } from '../skills/session-runtime.js';
import { refreshSessionPluginManifest, type SessionPluginManifest } from './session-manifest.js';
import { refreshSessionMcpRuntimeManifest } from './mcp/session-runtime.js';
import { resolvePluginSkillPackages } from './skills.js';
import { assertNoGlobalBotmuxSkills } from '../../skills/zero-injection.js';

export interface CliPluginGenerationResult {
  pluginManifest: SessionPluginManifest;
  prompt: string;
  /** Catalog bytes appended to prompt (or deferred when prompt is empty).
   * Structured transports use this copy as hidden application context. */
  skillCatalog?: string;
  skillCatalogDigest?: string;
  /** Hash of the canonical catalog, independent of its refresh wrapper. */
  skillCatalogFingerprint?: string;
  skillPluginDir?: string;
  skillReadonlyRoots?: string[];
  deferredSkillCatalog?: string;
  diagnostics: string[];
  fatal?: boolean;
}

function renderReplacementCatalog(catalog: string): string {
  const replacement = catalog || '<botmux_skills mode="priority"></botmux_skills>';
  return [
    '<botmux_skills_refresh>',
    '  <instruction>This catalog replaces every earlier botmux_skills catalog in this conversation. Skills not listed here are no longer available.</instruction>',
    replacement,
    '</botmux_skills_refresh>',
  ].join('\n');
}

/** Prepare the shared Skills/MCP snapshot immediately before a real CLI spawn. */
export function prepareCliPluginGeneration(opts: {
  sessionId: string;
  bot: Pick<BotConfig, 'larkAppId' | 'name' | 'plugins' | 'skills' | 'pluginRuntime'>;
  global?: Pick<GlobalConfig, 'plugins' | 'mcpGatewayMaxToolTimeoutMs'>;
  dataDir?: string;
  cliId: CliId;
  adapter: CliAdapter;
  workingDir: string;
  prompt: string;
  replacesPriorGeneration: boolean;
  promptInjection?: 'default' | 'none';
  compactCatalog?: boolean;
  deferCatalogToContextManager?: boolean;
  /** Only the host's admitted Auto resume passes its last delivered catalog. */
  previousSkillCatalogFingerprint?: string;
  now?: () => string;
}): CliPluginGenerationResult {
  const pluginManifest = refreshSessionPluginManifest({
    sessionId: opts.sessionId,
    bot: opts.bot,
    global: opts.global,
    dataDir: opts.dataDir,
    now: opts.now,
  });
  refreshSessionMcpRuntimeManifest({
    sessionId: opts.sessionId,
    pluginIds: pluginManifest.pluginIds,
    pluginRuntime: opts.bot.pluginRuntime,
    maxToolTimeoutMs: opts.global?.mcpGatewayMaxToolTimeoutMs,
    dataDir: opts.dataDir,
    now: opts.now,
  });
  if (opts.promptInjection === 'none') {
    assertNoGlobalBotmuxSkills(opts.adapter.skillsDir);
    // Keep operational MCP/plugin state, but do not advertise or materialize
    // any skill catalog, including the replacement catalog on resume.
    prepareSessionSkillPrompt({ sessionId: opts.sessionId, cliId: opts.cliId,
      workingDir: opts.workingDir, prompt: opts.prompt, botPolicy: undefined });
    return { pluginManifest, prompt: opts.prompt, diagnostics: [] };
  }
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
  const baseCatalog = renderSkillCatalogBlock(
    preparedSkills.manifest,
    { compact: opts.compactCatalog === true },
  );
  const fingerprint = createHash('sha256').update(baseCatalog).digest('hex');
  const unchanged = opts.replacesPriorGeneration
    && opts.previousSkillCatalogFingerprint === fingerprint;
  const catalog = unchanged ? '' : opts.replacesPriorGeneration
    ? renderReplacementCatalog(baseCatalog)
    : baseCatalog;
  let prompt = preparedSkills.prompt;
  if (unchanged || opts.deferCatalogToContextManager) prompt = opts.prompt;
  else if (opts.replacesPriorGeneration && opts.prompt.trim().length > 0) {
    prompt = `${opts.prompt}\n\n${catalog}`;
  }
  let deferredSkillCatalog: string | undefined;
  if (catalog && (opts.deferCatalogToContextManager || prompt.trim().length === 0)) {
    deferredSkillCatalog = catalog;
  }

  return {
    pluginManifest,
    prompt,
    skillCatalog: catalog || undefined,
    skillCatalogDigest: catalog
      ? createHash('sha256').update(baseCatalog, 'utf8').digest('hex')
      : undefined,
    skillCatalogFingerprint: fingerprint,
    skillPluginDir: delivery.pluginDir,
    skillReadonlyRoots: delivery.readonlyRoots.length > 0 ? delivery.readonlyRoots : undefined,
    deferredSkillCatalog,
    diagnostics: [
      ...pluginSkills.diagnostics.map(value => `plugin_skill:${value}`),
      ...(preparedSkills.snapshotDiagnostics ?? []).map(value => `skill_snapshot:${value}`),
      ...delivery.diagnostics.map(value => `skill_delivery:${value}`),
    ],
    fatal: delivery.fatal,
  };
}
