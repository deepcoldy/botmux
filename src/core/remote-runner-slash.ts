import type { RemoteRunnerConfig } from '../adapters/backend/remote-runner-config.js';
import type { BackendType } from '../adapters/backend/types.js';
import type { BotConfig } from '../bot-registry.js';
import type { AcceptedCommandInput, Session, TrustedCaller } from '../types.js';
import { t, localeForBot } from '../i18n/index.js';
import { resolveDelegatedSlashCommands } from './delegated-slash.js';
import type { SlashRouteDecision } from './command-router.js';
import { resolvePairedSpawnBackendType } from './persistent-backend.js';
import type { DaemonSession } from './types.js';

/** Routing and help use the same effective backend and provider policy. A live
 * worker keeps its startup configuration; changes apply at its next spawn. */
export function sessionDelegatedSlashCommands(
  bot: Pick<BotConfig, 'cliId' | 'backendType' | 'remoteRunner'> | undefined,
  ds: Pick<DaemonSession, 'session' | 'initConfig' | 'worker'> | undefined,
  defaultBackend: BackendType,
): ReadonlySet<string> {
  const cliId = ds?.session.cliLaunchSnapshot?.cliId ?? ds?.session.cliId ?? bot?.cliId;
  if (!cliId) return new Set();
  const backend = ds?.initConfig?.backendType ?? resolvePairedSpawnBackendType(
    cliId, ds?.session.backendType, bot?.backendType, defaultBackend,
  );
  const runner = ds?.worker && !ds.worker.killed && ds.initConfig?.backendType === 'remote-runner'
    ? ds.initConfig.backendConfig as RemoteRunnerConfig | undefined
    : bot?.remoteRunner;
  return resolveDelegatedSlashCommands(runner, backend);
}

/** Grant restrictions and bot gating precede this seam at both slash entries.
 * Only an admitted command produces a payload; the ordinary turn pipeline owns
 * quotas, FIFO, persistence, and LinkRefs after this point. */
export async function admitDelegatedSlashTurn(
  decision: Extract<SlashRouteDecision, { kind: 'delegated_turn' }>,
  context: {
    authorized: boolean;
    primary: boolean;
    caller?: TrustedCaller;
    larkAppId: string;
    reply: (text: string) => Promise<unknown>;
  },
): Promise<AcceptedCommandInput | undefined> {
  const locale = localeForBot(context.larkAppId);
  const denial = !context.authorized
    ? t('daemon.cmd_allowed_users_only', { cmd: decision.cmd }, locale)
    : context.primary && decision.cmd !== '/adopt'
      ? t('cmd.detach.primary_unsupported', undefined, locale)
      : decision.sessionPolicy === 'unbound'
        ? t('cmd.remote_runner.no_binding', undefined, locale)
        : undefined;
  if (denial) {
    await context.reply(denial);
    return undefined;
  }
  return { content: decision.content, ...(context.caller ? { trustedCaller: context.caller } : {}) };
}

/** An accepted structured turn cannot be folded into a parked task. Retain the
 * task as the opening and admit the current payload as its exact FIFO successor. */
export function queuedOpeningHasTail(
  session: Pick<Session, 'queued' | 'queuedPrompt' | 'queuedActivationTail'>,
  acceptedInput?: AcceptedCommandInput,
): boolean {
  return !!(session.queued && session.queuedPrompt
    && ((session.queuedActivationTail?.length ?? 0) > 0 || acceptedInput));
}
