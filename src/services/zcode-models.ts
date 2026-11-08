import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ZcodePersonalProvider {
  providerId: string;
  providerName?: string;
  config?: { personalModelIds?: string[]; api?: { baseUrl?: string } };
}

/** ZCODE_DATA_BASE_DIR is the parent of .zcode, as in the native CLI. */
export function zcodePersonalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
    || join(env.ZCODE_DATA_BASE_DIR?.trim() || homedir(), '.zcode', 'v2', 'provider_config.json');
}

export function readZcodeProviders(env: NodeJS.ProcessEnv = process.env): ZcodePersonalProvider[] {
  const value = JSON.parse(readFileSync(resolve(zcodePersonalConfigPath(env)), 'utf8'));
  const rules = value?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) throw new Error('ZCode personal provider list is unavailable');
  return rules.filter((r: ZcodePersonalProvider) => typeof r?.providerId === 'string' && r.providerId);
}

/** Values carry stable provider ids, while the card may display friendly names. */
export function readZcodeModelChoices(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const out: string[] = [];
  for (const provider of readZcodeProviders(env)) {
    for (const modelId of provider.config?.personalModelIds ?? []) {
      if (typeof modelId === 'string' && modelId.trim()) out.push(`${provider.providerId}/${modelId.trim()}`);
    }
  }
  return [...new Set(out)];
}

/** Gateway host of a provider's endpoint, for disambiguating labels. */
export function zcodeProviderHost(provider: ZcodePersonalProvider): string {
  const baseUrl = provider.config?.api?.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl) return '';
  try { return new URL(baseUrl).host; } catch { return ''; }
}

/** Model ids served by more than one provider — the case where a bare
 *  `provider/model` label cannot be told apart (the same model name behind two
 *  gateways). Computed from the choices themselves, so a unique model keeps the
 *  short label. */
export function zcodeAmbiguousModelIds(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const seen = new Map<string, number>();
  try {
    for (const provider of readZcodeProviders(env)) {
      for (const modelId of provider.config?.personalModelIds ?? []) {
        if (typeof modelId === 'string' && modelId) seen.set(modelId, (seen.get(modelId) ?? 0) + 1);
      }
    }
  } catch { return new Set(); }
  return new Set([...seen].filter(([, count]) => count > 1).map(([modelId]) => modelId));
}

/** Human label for the model dropdown. A model served by several gateways also
 *  carries its host, because `providerA/glm-5.3-flash` and `providerB/glm-5.3-flash`
 *  look identical otherwise and the user cannot tell which one they picked. */
export function formatZcodeModelChoice(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  ambiguous?: ReadonlySet<string>,
): string {
  try {
    const provider = readZcodeProviders(env).find(p => value.startsWith(`${p.providerId}/`));
    if (provider?.providerName) {
      const modelId = value.slice(provider.providerId.length + 1);
      const host = ambiguous?.has(modelId) ? zcodeProviderHost(provider) : '';
      return `${provider.providerName}${host ? `(${host})` : ''}/${modelId}`;
    }
  } catch { /* Rendering is best-effort; launch validation must fail explicitly. */ }
  return value;
}

/** Accept legacy display-name selections only when unambiguous. */
export function resolveZcodeModelReference(value: string, env: NodeJS.ProcessEnv = process.env): {
  providerId: string; modelId: string;
} {
  const providers = readZcodeProviders(env);
  const exact = providers.filter(p => value.startsWith(`${p.providerId}/`));
  if (exact.length === 1) return { providerId: exact[0].providerId, modelId: value.slice(exact[0].providerId.length + 1) };
  const named = providers.flatMap(p => {
    const prefix = p.providerName ? `${p.providerName}/` : '';
    if (prefix && value.startsWith(prefix)) return [{ providerId: p.providerId, modelId: value.slice(prefix.length) }];
    if (p.config?.personalModelIds?.includes(value)) return [{ providerId: p.providerId, modelId: value }];
    return [];
  });
  if (named.length !== 1) throw new Error('ZCode model selection is missing or ambiguous; select its provider/model again');
  return named[0];
}
