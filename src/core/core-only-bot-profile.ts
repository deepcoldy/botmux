import { CODEX_REASONING_EFFORTS } from '../services/codex-reasoning-effort.js';
import { isCodexServiceTier } from '../services/codex-service-tier.js';
import { normalizeCodexBrowserConfig } from './codex-browser-config.js';
import { normalizeNativeSubagentRuntimePolicy } from '../services/native-subagent-runtime-policy.js';
import { normalizeTraexAutoModelConfig } from '../services/traex-auto-model.js';
import { botEnvLayer, envLayerWithinBudget } from './session-env.js';
import { sanitizePerBotEnv, isReservedPerBotEnvKey } from './per-bot-env.js';
import { normalizeEnvPolicy } from './env-policy.js';
import { normalizePromptCacheConfig } from '../services/prompt-cache-policy.js';
import { isNativeGatewayReservedEnvKey } from './native-gateway-contract.js';

/** Transport-neutral configuration only. Identity, credentials, fleet authority,
 * grants and IM-specific settings must never enter a synthetic core-only bot. */
export const CORE_ONLY_BACKENDS = ['pty','tmux','herdr','zellij','zmx','riff','mojo','remote-runner','orca'] as const;

export const CORE_ONLY_BOT_PROFILE_KEYS = [
  'herdr', 'riff', 'mojo', 'remoteRunner', 'credentialsSourceDir',
  'cliRuntime', 'cliPathOverride', 'cliConfigDir', 'wrapperCli', 'cliLaunchMode',
  'launchShell', 'traexAutoModel', 'modelBackendVariant', 'turnTimeoutMs',
  'dshProfile', 'dshRuntime', 'reasoningEffort', 'codexProfile', 'serviceTier',
  'nativeSubagentRuntime', 'disableCliBypass', 'codexAppCleanInput',
  'goalStatusCard', 'codexCapacityRecovery', 'codexBrowser', 'codexRpcInput', 'codexAuthSync',
  'archiveCodex', 'sandbox', 'scratchStorage', 'scratchTmpfsSizeMb',
  'scratchDenyPaths', 'sandboxPaths', 'sandboxNetwork', 'sandboxNetworkPolicy',
  'readIsolation', 'readDenyExtraPaths', 'maxLiveWorkers', 'idleSuspendMinutes',
  'idleSpinSuspend', 'startupCommands', 'customPassthroughCommands',
  'canTalkDaemonCommands', 'env', 'envUnset', 'envPolicy', 'skillInjection',
  'skills', 'plugins', 'pluginRuntime', 'promptCache', 'promptInjection',
  'envelopeInjection', 'senderTag', 'senderTagHideEmail', 'hideLocalAddresses',
  'defaultWorkingDir', 'defaultWorkingDirAutoWorktree', 'lang',
] as const;
export type CoreOnlyBotProfile = Partial<Record<typeof CORE_ONLY_BOT_PROFILE_KEYS[number], unknown>>;
const keys = new Set<string>(CORE_ONLY_BOT_PROFILE_KEYS);
const booleans = new Set(['goalStatusCard','disableCliBypass','codexAppCleanInput','codexCapacityRecovery','codexRpcInput','archiveCodex','sandboxNetwork','readIsolation','senderTag','senderTagHideEmail','hideLocalAddresses','defaultWorkingDirAutoWorktree']);
const strings = new Set(['credentialsSourceDir','cliPathOverride','cliConfigDir','wrapperCli','launchShell','dshProfile','codexProfile','defaultWorkingDir']);
const arrays = new Set(['scratchDenyPaths','readDenyExtraPaths','startupCommands','customPassthroughCommands','canTalkDaemonCommands','plugins','envUnset']);
const enums: Record<string, readonly unknown[]> = {
  sandbox:[true,false,'oncall','scratch','off'], scratchStorage:['disk','tmpfs'],
  cliLaunchMode:['forge-traex'], modelBackendVariant:['standard','max'],
  dshRuntime:['official','tui'], reasoningEffort:CODEX_REASONING_EFFORTS,
  codexAuthSync:['isolated','shared'],
  skillInjection:['global','prompt','off'], promptInjection:['default','none'],
  // Retired switch (Hook injection is always on): still accepted so a configuration
  // saved by an earlier version loads; the BotConfig parser ignores it.
  envelopeInjection:['auto','off'], lang:['zh','en'],
};
/** Validate the raw wire form before the normal BotConfig parser normalizes it.
 * A malformed security field must reject a save, never silently clear a fence. */
export function validateCoreOnlyBotProfile(raw: unknown): CoreOnlyBotProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid_core_bot_profile');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !keys.has(key))) throw new Error('invalid_core_bot_profile');
  for (const [key,value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null) throw new Error('invalid_core_bot_profile');
    if (booleans.has(key) && typeof value !== 'boolean') throw new Error('invalid_core_bot_profile');
    if (strings.has(key) && (typeof value !== 'string' || value.includes('\0') || value.length > 8192)) throw new Error('invalid_core_bot_profile');
    if (arrays.has(key) && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.includes('\0')))) throw new Error('invalid_core_bot_profile');
    if (key === 'serviceTier' && !isCodexServiceTier(value)) throw new Error('invalid_core_bot_profile');
    if (enums[key] && !enums[key].includes(value)) throw new Error('invalid_core_bot_profile');
    if (['maxLiveWorkers','idleSuspendMinutes','turnTimeoutMs','scratchTmpfsSizeMb'].includes(key)
      && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || (key === 'turnTimeoutMs' && value > 2147483647))) throw new Error('invalid_core_bot_profile');
    if (!['codexBrowser','serviceTier'].includes(key) && !booleans.has(key) && !strings.has(key) && !arrays.has(key) && !enums[key]
      && !['maxLiveWorkers','idleSuspendMinutes','turnTimeoutMs','scratchTmpfsSizeMb'].includes(key)
      && (typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid_core_bot_profile');
  }
  if (input.env !== undefined) {
    const env = input.env as Record<string, unknown>;
    if (Object.entries(env).some(([key,value]) => typeof value !== 'string' || value.includes('\0') || isReservedPerBotEnvKey(key) || isNativeGatewayReservedEnvKey(key))) throw new Error('invalid_core_bot_profile');
    const sanitized = sanitizePerBotEnv(env);
    if (Object.keys(sanitized ?? {}).length !== Object.keys(env).length) throw new Error('invalid_core_bot_profile');
  }
  if (input.envUnset !== undefined && (input.envUnset as string[]).some(key => isReservedPerBotEnvKey(key) || isNativeGatewayReservedEnvKey(key))) throw new Error('invalid_core_bot_profile');
  if (!envLayerWithinBudget({set:{},unset:[]},botEnvLayer(input))) throw new Error('invalid_core_bot_profile');
  if (input.codexBrowser !== undefined) normalizeCodexBrowserConfig(input.codexBrowser);
  if (input.nativeSubagentRuntime !== undefined && !normalizeNativeSubagentRuntimePolicy(input.nativeSubagentRuntime).ok) throw new Error('invalid_core_bot_profile');
  if (input.traexAutoModel !== undefined && normalizeTraexAutoModelConfig(input.traexAutoModel).error) throw new Error('invalid_core_bot_profile');
  if (input.envPolicy !== undefined) normalizeEnvPolicy(input.envPolicy);
  if (input.promptCache !== undefined) normalizePromptCacheConfig(input.promptCache);
  if (input.sandboxPaths !== undefined) {
    const paths = input.sandboxPaths as Record<string,unknown>;
    if (Object.keys(paths).some(key => !['readWrite','readOnly','deny'].includes(key))
      || Object.values(paths).some(value => !Array.isArray(value) || value.some(path => typeof path !== 'string' || path.includes('\0')))) throw new Error('invalid_core_bot_profile');
  }
  return JSON.parse(JSON.stringify(input)) as CoreOnlyBotProfile;
}
