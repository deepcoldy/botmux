import { buildEffectiveChildEnv } from '../adapters/backend/mojo-types.js';
import { applyCodexInstanceEnv, type SessionCliInstanceBindingV1 } from './codex-instance-pool.js';

/**
 * Environment for the worker's launch-time `codex debug models`, assembled the
 * way the child's own env is (session env, then bot env, then the read-isolation
 * CODEX_HOME, then the instance-pool binding), so the catalogue is read under
 * the CODEX_HOME — and therefore the config.toml / provider — the CLI starts on.
 */
export function codexLaunchCatalogEnv(input: {
  base: NodeJS.ProcessEnv;
  botEnv: NodeJS.ProcessEnv;
  isolatedCodexHome?: string;
  instanceBinding?: SessionCliInstanceBindingV1;
}): NodeJS.ProcessEnv {
  const env = buildEffectiveChildEnv({ base: input.base, botEnv: input.botEnv });
  if (input.isolatedCodexHome) env.CODEX_HOME = input.isolatedCodexHome;
  applyCodexInstanceEnv(env, input.instanceBinding);
  return env;
}
