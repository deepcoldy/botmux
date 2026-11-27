import { useEffect, useState } from 'react';
import type { CliAvailabilityStatus } from '../../setup/cli-availability.js';

export function cliAvailabilityRevision(bot: {
  cliId?: string | null; wrapperCli?: string | null; cliLaunchMode?: string | null; cliPathOverride?: string | null;
  cliRuntime?: { executable?: string } | null; envRevision?: string;
}): string {
  return JSON.stringify([bot.cliId ?? '', bot.wrapperCli ?? '', bot.cliLaunchMode ?? '',
    bot.cliPathOverride ?? '', bot.cliRuntime?.executable ?? '', bot.envRevision ?? '']);
}

export interface ProviderProbeTarget { provider:'wecom'; id:string }

type Option = { available?: boolean; availabilityStatus?: CliAvailabilityStatus };

export function cliAvailabilityStatus(option: Option | undefined): CliAvailabilityStatus {
  // Old servers did not distinguish a PATH miss; retain their wire contract.
  return option?.availabilityStatus ?? (option?.available === false ? 'unavailable'
    : option?.available === true ? 'available' : 'unknown');
}

export async function fetchCliAvailability(
  key: string,
  appId?: string,
  signal?: AbortSignal,
  options?: { refresh?: boolean },
  provider?:ProviderProbeTarget,
): Promise<CliAvailabilityStatus | null> {
  try {
    const query = new URLSearchParams({ key });
    if (appId) query.set('bot', appId);
    if (options?.refresh) query.set('refresh', '1');
    const response = await fetch(provider ? `/api/wecom/connections/${encodeURIComponent(provider.id)}/cli-options/availability?${query}` : `/api/cli-options/availability?${query}`, { signal });
    const body = await response.json();
    return response.ok && ['available', 'unavailable', 'unknown'].includes(body?.status) ? body.status : null;
  } catch {
    return null;
  }
}

/** Key and Bot revision also guard the render before effect cleanup runs. */
export function useCliAvailability(
  key: string,
  option: Option | undefined,
  appId?: string,
  revision?: string,
  options?: { refresh?: boolean },
  provider?:ProviderProbeTarget,
): CliAvailabilityStatus {
  const refreshOnImmediateProbe = Boolean(options?.refresh);
  const [result, setResult] = useState<{
    key: string; appId?: string; revision?: string; status: CliAvailabilityStatus | null;
  } | null>(null);
  useEffect(() => {
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const probe = (bypassCache: boolean) => {
      controller?.abort();
      if (timeout) clearTimeout(timeout);
      const current = new AbortController();
      controller = current;
      timeout = setTimeout(() => current.abort(), 45_000);
      void fetchCliAvailability(key, appId, current.signal, bypassCache ? { refresh: true } : undefined,provider).then(status => {
        if (timeout && controller === current) clearTimeout(timeout);
        if (!disposed && !current.signal.aborted) setResult({ key, appId, revision, status });
      });
    };
    probe(refreshOnImmediateProbe);
    // Global env edits do not produce a roster event. A visible form refreshes
    // the short-lived server result without discarding its previous warning.
    const refresh = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') probe(false);
    }, 30_000);
    return () => { disposed = true; clearInterval(refresh); if (timeout) clearTimeout(timeout); controller?.abort(); };
  }, [key, appId, revision, refreshOnImmediateProbe,provider?.id]);
  return result?.key === key && result.appId === appId && result.revision === revision && result.status
    ? result.status : cliAvailabilityStatus(option);
}
