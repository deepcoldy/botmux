import type { BotConfig } from '../bot-registry.js';
import { isKnownSelectionKey } from '../services/model-catalog.js';
import { resolveCliSelection } from '../setup/cli-selection.js';
import { checkCliAvailabilityAsync, type CliAvailabilityProbe } from '../setup/cli-availability.js';
import { modelCatalogProbeContext } from './model-catalog-request.js';

/** Short-lived probe cache also coalesces concurrent mounts/tabs. The semaphore
 * covers the complete probe, including Forge doctor; outstanding work is bounded. */
export function createCliAvailabilityCache(options: { ttlMs?: number; concurrency?: number; now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { expires: number; pending: Promise<CliAvailabilityProbe> }>();
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (key: string, probe: () => Promise<CliAvailabilityProbe>): Promise<CliAvailabilityProbe> => {
    const prior = entries.get(key);
    if (prior && prior.expires > now()) return prior.pending;
    if (waiting.length >= 64) return { available: false, localExecutableRequired: true, status: 'unknown' };
    const pending = (async () => {
      if (running >= (options.concurrency ?? 4)) {
        const admitted = await new Promise<boolean>(resolve => {
          const wake = () => { clearTimeout(timer); resolve(true); };
          const timer = setTimeout(() => {
            const index = waiting.indexOf(wake);
            if (index >= 0) waiting.splice(index, 1);
            resolve(false);
          }, 15_000);
          waiting.push(wake);
        });
        if (!admitted) return { available: false, localExecutableRequired: true, status: 'unknown' as const };
      } else running++;
      try { return await probe(); }
      finally {
        const next = waiting.shift();
        if (next) next(); else running--;
      }
    })();
    const entry = { expires: Infinity, pending };
    entries.set(key, entry);
    while (entries.size > 128) entries.delete(entries.keys().next().value!);
    try {
      const result = await pending;
      entry.expires = now() + (options.ttlMs ?? 15_000);
      return result;
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  };
}

const cachedProbe = createCliAvailabilityCache();

export async function cliAvailabilityResponse(
  key: string, botConfig: BotConfig | undefined, baseEnv: NodeJS.ProcessEnv,
  probe = checkCliAvailabilityAsync,
  cache = cachedProbe,
): Promise<{ statusCode: number; body: { ok?: false; error?: string; status?: CliAvailabilityProbe['status']; command?: string } }> {
  if (!isKnownSelectionKey(key)) return { statusCode: 400, body: { ok: false, error: 'unknown_selection_key' } };
  const selection = resolveCliSelection(key);
  const context = modelCatalogProbeContext(key, botConfig, baseEnv);
  const cacheKey = JSON.stringify([key, botConfig?.larkAppId, context.runtimeExecutable, context.fingerprint]);
  const availability = await cache(cacheKey, () => probe({ ...selection, cliPathOverride: context.runtimeExecutable }, {
    env: context.probeEnv ?? baseEnv, timeoutMs: 1_000, shellFallback: true,
  }));
  // command is an operator-facing configured command and may be a private path.
  // Never expose resolvedPath or environment values in this endpoint.
  return { statusCode: 200, body: { status: availability.status, command: availability.command } };
}
