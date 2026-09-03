import { isAbsolute, resolve } from 'node:path';

export type CodexBrowserFamily = 'chrome' | 'edge';

/**
 * Optional Codex App browser bridge. It is deliberately scoped to the Codex
 * browser plugin and disabled unless a bot opts in explicitly.
 */
export interface CodexBrowserConfig {
  enabled: true;
  family: CodexBrowserFamily;
  /**
   * Trusted operator override for a Codex Chrome plugin checkout/cache root.
   * The model never sees or controls this path. When omitted, Botmux discovers
   * the standard plugin cache below CODEX_HOME (or ~/.codex).
   */
  pluginRoot?: string;
}

function configError(label: string, message: string): Error {
  return new Error(`${label}: ${message}`);
}

export function normalizeCodexBrowserConfig(
  raw: unknown,
  label = 'codexBrowser',
): CodexBrowserConfig | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return { enabled: true, family: 'chrome' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw configError(label, 'must be true, false, or an object');
  }

  const value = raw as Record<string, unknown>;
  if (value.enabled !== true) {
    throw configError(label, 'object form requires enabled: true');
  }
  const family = value.family ?? 'chrome';
  if (family !== 'chrome' && family !== 'edge') {
    throw configError(`${label}.family`, 'must be "chrome" or "edge"');
  }

  let pluginRoot: string | undefined;
  if (value.pluginRoot !== undefined) {
    if (typeof value.pluginRoot !== 'string' || !value.pluginRoot.trim()) {
      throw configError(`${label}.pluginRoot`, 'must be a non-empty absolute path');
    }
    if (!isAbsolute(value.pluginRoot.trim())) {
      throw configError(`${label}.pluginRoot`, 'must be an absolute path');
    }
    pluginRoot = resolve(value.pluginRoot.trim());
  }

  return {
    enabled: true,
    family,
    ...(pluginRoot ? { pluginRoot } : {}),
  };
}
