import { execFile } from 'node:child_process';

export const TRAEX_QUOTA_ERROR_CODE = 'traex_usage_limit_exceeded';

/** Only a provider's structured code is authority. User-visible text, tool
 * failures, 429s and session budgets are not account/model quota exhaustion. */
export function isTraexQuotaError(error: unknown): boolean {
  let value = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return false; }
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const code = record.codex_error_info ?? record.codexErrorInfo ?? record.code;
    if (code === 'usageLimitExceeded' || code === 'usage_limit_exceeded') return true;
    if (record.error !== undefined) value = record.error;
    else if (typeof record.message === 'string') value = record.message;
    else return false;
  }
  return false;
}

export interface TraexQuotaEvidence {
  depleted: boolean;
  resetAtMs?: number;
}

/** Raw `traex debug models --remote` catalog. Do not persist the full catalog:
 * it contains model prompts and routing metadata unrelated to this feature. */
export function parseTraexModelQuotas(raw: unknown, nowMs = Date.now()): Map<string, TraexQuotaEvidence> {
  const result = new Map<string, TraexQuotaEvidence>();
  if (!raw || typeof raw !== 'object') return result;
  const models = (raw as { models?: unknown }).models;
  if (!Array.isArray(models)) return result;
  for (const entry of models) {
    if (!entry || typeof entry.slug !== 'string') continue;
    const metadata = entry.business_metadata;
    const requiredDaily = typeof metadata?.internal_daily_quota_key === 'string'
      && metadata.internal_daily_quota_key.length > 0;
    const requiredWeekly = metadata?.is_internal_usage_limit === true;
    const windows = [
      { depleted: metadata?.internal_daily_usage?.isDepleted, reset: metadata?.internal_daily_usage?.resetTime },
      { depleted: metadata?.internal_usage?.is_depleted, reset: metadata?.internal_usage?.reset_time },
    ].filter(window => typeof window.depleted === 'boolean');
    // A past window is stale evidence, not proof that the new quota is full.
    const current = windows.filter(window => !(typeof window.reset === 'number' && window.reset * 1000 <= nowMs));
    if (!current.length) continue;
    const depleted = current.filter(window => window.depleted);
    // A full weekly budget cannot prove recovery of a missing daily window.
    // Only explicit data for every advertised applicable quota may clear a block.
    if (!depleted.length && (
      (requiredDaily && typeof metadata?.internal_daily_usage?.isDepleted !== 'boolean')
      || (requiredWeekly && typeof metadata?.internal_usage?.is_depleted !== 'boolean')
      || current.length !== windows.length
    )) continue;
    const resets = depleted.map(window => typeof window.reset === 'number'
      && Number.isFinite(window.reset) && window.reset * 1000 > nowMs ? window.reset * 1000 : undefined);
    result.set(entry.slug.toLowerCase(), {
      depleted: depleted.length > 0,
      ...(resets.length && resets.every(reset => reset !== undefined)
        ? { resetAtMs: Math.max(...resets as number[]) } : {}),
    });
  }
  return result;
}

/** Read-only, bounded native request with the same environment as the worker.
 * No model inference and no shared daemon lifecycle changes. */
export function readTraexModelQuotas(input: {
  cliBin: string; cwd?: string; env?: NodeJS.ProcessEnv;
}): Promise<Map<string, TraexQuotaEvidence> | null> {
  return new Promise(resolve => {
    let settled = false;
    const child = execFile(input.cliBin, ['debug', 'models', '--remote'], {
      cwd: input.cwd, env: input.env, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) { finish(null); return; }
      try { finish(parseTraexModelQuotas(JSON.parse(stdout))); }
      catch { finish(null); }
    });
    // execFile's own timeout only sends SIGTERM and waits for the child to
    // close. An unresponsive helper must neither strand input nor leak forever.
    const timeout = setTimeout(() => {
      finish(null);
      child.kill('SIGTERM');
      const reap = setTimeout(() => child.kill('SIGKILL'), 1_000);
      reap.unref();
      child.once('exit', () => clearTimeout(reap));
    }, 8_000);
    function finish(result: Map<string, TraexQuotaEvidence> | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }
  });
}
