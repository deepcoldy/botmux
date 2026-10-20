import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { botmuxHome } from './paths.js';
import { assertValidPluginId } from './ids.js';
import type { FleetBotSpec } from '../fleet-supervisor.js';
import { parseFleetState } from '../fleet-state-store.js';
import { assertProjectionIdentity } from '../fleet-supervisor-policy.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';

/** Plugin services have their own instance of the shared fleet supervisor so
 * ordinary bot restarts and --with-plugin retain their existing semantics. */
export const pluginSupervisorDir = () => join(botmuxHome(), 'plugin-supervisor');
export const pluginSupervisorStatePath = () => join(pluginSupervisorDir(), 'state.json');
export const pluginSupervisorDesiredPath = () => join(pluginSupervisorDir(), 'desired.json');
export const pluginSupervisorResultPath = () => join(pluginSupervisorDir(), 'result.json');
export const pluginServiceName = (id: string) => `botmux-plugin-${assertValidPluginId(id)}`;

/** Bun reads BUN_BE_BUN before loading the entry. Remove that bootstrap-only
 * switch before plugin code runs, or nested botmux commands enter Bun's CLI.
 * A preload preserves the script's normal argv and require.main semantics. */
export function ensurePluginServicePreload(): string {
  const path = join(pluginSupervisorDir(), 'service-preload.cjs');
  mkdirSync(pluginSupervisorDir(), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, 'delete process.env.BUN_BE_BUN;\n', { mode: 0o600, followTargetSymlink: false });
  return path;
}

/** The general fleet reader tolerates partial historical records. Lifecycle
 * guards need stricter evidence: dropping a malformed row could hide a child. */
export function readPluginSupervisorState() {
  const file = pluginSupervisorStatePath();
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const state = parseFleetState(raw);
  if (!state || !Array.isArray(raw.procs) || raw.procs.length !== state.procs.length
    || raw.procs.some((p: any) => !p || !Number.isSafeInteger(p.pid) || p.pid < 0
      || !['online', 'launching', 'stopped', 'errored'].includes(p.status))) {
    throw new Error('plugin_supervisor_invalid_process_state');
  }
  assertProjectionIdentity(state.procs);
  return state;
}

export interface PluginServiceSpec extends FleetBotSpec {
  external: NonNullable<FleetBotSpec['external']>;
  watch?: { path: string; delayMs: number };
}

export interface PluginSupervisorDesired {
  revision: string;
  target: string;
  services: Record<string, { spec: PluginServiceSpec; running: boolean }>;
}

export interface PluginSupervisorResult {
  revision: string;
  pid: number;
  processStart?: string;
  error?: string;
}

/** Corrupt state is uncertainty, never evidence that a service is stopped. */
export function readPluginSupervisorDesired(): PluginSupervisorDesired {
  const file = pluginSupervisorDesiredPath();
  if (!existsSync(file)) return { revision: '', target: '', services: {} };
  const value = JSON.parse(readFileSync(file, 'utf8')) as PluginSupervisorDesired;
  if (!value || typeof value.revision !== 'string' || typeof value.target !== 'string'
    || !value.services || typeof value.services !== 'object' || Array.isArray(value.services)) {
    throw new Error('plugin_supervisor_invalid_desired_state');
  }
  if (value.target) assertValidPluginId(value.target);
  for (const [id, item] of Object.entries(value.services)) {
    if (item?.spec?.name !== pluginServiceName(id) || !item.spec.external
      || typeof item.running !== 'boolean' || typeof item.spec.external.command !== 'string') {
      throw new Error(`plugin_supervisor_invalid_spec:${id}`);
    }
  }
  return value;
}

export function readPluginSupervisorResult(): PluginSupervisorResult | undefined {
  const file = pluginSupervisorResultPath();
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, 'utf8')) as PluginSupervisorResult;
  if (!value || typeof value.revision !== 'string' || !Number.isSafeInteger(value.pid) || value.pid <= 1
    || (value.processStart !== undefined && typeof value.processStart !== 'string')
    || (value.error !== undefined && typeof value.error !== 'string')) {
    throw new Error('plugin_supervisor_invalid_result');
  }
  return value;
}
