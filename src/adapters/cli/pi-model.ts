import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PiModelLookup = {
  homeDir?: string;
  /** Pin the settings file directly; wins over homeDir / env overlays. */
  settingsPath?: string;
  /**
   * The resolved child-process environment pi will actually be spawned with.
   * Defaults to process.env; the worker passes per-bot injected env merged on
   * the daemon env, since PI_CODING_AGENT_DIR / HOME can be bot-scoped (per-bot
   * config env, per-sender identity isolation, CLI data-dir redirects).
   */
  env?: NodeJS.ProcessEnv;
};

/** Pi accepts `--model provider/id`. A slash already pins the provider. */
export function isPiQualifiedModel(model: string): boolean {
  return model.includes('/');
}

function lookupEnv(lookup: PiModelLookup | string): NodeJS.ProcessEnv {
  return typeof lookup === 'string' || !lookup.env ? process.env : lookup.env;
}

export function piSettingsPath(lookup: PiModelLookup | string = {}): string {
  if (typeof lookup === 'string') return join(lookup, '.pi', 'agent', 'settings.json');
  if (lookup.settingsPath) return lookup.settingsPath;
  const env = lookupEnv(lookup);
  // Pi derives the same variable name from its package name (PI_CODING_AGENT_DIR
  // for stock pi, TAU_CODING_AGENT_DIR for re-skinned builds).
  const overlay = env.PI_CODING_AGENT_DIR?.trim();
  if (overlay) return join(overlay, 'settings.json');
  const configuredHome = env.HOME?.trim();
  const home = lookup.homeDir ?? configuredHome ?? homedir();
  return join(home, '.pi', 'agent', 'settings.json');
}

type PiSettingsState = 'absent' | 'ok' | 'invalid';

function readPiSettings(lookup: PiModelLookup | string = {}): {
  path: string;
  state: PiSettingsState;
  provider?: string;
} {
  const path = piSettingsPath(lookup);
  if (!existsSync(path)) return { path, state: 'absent' };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { defaultProvider?: unknown };
    const provider = typeof raw.defaultProvider === 'string' && raw.defaultProvider.trim()
      ? raw.defaultProvider.trim()
      : undefined;
    return { path, state: 'ok', provider };
  } catch {
    return { path, state: 'invalid' };
  }
}

export function readPiDefaultProvider(lookup: PiModelLookup | string = {}): string | undefined {
  return readPiSettings(lookup).provider;
}

/**
 * Outcome of qualifying a BotConfig.model for pi:
 * - none: no model configured (no --model flag)
 * - qualified: already `provider/id`, passed through untouched
 * - prefixed: bare slug prefixed with settings.defaultProvider — callers
 *   should surface the rewrite so config vs. effective argv stays auditable
 * - bare: left as-is (no usable defaultProvider); pi itself exits when such an
 *   id is ambiguous across authenticated providers
 */
export type PiModelResolution =
  | { kind: 'none' }
  | { kind: 'qualified'; flag: string }
  | { kind: 'prefixed'; flag: string; provider: string; settingsPath: string }
  | {
      kind: 'bare';
      flag: string;
      settingsPath: string;
      state: Exclude<PiSettingsState, 'ok'> | 'ok-no-provider';
    };

/**
 * Qualify a BotConfig.model so Pi does not treat a shared slug as ambiguous.
 *
 * Bare `grok-4.6` collides across github-copilot / opencode / xai / tako-*
 * even when settings.defaultProvider is set — `--model` bypasses that default.
 */
export function resolvePiModel(
  model: string | undefined,
  lookup: PiModelLookup | string = {},
): PiModelResolution {
  const trimmed = model?.trim();
  if (!trimmed) return { kind: 'none' };
  if (isPiQualifiedModel(trimmed)) return { kind: 'qualified', flag: trimmed };
  const settings = readPiSettings(lookup);
  if (settings.provider) {
    return {
      kind: 'prefixed',
      flag: `${settings.provider}/${trimmed}`,
      provider: settings.provider,
      settingsPath: settings.path,
    };
  }
  return {
    kind: 'bare',
    flag: trimmed,
    settingsPath: settings.path,
    state: settings.state === 'ok' ? 'ok-no-provider' : settings.state,
  };
}
