import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopPaths } from '../shared/types.js';
import type { FleetAppSummary } from './runtime-source.js';
import { readFleetState } from '../../core/fleet-state-store.js';
import { pidAlive } from '../../core/fleet-supervisor.js';

/**
 * List the fleet recorded by the built-in supervisor. A missing record means no
 * fleet has been started; a corrupt one rejects so runtime-service can surface a
 * degraded state instead of pretending the runtime is stopped.
 */
export async function listFleetApps(paths: DesktopPaths): Promise<FleetAppSummary[]> {
  const statePath = join(paths.botmuxHome, 'fleet-state.json');
  if (!existsSync(statePath)) return [];
  const state = readFleetState(statePath);
  if (!state) throw new Error('Invalid fleet state');
  return state.procs.map(proc => ({
    name: proc.name,
    status: pidAlive(proc.pid) ? proc.status : 'stopped',
    ...(state.supervisorEntry ? { script: state.supervisorEntry } : {}),
  }));
}
