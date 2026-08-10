/**
 * Host-neutral adapter for the complete v3 Node runtime.
 *
 * The action realization remains single-sourced in shared-node-runtime.ts;
 * this adapter only translates execution profiles and agent calls.
 */

import type { BotSnapshot, RunNodeRequest } from './contract.js';
import type { ValidateManifest } from './artifact-contract.js';
import {
  isGoalNode,
  isLoopNode,
  validateDag,
  type V3Dag,
} from './dag.js';
import { createInProcessAttemptLeaseProvider } from './in-process-attempt-lease.js';
import { readPortableWorkflowFinalOutputs } from './portable-final-outputs.js';
import type { PortableWorkflowFinalOutput } from './portable-final-outputs.js';
import { assertOrCreatePortableRunSnapshot } from './portable-run-snapshot.js';
import { runWorkflow as runNodeWorkflow } from './shared-node-runtime.js';
import { join } from 'node:path';
import type {
  AgentExecutor,
  AttemptLeaseProvider,
  ExecutionContextSnapshot,
  ExecutionProfileSnapshot,
  GateResolver,
  HostExecutorRegistry,
  HostExecutorPolicy,
  ProviderReconciler,
} from './runtime-host-contract.js';

export interface PortableWorkflowPendingGate {
  nodeId: string;
  waitId: string;
  prompt: string;
  options: string[];
  approveOptions: string[];
  approvers: string[];
  hostApproval?: {
    attemptId: string;
    approvalDigest: string;
    inputHash: string;
  };
}

export {
  readPortableWorkflowFinalOutputs,
} from './portable-final-outputs.js';
export type {
  PortableWorkflowFinalOutput,
} from './portable-final-outputs.js';

export type PortableWorkflowRunOutcome =
  | {
      reason: 'terminal';
      runStatus: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
      failedNodeId?: string;
      blockedNodeId?: string;
      failureReason?: 'allSinksSkipped';
      failureDetail?: string;
      uncertainHostEffects?: Array<{
        nodeId: string;
        instanceId: string;
        attemptId: string;
        executor: string;
        errorCode: string;
      }>;
      finalOutputs: PortableWorkflowFinalOutput[];
      runDir: string;
    }
  | {
      reason: 'awaitingGate';
      pendingWaits: PortableWorkflowPendingGate[];
      runDir: string;
    };

export interface PortableWorkflowRuntimeDeps {
  executeAgent: AgentExecutor;
  validateManifest: ValidateManifest;
  resolveExecutionProfile: (
    selector: string | undefined,
  ) => ExecutionProfileSnapshot;
  validateExecutionProfile?: (
    profile: ExecutionProfileSnapshot,
    selector: string,
  ) => void;
  /**
   * Optional only for fresh process-local runs. The default provider cannot
   * prove old attempts closed after recovery and therefore returns `unknown`.
   * Desktop and other durable hosts must inject a durable provider.
   */
  attemptLeaseProvider?: AttemptLeaseProvider;
  hostExecutors?: HostExecutorRegistry;
  hostReconcilers?: Map<string, ProviderReconciler>;
  hostExecutorPolicy?: HostExecutorPolicy;
  now?: () => number;
  resolveGate?: GateResolver;
}

export interface PortableWorkflowRuntimeOptions {
  /**
   * Durable run root. Reusing the same baseDir + dag.runId formally resumes
   * the existing journal and does not redispatch settled nodes.
   */
  baseDir: string;
  gateMode?: 'blocking' | 'suspend';
  globalConcurrency?: number;
  frozenExecutionProfiles?: ReadonlyMap<string, ExecutionProfileSnapshot>;
  perProfileConcurrency?: number;
  perExecutorConcurrency?: number;
  cancelSignal?: AbortSignal;
  authorizedArtifacts?: boolean;
  executionContext?: ExecutionContextSnapshot;
  /** @deprecated Use `executionContext`. */
  resolvedWorkflowData?: ExecutionContextSnapshot;
  hostResponseWaitMs?: number;
}

function defaultValidateProfile(
  profile: ExecutionProfileSnapshot,
  selector: string,
): void {
  if (!profile.profileId || !profile.executorId || !profile.workingDirectory) {
    throw new Error(
      `v3 runtime: execution profile "${selector || '<default>'}" is incomplete`,
    );
  }
}

function botSnapshotFor(profile: ExecutionProfileSnapshot): BotSnapshot {
  return {
    // These legacy field names are confined to this adapter. The scheduler
    // treats them as opaque profile/executor/cwd slots.
    larkAppId: profile.profileId,
    cliId: profile.executorId as BotSnapshot['cliId'],
    workingDir: profile.workingDirectory,
    ...(profile.model ? { model: profile.model } : {}),
  };
}

export async function runPortableWorkflow(
  dag: V3Dag,
  deps: PortableWorkflowRuntimeDeps,
  options: PortableWorkflowRuntimeOptions,
): Promise<PortableWorkflowRunOutcome> {
  const normalizedDag = validateDag(dag);
  let profiles = new Map<string, ExecutionProfileSnapshot>(
    options.frozenExecutionProfiles ?? [],
  );
  const resolveProfile = (selector: string | undefined): ExecutionProfileSnapshot => {
    const key = selector ?? '';
    const existing = profiles.get(key);
    if (existing) return existing;
    if (options.frozenExecutionProfiles) {
      throw new Error(
        `v3 runtime: frozen execution profiles are missing selector "${key || '<default>'}"`,
      );
    }
    const profile = deps.resolveExecutionProfile(selector);
    profiles.set(key, profile);
    return profile;
  };

  for (const node of normalizedDag.nodes) {
    if (isGoalNode(node)) resolveProfile(node.bot);
    if (isLoopNode(node)) {
      for (const bodyNode of node.body.nodes) {
        resolveProfile(bodyNode.bot ?? node.bot);
      }
    }
  }
  const validateProfile = deps.validateExecutionProfile ?? defaultValidateProfile;
  for (const [selector, executionProfile] of profiles) {
    validateProfile(executionProfile, selector);
  }

  const frozenDefinition = assertOrCreatePortableRunSnapshot(
    join(options.baseDir, normalizedDag.runId),
    normalizedDag,
    profiles,
  );
  profiles = frozenDefinition.executionProfiles;
  const frozenDag = frozenDefinition.dag;
  const profileById = new Map<string, ExecutionProfileSnapshot>();
  for (const executionProfile of profiles.values()) {
    profileById.set(executionProfile.profileId, executionProfile);
  }
  const requireProfile = (selector: string | undefined): ExecutionProfileSnapshot => {
    const key = selector ?? '';
    const executionProfile = profiles.get(key);
    if (!executionProfile) {
      throw new Error(
        `v3 runtime: frozen execution profiles are missing selector "${key || '<default>'}"`,
      );
    }
    return executionProfile;
  };

  const runNode = async (request: RunNodeRequest) => {
    const profile = profileById.get(request.botSnapshot.larkAppId);
    if (!profile) {
      throw new Error(
        `v3 runtime: execution profile "${request.botSnapshot.larkAppId}" was not frozen`,
      );
    }
    if (!request.attemptLease) {
      throw new Error(`v3 runtime: attempt ${request.attemptId} has no lease`);
    }
    return deps.executeAgent({
      runId: request.runId,
      attemptId: request.attemptId,
      attemptLease: request.attemptLease,
      node: request.node,
      executionProfile: {
        ...profile,
        ...(request.botSnapshot.model ? { model: request.botSnapshot.model } : {}),
      },
      runDir: request.runDir,
      attemptDir: request.attemptDir,
      inputsPath: request.inputsPath,
      outputDir: request.outputDir,
      env: request.env,
      timeoutMs: request.timeoutMs,
      ...(request.onSessionReady ? { onSessionReady: request.onSessionReady } : {}),
      ...(request.stdoutPath ? { stdoutPath: request.stdoutPath } : {}),
      ...(request.stderrPath ? { stderrPath: request.stderrPath } : {}),
    });
  };

  const outcome = await runNodeWorkflow(frozenDag, {
    runNode,
    validateManifest: deps.validateManifest,
    resolveBotSnapshot: (selector) => botSnapshotFor(requireProfile(selector)),
    validateExecutionSnapshot: (snapshot, selector) => {
      const profile = profileById.get(snapshot.larkAppId);
      if (!profile) {
        throw new Error(`v3 runtime: profile "${snapshot.larkAppId}" is unavailable`);
      }
      validateProfile(profile, selector);
    },
    attemptLeaseProvider:
      deps.attemptLeaseProvider ?? createInProcessAttemptLeaseProvider(),
    ...(deps.hostExecutors ? { hostExecutors: deps.hostExecutors } : {}),
    ...(deps.hostReconcilers ? { hostReconcilers: deps.hostReconcilers } : {}),
    ...(deps.hostExecutorPolicy ? { hostExecutorPolicy: deps.hostExecutorPolicy } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.resolveGate ? { resolveGate: deps.resolveGate } : {}),
  }, {
    ...options,
    perBotConcurrency: options.perProfileConcurrency,
    perCliConcurrency: options.perExecutorConcurrency,
    frozenBotSnapshots: new Map(
      [...profiles].map(([key, profile]) => [
        key,
        botSnapshotFor(profile),
      ]),
    ),
  });
  if (outcome.reason !== 'terminal') return outcome;
  return {
    ...outcome,
    finalOutputs: outcome.runStatus === 'succeeded'
      ? await readPortableWorkflowFinalOutputs(
          frozenDag,
          outcome.runDir,
          deps.validateManifest,
        )
      : [],
  };
}
