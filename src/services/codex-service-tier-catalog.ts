import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { parseDebugModelCapabilitiesJson, type DebugModelCapabilities } from '../adapters/cli/model-catalog-json.js';
import type { CodexServiceTier } from './codex-service-tier.js';

export type CodexServiceTierCheck =
  | { ok: true }
  | { ok: false; error: 'model_required' | 'catalog_unavailable' | 'not_supported_by_model' };

export const CODEX_SERVICE_TIER_CATALOG_TTL_MS = 10 * 60 * 1000;

const catalogCache = new Map<string, { at: number; catalog: readonly DebugModelCapabilities[] }>();
// These per-session routing values cannot select a model provider. Keep other
// environment differences in the cache key so custom runtimes fail closed
// instead of sharing a capability result across contexts.
const CACHE_IRRELEVANT_ENV = new Set([
  'BOTMUX_SESSION_ID',
  'BOTMUX_CHAT_ID',
  'BOTMUX_CHAT_TYPE',
  'BOTMUX_LARK_APP_ID',
  'BOTMUX_ROOT_MESSAGE_ID',
  'BOTMUX_SESSION_SCOPE',
  '__OWNER_OPEN_ID',
  'SESSION_DATA_DIR',
]);

function executableIdentity(cliBin: string): string {
  try {
    const canonicalPath = realpathSync(cliBin);
    const stat = statSync(canonicalPath);
    return `${canonicalPath}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    // Preserve fail-soft behavior for mocked or temporarily unavailable paths;
    // execFile below remains the authority on whether the probe can run.
    return cliBin;
  }
}

function cacheKey(cliBin: string, env: NodeJS.ProcessEnv): string {
  const stableEnv = Object.keys(env)
    .filter(key => !CACHE_IRRELEVANT_ENV.has(key))
    .sort()
    .map(key => `${key}=${env[key] ?? ''}`)
    .join('\n');
  return `${executableIdentity(cliBin)}\0${stableEnv}`;
}

export function clearCodexServiceTierCatalogCache(): void {
  catalogCache.clear();
}

export async function loadCodexServiceTierCatalog(
  input: { cliBin: string; env?: NodeJS.ProcessEnv },
): Promise<readonly DebugModelCapabilities[] | null> {
  const env = input.env ?? process.env;
  const key = cacheKey(input.cliBin, env);
  const cached = catalogCache.get(key);
  if (cached && Date.now() - cached.at < CODEX_SERVICE_TIER_CATALOG_TTL_MS) return cached.catalog;
  catalogCache.delete(key);
  try {
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(input.cliBin, ['debug', 'models'], {
      env,
      timeout: 8_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const catalog = parseDebugModelCapabilitiesJson(stdout);
    if (catalog.length === 0) return null;
    catalogCache.set(key, { at: Date.now(), catalog });
    return catalog;
  } catch {
    return null;
  }
}

export function checkCodexServiceTierSupport(
  catalog: readonly DebugModelCapabilities[] | null,
  model: string | undefined,
  serviceTier: CodexServiceTier,
): CodexServiceTierCheck {
  if (serviceTier === 'default') return { ok: true };
  const modelName = model?.trim().toLowerCase();
  if (!modelName) return { ok: false, error: 'model_required' };
  if (!catalog) return { ok: false, error: 'catalog_unavailable' };
  return catalog.some(item => item.slug.toLowerCase() === modelName && item.serviceTiers.includes(serviceTier))
    ? { ok: true }
    : { ok: false, error: 'not_supported_by_model' };
}

export async function validateCodexServiceTier(input: {
  cliBin: string;
  env?: NodeJS.ProcessEnv;
  model?: string;
  serviceTier?: CodexServiceTier;
}): Promise<CodexServiceTierCheck> {
  if (!input.serviceTier || input.serviceTier === 'default') return { ok: true };
  const catalog = await loadCodexServiceTierCatalog(input);
  return checkCodexServiceTierSupport(catalog, input.model, input.serviceTier);
}
