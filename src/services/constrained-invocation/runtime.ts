import type { InvocationResult } from './contract.js';
import { applySessionOwnerEnv } from '../../utils/child-env.js';

/** Provider-neutral result contract for CLI-backed model-only inference. */
export type NativeInvocationOutput = Pick<InvocationResult, 'output' | 'configuredModel' | 'actualModel' | 'reasoningEffort' | 'usage' | 'usageSource' | 'startupMs'>;

export interface ModelOnlyRuntime {
  executable: string;
  authHome: string;
  ownerOpenId?: string;
  env?: NodeJS.ProcessEnv;
}

export class NativeInvocationError extends Error {
  constructor(message: string, readonly telemetry: NativeInvocationOutput) { super(message); }
}

export function isolatedModelEnv(home: string, source: NodeJS.ProcessEnv, owner?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy']) {
    if (source[key]) env[key] = source[key];
  }
  env.HOME = home;
  applySessionOwnerEnv(env, owner);
  return env;
}
