import { readProcessStartIdentity } from '../../core/session-marker.js';
import {
  activateV3AttemptWorkerFence,
  armV3AttemptWorkerFence,
  closeV3ArmedFenceWithoutSpawn,
  discoverV3AttemptWorker,
  probeV3AttemptWorkerFence,
  readV3AttemptWorkerFence,
  recoverV3ArmedFenceWorker,
  removeV3AttemptWorkerFence,
  signalV3AttemptWorker,
  type V3ActiveAttemptWorkerFence,
  type V3ArmedAttemptWorkerFence,
  type V3AttemptWorkerFence,
} from './worker-fence.js';
import type {
  AttemptLeaseAcquisition,
  AttemptLeaseBinding,
  AttemptLeaseCloseReason,
  AttemptLeaseDrainResult,
  AttemptLeaseProvider,
} from './runtime-host-contract.js';

const MISSING_FENCE_DOUBLE_SCAN_MS = 500;
const EXTERNAL_CANCEL_KILL_GRACE_MS = 5_000;

function armedToken(acquisition: AttemptLeaseAcquisition): V3ArmedAttemptWorkerFence {
  const token = acquisition.hostToken as V3ArmedAttemptWorkerFence | undefined;
  if (!token || token.phase !== 'armed') {
    throw new Error('v3 runtime: Botmux attempt lease is not armed');
  }
  return token;
}

/**
 * Existing Botmux worker-fence semantics behind the host-neutral lease API.
 * All sidecar removal remains deferred until the runtime journals close proof.
 */
export function createBotmuxAttemptLeaseProvider(): AttemptLeaseProvider {
  const missingFenceNoneSince = new Map<string, number>();
  const externalDrainSignals = new Map<string, { sigintAt: number; sigkillAt?: number }>();

  const emptyDiscoveryIsStable = (attemptId: string): boolean => {
    const now = Date.now();
    const first = missingFenceNoneSince.get(attemptId);
    if (first === undefined) {
      missingFenceNoneSince.set(attemptId, now);
      return false;
    }
    return now - first >= MISSING_FENCE_DOUBLE_SCAN_MS;
  };

  const clearTracking = (attemptId: string): void => {
    missingFenceNoneSince.delete(attemptId);
    externalDrainSignals.delete(attemptId);
  };

  const closed = (
    binding: AttemptLeaseBinding,
    fence?: V3AttemptWorkerFence,
  ): AttemptLeaseDrainResult => ({
    status: 'closed',
    finalizeAfterProof: () => {
      if (fence) removeV3AttemptWorkerFence(binding.attemptDir, fence);
      clearTracking(binding.attemptId);
    },
  });

  return {
    acquire(binding) {
      return {
        auditKind: 'workerFence',
        hostToken: armV3AttemptWorkerFence(binding),
      };
    },

    closeBeforeExecution(binding, acquisition, reason: AttemptLeaseCloseReason) {
      closeV3ArmedFenceWithoutSpawn(
        binding.attemptDir,
        armedToken(acquisition),
        reason,
      );
    },

    drainExternallyOwned(binding): AttemptLeaseDrainResult {
      let fence: V3AttemptWorkerFence | null;
      try {
        fence = readV3AttemptWorkerFence(binding.attemptDir, binding);
      } catch {
        return { status: 'unknown' };
      }

      if (fence?.phase === 'armed') {
        const ownedByThisRuntime = fence.ownerPid === process.pid &&
          fence.ownerProcStart === readProcessStartIdentity(process.pid);
        if (ownedByThisRuntime) {
          const discovery = discoverV3AttemptWorker(binding.attemptDir);
          if (discovery.status === 'one') {
            try {
              fence = activateV3AttemptWorkerFence({
                attemptDir: binding.attemptDir,
                armed: fence,
                workerPid: discovery.worker.pid,
              });
              missingFenceNoneSince.delete(binding.attemptId);
            } catch {
              return { status: 'unknown' };
            }
          } else if (discovery.status === 'none') {
            if (!emptyDiscoveryIsStable(binding.attemptId)) return { status: 'pending' };
            try {
              return closed(
                binding,
                closeV3ArmedFenceWithoutSpawn(binding.attemptDir, fence, 'setup_failed'),
              );
            } catch {
              return { status: 'unknown' };
            }
          } else {
            missingFenceNoneSince.delete(binding.attemptId);
            return { status: 'unknown' };
          }
        } else {
          const recovered = recoverV3ArmedFenceWorker({
            attemptDir: binding.attemptDir,
            armed: fence,
          });
          if (recovered.status === 'recovered' || recovered.status === 'already_active') {
            fence = recovered.fence;
            missingFenceNoneSince.delete(binding.attemptId);
          } else if (
            recovered.status === 'already_closed' ||
            recovered.status === 'already_closed_no_spawn'
          ) {
            fence = recovered.fence;
          } else if (recovered.status === 'none') {
            if (!emptyDiscoveryIsStable(binding.attemptId)) return { status: 'pending' };
            return closed(binding, fence);
          } else {
            missingFenceNoneSince.delete(binding.attemptId);
            return { status: 'unknown' };
          }
        }
      }

      if (!fence) {
        const discovery = discoverV3AttemptWorker(binding.attemptDir);
        if (discovery.status === 'one') {
          try {
            const armed = armV3AttemptWorkerFence(binding);
            fence = activateV3AttemptWorkerFence({
              attemptDir: binding.attemptDir,
              armed,
              workerPid: discovery.worker.pid,
            });
            missingFenceNoneSince.delete(binding.attemptId);
          } catch {
            return { status: 'unknown' };
          }
        } else if (discovery.status === 'none') {
          if (!emptyDiscoveryIsStable(binding.attemptId)) return { status: 'pending' };
          return closed(binding);
        } else {
          missingFenceNoneSince.delete(binding.attemptId);
          return { status: 'unknown' };
        }
      }

      const probe = probeV3AttemptWorkerFence(binding.attemptDir, binding);
      if (probe.status === 'dead') return closed(binding, probe.fence);
      if (probe.status !== 'alive') return { status: 'unknown' };

      const now = Date.now();
      const prior = externalDrainSignals.get(binding.attemptId);
      const signal = !prior
        ? 'SIGINT'
        : prior.sigkillAt === undefined && now - prior.sigintAt >= EXTERNAL_CANCEL_KILL_GRACE_MS
          ? 'SIGKILL'
          : undefined;
      if (!signal) return { status: 'pending' };
      const result = signalV3AttemptWorker(
        binding.attemptDir,
        probe.fence as V3ActiveAttemptWorkerFence,
        signal,
      );
      if (result.status === 'dead') return closed(binding, result.fence);
      if (result.status !== 'signalled') return { status: 'unknown' };
      if (!prior) externalDrainSignals.set(binding.attemptId, { sigintAt: now });
      else externalDrainSignals.set(binding.attemptId, { ...prior, sigkillAt: now });
      return { status: 'pending' };
    },

    cleanupSettled(binding, acquisition) {
      try {
        const fence = readV3AttemptWorkerFence(binding.attemptDir, binding);
        if (!fence) return;
        if (fence.phase === 'armed') {
          removeV3AttemptWorkerFence(binding.attemptDir, fence);
          return;
        }
        const probe = probeV3AttemptWorkerFence(binding.attemptDir, binding);
        if (probe.status === 'dead') removeV3AttemptWorkerFence(binding.attemptDir, probe.fence);
      } catch {
        // Leaving the sidecar is the fail-safe cleanup direction.
      } finally {
        if (!acquisition) clearTracking(binding.attemptId);
      }
    },
  };
}
