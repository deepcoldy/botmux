import { botInjectedEnv } from '../../core/env-policy.js';
import { applySessionEnvUnset } from '../../core/session-env.js';
import { GIT_CONFIG_PAIR_ENV_KEY } from '../../utils/child-env.js';
import type { SpawnOpts } from './types.js';

/** Direct exec argv: no pane shell, profile exports or shared server globals.
 * opts.env has already passed the worker's inheritance boundary and received
 * trusted session identity. Config env cannot override that identity. */
export function strictPaneEnvArgs(opts: SpawnOpts): string[] {
  const base: NodeJS.ProcessEnv = { ...opts.env };
  applySessionEnvUnset(base, opts.unsetEnv);
  const injected = botInjectedEnv(opts.injectEnv, { mode: 'strict' });
  const env = { ...base };
  // The git command-line config channel is owned by the worker's
  // turn-authored block already present in opts.env; per-bot `env` cannot add
  // GIT_CONFIG_COUNT or numbered pairs here either.
  for (const [key, value] of Object.entries(injected)) {
    if (key === 'GIT_CONFIG_COUNT' || GIT_CONFIG_PAIR_ENV_KEY.test(key)) continue;
    env[key] = value;
  }
  // env -i removes the terminal default supplied by the pane server. v3
  // workers may have no ambient TERM; use the same type as our PTY clients.
  env.TERM ??= 'xterm-256color';
  if (env.BOTMUX_CODEX_INSTANCE_BINDING) {
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  }
  if (Object.values(env).some(value => value?.includes('\0'))) throw new Error('Strict environment contains an invalid value');
  return ['-i', ...Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)];
}

export function strictPaneCommand(bin: string, args: string[], opts: SpawnOpts): string[] {
  return ['/usr/bin/env', ...strictPaneEnvArgs(opts), bin, ...args];
}
