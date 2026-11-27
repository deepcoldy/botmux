/**
 * Environment of the dedicated core a WeCom gateway manages, derived from
 * configuration alone; nothing here starts a process. The gateway launches the
 * core with it (gateway/managed-core.ts), and the Dashboard uses it as the base
 * environment for the CLI probes it runs on behalf of that connection.
 */
import type { BackendType } from '../../../adapters/backend/types.js';
import { validateCoreOnlyBotProfile, type CoreOnlyBotProfile } from '../../../core/core-only-bot-profile.js';
import { isNativeGatewayReservedEnvKey, type NativeGatewayCoreProfile } from '../../../core/native-gateway-contract.js';
import { NATIVE_GATEWAY_CORE_ENV, NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV } from '../../../core/runtime-mode.js';
import { wecomCustomizationStoreDir } from '../../../services/customization-scope.js';
import { resolve } from 'node:path';
import {
  CORE_ONLY_FROZEN_LOOPBACK_ENV,
  MANAGED_CORE_NO_CLAIM_ENV,
  redactChildEnv,
  scrubClaudeSessionMarkerEnv,
  scrubSessionCliHomeEnv,
  scrubSessionTurnMarkerEnv,
  scrubWorkflowWorkerEnv,
} from '../../../utils/child-env.js';

export interface WecomManagedCoreSettings {
  botConfig?: CoreOnlyBotProfile;
  botId: string;
  cli: string;
  backend: BackendType;
  workingDirectory: string;
  model?: string;
  port: number;
  stateDir: string;
}

/**
 * Where the managed core's web-terminal reverse proxy starts looking for a port.
 *
 * A core-only daemon binds its proxy on 127.0.0.1; Feishu bot daemons bind
 * theirs on WEB_HOST (default 0.0.0.0) at BOTMUX_WEB_PROXY_BASE_PORT (default
 * 8800) + bot index. On macOS a 127.0.0.1 listener and a 0.0.0.0 listener on
 * the same port coexist and every loopback connection goes to the 127.0.0.1
 * one, so a core left on the Feishu default took over bot 0's terminal port
 * for every local client — the Dashboard dials 127.0.0.1:<port>. (Linux
 * refuses the second of the two binds, so whichever started later moved up.)
 *
 * This base keeps clear of every port botmux's Feishu side listens on: the
 * proxy range (8800 + bots + 20 probes), the Dashboard (7891–7911), daemon IPC
 * (7950 + bots) and the OS ephemeral ranges Feishu workers get their ports from
 * (Linux 32768–60999, macOS 49152–65535). Cores probe upward among themselves:
 * two 127.0.0.1 binds of one port conflict on every platform. A core advertises
 * the port it actually bound (core/terminal-url.ts), so nothing else assumes
 * this number.
 */
export const WECOM_CORE_TERMINAL_PROXY_BASE_PORT = 18800;

/**
 * Carries the base above into the core. The core entry (index-core-only.ts)
 * consumes it and removes it again before any worker starts, so it never
 * reaches a CLI session — where a `botmux start/restart` would otherwise pin
 * it onto the Feishu fleet as BOTMUX_WEB_PROXY_BASE_PORT.
 */
export const CORE_TERMINAL_PROXY_BASE_PORT_ENV = 'BOTMUX_CORE_WEB_PROXY_BASE_PORT';

/** The parts of a WeCom configuration the managed core is derived from. */
export interface WecomManagedCoreConfig {
  managedCore?: WecomManagedCoreSettings;
  secretEnv?: string;
  message?: { goalStatusCard?: boolean };
}

/**
 * The core settings a configuration projects to: the environment keys the core
 * synthesizes its bot from (NATIVE_GATEWAY_CORE_PROFILE_ENV_KEYS). The one
 * source of them — the environment a core is started with carries exactly
 * these, and a running core is handed exactly these when the configuration
 * changes (gateway/core-profile-sync.ts), so a core that took a change runs
 * what a core started on the changed configuration would.
 */
export function wecomManagedCoreProfileEnvironment(config: WecomManagedCoreConfig): NativeGatewayCoreProfile {
  const settings = config.managedCore;
  if (!settings) {
    throw new Error('wecom_external_core_configuration');
  }
  const profile = validateCoreOnlyBotProfile({
    ...settings.botConfig,
    ...(config.message?.goalStatusCard !== undefined ? { goalStatusCard: config.message.goalStatusCard } : {}),
  });
  return {
    BOTMUX_CORE_BOT_CONFIG: JSON.stringify(profile),
    BOTMUX_CORE_CLI: settings.cli,
    BOTMUX_CORE_BACKEND: settings.backend,
    BOTMUX_CORE_WORKING_DIR: resolve(settings.workingDirectory),
    ...(settings.model ? { BOTMUX_CORE_MODEL: settings.model } : {}),
  };
}

export function wecomManagedCoreEnvironment(
  config: WecomManagedCoreConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const settings = config.managedCore;
  if (!settings) {
    throw new Error('wecom_external_core_configuration');
  }
  // The WeCom customization store every connection shares, resolved from the
  // gateway's own environment (before the scrub below drops its
  // SESSION_DATA_DIR from the core's copy) by the one rule the Dashboard and the
  // gateway's own lines use too. The core's own state dir is never it.
  const customizationDir = wecomCustomizationStoreDir(baseEnv);
  const profile = wecomManagedCoreProfileEnvironment(config);
  const env = redactChildEnv(baseEnv, config.secretEnv ? [config.secretEnv] : []);
  scrubSessionTurnMarkerEnv(env);
  scrubSessionCliHomeEnv(env);
  scrubClaudeSessionMarkerEnv(env);
  scrubWorkflowWorkerEnv(env);
  for (const key of Object.keys(env)) {
    if ((key.startsWith('BOTMUX_') && key !== 'BOTMUX_FENCED_RUN')
      || isNativeGatewayReservedEnvKey(key)
      // A Feishu relay's external terminal port: the core would advertise it
      // instead of the loopback port it actually bound.
      || ['BOTS_CONFIG', 'SESSION_DATA_DIR', '__OWNER_OPEN_ID', 'WEB_EXTERNAL_PORT'].includes(key)) {
      delete env[key];
    }
  }
  Object.assign(env, {
    BOTMUX_CORE_ONLY: '1',
    [NATIVE_GATEWAY_CORE_ENV]: '1',
    BOTMUX_CORE_SKIP_DOTENV: '1',
    BOTMUX_API_ONLY_BOT: settings.botId,
    BOTMUX_API_PORT: String(settings.port),
    BOTMUX_CORE_STATE_DIR: resolve(settings.stateDir),
    // Prompt overrides the core resolves (read-only): the shared WeCom store,
    // not the core's own state dir (skills/effective-builtins.ts).
    [NATIVE_GATEWAY_CUSTOMIZATION_DIR_ENV]: customizationDir,
    // CLI, backend, working directory, model and bot profile.
    ...profile,
    // The same loopback values the core entry freezes (index-core-only.ts).
    ...CORE_ONLY_FROZEN_LOOPBACK_ENV,
    // Never repoint the global `botmux` wrapper (shared with the fleet's scrub).
    ...MANAGED_CORE_NO_CLAIM_ENV,
    [CORE_TERMINAL_PROXY_BASE_PORT_ENV]: String(WECOM_CORE_TERMINAL_PROXY_BASE_PORT),
  });
  return env;
}
