import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Session } from '../types.js';
import type { DaemonSession } from './types.js';
import type { CloseSessionResult } from './worker-pool.js';
import { withFileLock } from '../utils/file-lock.js';
import { tryWithBotTurnMutation } from './bot-turn-mutation-gate.js';
import { protectedSessionMutationReasons } from './session-mutation-guard.js';
import { hasPendingSessionTurns } from './session-turn-queue.js';
import { assertWorkspaceRemoved, canonicalWorkspacePath, captureWorkspace } from './workspace-recycle-path.js';
import { discoverWorkspaceSessions, targetFingerprint } from './workspace-recycle-model.js';
import {
  assertRecycleStateOutsideWorkspace, persistRecycleJson, readRecycleJournal,
  recycleJournalPath, recycleKey, sameRecycleRequest, validateRecycleRequest,
  type RecycleJournal, type RecycleRequest,
} from './workspace-recycle-journal.js';
import {
  captureRecycleResources, rereadRecycleResources, resourceResiduals,
  type RecycleResources,
} from './workspace-recycle-resources.js';

export interface WorkspaceRecycleRuntimeDeps {
  appId: () => string;
  dataDir: () => string;
  getSession: (id: string) => Session | undefined;
  getRuntime: (id: string) => DaemonSession | undefined;
  allSessions: () => Session[];
  close: (id: string, opts: { workspaceRetirement: NonNullable<Session['workspaceRetirement']> }) => Promise<CloseSessionResult>;
  /** Synchronous durable re-close only: attach retirement to a row that was
   * independently closed after prepare, without retrying process teardown. */
  retireClosed: (id: string, retirement: NonNullable<Session['workspaceRetirement']>) => void;
  lifecycleBusy: (ds: DaemonSession) => boolean;
  closeResidual: (session: Session) => string | undefined;
  capture?: typeof captureRecycleResources;
  reread?: typeof rereadRecycleResources;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export type RecycleAction = 'prepare' | 'close' | 'defer' | 'abort';
export interface RecycleTargetResult {
  ok: boolean;
  status: RecycleJournal['phase'];
  journal: RecycleJournal;
}

function inputStamp(session: Session, ds?: DaemonSession): string {
  // Status/output observations deliberately do not count as NEW INPUT.
  return createHash('sha256').update(JSON.stringify([
    session.lastMessageAt ?? null, ds?.lastMessageAt ?? null,
    ds?.streamCardTurnGeneration ?? null, ds?.workerGeneration ?? null, ds?.currentTurnId ?? null,
  ])).digest('hex');
}

export function recycleBusyReasons(session: Session, ds?: DaemonSession): string[] {
  const reasons: string[] = protectedSessionMutationReasons(ds ?? session);
  if (hasPendingSessionTurns(session.sessionId)) reasons.push('session_turn_pending');
  if (session.ordinaryTurnRecovery && ['running', 'backoff', 'dispatching'].includes(session.ordinaryTurnRecovery.status)) reasons.push('ordinary_turn_unsettled');
  if (!ds) {
    if (session.pid) reasons.push('unregistered_worker');
    return reasons;
  }
  if (ds.worker && ds.lastScreenStatus !== 'idle') reasons.push('worker_not_idle');
  if (ds.managedTurnOrigin?.turnId) reasons.push('managed_turn_not_terminal');
  if (ds.pendingRepo || ds.pendingRepoCommitInFlight) reasons.push('repository_setup');
  if (ds.pendingPrompt || ds.pendingRawInput || ds.pendingFollowUpInput
      || ds.pendingFollowUps?.length || ds.pendingAttachments?.length) reasons.push('buffered_input');
  if (ds.pendingWaitPromises?.size) reasons.push('pending_reply');
  if (ds.idempotentAsyncTurns?.size || [...(ds.asyncTriggerResults?.values() ?? [])].some(t => t.status === 'pending')) reasons.push('async_trigger_pending');
  if (ds.tuiPromptProcessing || ds.stuckWarningProcessing) reasons.push('interactive_input_pending');
  return [...new Set(reasons)];
}

/** Host-only per-target close, under the SAME admission/drain gate used by
 * ordinary close. All decisions are made after earlier inbound turns drain.
 * Journals live in the daemon data directory, never in the retiring cwd. */
export class WorkspaceRecycleRuntime {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private readonly deps: WorkspaceRecycleRuntimeDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private path(request: RecycleRequest): string {
    return recycleJournalPath(this.deps.dataDir(), request.operationId, request.target);
  }
  private save(journal: RecycleJournal): void {
    journal.updatedAt = new Date(this.now()).toISOString();
    persistRecycleJson(this.path(journal), journal);
  }
  private result(journal: RecycleJournal): RecycleTargetResult {
    return { ok: journal.blockers.length === 0 && ['prepared', 'closed'].includes(journal.phase), status: journal.phase, journal };
  }
  private block(journal: RecycleJournal, blockers: string[]): RecycleTargetResult {
    journal.phase = 'blocked';
    journal.blockers = blockers;
    this.save(journal);
    return this.result(journal);
  }
  private isInitiator(request: RecycleRequest): boolean {
    return !!request.initiator && recycleKey(request.initiator) === recycleKey(request.target);
  }

  private retirement(request: RecycleRequest): NonNullable<Session['workspaceRetirement']> {
    return { operationId: request.operationId, workspacePath: request.workspace.canonicalPath,
      retiredAt: new Date(this.now()).toISOString() };
  }

  private checkIdentity(request: RecycleRequest, session: Session, ds?: DaemonSession): string[] {
    const blockers: string[] = [];
    if (session.larkAppId !== this.deps.appId() || targetFingerprint(session) !== request.target.fingerprint) blockers.push('session_identity_or_location_changed');
    if (ds && (ds.larkAppId !== request.target.larkAppId || ds.chatId !== request.target.chatId
        || (ds.workingDir && ds.workingDir !== session.workingDir))) blockers.push('runtime_identity_or_location_changed');
    if (session.adoptedFrom || session.existingAppServerEndpoint || ds?.adoptedFrom || ds?.initConfig?.adoptMode) blockers.push('external_or_shared_session');
    try {
      if (canonicalWorkspacePath(session.workingDir!) !== request.target.canonicalWorkingDir) blockers.push('workspace_alias_changed');
    } catch { blockers.push('workspace_alias_unverifiable'); }
    return blockers;
  }

  private peersClosed(journal: RecycleJournal, sessions: Session[]): boolean {
    return journal.peers.filter(peer => recycleKey(peer) !== recycleKey(journal.target)).every(peer => {
      const other = readRecycleJournal(recycleJournalPath(this.deps.dataDir(), journal.operationId, peer));
      const copies = sessions.filter(session => session.sessionId === peer.sessionId);
      return other?.phase === 'closed' && other.blockers.length === 0
        && JSON.stringify(other.workspace) === JSON.stringify(journal.workspace)
        && JSON.stringify(other.peers) === JSON.stringify(journal.peers)
        && copies.length === 1 && copies[0].status === 'closed' && !!copies[0].workspaceRetirement
        && targetFingerprint(copies[0]) === other.target.fingerprint;
    });
  }

  async perform(action: RecycleAction | 'drain', request: RecycleRequest): Promise<RecycleTargetResult> {
    validateRecycleRequest(request);
    if (request.target.larkAppId !== this.deps.appId()) throw new Error('wrong_owner_daemon');
    assertRecycleStateOutsideWorkspace(this.deps.dataDir(), request.workspace);
    const path = this.path(request);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return withFileLock(path, async () => {
      const previous = readRecycleJournal(path);
      if (previous && !sameRecycleRequest(previous, request)) throw new Error('recycle_operation_conflict');
      if (action === 'abort') {
        if (!previous) throw new Error('recycle_not_prepared');
        if (!['prepared', 'blocked', 'deferred', 'aborted'].includes(previous.phase) || previous.closeResult) throw new Error('recycle_already_started');
        previous.phase = 'aborted'; previous.blockers = [];
        this.save(previous);
        return this.result(previous);
      }
      if (previous?.phase === 'aborted') throw new Error('recycle_aborted');
      if (action !== 'prepare' && !previous) throw new Error('recycle_not_prepared');

      const guarded = await tryWithBotTurnMutation(this.deps.appId(), 1_000, async () => {
        try {
          const session = this.deps.getSession(request.target.sessionId);
          const ds = this.deps.getRuntime(request.target.sessionId);
          if (!session) throw new Error('session_owner_record_missing');
          if (action === 'prepare') {
            // Recheck preflight readiness without approving a changed input stamp.
            if (previous && !['prepared', 'blocked'].includes(previous.phase)) return this.result(previous);
            if (previous && previous.inputStamp !== inputStamp(session, ds)) return this.block(previous, ['new_input_or_worker_generation_after_prepare']);
            if (JSON.stringify(captureWorkspace(request.workspace.path)) !== JSON.stringify(request.workspace)) throw new Error('workspace_identity_changed');
            const blockers = this.checkIdentity(request, session, ds);
            const busy = recycleBusyReasons(session, ds);
            if (ds && this.deps.lifecycleBusy(ds)) busy.push('session_lifecycle_in_flight');
            if (!this.isInitiator(request)) blockers.push(...busy);
            if (session.status !== 'active') blockers.push('session_already_closed_before_prepare');
            const journal: RecycleJournal = {
              ...request, phase: 'prepared', inputStamp: previous?.inputStamp ?? inputStamp(session, ds),
              before: previous?.before ?? (this.deps.capture ?? captureRecycleResources)(session, ds),
              blockers, preparedAt: previous?.preparedAt ?? new Date(this.now()).toISOString(), updatedAt: '',
            };
            this.save(journal);
            return this.result(journal);
          }

          const journal = previous!;
          assertWorkspaceRemoved(journal.workspace);
          const changed = this.checkIdentity(journal, session, ds);
          if (changed.length) return this.block(journal, changed);
          if (session.status === 'closed') return this.verify(journal, session, ds);
          if (journal.phase === 'closed' || journal.phase === 'closed_with_residual') return this.block(journal, ['session_reactivated_after_close']);
          if (journal.inputStamp !== inputStamp(session, ds)) return this.block(journal, ['new_input_or_worker_generation_after_prepare']);
          if (this.isInitiator(journal)) {
            // The caller may have exited minutes ago. Re-discover coverage before
            // cashing in its deferred handoff; never hide a newly-created peer.
            const allSessions = this.deps.allSessions();
            if (!this.peersClosed(journal, allSessions)) return this.block(journal, ['initiator_waiting_for_other_targets']);
            const discovery = discoverWorkspaceSessions(allSessions, journal.workspace.canonicalPath);
            const planned = new Set(journal.peers.map(recycleKey));
            if (discovery.errors.length || discovery.targets.some(t => !planned.has(recycleKey(t)))) return this.block(journal, ['workspace_coverage_changed']);
          }
          if (action === 'defer') {
            if (!this.isInitiator(journal)) throw new Error('only_initiator_can_be_deferred');
            journal.deferredUntil ??= this.now() + 15 * 60_000;
            journal.phase = 'deferred'; journal.blockers = [];
            this.save(journal);
            // Always return before closing the caller, even if its screen is
            // momentarily idle while the hook subprocess is still receiving ACK.
            this.scheduleRecovery();
            return this.result(journal);
          }
          const busy = recycleBusyReasons(session, ds);
          if (ds && this.deps.lifecycleBusy(ds)) busy.push('session_lifecycle_in_flight');
          if (busy.length) {
            if (action === 'drain' && this.isInitiator(journal)) {
              journal.deferredUntil ??= this.now() + 15 * 60_000;
              if (this.now() >= journal.deferredUntil) return this.block(journal, ['initiator_idle_deadline_exceeded', ...busy]);
              journal.phase = 'deferred'; journal.blockers = busy;
              this.save(journal); // ACK means durable handoff, never completed close.
              this.scheduleRecovery();
              return this.result(journal);
            }
            return this.block(journal, busy);
          }
          // Capture late descendants before the standard close can detach them.
          const latest = (this.deps.capture ?? captureRecycleResources)(session, ds);
          const seen = new Set(journal.before.processes.map(p => `${p.pid}:${p.identity}`));
          journal.before.processes.push(...latest.processes.filter(p => !seen.has(`${p.pid}:${p.identity}`)));
          journal.phase = 'closing'; journal.blockers = [];
          this.save(journal); // A crash after here recovers by readback, not a blind kill.
          try { journal.closeResult = await this.deps.close(session.sessionId, { workspaceRetirement: this.retirement(journal) }); }
          catch (error) {
            const fresh = this.deps.getSession(session.sessionId);
            if (fresh?.status === 'closed') {
              journal.blockers = [`close_exception:${String(error)}`];
              return this.verify(journal, fresh, this.deps.getRuntime(session.sessionId));
            }
            return this.block(journal, [`close_exception:${String(error)}`]);
          }
          const fresh = this.deps.getSession(session.sessionId);
          if (!fresh) return this.block(journal, ['session_record_missing_after_close']);
          if (!journal.closeResult.ok) return this.block(journal, [`close_refused:${journal.closeResult.error}`]);
          return this.verify(journal, fresh, this.deps.getRuntime(session.sessionId));
        } catch (error) {
          if (previous) return this.block(previous, [`recycle_revalidation_error:${String(error)}`]);
          throw error;
        }
      });
      if (guarded.acquired) return guarded.value;
      if (previous) return this.block(previous, ['inbound_admission_drain_timeout']);
      throw new Error('inbound_admission_drain_timeout');
    }, { maxWaitMs: 1_500 });
  }

  private async verify(journal: RecycleJournal, session: Session, ds?: DaemonSession): Promise<RecycleTargetResult> {
    if (session.status === 'closed' && !session.workspaceRetirement) {
      this.deps.retireClosed(session.sessionId, this.retirement(journal));
      session = this.deps.getSession(session.sessionId) ?? session;
    }
    journal.after = (this.deps.reread ?? rereadRecycleResources)(journal.before, session, ds);
    // A standard close fence can be acknowledged just BEFORE process exit.
    // Give already-closing owned processes a bounded read-only release window.
    const deadline = Date.now() + 2_000;
    while (journal.after.processes.some(p => p.state === 'alive') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      journal.after = (this.deps.reread ?? rereadRecycleResources)(journal.before, session, this.deps.getRuntime(session.sessionId));
    }
    const residual = this.deps.closeResidual(session);
    const blockers = resourceResiduals(journal.after);
    if (session.status !== 'closed') blockers.push('durable_status_not_closed');
    if (!session.workspaceRetirement) blockers.push('durable_retirement_missing');
    if (residual) blockers.push(residual);
    if (journal.closeResult?.ok && journal.closeResult.outcome === 'closed_with_residual') blockers.push(journal.closeResult.residual.reason);
    // Remote cancellation is proved by the standard close's durable result.
    // A crash that lost that receipt must not guess cancellation from a null id.
    if (journal.after.backing.state === 'remote' && !journal.closeResult?.ok) blockers.push('remote_close_receipt_missing');
    journal.blockers = [...new Set([...journal.blockers.filter(s => s.startsWith('close_exception:')), ...blockers])];
    journal.phase = session.status !== 'closed' ? 'blocked' : journal.blockers.length ? 'closed_with_residual' : 'closed';
    this.save(journal);
    return this.result(journal);
  }

  /** Only explicitly handed-off initiators resume automatically. Ordinary
   * partial failures remain inspectable until an operator replays commit. */
  async recoverDeferred(): Promise<void> {
    if (this.stopped) return;
    const root = join(this.deps.dataDir(), 'workspace-recycle');
    let operations: string[];
    try { operations = readdirSync(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    let pending = false;
    for (const operation of operations) {
      let files: string[];
      try { files = readdirSync(join(root, operation)); } catch { continue; }
      for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
        try {
          const journal = readRecycleJournal(join(root, operation, file));
          if (journal?.phase !== 'deferred' || journal.target.larkAppId !== this.deps.appId()) continue;
          const result = await this.perform('drain', journal);
          pending ||= result.status === 'deferred';
        } catch (error) {
          // An unreadable journal must not hide other independent handoffs.
          this.deps.onError?.(error);
        }
      }
    }
    if (pending) this.scheduleRecovery();
  }

  scheduleRecovery(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.recoverDeferred().catch(error => this.deps.onError?.(error));
    }, 2_000);
    this.timer.unref();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  start(): void { this.stopped = false; }
}
