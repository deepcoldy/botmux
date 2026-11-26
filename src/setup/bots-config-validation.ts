import { normalizeMojoConfig } from '../adapters/backend/mojo-types.js';
import { normalizeRemoteRunnerConfig } from '../adapters/backend/remote-runner-config.js';
import { retiredCli } from '../adapters/cli/retired-cli.js';
import { normalizeCliRuntimeConfig, supportsConfiguredCliRuntime } from '../adapters/cli/runtime.js';
import { normalizeSandboxMode, normalizeScratchStorage, type SandboxMode } from '../adapters/cli/sandbox-mode.js';
import { normalizeBotActorOwnerBindings } from '../core/bot-actor-owner-binding.js';
import { cliSupportsConfigDir, normalizeCliConfigDir } from '../core/cli-config-dir.js';
import { normalizeCliLaunchMode, validateCliLaunchModeConfig } from '../core/cli-launch-mode.js';
import { normalizeCodexBrowserConfig } from '../core/codex-browser-config.js';
import { normalizeEnvPolicy } from '../core/env-policy.js';
import { normalizeExistingAppServerConfig } from '../core/existing-app-server.js';
import { parseSandboxNetworkPolicy } from '../core/sandbox-network-policy.js';
import { normalizeCredentialsSourceDir } from '../services/cli-credential-source.js';
import { normalizeCodexInstancePool, validateCodexInstanceRoster } from '../services/codex-instance-pool.js';
import { assertCodexProfileConfig, normalizeCodexProfile } from '../services/codex-profiles.js';
import { normalizeFeedbackPolicyLayer } from '../services/feedback-policy-resolver.js';
import { normalizeFeedbackPresentation } from '../services/feedback-presentation.js';
import { parseGroupCreationDefaults } from '../services/group-creation-options.js';
import { parseInviteConfig } from '../services/invite-config.js';
import { normalizeNoProgressNotifyPolicy } from '../services/no-progress-notify-policy.js';
import { normalizeOncallGroupPolicy } from '../services/oncall-group-policy.js';
import { parseTriggerUserAuthConfig } from '../services/trigger-user-auth.js';
import { normalizeVcMeetingListenerPolicy } from '../services/vc-meeting-listener-policy.js';
import { isLocalBotId } from './local-bot.js';

export type BotConfigValidationResult =
  | { ok: true; count: number }
  | { ok: false; message: string };

const LEGACY_DEFAULT_CLI_ID = 'claude-code';

function validateSandboxPathList(value: unknown, field: string, index: number): void {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Bot config [${index}]: ${field} must be an array of strings`);
  }
}

/**
 * Pure, side-effect-free validator for parsed `bots.json` content.
 *
 * Mirrors all throwing entry and roster checks of `parseBotConfigsFromText` in
 * `src/bot-registry.ts` (without importing `@larksuiteoapi/node-sdk` or emitting
 * `logger.warn` stderr spam), while preserving raw `parsed.length` as `count` so
 * activation-pending or retired-CLI rows are never miscounted as 0 bots.
 */
export function validateBotConfigEntries(parsed: unknown): BotConfigValidationResult {
  if (!Array.isArray(parsed)) {
    return { ok: false, message: 'bots.json must contain a JSON array' };
  }
  if (parsed.length === 0) {
    return { ok: true, count: 0 };
  }

  const activeForRoster: Array<Record<string, any> & {
    larkAppId: string;
    codexInstancePool?: ReturnType<typeof normalizeCodexInstancePool>;
  }> = [];

  try {
    for (let i = 0; i < parsed.length; i += 1) {
      const entry = parsed[i] as Record<string, any> | null;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { ok: false, message: `bots.json entry ${i} must be an object` };
      }

      const codexInstancePool = normalizeCodexInstancePool(entry.codexInstancePool, entry);

      if (typeof entry.larkAppId !== 'string' || entry.larkAppId.trim().length === 0) {
        return { ok: false, message: `bots.json entry ${i} is missing larkAppId` };
      }

      if (entry.mojo !== undefined) {
        const normalizedMojo = normalizeMojoConfig(entry.mojo);
        if (!normalizedMojo.ok) {
          throw new Error(`Bot config [${i}]: ${normalizedMojo.errors.join('; ')}`);
        }
      }

      if (entry.localIdentity !== undefined && typeof entry.localIdentity !== 'boolean') {
        return { ok: false, message: `bots.json entry ${i} has invalid localIdentity` };
      }
      if (entry.localIdentity === true) {
        if (entry.apiOnly !== true) {
          return { ok: false, message: `bots.json entry ${i} localIdentity requires apiOnly: true` };
        }
        if (!isLocalBotId(entry.larkAppId)) {
          return { ok: false, message: `bots.json entry ${i} localIdentity requires a local_<slug> larkAppId` };
        }
      }

      if (entry.apiOnly === true) {
        if (entry.larkAppSecret !== undefined && typeof entry.larkAppSecret !== 'string') {
          return { ok: false, message: `bots.json entry ${i} has invalid larkAppSecret` };
        }
      } else if (typeof entry.larkAppSecret !== 'string' || entry.larkAppSecret.trim().length === 0) {
        return { ok: false, message: `bots.json entry ${i} is missing larkAppSecret` };
      }

      // Mirror parseBotConfigsFromText early-skip for activation-pending and retired-CLI rows
      // (while still counting them in `parsed.length` so they are never treated as 0-bot).
      if (
        entry.activationPending === true
        || entry.activationDeactivating !== undefined
        || entry.activationStarting !== undefined
        || entry.activationCommitted !== undefined
      ) {
        continue;
      }
      if (retiredCli(entry.cliId)) {
        continue;
      }

      const entryCliId = entry.cliId ?? LEGACY_DEFAULT_CLI_ID;
      if (entry.cliRuntime !== undefined && !supportsConfiguredCliRuntime(entryCliId)) {
        throw new Error(`Bot config [${i}]: cliRuntime is currently supported only for cliId "codex" or "kimi"`);
      }
      if (entry.cliRuntime !== undefined && typeof entry.wrapperCli === 'string' && entry.wrapperCli.trim()) {
        throw new Error(`Bot config [${i}]: cliRuntime cannot be combined with wrapperCli`);
      }

      const codexProfile = normalizeCodexProfile(entry.codexProfile);
      if (codexProfile) assertCodexProfileConfig(entry);

      const cliRuntime = entry.cliRuntime === undefined
        ? undefined
        : normalizeCliRuntimeConfig(entry.cliRuntime, `Bot config [${i}].cliRuntime`);
      const cliLaunchMode = normalizeCliLaunchMode(entry.cliLaunchMode, `Bot config [${i}].cliLaunchMode`);

      if (cliSupportsConfigDir(entryCliId)) {
        normalizeCliConfigDir(entry.cliConfigDir);
      }
      const credentialsSourceDir = normalizeCredentialsSourceDir(entry.credentialsSourceDir);
      if (credentialsSourceDir && entry.codexAuthSync === 'isolated') {
        throw new Error(`Bot config [${i}]: credentialsSourceDir cannot be combined with codexAuthSync "isolated"`);
      }
      if (cliRuntime && entry.cliPathOverride === undefined) {
        throw new Error(`Bot config [${i}]: cliPathOverride is required as an exact downgrade shadow of cliRuntime.executable`);
      }
      if (cliRuntime && entry.cliPathOverride !== cliRuntime.executable) {
        throw new Error(`Bot config [${i}]: cliPathOverride must exactly match cliRuntime.executable`);
      }

      const sandboxMode: SandboxMode = normalizeSandboxMode(entry.sandbox);
      if (entry.scratchStorage !== undefined) {
        normalizeScratchStorage(entry.scratchStorage);
      }
      validateSandboxPathList(entry.scratchDenyPaths, 'scratchDenyPaths', i);
      if (entry.sandboxPaths != null) {
        if (typeof entry.sandboxPaths !== 'object' || Array.isArray(entry.sandboxPaths)) {
          throw new Error(`Bot config [${i}]: sandboxPaths must be an object of readWrite / readOnly / deny path arrays`);
        }
        validateSandboxPathList(entry.sandboxPaths.readWrite, 'sandboxPaths.readWrite', i);
        validateSandboxPathList(entry.sandboxPaths.readOnly, 'sandboxPaths.readOnly', i);
        validateSandboxPathList(entry.sandboxPaths.deny, 'sandboxPaths.deny', i);
      }
      if (entry.sandboxNetwork != null && typeof entry.sandboxNetwork !== 'boolean') {
        throw new Error(`Bot config [${i}]: sandboxNetwork must be true or false`);
      }
      if (entry.sandboxWithholdBotSecret != null && typeof entry.sandboxWithholdBotSecret !== 'boolean') {
        throw new Error(`Bot config [${i}]: sandboxWithholdBotSecret must be true or false`);
      }
      if (entry.protectedResults != null && typeof entry.protectedResults !== 'boolean') {
        throw new Error(`Bot config [${i}]: protectedResults must be true or false`);
      }
      if (
        entry.protectedResults === true
        && (!(entry.sandbox === true || entry.sandbox === 'oncall') || entry.larkToolBinding === false)
      ) {
        throw new Error(`Bot config [${i}]: protectedResults requires an explicit oncall sandbox and managed lark-tool binding`);
      }

      validateCliLaunchModeConfig({
        cliId: entryCliId,
        cliLaunchMode,
        wrapperCli: entry.wrapperCli,
        cliRuntime: entry.cliRuntime,
        cliPathOverride: entry.cliPathOverride,
        sandbox: sandboxMode,
        readIsolation: entry.readIsolation,
      }, `Bot config [${i}]`);

      const existingAppServer = normalizeExistingAppServerConfig(
        entry.existingAppServer,
        `Bot config [${i}].existingAppServer`,
      );
      parseTriggerUserAuthConfig(entry.triggerUserAuth);
      const codexBrowser = normalizeCodexBrowserConfig(
        entry.codexBrowser,
        `Bot config [${i}].codexBrowser`,
      );
      if (codexBrowser) {
        if (entryCliId !== 'codex-app') {
          throw new Error(`Bot config [${i}]: codexBrowser is supported only for cliId "codex-app"`);
        }
        if (existingAppServer) {
          throw new Error(`Bot config [${i}]: codexBrowser cannot be combined with existingAppServer`);
        }
        if (sandboxMode !== 'off' || entry.readIsolation === true) {
          throw new Error(`Bot config [${i}]: codexBrowser cannot be combined with sandbox or readIsolation`);
        }
      }
      if (existingAppServer) {
        if (entryCliId !== 'codex' && entryCliId !== 'codex-app') {
          throw new Error(`Bot config [${i}]: existingAppServer is supported only for cliId "codex" or "codex-app"`);
        }
        if (entry.codexRpcInput === true) {
          throw new Error(`Bot config [${i}]: existingAppServer cannot be combined with codexRpcInput`);
        }
        if (typeof entry.wrapperCli === 'string' && entry.wrapperCli.trim()) {
          throw new Error(`Bot config [${i}]: existingAppServer cannot be combined with wrapperCli`);
        }
        if (sandboxMode !== 'off' || entry.readIsolation === true) {
          throw new Error(`Bot config [${i}]: existingAppServer cannot be combined with sandbox or readIsolation`);
        }
      }

      if (entry.envPolicy !== undefined) {
        normalizeEnvPolicy(entry.envPolicy);
      }
      if (entry.vcMeetingAgent?.listenerPolicy !== undefined) {
        normalizeVcMeetingListenerPolicy(entry.vcMeetingAgent.listenerPolicy);
      }
      if (entry.botActorOwnerBindings !== undefined) {
        normalizeBotActorOwnerBindings(entry.botActorOwnerBindings, `Bot config [${i}].botActorOwnerBindings`);
      }
      if (entry.groupCreation !== undefined) {
        parseGroupCreationDefaults(entry.groupCreation);
      }
      if (entry.inviteConfig !== undefined) {
        parseInviteConfig(entry.inviteConfig);
      }
      if (entry.oncallGroup !== undefined) {
        normalizeOncallGroupPolicy(entry.oncallGroup);
      }
      if (entry.noProgressNotify !== undefined) {
        normalizeNoProgressNotifyPolicy(entry.noProgressNotify);
      }
      if (entry.feedback !== undefined) {
        normalizeFeedbackPolicyLayer(entry.feedback);
      }
      if (entry.feedbackPresentation !== undefined) {
        normalizeFeedbackPresentation(entry.feedbackPresentation);
      }
      if (
        entry.chatFeedbackPolicies
        && typeof entry.chatFeedbackPolicies === 'object'
        && !Array.isArray(entry.chatFeedbackPolicies)
      ) {
        for (const layer of Object.values(entry.chatFeedbackPolicies)) {
          normalizeFeedbackPolicyLayer(layer);
        }
      }
      if (entry.remoteRunner !== undefined) {
        normalizeRemoteRunnerConfig(entry.remoteRunner);
      }
      if (entry.sandboxNetworkPolicy !== undefined) {
        parseSandboxNetworkPolicy(entry.sandboxNetworkPolicy);
      }

      // Roster validation normalizes the pool again; preserve the complete entry so
      // cliId/backendType and all exclusion fields match the real daemon loader.
      activeForRoster.push({ ...entry, larkAppId: entry.larkAppId, codexInstancePool });
    }

    validateCodexInstanceRoster(activeForRoster as any);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, count: parsed.length };
}
