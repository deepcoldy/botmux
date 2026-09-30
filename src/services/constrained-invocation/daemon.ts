import { dirname, join } from 'node:path';
import { getBot } from '../../bot-registry.js';
import { config } from '../../config.js';
import { botHomePath } from '../../adapters/cli/read-isolation.js';
import { InvocationService } from './service.js';
import { rawCliExecutable } from '../../adapters/cli/registry.js';
import { modelOnlyAdapter, modelOnlyAdapterCapabilities, modelOnlyCapabilities } from './adapters.js';
import { modelOnlyAssessments } from './support-status.js';

const services = new Map<string, InvocationService>();

/** First release requires a dedicated core-only bot with its own native login.
 * No implicit fallback to host/global or another bot's subscription. */
export function invocationCapabilityForBot(botId: string): Record<string, unknown> {
  const bot = getBot(botId).config;
  const adapter = modelOnlyAdapter(bot.cliId);
  const supported = !!adapter && bot.apiOnly === true && adapter.acceptsIdentity(bot)
    && !bot.wrapperCli && !bot.cliRuntime && !bot.codexInstancePool && !bot.existingAppServer
    && !bot.triggerUserAuth?.enabled && !bot.sandbox && !bot.readIsolation && process.env.BOTMUX_SANDBOX !== '1'
    && !bot.backendType && !bot.maxLiveWorkers && !(bot.startupCommands?.length)
    && Object.keys(bot.env ?? {}).length === 0;
  return { ...modelOnlyCapabilities, cli: bot.cliId, modelPolicy: adapter?.modelPolicy ?? null,
    supported, maxOutputTokens: bot.cliId === 'claude-code', runtimeVerified: false,
    reason: supported ? null : adapter ? 'requires_dedicated_core_only_isolated_auth' : modelOnlyAssessments[bot.cliId].reason,
    adapters: modelOnlyAdapterCapabilities(),
  };
}
export function invocationServiceForBot(botId: string, forStart = false): InvocationService {
  if (forStart && invocationCapabilityForBot(botId).supported !== true) throw new Error('constrained_capability_unsupported');
  let service = services.get(botId);
  if (!service) {
    service = new InvocationService({
      directory: join(config.session.dataDir, 'constrained-invocations', botId),
      run: (request, signal) => {
        if (invocationCapabilityForBot(botId).supported !== true) throw new Error('constrained_capability_unsupported');
        const bot = getBot(botId).config;
        const adapter = modelOnlyAdapter(bot.cliId)!;
        if (request.maxOutputTokens !== undefined && bot.cliId !== 'claude-code') throw new Error('max_output_tokens_unsupported');
        const executable = rawCliExecutable(bot.cliId, bot.cliPathOverride);
        if (!executable) throw new Error('constrained_capability_unsupported');
        return adapter.run(request, {
          executable, authHome: join(botHomePath(dirname(config.session.dataDir), botId), adapter.authSubdir),
          // Core-only host admission has no IM owner. applySessionOwnerEnv clears
          // both inherited owner channels; the request cannot supply either.
          ownerOpenId: undefined,
        }, signal);
      },
    });
    services.set(botId, service);
  }
  return service;
}
export async function closeConstrainedInvocations(): Promise<void> {
  await Promise.allSettled([...services.values()].map(service => service.close()));
  services.clear();
}
