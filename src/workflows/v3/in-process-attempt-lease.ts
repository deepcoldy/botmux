import type {
  AttemptLeaseAcquisition,
  AttemptLeaseProvider,
} from './runtime-host-contract.js';

/**
 * Lease provider for fresh, process-local executions.
 *
 * It can prove only closures observed by this exact provider instance. An
 * attempt absent from the local ledger may belong to another live process, so
 * restart recovery stays fail-closed instead of inventing a close proof.
 */
export function createInProcessAttemptLeaseProvider(): AttemptLeaseProvider {
  const leases = new Map<string, 'active' | 'closed'>();
  const keyFor = (binding: {
    runId: string;
    attemptId: string;
    attemptDir: string;
  }): string => `${binding.runId}\0${binding.attemptId}\0${binding.attemptDir}`;

  return {
    acquire: (binding): AttemptLeaseAcquisition => {
      const key = keyFor(binding);
      if (leases.has(key)) {
        throw new Error(`in-process attempt lease already acquired: ${binding.attemptId}`);
      }
      leases.set(key, 'active');
      return { auditKind: 'attemptLease' };
    },
    closeBeforeExecution: (binding) => {
      const key = keyFor(binding);
      if (leases.get(key) !== 'active') {
        throw new Error(`in-process attempt lease is not active: ${binding.attemptId}`);
      }
      leases.set(key, 'closed');
    },
    drainExternallyOwned: (binding) => {
      const key = keyFor(binding);
      const state = leases.get(key);
      if (state === 'active') return { status: 'pending' };
      if (state !== 'closed') return { status: 'unknown' };
      return {
        status: 'closed',
        finalizeAfterProof: () => {
          if (leases.get(key) === 'closed') leases.delete(key);
        },
      };
    },
    cleanupSettled: (binding) => {
      leases.delete(keyFor(binding));
    },
  };
}
