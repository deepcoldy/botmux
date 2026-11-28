import type { CliAdapter, CliId } from '../../adapters/cli/types.js';
import { createHash } from 'node:crypto';
import type { BotConfig } from '../../bot-registry.js';
import type { GlobalConfig } from '../../global-config.js';
import { prepareSkillDelivery } from '../skills/delivery.js';
import { writeSessionSkillManifest } from '../skills/manifest-store.js';
import { renderSkillCatalogBlock } from '../skills/prompt.js';
import { prepareSessionSkillPrompt } from '../skills/session-runtime.js';
import { removeSessionSkillRuntime } from '../skills/snapshot.js';
import {
  formatUnavailableSkillDiagnostic,
  formatUnavailableSkillsUserWarning,
  mergeUnavailableSkills,
  type UnavailableSkillEntry,
} from '../skills/source-health.js';
import { refreshSessionPluginManifest, type SessionPluginManifest } from './session-manifest.js';
import { refreshSessionMcpRuntimeManifest } from './mcp/session-runtime.js';
import { resolvePluginSkillPackages } from './skills.js';
import { assertNoGlobalBotmuxSkills } from '../../skills/zero-injection.js';
import { rekeyPromptContextWithFallback } from '../../services/prompt-context-store.js';

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
  unavailableSkills?: UnavailableSkillEntry[];
  userWarnings?: string[];
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
  turnId?: string;
  replacesPriorGeneration: boolean;
  promptInjection?: 'default' | 'none';
  compactCatalog?: boolean;
  deferCatalogToContextManager?: boolean;
  /** Only the host's admitted Auto resume passes its last delivered catalog. */
  previousSkillCatalogFingerprint?: string;
  locale?: 'zh' | 'en';
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
  // If a skill disappeared between preflight and native delivery (TOCTOU),
  // strip it from the persisted manifest and catalog so the model isn't
  // advertised a skill that failed to materialize.
  let effectiveManifest = preparedSkills.manifest;
  let deliverySkippedChangedManifest = false;
  let effectiveReadonlyRoots = delivery.readonlyRoots;
  if (effectiveManifest && delivery.skippedSkills?.length) {
    const skippedNames = new Set(delivery.skippedSkills.map(entry => entry.name));
    const remainingSkills = effectiveManifest.prioritySkills.filter(skill => !skippedNames.has(skill.name));
    if (remainingSkills.length !== effectiveManifest.prioritySkills.length) {
      deliverySkippedChangedManifest = true;
      const extraDiagnostics = delivery.skippedSkills.map(entry => ({
        level: 'warn' as const,
        code: 'skill_source_missing',
        skillName: entry.name,
        message: formatUnavailableSkillDiagnostic(entry),
      }));
      effectiveManifest = {
        ...effectiveManifest,
        prioritySkills: remainingSkills,
        diagnostics: [...effectiveManifest.diagnostics, ...extraDiagnostics],
      };
      if (remainingSkills.length > 0) {
        writeSessionSkillManifest(effectiveManifest);
      } else {
        removeSessionSkillRuntime(opts.sessionId, opts.dataDir);
        effectiveReadonlyRoots = [];
      }
    }
  }
  const baseCatalog = renderSkillCatalogBlock(
    effectiveManifest,
    { compact: opts.compactCatalog === true },
  );
  const fingerprint = createHash('sha256').update(baseCatalog).digest('hex');
  const unchanged = opts.replacesPriorGeneration
    && opts.previousSkillCatalogFingerprint === fingerprint;
  const catalog = unchanged ? '' : opts.replacesPriorGeneration
    ? renderReplacementCatalog(baseCatalog)
    : baseCatalog;
  const promptCatalog = deliverySkippedChangedManifest
    ? renderSkillCatalogBlock(effectiveManifest)
    : '';
  let prompt = deliverySkippedChangedManifest
    ? (opts.replacesPriorGeneration || opts.prompt.trim().length === 0 || opts.prompt.includes('<botmux_skills')
      ? opts.prompt
      : (promptCatalog ? `${opts.prompt}\n\n${promptCatalog}` : opts.prompt))
    : preparedSkills.prompt;
  if (unchanged || opts.deferCatalogToContextManager) prompt = opts.prompt;
  else if (opts.replacesPriorGeneration && opts.prompt.trim().length > 0) {
    prompt = `${opts.prompt}\n\n${catalog}`;
  }
  let deferredSkillCatalog: string | undefined;
  if (catalog && (opts.deferCatalogToContextManager || prompt.trim().length === 0)) {
    deferredSkillCatalog = catalog;
  }
  if (!delivery.fatal && opts.turnId && prompt !== opts.prompt) {
    prompt = rekeyPromptContextWithFallback({
      sessionId: opts.sessionId,
      turnId: opts.turnId,
      previousPtyText: opts.prompt,
      nextPtyText: prompt,
      dataDir: opts.dataDir,
    }).content;
  }

  const unavailableSkills = mergeUnavailableSkills(
    preparedSkills.unavailableSkills,
    delivery.skippedSkills,
  );
  const unavailableWarning = !delivery.fatal
    ? formatUnavailableSkillsUserWarning(unavailableSkills, opts.locale)
    : null;

  return {
    pluginManifest,
    prompt,
    skillCatalog: catalog || undefined,
    skillCatalogDigest: catalog
      ? createHash('sha256').update(baseCatalog, 'utf8').digest('hex')
      : undefined,
    skillCatalogFingerprint: fingerprint,
    skillPluginDir: delivery.pluginDir,
    skillReadonlyRoots: effectiveReadonlyRoots.length > 0 ? effectiveReadonlyRoots : undefined,
    deferredSkillCatalog,
    diagnostics: [
      ...pluginSkills.diagnostics.map(value => `plugin_skill:${value}`),
      ...(preparedSkills.sourceDiagnostics ?? []).map(value => `skill_source:${value}`),
      ...(preparedSkills.snapshotDiagnostics ?? []).map(value => `skill_snapshot:${value}`),
      ...delivery.diagnostics.map(value => `skill_delivery:${value}`),
    ],
    ...(unavailableSkills.length > 0 ? { unavailableSkills } : {}),
    ...(unavailableWarning ? { userWarnings: [unavailableWarning] } : {}),
    fatal: delivery.fatal,
  };
}
