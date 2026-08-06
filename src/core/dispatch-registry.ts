import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLock } from '../utils/file-lock.js';

export type DispatchRegistry = Record<string, unknown>;

export interface FederationDispatchRoute {
  teamId: string;
  originDeploymentId: string;
}

function readDispatchRegistry(path: string): DispatchRegistry {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('orchestrate-dispatch.json must contain an object');
  }
  return parsed as DispatchRegistry;
}

/**
 * Serialize a dispatch-registry read-modify-write across CLI processes.
 *
 * Atomic rename alone only prevents torn JSON; without the surrounding lock,
 * two dispatch commands can both read the same snapshot and the last rename
 * silently drops the other command's seed. Keep the mutation inside the lock
 * so report-back retains every concurrently-created thread.
 */
export async function updateDispatchRegistry(
  path: string,
  mutate: (registry: DispatchRegistry) => void | Promise<void>,
): Promise<void> {
  await withFileLock(path, async () => {
    const registry = readDispatchRegistry(path);
    await mutate(registry);
    atomicWriteFileSync(path, JSON.stringify(registry, null, 2));
  });
}

export async function recordDispatchRegistryEntry(
  path: string,
  seedId: string,
  entry: unknown,
): Promise<void> {
  await updateDispatchRegistry(path, registry => {
    registry[seedId] = entry;
  });
}

export function readDispatchRegistryEntry(path: string, key: string): unknown {
  return readDispatchRegistry(path)[key];
}

function federationRouteKey(teamId: string, dispatchRoot: string): string {
  return `federation:${encodeURIComponent(teamId)}:${dispatchRoot}`;
}

export function findFederationDispatchRoute(
  path: string,
  teamId: string,
  dispatchRoot: string,
): FederationDispatchRoute | undefined {
  const value = readDispatchRegistry(path)[federationRouteKey(teamId, dispatchRoot)];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const route = value as Record<string, unknown>;
  if (route.teamId !== teamId || typeof route.originDeploymentId !== 'string' || !route.originDeploymentId) return undefined;
  return { teamId, originDeploymentId: route.originDeploymentId };
}

export async function recordFederationDispatchRoute(
  path: string,
  teamId: string,
  dispatchRoot: string,
  originDeploymentId: string,
): Promise<void> {
  await updateDispatchRegistry(path, registry => {
    const key = federationRouteKey(teamId, dispatchRoot);
    const existing = registry[key] as Partial<FederationDispatchRoute> | undefined;
    if (existing?.originDeploymentId && existing.originDeploymentId !== originDeploymentId) {
      throw new Error('dispatch_route_conflict');
    }
    registry[key] = { teamId, originDeploymentId } satisfies FederationDispatchRoute;
  });
}
