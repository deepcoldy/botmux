import {
  LINK_REF_ENV_MODE,
  type LinkRefConfig,
  type LinkRefMode,
} from './link-ref-types.js';

function isLinkRefMode(value: unknown): value is LinkRefMode {
  return value === 'disabled' || value === 'observe' || value === 'enabled';
}

export function normalizeLinkRefConfig(raw: unknown): LinkRefConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const mode = (raw as Record<string, unknown>).mode;
  return isLinkRefMode(mode) ? { mode } : undefined;
}

export function resolveEffectiveLinkRefMode(input: {
  env: NodeJS.ProcessEnv;
  bot?: LinkRefConfig;
  global?: LinkRefConfig;
}): LinkRefMode {
  const envMode = input.env[LINK_REF_ENV_MODE];
  if (isLinkRefMode(envMode)) return envMode;
  return input.bot?.mode ?? input.global?.mode ?? 'disabled';
}
