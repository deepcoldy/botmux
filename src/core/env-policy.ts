import { sanitizePerBotEnv, isReservedPerBotEnvKey } from './per-bot-env.js';
import { BOTMUX_INJECTED_ENV_KEYS, WORKFLOW_WORKER_ENV_KEYS, redactChildEnv } from '../utils/child-env.js';

/** Secret-free per-bot inheritance policy. Missing means historical inheritance. */
export interface EnvPolicy {
  mode: 'inherit' | 'strict';
  inherit?: string[];
}

// No auth, proxy, CA, loader or shell-profile variables are implicit. Operators
// may authorize those individually via inherit, or configure this bot's env.
export const STRICT_ENV_BASELINE = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'TERM', 'COLORTERM', 'TERMINFO_DIRS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE',
] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROCESS_HOME_KEYS = new Set(['GROK_HOME', 'DSH_HOME', 'LARKSUITE_CLI_DATA_DIR']);

export function normalizeEnvPolicy(raw: unknown): EnvPolicy | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('envPolicy must be an object');
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some(k => k !== 'mode' && k !== 'inherit')) throw new Error('envPolicy has unknown fields');
  if (obj.mode !== 'inherit' && obj.mode !== 'strict') throw new Error('envPolicy.mode must be inherit or strict');
  if (obj.inherit !== undefined && (!Array.isArray(obj.inherit) || obj.inherit.some(k =>
    typeof k !== 'string' || !ENV_NAME.test(k) || (isReservedPerBotEnvKey(k) && !PROCESS_HOME_KEYS.has(k))
    || ['GITHUB_TOKEN', 'GH_TOKEN'].includes(k)))) {
    // Never interpolate invalid input: it may accidentally contain a secret.
    throw new Error('envPolicy.inherit must contain permitted environment variable names');
  }
  if (obj.mode === 'inherit' && (obj.inherit as unknown[] | undefined)?.length) throw new Error('envPolicy.inherit requires strict mode');
  const inherit = [...new Set(obj.inherit as string[] | undefined)].sort();
  return { mode: obj.mode, ...(inherit.length ? { inherit } : {}) };
}

/** Inherited user environment, before config env and trusted session injection. */
export function inheritBotEnv(base: NodeJS.ProcessEnv, policy?: EnvPolicy): NodeJS.ProcessEnv {
  const normalized = normalizeEnvPolicy(policy);
  if (normalized?.mode !== 'strict') return { ...base };
  const out: NodeJS.ProcessEnv = {};
  // Revalidate at IPC boundaries: malformed strict config must never widen it.
  for (const key of [...STRICT_ENV_BASELINE, ...(normalized.inherit ?? [])]) {
    if (base[key] !== undefined) out[key] = base[key];
  }
  return out;
}

/** CLI boundary. Keep only the fixed host-owned session/workflow contract. */
export function buildSessionChildEnv(base: NodeJS.ProcessEnv, policy?: EnvPolicy): NodeJS.ProcessEnv {
  const inherited = inheritBotEnv(base, policy);
  if (policy?.mode === 'strict') {
    for (const key of [...BOTMUX_INJECTED_ENV_KEYS, ...WORKFLOW_WORKER_ENV_KEYS]) {
      // Non-reserved adapter/pane keys may be arbitrary user exports.
      // Trusted wrappers inject their values later, after this boundary.
      if (!isReservedPerBotEnvKey(key)) continue;
      if (base[key] !== undefined) inherited[key] = base[key];
    }
  }
  return redactChildEnv(inherited);
}

/** Worker control process retains Botmux control knobs, never business env. */
export function buildBotWorkerEnv(base: NodeJS.ProcessEnv, policy?: EnvPolicy): NodeJS.ProcessEnv {
  const env = inheritBotEnv(base, policy);
  if (policy?.mode === 'strict') {
    for (const key of [...BOTMUX_INJECTED_ENV_KEYS, ...WORKFLOW_WORKER_ENV_KEYS,
      'BOTMUX_SANDBOX', 'BOTMUX_CORE_ONLY', 'BOTMUX_HOME', 'BOTMUX_CONFIG_DIR',
      'BOTMUX_DATA_DIR', 'BOTMUX_NO_CLAIM', 'BOTMUX_BOT_INDEX',
      'BOTMUX_WORKFLOW_ENABLED', 'BOTMUX_REQUIRE_MENTION_DECISION', 'BOTMUX_LANG',
      'BOTMUX_WORKER_HTTP_HOST', 'BOTMUX_WORKER_HOST', 'LARK_APP_ID', 'LARK_APP_SECRET',
    ]) {
      if (isReservedPerBotEnvKey(key) && base[key] !== undefined) env[key] = base[key];
    }
  }
  if (policy?.mode === 'strict') {
    // Host-owned worker HTTP/watchdog settings are control-plane only. The
    // CLI boundary does not retain them without an explicit user grant.
    for (const key of ['WEB_HOST', 'WEB_EXTERNAL_HOST', 'WEB_EXTERNAL_PORT',
      'STUCK_DETECTOR_ENABLED', 'STUCK_DETECTOR_TIMEOUT_MS']) {
      if (base[key] !== undefined) env[key] = base[key];
    }
  }
  return env;
}

/** Explicit values still obey the mandatory CLI secret/session scrub. */
export function botInjectedEnv(raw: unknown, policy?: EnvPolicy): Record<string, string> {
  const env = sanitizePerBotEnv(raw);
  return (policy?.mode === 'strict' ? redactChildEnv(env) : env) as Record<string, string>;
}
