import {DEFAULT_WECOM_SESSION_MODE,validateWecomSessionMode} from '../../im/wecom/config/session-mode.js';
import {wecomCommandTriggerConflicts,wecomTriggerPassthrough} from '../../im/wecom/config/command-triggers.js';
import { resolveCliSelection, selectionKeyForBot } from '../../setup/cli-selection.js';
import { wecomManagedCoreEnvironment } from '../../im/wecom/config/managed-core-env.js';
import { scanCodexProfiles } from '../../services/codex-profiles.js';
import { botSessionEnvView } from '../../core/session-env-host.js';
import { cliAvailabilityResponse } from '../cli-availability-request.js';
import { modelCatalogProbeContext } from '../model-catalog-request.js';
import { buildModelChoicesResponse, isKnownSelectionKey } from '../../services/model-catalog.js';
import { WECOM_MESSAGE_CONFIG_KEYS, validateWecomMessageConfig,effectiveWecomMessageConfig,WECOM_OWNER_REMINDER_STATES } from '../../im/wecom/config/message-config.js';
import { parseBotConfigsFromText } from '../../bot-registry.js';
import { createCliAdapterSync } from '../../adapters/cli/registry.js';
import { evaluateReadIsolationGate } from '../../adapters/cli/read-isolation.js';
import { backendSandboxCompatibilityError } from '../../adapters/backend/session-backend-selector.js';
import { localSandboxApplies } from '../../adapters/backend/sandbox.js';
import { probeScratchCapability } from '../../adapters/backend/scratch-capability.js';
import { globalBuiltinSkillInjectionDefault, resolveSkillInjectionSupport } from '../../skills/injection-mode.js';
import { hostDnsServers, proxyEnvKeys } from '../../core/sandbox-network-policy.js';
import { buildSessionChildEnv, botInjectedEnv } from '../../core/env-policy.js';
import { botConfigSandboxMode } from '../../adapters/cli/sandbox-mode.js';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { wecomFleetMemberEnvFromDotEnv } from '../../im/wecom/config/fleet-members.js';
import { stripDashboardH5Env } from '../../utils/child-env.js';
import { createHash,randomUUID } from 'node:crypto';
import { ALL_CLI_IDS } from '../../adapters/cli/registry.js';
import { CORE_ONLY_BACKENDS, validateCoreOnlyBotProfile } from '../../core/core-only-bot-profile.js';
import { parseWecomConfig, commitWecomConfiguration } from '../../im/wecom/config/config.js';
import { readWecomConfigPaths, wecomConfigId, wecomRoot } from '../../im/wecom/config/discovery.js';
import { WECOM_MESSAGE_QUOTA_MAX } from '../../im/wecom/config/native-core-config.js';
import { readLocalWecomConnections, wecomPeerAccepts, wecomPeerSide } from '../../im/wecom/config/peer-trust.js';
const revision = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The environment a WeCom gateway gets as a fleet member, as far as the
 * Dashboard can tell — the base its core and CLI sessions are derived from:
 * the fleet's base environment (which the Dashboard, itself a fleet member,
 * inherited) without the Dashboard-only H5 login family, plus the `.env` keys
 * the supervisor adds for a WeCom member, by the supervisor's own function
 * (wecomFleetMemberEnvFromDotEnv).
 */
export function wecomFleetMemberEnvironment(baseEnv: NodeJS.ProcessEnv, envFileText: string | undefined): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...baseEnv };
  stripDashboardH5Env(base);
  return { ...base, ...wecomFleetMemberEnvFromDotEnv(envFileText, base) };
}

function readFleetEnvFile(): string | undefined {
  try {
    return readFileSync(join(homedir(), '.botmux', '.env'), 'utf8');
  } catch {
    return undefined;
  }
}

export class WecomDashboardConfig {
  constructor(
    private readonly root = wecomRoot(),
    /** The gateway's environment (see wecomFleetMemberEnvironment); tests inject their own. */
    private readonly memberEnv: () => NodeJS.ProcessEnv = () => wecomFleetMemberEnvironment(process.env, readFleetEnvFile()),
  ) {}
  private read(id: string) {
    const file = readWecomConfigPaths(this.root).find(path => wecomConfigId(path) === id);
    if (!file) throw new Error('wecom_connection_not_found');
    const snapshot = readFileSync(file, 'utf8');
    return { file, snapshot, config: parseWecomConfig(JSON.parse(snapshot)) };
  }
  get(id: string) {
    const { config, snapshot } = this.read(id);
    const core = config.managedCore;
    return core ? {
      editable: true,
      native: config.native ?? {},
      displayName: config.displayName ?? '',
      cli: core.cli,
      backend: core.backend,
      model: core.model ?? '',
      workingDirectory: core.workingDirectory,
      sessionMode: config.sessionMode ?? DEFAULT_WECOM_SESSION_MODE,
      botConfig: { ...core.botConfig, ...effectiveWecomMessageConfig(config.message) },
      runtime: this.runtime(core),
      allowedUsers: config.allowedUsers,
      blockedUsers: config.blockedUsers ?? [],
      role: config.role ?? { content: '', injectMode: 'every' },
      commandTriggers: config.commandTriggers ?? null,
      requiresRestart: true,
      revision: revision(snapshot),
    } : { editable: false, requiresRestart: true, error: 'wecom_external_core_configuration' };
  }
  private profile(id: string) {
    const { config } = this.read(id);
    const core = config.managedCore;
    if (!core) {
      throw new Error('wecom_external_core_configuration');
    }
    const bot = parseBotConfigsFromText(JSON.stringify([{
      ...core.botConfig,
      larkAppId: core.botId,
      apiOnly: true,
      cliId: core.cli,
      model: core.model,
      backendType: core.backend,
    }]))[0];
    // Probes are external CLI children, not core/worker processes. Strip the
    // host-only profile envelope before any selection-specific resolver can
    // fall back to this baseline. The selected bot's intentional credentials
    // are applied only by the matching one-shot launch policy below.
    const env = buildSessionChildEnv(wecomManagedCoreEnvironment(config, this.memberEnv()));
    return { config, core, bot, env };
  }
  /**
   * The quota-limit hand-over targets of one connection: the other connections
   * of this host that accept it now (config/peer-trust.ts), by id and display
   * name only — never their user lists — and the configured target with
   * whether it is accepted. `trusting` is false while this connection's own
   * trustSameOwnerBots is off: it then hands over to nobody.
   */
  fallbackPeers(id: string) {
    const { config } = this.read(id);
    const source = wecomPeerSide(config);
    const configured = config.native?.quotaFallbackBot?.peerId;
    const peers: Array<{ id: string; name?: string }> = [];
    let current: { id: string; name?: string; accepted: boolean } | undefined;
    for (const peer of readLocalWecomConnections(this.root)) {
      if (peer.id === id) continue;
      const accepted = wecomPeerAccepts({ target: wecomPeerSide(peer.config), source, sameConnection: false, operation: 'fallback' });
      const name = peer.config.displayName || undefined;
      if (accepted) peers.push({ id: peer.id, ...(name ? { name } : {}) });
      if (peer.id === configured) current = { id: peer.id, ...(name ? { name } : {}), accepted };
    }
    if (configured && !current) current = { id: configured, accepted: false };
    return { peers, ...(current ? { current } : {}), trusting: config.native?.trustSameOwnerBots !== false };
  }
  commandTriggers(id: string, commands?: string[]) {
    const { config, core } = this.profile(id);
    return commands ? {
      results: wecomCommandTriggerConflicts(commands, wecomTriggerPassthrough(
        core.cli,
        core.botConfig?.customPassthroughCommands as string[] | undefined,
        core.botConfig?.cliPathOverride as string | undefined,
      )),
    } : { config: config.commandTriggers ?? null };
  }
  async codexProfiles(id: string) {
    const {bot,env} = this.profile(id);
    return { ...await scanCodexProfiles({...bot,probeBaseEnv:env}), connectionId:id };
  }
  environment(id: string) {
    const {bot,env} = this.profile(id);
    const {larkAppId,...view} = botSessionEnvView(bot,{baseEnv:env,sessions:[]});
    return {ok:true,...view,connectionId:id,canReveal:false};
  }
  async cliProbe(id: string, kind: 'availability' | 'models', key: string) {
    const { bot, env } = this.profile(id);
    if (!isKnownSelectionKey(key)) throw new Error('wecom_unknown_cli_selection');
    if (kind === 'availability') return (await cliAvailabilityResponse(key, bot, env)).body;
    const context = modelCatalogProbeContext(key, bot, env);
    return buildModelChoicesResponse(key, {
      runtimeExecutable: context.runtimeExecutable,
      runtimeContext: context.runtimeContext,
      probeEnv: context.probeEnv ?? env,
      // `env` is the managed core's sanitized environment, not this Dashboard
      // process's: every probe must run inside it (no gateway credentials).
      isolatedProbeEnv: true,
    });
  }
  private runtime(core: NonNullable<ReturnType<typeof parseWecomConfig>['managedCore']>) {
    const cfg = parseBotConfigsFromText(JSON.stringify([{
      ...core.botConfig,
      larkAppId: core.botId,
      apiOnly: true,
      cliId: core.cli,
      model: core.model,
      backendType: core.backend,
    }]))[0];
    let adapterSupports = false;
    try {
      adapterSupports = createCliAdapterSync(cfg.cliId, cfg.cliPathOverride).supportsReadIsolation === true;
    } catch { /* unavailable adapter */ }
    const env = {
      ...buildSessionChildEnv(this.memberEnv(), cfg.envPolicy, cfg.envUnset),
      ...botInjectedEnv(cfg.env, cfg.envPolicy),
    };
    return {
      sandboxNetworkPolicyPlatform: process.platform,
      sandboxNetworkHostDns: process.platform === 'linux' ? hostDnsServers(path => readFileSync(path, 'utf8')) : [],
      sandboxNetworkProxyEnv: proxyEnvKeys(env),
      sandboxCapable: backendSandboxCompatibilityError({
        backendType: core.backend,
        cliId: cfg.cliId,
        fileSandboxRequested: true,
        effectiveReadIsolationRequested: false,
        mojoConfig: cfg.mojo,
      }) === undefined,
      localSandboxApplies: localSandboxApplies(core.backend, cfg.mojo),
      effectiveSandboxMode: botConfigSandboxMode(cfg),
      sandboxEnvForce: null,
      readIsolationSupported: evaluateReadIsolationGate({
        configured: true,
        adapterSupports,
        wrapperCliSet: !!cfg.wrapperCli || !!cfg.cliLaunchMode,
        platform: process.platform,
        sessionDataDirSet: true,
      }).enabled,
      scratchSupported: process.platform === 'linux' || process.platform === 'darwin',
      scratchCapability: probeScratchCapability(),
      skillInjectionSupport: resolveSkillInjectionSupport(cfg.cliId, cfg.cliPathOverride),
      skillInjectionDefault: globalBuiltinSkillInjectionDefault(),
      ownerReminderStates: WECOM_OWNER_REMINDER_STATES,
      defaultBackendType: 'tmux',
      codexAuthSync: cfg.codexAuthSync,
      allowedChatGroupsCount: 0,
      oncallSharedChatCount: 0,
    };
  }
  async patch(id: string, body: Record<string, unknown>) {
    const { file, config, snapshot } = this.read(id);
    const core = config.managedCore;
    if (!core) {
      throw new Error('wecom_external_core_configuration');
    }
    if (body.revision !== revision(snapshot)) {
      throw new Error('wecom_configuration_changed');
    }
    if (Object.keys(body).some(key => ![
      'revision', 'displayName', 'cli', 'replaceCliSelection', 'backend', 'model', 'workingDirectory', 'botConfig',
      'sessionMode', 'commandTriggers', 'allowedUsers', 'blockedUsers', 'role', 'native',
    ].includes(key))) {
      throw new Error('wecom_invalid_configuration');
    }
    // A quota above the bound an earlier version allowed may stay as it is (grants take the bound), never be set anew.
    const quota = (body.native as Record<string, unknown> | undefined)?.messageQuotaDefaultLimit;
    if (typeof quota === 'number' && quota > WECOM_MESSAGE_QUOTA_MAX && quota !== config.native?.messageQuotaDefaultLimit) {
      throw new Error('wecom_invalid_configuration');
    }
    if (body.replaceCliSelection !== undefined && typeof body.replaceCliSelection !== 'boolean') {
      throw new Error('wecom_invalid_configuration');
    }
    const currentSelection = selectionKeyForBot(
      core.cli,
      core.botConfig?.wrapperCli as string | undefined,
      core.botConfig?.cliLaunchMode as any,
    );
    const selectionKey = body.cli ?? currentSelection;
    let selected: ReturnType<typeof resolveCliSelection>;
    try {
      if (typeof selectionKey !== 'string') {
        throw new Error();
      }
      selected = resolveCliSelection(selectionKey);
    } catch {
      throw new Error('wecom_invalid_configuration');
    }
    const cli = selected.cliId;
    const backend = body.backend ?? core.backend;
    const selectionChanged = body.replaceCliSelection === true || selectionKey !== currentSelection;
    const model = body.model ?? core.model ?? '';
    const workingDirectory = body.workingDirectory ?? core.workingDirectory;
    const displayName = body.displayName ?? config.displayName ?? '';
    if (typeof displayName !== 'string' || displayName.length > 100 || /[\x00-\x1f]/.test(displayName)
      || typeof cli !== 'string' || !ALL_CLI_IDS.includes(cli as any) || !(CORE_ONLY_BACKENDS as readonly unknown[]).includes(backend)
      || typeof workingDirectory !== 'string' || !isAbsolute(workingDirectory)
      || typeof model !== 'string' || model.length > 200 || /[\x00-\x1f]/.test(model)) {
      throw new Error('wecom_invalid_configuration');
    }
    try {
      if (!statSync(workingDirectory).isDirectory()) {
        throw new Error();
      }
    } catch {
      throw new Error('wecom_working_directory_unavailable');
    }
    const profile: Record<string, unknown> = Object.assign(Object.create(null), core.botConfig);
    if (selectionChanged) {
      delete profile.cliRuntime;
      delete profile.cliPathOverride;
      if (selected.wrapperCli) {
        profile.wrapperCli = selected.wrapperCli;
      } else {
        delete profile.wrapperCli;
      }
      if (selected.cliLaunchMode) {
        profile.cliLaunchMode = selected.cliLaunchMode;
      } else {
        delete profile.cliLaunchMode;
      }
      if (selected.cliId !== 'codex' || selected.wrapperCli || selected.cliLaunchMode) {
        delete profile.codexProfile;
      }
    }
    const message: Record<string, unknown> = Object.assign(Object.create(null), config.message);
    if (body.botConfig !== undefined) {
      if (!body.botConfig || typeof body.botConfig !== 'object' || Array.isArray(body.botConfig)) {
        throw new Error('wecom_invalid_configuration');
      }
      for (const [key, value] of Object.entries(body.botConfig)) {
        if ((WECOM_MESSAGE_CONFIG_KEYS as readonly string[]).includes(key)) {
          if (value === null) {
            delete message[key];
          } else {
            validateWecomMessageConfig({ [key]: value });
            message[key] = value;
          }
          continue;
        }
        // Validate even deleted keys: null must not become an identity-field bypass.
        if (value === null) {
          validateCoreOnlyBotProfile({ [key]: undefined });
          delete profile[key];
        } else {
          validateCoreOnlyBotProfile({ [key]: value });
          profile[key] = value;
        }
      }
      const patch = body.botConfig as Record<string, unknown>;
      if (patch.cliRuntime !== undefined && patch.cliPathOverride === undefined) {
        // The shared Agent editor speaks the structured descriptor. Persist
        // its downgrade shadow at this transaction boundary, just as the
        // fleet Agent writer does; clearing it clears the old shadow too.
        if (patch.cliRuntime === null) {
          delete profile.cliPathOverride;
        } else {
          profile.cliPathOverride = (patch.cliRuntime as Record<string, unknown>).executable;
        }
      }
    }
    try {
      const sessionMode = body.sessionMode !== undefined ? validateWecomSessionMode(body.sessionMode) : config.sessionMode;
      const sessionModeEpoch = JSON.stringify(sessionMode ?? DEFAULT_WECOM_SESSION_MODE) !== JSON.stringify(config.sessionMode ?? DEFAULT_WECOM_SESSION_MODE)
        ? randomUUID()
        : config.sessionModeEpoch;
      const next = parseWecomConfig({
        ...config,
        ...(body.native !== undefined ? { native: body.native } : {}),
        sessionMode,
        sessionModeEpoch,
        message: validateWecomMessageConfig(message),
        displayName: displayName.trim() || undefined,
        ...(body.commandTriggers !== undefined
          ? { commandTriggers: body.commandTriggers === null ? undefined : body.commandTriggers }
          : {}),
        ...(body.allowedUsers !== undefined ? { allowedUsers: body.allowedUsers } : {}),
        ...(body.blockedUsers !== undefined ? { blockedUsers: body.blockedUsers } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        managedCore: {
          ...core,
          cli,
          backend,
          model: model || undefined,
          workingDirectory,
          botConfig: validateCoreOnlyBotProfile(profile),
        },
      });
      await commitWecomConfiguration({ file, previous: snapshot, config: next });
    } catch (error) {
      if (error instanceof Error && error.message.includes('另一个向导')) {
        throw new Error('wecom_configuration_changed');
      }
      throw new Error('wecom_invalid_configuration');
    }
    return { ok: true, savedRestartRequired: true, config: this.get(id) };
  }
}
