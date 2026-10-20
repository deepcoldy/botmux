import { AsyncLocalStorage } from 'node:async_hooks';
import type { DurableConfigCoordinator, DurableConfigScope } from './durable-config-coordinator.js';

let coordinator: DurableConfigCoordinator | undefined;
const activeScope = new AsyncLocalStorage<DurableConfigScope>();

export function setDurableConfigCoordinator(next: DurableConfigCoordinator | undefined): void {
  coordinator = next;
}

export async function runDurableConfigMutation<T>(input: {
  scope: DurableConfigScope;
  path: string;
  mutation: () => Promise<T>;
}): Promise<T> {
  if (!coordinator) {
    if (process.env.BOTMUX_COORDINATION_MODE?.trim() === 'primary') {
      throw new Error('durable_config_coordinator_unavailable');
    }
    return input.mutation();
  }
  return activeScope.run(input.scope, () => coordinator!.run(input));
}

export function assertDurableConfigMutationAllowed(scope: DurableConfigScope): void {
  if (process.env.BOTMUX_COORDINATION_MODE?.trim() === 'primary'
      && activeScope.getStore() !== scope) {
    throw new Error('durable_config_coordinator_required');
  }
}
