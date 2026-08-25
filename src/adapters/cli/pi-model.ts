import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PiModelLookup = {
  homeDir?: string;
  settingsPath?: string;
};

/** Pi accepts `--model provider/id`. A slash already pins the provider. */
export function isPiQualifiedModel(model: string): boolean {
  return model.includes('/');
}

export function piSettingsPath(homeDir: string = homedir()): string {
  const overlay = process.env.PI_CODING_AGENT_DIR?.trim();
  if (overlay) return join(overlay, 'settings.json');
  return join(homeDir, '.pi', 'agent', 'settings.json');
}

export function readPiDefaultProvider(lookup: PiModelLookup | string = {}): string | undefined {
  const path = typeof lookup === 'string'
    ? piSettingsPath(lookup)
    : (lookup.settingsPath ?? piSettingsPath(lookup.homeDir));
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { defaultProvider?: unknown };
    return typeof raw.defaultProvider === 'string' && raw.defaultProvider.trim()
      ? raw.defaultProvider.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Qualify a BotConfig.model so Pi does not treat a shared slug as ambiguous.
 *
 * Bare `grok-4.6` collides across github-copilot / opencode / xai / tako-*
 * even when settings.defaultProvider is set — `--model` bypasses that default.
 */
export function resolvePiModelFlag(
  model: string | undefined,
  lookup: PiModelLookup | string = {},
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (isPiQualifiedModel(trimmed)) return trimmed;
  const provider = readPiDefaultProvider(lookup);
  return provider ? `${provider}/${trimmed}` : trimmed;
}
