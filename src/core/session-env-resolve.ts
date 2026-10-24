/**
 * Spawn-time resolution of the session environment overlay (see
 * core/session-env.ts). The daemon calls this whenever it hands an env to a
 * worker (init, restart, v3 workflow worker) and whenever it launches a
 * one-shot CLI process on a bot's behalf, so every path composes the same
 * layers with the same lock context.
 */
import type { BackendType } from '../adapters/backend/types.js';
import { readRawGlobalSessionEnv } from '../global-config.js';
import { botInjectedEnv, buildSessionChildEnv, type EnvPolicy } from './env-policy.js';
import type { SessionEnvLockContext } from './per-bot-env.js';
import { isRemoteBackendId } from './remote-cli-ids.js';
import {
  botEnvLayer,
  composeSessionEnv,
  globalEnvLayer,
  type ComposedSessionEnv,
  type EnvLayer,
} from './session-env.js';
import { sanitizePerBotEnv } from './per-bot-env.js';
import { sessionEnvFingerprint } from '../services/session-env-stamp.js';

/** The bot-config fields the overlay depends on. */
export interface SessionEnvBotInput {
  env?: Record<string, string>;
  envUnset?: string[];
  envPolicy?: EnvPolicy;
  triggerUserAuth?: { enabled?: boolean };
  larkToolBinding?: boolean;
  apiOnly?: boolean;
  backendType?: BackendType;
}

/** Per-launch facts the bot config alone cannot tell. */
export interface SessionEnvLaunchFacts {
  /** The worker installs no identity wrapper for this launch at all: a
   *  one-shot CLI process, a v3 workflow worker. */
  unwrapped?: boolean;
  /** The lark tool binding is off for this session although the bot enables
   *  it: no IM transport (HTTP virtual chat) or an external Codex App Server
   *  (worker.ts usesLarkToolBinding). */
  larkBindingOff?: boolean;
}

/**
 * Identity wrappers a launch runs (sessionEnvLock). Mirrors the worker's
 * gates: the lark tool binding is on unless disabled, transport-less, remote
 * or off for the session (usesLarkToolBinding); trigger-user auth is opt-in.
 * Without launch facts this is the bot-level view the Dashboard edits against.
 */
export function sessionEnvLockContextForBot(bot: SessionEnvBotInput, facts: SessionEnvLaunchFacts = {}): SessionEnvLockContext {
  if (facts.unwrapped) return {};
  const trigger = bot.triggerUserAuth?.enabled === true;
  const larkBinding = !facts.larkBindingOff && bot.larkToolBinding !== false && bot.apiOnly !== true
    && !isRemoteBackendId(bot.backendType ?? 'pty');
  return { identityShell: trigger || larkBinding, identityGit: trigger };
}

/**
 * Backends whose CLI is NOT a local process inheriting this host's env keep
 * the historical contract (only the bot's own `env`): riff sends env to a
 * remote API, and mojo's device-isolation proof reasons over exactly the bot
 * `env` + its own block. Everything else, remote-runner included (a local
 * provider process), gets the full overlay.
 */
const BOT_ENV_ONLY_BACKENDS: ReadonlySet<BackendType> = new Set<BackendType>(['riff', 'mojo']);

export function sessionEnvOverlayApplies(backendType: BackendType): boolean {
  return !BOT_ENV_ONLY_BACKENDS.has(backendType);
}

/** Read straight from config.json (not the 2s readGlobalConfig cache) so a
 *  session started right after a Dashboard save already gets the new layer. */
export function readGlobalSessionEnvLayer(): EnvLayer {
  return globalEnvLayer(readRawGlobalSessionEnv());
}

export interface ResolvedSessionEnv {
  composed: ComposedSessionEnv;
  /** Composed `set` for the worker's `env` field; undefined when empty. */
  env?: Record<string, string>;
  /** Composed `unset`; undefined when empty. */
  envUnset?: string[];
  fingerprint: string;
}

export function resolveSessionEnv(input: {
  bot: SessionEnvBotInput;
  backendType: BackendType;
  /** /cli-selected and Codex-instance-bound sessions never received the bot's
   *  `env` (it targets the bot's default CLI); removals still apply. */
  skipBotSet?: boolean;
  /** Defaults to config.json. */
  global?: EnvLayer;
  facts?: SessionEnvLaunchFacts;
}): ResolvedSessionEnv {
  let composed: ComposedSessionEnv;
  if (!sessionEnvOverlayApplies(input.backendType)) {
    composed = { set: input.skipBotSet ? {} : sanitizePerBotEnv(input.bot.env), unset: [] };
  } else {
    const bot = botEnvLayer(input.bot);
    composed = composeSessionEnv(
      [input.global ?? readGlobalSessionEnvLayer(), input.skipBotSet ? { set: {}, unset: bot.unset } : bot],
      sessionEnvLockContextForBot(input.bot, input.facts),
    );
  }
  return {
    composed,
    ...(Object.keys(composed.set).length ? { env: composed.set } : {}),
    ...(composed.unset.length ? { envUnset: composed.unset } : {}),
    fingerprint: sessionEnvFingerprint(composed, input.bot.envPolicy),
  };
}

/**
 * Env for a one-shot CLI process run on a bot's behalf (title generation,
 * model / service-tier probes): the same layers that bot's sessions get, so a
 * proxy or provider set in the Dashboard reaches these calls too.
 */
export function botOneShotProbeEnv(base: NodeJS.ProcessEnv, bot: SessionEnvBotInput): { env: NodeJS.ProcessEnv; fingerprint: string } {
  // A one-shot is launched directly, never behind the identity wrappers.
  const resolved = resolveSessionEnv({ bot, backendType: bot.backendType ?? 'pty', facts: { unwrapped: true } });
  return {
    env: {
      ...buildSessionChildEnv(base, bot.envPolicy, resolved.envUnset),
      ...botInjectedEnv(resolved.env, bot.envPolicy),
    },
    fingerprint: resolved.fingerprint,
  };
}

export function botOneShotEnv(base: NodeJS.ProcessEnv, bot: SessionEnvBotInput): NodeJS.ProcessEnv {
  return botOneShotProbeEnv(base, bot).env;
}
