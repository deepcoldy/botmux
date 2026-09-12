import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from '../utils/file-lock.js';
import { loadAllSessionsStrict } from './session-store.js';
import { listOnlineDaemons, type OnlineDaemonInfo } from '../utils/daemon-discovery.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { captureWorkspace, assertWorkspaceRemoved, type WorkspaceIdentity } from '../core/workspace-recycle-path.js';
import { discoverWorkspaceSessions, targetFingerprint, WORKSPACE_RECYCLE_PROTOCOL, type WorkspaceDiscovery, type WorkspaceSessionTarget } from '../core/workspace-recycle-model.js';
import {
  assertRecycleStateOutsideWorkspace, persistRecycleJson, readRecycleJournal, recycleJournalPath,
  recycleKey, validateRecycleOperationId, type RecyclePeer, type RecycleRequest, type RecycleJournal,
} from '../core/workspace-recycle-journal.js';
import type { RecycleAction, RecycleTargetResult } from '../core/workspace-recycle-runtime.js';
import type { Session } from '../types.js';

export interface WorkspaceRecycleOperation {
  protocol: typeof WORKSPACE_RECYCLE_PROTOCOL;
  operationId: string;
  workspace: WorkspaceIdentity;
  initiator?: RecyclePeer;
  targets: WorkspaceSessionTarget[];
  excluded: WorkspaceDiscovery['excluded'];
  phase: 'preparing' | 'prepared' | 'committing' | 'pending' | 'partial' | 'closed' | 'aborted';
  prepared: boolean;
  errors: Array<{ sessionId?: string; error: string }>;
  lifecycle?: { eventId: string; outcome: 'succeeded' | 'failed' };
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRecycleStatus {
  ok: boolean;
  status: WorkspaceRecycleOperation['phase'];
  operation: WorkspaceRecycleOperation;
  results: Array<RecycleJournal | { target: WorkspaceSessionTarget; phase: 'missing' }>;
  errors: WorkspaceRecycleOperation['errors'];
  evidencePath: string;
}

export interface WorkspaceRecycleDeps {
  dataDir: string;
  sessions?: () => Session[];
  daemons?: () => OnlineDaemonInfo[];
  call?: (daemon: OnlineDaemonInfo, action: RecycleAction, request: RecycleRequest) => Promise<RecycleTargetResult>;
}

/** This coordinator does not own a session store and never closes a row on
 * disk as a fallback. Only each target's authenticated live owner may close. */
export class WorkspaceRecycler {
  constructor(private readonly deps: WorkspaceRecycleDeps) {}

  discover(path: string): WorkspaceDiscovery {
    return discoverWorkspaceSessions(this.sessions(), path);
  }
  private sessions(): Session[] { return (this.deps.sessions ?? (() => loadAllSessionsStrict(this.deps.dataDir)))(); }
  private path(operationId: string): string {
    validateRecycleOperationId(operationId);
    return join(this.deps.dataDir, 'workspace-recycle', operationId, 'operation.json');
  }
  private save(operation: WorkspaceRecycleOperation): void {
    operation.updatedAt = new Date().toISOString();
    persistRecycleJson(this.path(operation.operationId), operation);
  }
  private load(operationId: string): WorkspaceRecycleOperation {
    const operation = JSON.parse(readFileSync(this.path(operationId), 'utf8')) as WorkspaceRecycleOperation;
    if (operation.protocol !== WORKSPACE_RECYCLE_PROTOCOL || operation.operationId !== operationId
        || !Array.isArray(operation.targets) || !Array.isArray(operation.errors)) throw new Error('invalid_recycle_operation');
    assertRecycleStateOutsideWorkspace(this.deps.dataDir, operation.workspace);
    return operation;
  }
  private request(operation: WorkspaceRecycleOperation, target: WorkspaceSessionTarget): RecycleRequest {
    return {
      protocol: WORKSPACE_RECYCLE_PROTOCOL, operationId: operation.operationId,
      workspace: operation.workspace, target,
      peers: operation.targets.map(({ larkAppId, sessionId }) => ({ larkAppId, sessionId })),
      initiator: operation.initiator,
    };
  }

  private coverageErrors(operation: WorkspaceRecycleOperation): WorkspaceRecycleOperation['errors'] {
    try {
      const after = this.discover(operation.workspace.canonicalPath);
      const planned = new Set(operation.targets.map(recycleKey));
      return [
        ...after.errors,
        ...after.targets.filter(target => !planned.has(recycleKey(target)))
          .map(target => ({ sessionId: target.sessionId, error: 'unplanned_active_session' })),
      ];
    } catch (error) { return [{ error: `workspace_coverage_unavailable:${String(error)}` }]; }
  }

  private async call(action: RecycleAction, request: RecycleRequest): Promise<RecycleTargetResult> {
    const daemons = (this.deps.daemons ?? (() => listOnlineDaemons(this.deps.dataDir)))();
    const matches = daemons.filter(d => d.larkAppId === request.target.larkAppId);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].ipcPort)
        || matches[0].ipcPort < 1 || matches[0].ipcPort > 65_535) throw new Error('owner_daemon_missing_or_ambiguous');
    if (this.deps.call) return this.deps.call(matches[0], action, request);
    const response = await fetchDaemonIpc(matches[0].ipcPort, `/api/workspace-recycle/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: AbortSignal.timeout(60_000),
    });
    const result = await response.json() as RecycleTargetResult & { error?: string };
    if (!result.journal || result.journal.target.sessionId !== request.target.sessionId
        || result.journal.target.larkAppId !== request.target.larkAppId || result.journal.operationId !== request.operationId) {
      throw new Error(`recycle_owner_response_unavailable:${response.status}:${result.error ?? 'invalid_result'}`);
    }
    return result;
  }

  async prepare(operationId: string, path: string, initiatorSessionId?: string): Promise<WorkspaceRecycleStatus> {
    const workspace = captureWorkspace(path);
    assertRecycleStateOutsideWorkspace(this.deps.dataDir, workspace);
    const file = this.path(operationId);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    return withFileLock(file, async () => {
      let prior: WorkspaceRecycleOperation | undefined;
      try { prior = this.load(operationId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (prior) {
        if (JSON.stringify(prior.workspace) !== JSON.stringify(workspace)
            || (initiatorSessionId && prior.initiator?.sessionId !== initiatorSessionId)) throw new Error('recycle_operation_conflict');
        if (!['preparing', 'prepared'].includes(prior.phase)) return this.status(operationId);
      }
      const discovered = this.discover(path);
      if (discovered.errors.length) throw new Error(`workspace_discovery_incomplete:${JSON.stringify(discovered.errors)}`);
      const initiator = discovered.targets.find(t => t.sessionId === initiatorSessionId);
      if (initiatorSessionId && !initiator) throw new Error('initiator_not_in_plan');
      const operation: WorkspaceRecycleOperation = prior ?? {
        protocol: WORKSPACE_RECYCLE_PROTOCOL, operationId, workspace,
        targets: discovered.targets, excluded: discovered.excluded,
        initiator: initiator ? { larkAppId: initiator.larkAppId, sessionId: initiator.sessionId } : undefined,
        phase: 'preparing', prepared: false, errors: [], createdAt: new Date().toISOString(), updatedAt: '',
      };
      operation.errors = [];
      this.save(operation);
      for (const target of operation.targets) {
        try {
          const result = await this.call('prepare', this.request(operation, target));
          if (!result.ok) operation.errors.push({ sessionId: target.sessionId, error: result.journal.blockers.join(',') });
        } catch (error) {
          operation.errors.push({ sessionId: target.sessionId, error: String(error) });
        }
        this.save(operation);
      }
      // Discovery may have raced a newly-created row while other bots prepared.
      const after = this.discover(path);
      const planned = new Set(operation.targets.map(recycleKey));
      for (const target of after.targets) if (!planned.has(recycleKey(target))) operation.errors.push({ sessionId: target.sessionId, error: 'new_session_during_prepare' });
      operation.errors.push(...after.errors);
      operation.prepared = operation.errors.length === 0;
      operation.phase = operation.prepared ? 'prepared' : 'preparing';
      this.save(operation);
      return this.status(operationId);
    }, { maxWaitMs: 1_500 });
  }

  /** Equivalent generic lifecycle event. A failed end NEVER closes anything.
   * The caller supplies the same operationId stamped by its pre-end hook. */
  async finish(operationId: string, event: { eventId: string; outcome: 'succeeded' | 'failed' }): Promise<WorkspaceRecycleStatus> {
    if (!event.eventId || !['succeeded', 'failed'].includes(event.outcome)) throw new Error('invalid_recycle_completion_event');
    return withFileLock(this.path(operationId), async () => {
      const operation = this.load(operationId);
      if (operation.lifecycle && JSON.stringify(operation.lifecycle) !== JSON.stringify(event)) throw new Error('recycle_event_conflict');
      if (operation.phase === 'aborted') return this.status(operationId);
      if (event.outcome === 'succeeded' && !operation.prepared) throw new Error('recycle_preflight_not_ready');
      if (event.outcome === 'succeeded') assertWorkspaceRemoved(operation.workspace);
      operation.lifecycle = event;
      operation.errors = [];
      operation.phase = event.outcome === 'failed' ? 'aborted' : 'committing';
      if (event.outcome === 'succeeded') operation.errors.push(...this.coverageErrors(operation));
      this.save(operation); // durable before the first owner receives a close
      const targets = [...operation.targets].sort((a, b) => Number(a.sessionId === operation.initiator?.sessionId) - Number(b.sessionId === operation.initiator?.sessionId));
      for (const target of targets) {
        const isInitiator = target.sessionId === operation.initiator?.sessionId;
        // Check again BEFORE handing off the last session: new rows can arrive
        // while its peers close. An incomplete scan must keep the closer alive.
        if (event.outcome === 'succeeded' && isInitiator) operation.errors.push(...this.coverageErrors(operation));
        if (event.outcome === 'succeeded' && isInitiator && operation.errors.length) {
          operation.errors.push({ sessionId: target.sessionId, error: 'initiator_waiting_for_other_targets' });
          continue;
        }
        try {
          const result = await this.call(event.outcome === 'failed' ? 'abort' : isInitiator ? 'defer' : 'close', this.request(operation, target));
          if (!result.ok && !['aborted', 'deferred'].includes(result.status)) operation.errors.push({ sessionId: target.sessionId, error: result.journal.blockers.join(',') });
        } catch (error) {
          operation.errors.push({ sessionId: target.sessionId, error: String(error) });
        }
        this.save(operation);
      }
      if (event.outcome === 'succeeded') {
        operation.errors.push(...this.coverageErrors(operation));
        this.save(operation);
        const status = this.status(operationId);
        operation.phase = status.status;
      }
      this.save(operation);
      return this.status(operationId);
    }, { maxWaitMs: 1_500 });
  }

  /** Pure readback; deferred initiator completion can happen after CLI exit. */
  status(operationId: string): WorkspaceRecycleStatus {
    const operation = this.load(operationId);
    const results = operation.targets.map(target => readRecycleJournal(recycleJournalPath(this.deps.dataDir, operationId, target)) ?? { target, phase: 'missing' as const });
    let status = operation.phase;
    const errors = [...operation.errors];
    if (operation.lifecycle?.outcome === 'succeeded') {
      errors.push(...this.coverageErrors(operation));
      try {
        assertWorkspaceRemoved(operation.workspace);
        const sessions = this.sessions();
        for (const result of results.filter(result => result.phase === 'closed')) {
          const matches = sessions.filter(s => s.sessionId === result.target.sessionId);
          if (matches.length !== 1 || matches[0].status !== 'closed' || targetFingerprint(matches[0]) !== result.target.fingerprint) {
            errors.push({ sessionId: result.target.sessionId, error: 'durable_close_readback_changed_or_missing' });
          }
        }
      } catch (error) { errors.push({ error: `final_readback_unavailable:${String(error)}` }); }
      for (const result of results) {
        if (!['closed', 'deferred'].includes(result.phase)) errors.push({ sessionId: result.target.sessionId, error: result.phase === 'missing' ? 'target_journal_missing' : result.blockers.join(',') || result.phase });
      }
      status = errors.length ? 'partial' : results.some(r => r.phase === 'deferred') ? 'pending' : 'closed';
    }
    return {
      ok: errors.length === 0 && (status === 'closed' || status === 'prepared' || status === 'aborted'),
      status, operation: { ...operation, phase: status }, results, errors,
      evidencePath: this.path(operationId),
    };
  }
}
