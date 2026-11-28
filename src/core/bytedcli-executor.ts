import { matchSkillApi } from './bytedcli-skill-api.js';
import type { BytedcliHostApiRunner } from './bytedcli-skill-api-transport.js';
import type { BytedcliTrustedPythonRuntime } from './bytedcli-python-runtime.js';
import { constants, closeSync, mkdtempSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BYTEDCLI_EXEC_SCHEMA, BYTEDCLI_EXEC_LIMITS, BYTEDCLI_EXEC_ERROR_CODES, decodeBytedcliBase64,
  type BytedcliExecResponse, type BytedcliExecErrorCode, type BytedcliEffectiveIdentity } from '../cli/bytedcli-exec-protocol.js';
import { parseBytedcliOperation, assertBytedcliAuditedRelease, isBytedcliWriteLike, type BytedcliOperation } from './bytedcli-operation-policy.js';
import { ensureBytedcliPrivateDirectory, type BytedcliAuditRecord, type BytedcliAuditSink } from './bytedcli-broker-audit.js';
import { bytedcliSafeFingerprint, type BytedcliAuthorityRecheck, type BytedcliVerifiedActor,
  type BytedcliCredentialLease, type BytedcliLeaseResolver } from './bytedcli-broker-credentials.js';
import { BytedcliBrokerError, bytedcliMinimalEnv, runBoundedBytedcliChild,
  type BytedcliChildRunner, type BytedcliTrustedCli, type BytedcliTrustedDbRuntime } from './bytedcli-broker-process.js';
import { maskCredentialShapes } from './stuck-page-catalog.js';
import { isolateBytedcliInvocation } from './bytedcli-isolated-process.js';
import { isParsedBytedcliOperationPolicy, resolveBytedcliOperationRule } from './bytedcli-operation-policy-config.js';
import type { BytedcliFrozenOperationPolicy } from './bytedcli-host-operation-policy.js';

/** Constructed only by host peer/admission/turn/delegation resolution. */
export interface BytedcliFrozenAuthority {
  readonly daemonBootId: string; readonly botAppId: string; readonly sessionId: string;
  readonly turnId: string; readonly identityTurnId?: string; readonly workerGeneration: number;
  readonly dispatchAttempt: number; readonly policyFingerprint: string;
  readonly executionIdentity?: 'machine' | 'actor';
  readonly operationPolicy?: BytedcliFrozenOperationPolicy;
  readonly actor?: BytedcliVerifiedActor; readonly recheck: BytedcliAuthorityRecheck;
  /** Frozen host state check without starting delegated provider work. Used
   * only for refusals that expose no business data or execution authority. */
  readonly current?: () => BytedcliExecErrorCode | undefined;
}
export interface BytedcliExecutionRequest {
  readonly requestId: string; readonly operation: BytedcliOperation;
  readonly authority: BytedcliFrozenAuthority; readonly signal?: AbortSignal;
}
export interface BytedcliExecutorDependencies {
  readonly privateRoot: string; readonly trustedCli: (signal: AbortSignal) => Promise<BytedcliTrustedCli>;
  readonly leases: BytedcliLeaseResolver; readonly audit: BytedcliAuditSink;
  readonly networkEnv?: Readonly<NodeJS.ProcessEnv>; readonly run?: BytedcliChildRunner;
  readonly dbRuntime?: BytedcliTrustedDbRuntime;
  readonly pythonRuntime?: BytedcliTrustedPythonRuntime;
  readonly hostApi?: BytedcliHostApiRunner;
}
export function redactBytedcliOutput(buffer: Buffer, activeSecrets: readonly string[]): Buffer {
  let text = buffer.toString('utf8');
  for (const secret of activeSecrets) {
    if (!secret) continue;
    for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) {
      text = text.split(value).join('[REDACTED]');
    }
  }
  text = maskCredentialShapes(text)
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:"|\b)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|jwt|authorization|cookie|client[_-]?secret|secret[_-]?access[_-]?key|device[_-]?code|authorize[_-]?url)(?:"\s*:|\s*[:=])\s*)(?:"(?:\\.|[^"\\])*"|[^\s,;}]+)/gi, '$1"[REDACTED]"')
    .replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]');
  return Buffer.from(text, 'utf8');
}
const GLOBAL_OUTPUT_LIMIT = 128 * 1024 * 1024;
async function joinOwnedWork(work: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(work);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
interface Waiter { request: BytedcliExecutionRequest; resolve: (release: () => void) => void; reject: (error: Error) => void; cleanup: () => void }
interface Entry { digest: string; tuple: string; execution: string; requestId: string; effect: 'read' | 'write' | 'unknown'; sessionId: string; workerGeneration:number; promise: Promise<BytedcliExecResponse>; settled: boolean;
  outputBytes: number; revalidate?: BytedcliCredentialLease['stillCurrent']; controller?: AbortController;
  identity?: BytedcliEffectiveIdentity; dispatched?: boolean; overflow?: boolean }
/** Response cancellation and underlying resource settlement are separate.
 * Keep quota and lifecycle ownership until every started provider has ended. */
class OwnedBytedcliRequest {
  readonly cleanup: Promise<void>;
  private complete!: () => void;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(readonly sessionId: string, readonly workerGeneration:number, readonly controller: AbortController, private readonly retired: () => void) {
    this.cleanup = new Promise(resolve => { this.complete = resolve; });
  }
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  finish(release: () => void): void {
    void (async () => {
      try {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        release();
      } finally { this.retired(); this.complete(); }
    })();
  }
}
function errorCode(error: unknown): BytedcliExecErrorCode {
  const code = (error as { code?: unknown })?.code;
  return (BYTEDCLI_EXEC_ERROR_CODES as readonly unknown[]).includes(code) ? code as BytedcliExecErrorCode : 'internal_error';
}
function rejectResponse(request: BytedcliExecutionRequest, code: BytedcliExecErrorCode,
  identity: BytedcliEffectiveIdentity = { kind: 'none' }, unknownWrite = false): BytedcliExecResponse {
  return Object.freeze({ schema: BYTEDCLI_EXEC_SCHEMA, requestId: request.requestId, operationId: request.operation.id,
    operationEffect: request.operation.effect,
    effectiveIdentity: identity, outcome: unknownWrite ? 'write_outcome_unknown' : 'rejected',
    stdoutBase64: '', stderrBase64: '', exitCode: 77, errorCode: unknownWrite ? 'write_outcome_unknown' : code });
}
function tupleOf(authority: BytedcliFrozenAuthority): string {
  return JSON.stringify([executionOf(authority), authority.policyFingerprint, authority.executionIdentity ?? null, authority.actor ?? null]);
}
function executionOf(authority: BytedcliFrozenAuthority): string {
  return JSON.stringify([authority.daemonBootId, authority.botAppId, authority.sessionId, authority.workerGeneration,
    authority.dispatchAttempt, authority.turnId, authority.identityTurnId ?? authority.turnId,
  ]);
}
function executionIdentityOf(request: BytedcliExecutionRequest): 'machine' | 'actor' {
  return request.authority.executionIdentity ?? (request.operation.effect === 'read' ? 'machine' : 'actor');
}
function provesExplicitMachineWrite(request: BytedcliExecutionRequest): boolean {
  const policy = request.authority.operationPolicy;
  if (!policy || !Object.isFrozen(policy) || typeof policy.globalRevision !== 'string' || !policy.globalRevision
    || (policy.globalPolicy !== undefined && !isParsedBytedcliOperationPolicy(policy.globalPolicy))
    || (policy.botPolicy !== undefined && !isParsedBytedcliOperationPolicy(policy.botPolicy))) return false;
  const selected = resolveBytedcliOperationRule(request.operation.id, policy.globalPolicy, policy.botPolicy);
  return selected.enabled && selected.identity === 'machine'
    && (policy.globalPolicy?.rules[request.operation.id] === 'machine' || policy.botPolicy?.rules[request.operation.id] === 'machine');
}
function snapshotOperation(operation: BytedcliOperation): BytedcliOperation {
  // Reparse even host descriptors: input bytes and canonical argv must remain
  // bound to one audited schema. Only host-selected lower limits are retained.
  const stdin = operation.stagedInputs.find(input => operation.argv[input.argvIndex] === '-');
  const files = operation.stagedInputs.filter(input => operation.argv[input.argvIndex] !== '-')
    .map(input => ({ id: input.id, dataBase64: input.dataBase64 }));
  const inputs = operation.stagedInputs.length ? { ...(stdin ? { stdinBase64: stdin.dataBase64 } : {}), ...(files.length ? { files } : {}) } : undefined;
  const parsed = parseBytedcliOperation(operation.argv, inputs);
  if (parsed.id !== operation.id || parsed.effect !== operation.effect || parsed.execution !== operation.execution || parsed.requiredRuntime !== operation.requiredRuntime || parsed.region !== operation.region
    || parsed.cliVersion !== operation.cliVersion || parsed.catalogVersion !== operation.catalogVersion
    || JSON.stringify(parsed.argv) !== JSON.stringify(operation.argv)
    || JSON.stringify(parsed.stagedInputs) !== JSON.stringify(operation.stagedInputs)) throw new BytedcliBrokerError('unsupported_operation');
  if (!Number.isSafeInteger(operation.timeoutMs) || operation.timeoutMs < 1 || operation.timeoutMs > BYTEDCLI_EXEC_LIMITS.maxTimeoutMs
    || !Number.isSafeInteger(operation.outputLimitBytes) || operation.outputLimitBytes < 1 || operation.outputLimitBytes > parsed.outputLimitBytes
    || !Number.isSafeInteger(operation.inputLimitBytes) || operation.inputLimitBytes < 0 || operation.inputLimitBytes > parsed.inputLimitBytes) {
    throw new BytedcliBrokerError('invalid_request');
  }
  return Object.freeze({ ...parsed, timeoutMs: operation.timeoutMs, outputLimitBytes: operation.outputLimitBytes, inputLimitBytes: operation.inputLimitBytes });
}

/** One instance per daemon. Quotas include lease waits; cached responses count
 * toward the global output budget. Settled stale tuples are retired only after
 * a new host-authorized turn proves they cannot be replayed. */
export class BytedcliExecutor {
  private running = 0; private writes = 0; private outputBytes = 0;
  private admissions = 0; private duplicateWaiters = 0;
  private closed = false;
  private readonly owners = new Set<OwnedBytedcliRequest>();
  private readonly retiringGenerations = new Map<string,number>();
  private readonly sessions = new Map<string, { reads: number; writes: number }>();
  private readonly waiters: Waiter[] = []; private readonly entries = new Map<string, Entry>();
  constructor(private readonly deps: BytedcliExecutorDependencies) {}
  async execute(raw: BytedcliExecutionRequest): Promise<BytedcliExecResponse> {
    if (this.closed) return rejectResponse(raw, 'executor_unavailable');
    if (this.generationRetiring(raw.authority.sessionId, raw.authority.workerGeneration)) return rejectResponse(raw, 'execution_stale');
    if (this.admissions >= 80) return rejectResponse(raw, 'busy');
    this.admissions++;
    let ownedAdmission = false;
    const started = Date.now();
    let request = raw;
    try {
      const operation = snapshotOperation(raw.operation);
      const authority = Object.freeze({ ...raw.authority, ...(raw.authority.actor ? { actor: Object.freeze({ ...raw.authority.actor }) } : {}) });
      request = Object.freeze({ ...raw, operation, authority });
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.requestId)) throw new BytedcliBrokerError('invalid_request');
      if (operation.effect !== 'read' && !isBytedcliWriteLike(operation.effect)) throw new BytedcliBrokerError('unsupported_operation');
      const identity = executionIdentityOf(request);
      if (!['machine', 'actor'].includes(identity)) throw new BytedcliBrokerError('invalid_request');
      if ((isBytedcliWriteLike(operation.effect) && identity === 'machine' && !provesExplicitMachineWrite(request))
        || (identity === 'actor' && (!authority.actor || !authority.actor.verifiedEmail))) throw new BytedcliBrokerError('actor_required');
      const deadline = started + operation.timeoutMs;
      const tuple = tupleOf(authority); const key = JSON.stringify([tuple, request.requestId]);
      const digest = bytedcliSafeFingerprint([operation.argv, operation.stagedInputs.map(input => input.dataBase64),
        operation.timeoutMs, operation.outputLimitBytes, operation.inputLimitBytes]);
      const prior = this.entries.get(key);
      if (prior) {
        if (prior.digest !== digest) return rejectResponse(request, 'invalid_request');
        ownedAdmission = true;
        return await this.replay(request, prior, deadline);
      }
      const execution = executionOf(authority);
      // A policy/account change invalidates cached output, never the fact that
      // this execution already dispatched a write. Keep that fence in the same
      // bounded entry set rather than an unbounded secondary history.
      const dispatched = [...this.entries.values()].find(old => old.execution === execution && old.requestId === request.requestId
        && isBytedcliWriteLike(old.effect) && old.dispatched);
      if (dispatched) return rejectResponse(request, 'policy_changed', dispatched.identity ?? { kind: 'actor' }, isBytedcliWriteLike(operation.effect));
      const overflow = this.entries.size >= 4096;
      if (overflow && ![...this.entries.values()].some(old => this.retirable(old, authority, tuple))) {
        throw new BytedcliBrokerError('busy');
      }
      const entry: Entry = { digest, tuple, execution, requestId: request.requestId, effect: operation.effect, sessionId: authority.sessionId, workerGeneration:authority.workerGeneration, promise: Promise.resolve(rejectResponse(request, 'internal_error')),
        settled: false, outputBytes: 0, overflow };
      this.entries.set(key, entry);
      ownedAdmission = true;
      entry.promise = this.executeOnce(request, digest, entry, deadline);
      return await entry.promise;
    } catch (error) { return rejectResponse(request, errorCode(error)); }
    finally { if (!ownedAdmission) this.admissions--; }
  }
  private retirable(entry: Entry, authority: BytedcliFrozenAuthority, tuple: string): boolean {
    return entry.settled && entry.sessionId === authority.sessionId && entry.tuple !== tuple
      && !(isBytedcliWriteLike(entry.effect) && entry.dispatched && entry.execution === executionOf(authority));
  }
  private async check(request: BytedcliExecutionRequest): Promise<void> {
    if (this.closed) throw new BytedcliBrokerError('executor_unavailable');
    if (this.generationRetiring(request.authority.sessionId,request.authority.workerGeneration)) throw new BytedcliBrokerError('execution_stale');
    if (request.signal?.aborted) throw new BytedcliBrokerError('cancelled');
    const code = await request.authority.recheck(); if (code) throw new BytedcliBrokerError(code);
    if (this.closed) throw new BytedcliBrokerError('executor_unavailable');
    if (this.generationRetiring(request.authority.sessionId,request.authority.workerGeneration)) throw new BytedcliBrokerError('execution_stale');
    if (request.signal?.aborted) throw new BytedcliBrokerError('cancelled');
  }
  private generationKey(sessionId:string,generation:number):string{return JSON.stringify([sessionId,generation]);}
  private generationRetiring(sessionId:string,generation:number):boolean{return this.retiringGenerations.has(this.generationKey(sessionId,generation));}
  /** Retire the frozen generation only. No-generation callers snapshot all
   * currently owned generations; later admissions are never cancelled by ID. */
  async retireSession(sessionId: string, workerGeneration?:number): Promise<void> {
    const selected=(generation:number)=>workerGeneration===undefined||generation===workerGeneration;
    const retired = [...this.entries].filter(([, entry]) => entry.sessionId === sessionId&&selected(entry.workerGeneration));
    const owners = [...this.owners].filter(owner => owner.sessionId === sessionId&&selected(owner.workerGeneration));
    const generations=workerGeneration===undefined?[...new Set([...retired.map(([,entry])=>entry.workerGeneration),...owners.map(owner=>owner.workerGeneration)])]:[workerGeneration];
    const keys=generations.map(generation=>this.generationKey(sessionId,generation));
    for(const key of keys)this.retiringGenerations.set(key,(this.retiringGenerations.get(key)??0)+1);
    try {
      for (const owner of owners) owner.controller.abort();
      try { await joinOwnedWork([...owners.map(owner => owner.cleanup), ...retired.map(([, entry]) => entry.promise)]); }
      finally {
        for (const [key, entry] of retired) {
          if (this.entries.get(key) === entry) { this.outputBytes -= entry.outputBytes; this.entries.delete(key); }
        }
      }
    } finally {
      for(const key of keys){const remaining=(this.retiringGenerations.get(key)??1)-1;if(remaining)this.retiringGenerations.set(key,remaining);else this.retiringGenerations.delete(key);}
    }
  }
  /** Daemon-owned lifecycle: cancel/reap requests and discard retained output. */
  async close(): Promise<void> {
    this.closed = true;
    await joinOwnedWork([...new Set([...this.entries.values()].map(entry => entry.sessionId)
      .concat([...this.owners].map(owner => owner.sessionId)))].map(id => this.retireSession(id)));
  }
  private own(sessionId: string, workerGeneration:number, controller: AbortController): OwnedBytedcliRequest {
    const owner = new OwnedBytedcliRequest(sessionId, workerGeneration, controller, () => this.owners.delete(owner));
    this.owners.add(owner);
    if (this.closed || this.generationRetiring(sessionId,workerGeneration)) controller.abort();
    return owner;
  }
  private abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new BytedcliBrokerError('cancelled'));
    return new Promise((resolveResult, reject) => {
      const abort = () => reject(new BytedcliBrokerError('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      promise.then(resolveResult, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private async replay(request: BytedcliExecutionRequest, entry: Entry, deadline: number): Promise<BytedcliExecResponse> {
    if (this.waiters.length + this.duplicateWaiters >= 64) { this.admissions--; return rejectResponse(request, 'busy'); }
    this.duplicateWaiters++; let counted = true; let release: (() => void) | undefined; let timedOut = false;
    const controller = new AbortController(); const abort = () => controller.abort();
    const owner = this.own(request.authority.sessionId, request.authority.workerGeneration, controller);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    request.signal?.addEventListener('abort', abort, { once: true }); if (request.signal?.aborted) abort();
    const active = { ...request, signal: controller.signal };
    try {
      const result = await this.abortable(entry.promise, controller.signal);
      this.duplicateWaiters--; counted = false;
      // Result source verification can itself touch the provider. Give it the
      // same quota/deadline as a fresh request, without re-dispatching business.
      release = await this.acquire(active); await this.abortable(owner.track(this.check(active)), controller.signal);
      if (entry.revalidate) {
        const current = await this.abortable(owner.track(entry.revalidate(controller.signal)), controller.signal);
        if (current) throw new BytedcliBrokerError(current);
      }
      await this.abortable(owner.track(this.check(active)), controller.signal);
      return result;
    } catch (error) {
      return rejectResponse(request, timedOut ? 'timeout' : errorCode(error), entry.identity ?? { kind: 'none' },
        !!entry.dispatched && isBytedcliWriteLike(request.operation.effect));
    } finally {
      if (counted) this.duplicateWaiters--; clearTimeout(timer);
      try { request.signal?.removeEventListener('abort', abort); }
      finally { owner.finish(() => { release?.(); this.admissions--; }); }
    }
  }
  private fits(request: BytedcliExecutionRequest): boolean {
    const session = this.sessions.get(request.authority.sessionId) ?? { reads: 0, writes: 0 };
    return this.running < 16 && (isBytedcliWriteLike(request.operation.effect)
      ? this.writes < 4 && session.writes < 1 : session.reads < 4);
  }
  private reserve(request: BytedcliExecutionRequest): () => void {
    const id = request.authority.sessionId; const session = this.sessions.get(id) ?? { reads: 0, writes: 0 };
    const write = isBytedcliWriteLike(request.operation.effect); this.running++; if (write) { this.writes++; session.writes++; } else session.reads++;
    this.sessions.set(id, session); let released = false;
    return () => {
      if (released) return; released = true; this.running--; if (write) { this.writes--; session.writes--; } else session.reads--;
      if (!session.reads && !session.writes) this.sessions.delete(id);
      for (let index = 0; index < this.waiters.length;) {
        const waiter = this.waiters[index]!;
        if (this.fits(waiter.request)) { this.waiters.splice(index, 1); waiter.cleanup(); waiter.resolve(this.reserve(waiter.request)); }
        else index++;
      }
    };
  }
  private async acquire(request: BytedcliExecutionRequest): Promise<() => void> {
    if (request.signal?.aborted) throw new BytedcliBrokerError('cancelled');
    if (this.fits(request)) return this.reserve(request);
    if (this.waiters.length >= 64) throw new BytedcliBrokerError('busy');
    return new Promise((resolveRelease, reject) => {
      const fail = (code: BytedcliExecErrorCode) => {
        const index = this.waiters.indexOf(waiter); if (index >= 0) this.waiters.splice(index, 1);
        waiter.cleanup(); reject(new BytedcliBrokerError(code));
      };
      const abort = () => fail('cancelled'); const timer = setTimeout(() => fail('busy'), 5000);
      const waiter: Waiter = { request, resolve: resolveRelease, reject, cleanup: () => { clearTimeout(timer); request.signal?.removeEventListener('abort', abort); } };
      this.waiters.push(waiter); request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
    });
  }
  private async executeOnce(request: BytedcliExecutionRequest, digest: string, entry: Entry, deadline: number): Promise<BytedcliExecResponse> {
    const controller = new AbortController(); let timeout = false; let dispatched = false;
    const owner = this.own(request.authority.sessionId, request.authority.workerGeneration, controller);
    void owner.cleanup.then(() => {
      entry.settled = true;
      if (entry.overflow) {
        const key = JSON.stringify([entry.tuple, request.requestId]);
        if (this.entries.get(key) === entry) this.entries.delete(key);
      }
    });
    entry.controller = controller;
    const abort = () => controller.abort(); request.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    const active = Object.freeze({ ...request, signal: controller.signal });
    let release: (() => void) | undefined; let root: string | undefined; let lease: BytedcliCredentialLease | undefined;
    let identity: BytedcliEffectiveIdentity = { kind: 'none' }; let auditBase: Omit<BytedcliAuditRecord, 'phase'> | undefined;
    let heldOutput = 0; const started = Date.now();
    const bounded = <T>(promise: Promise<T>) => this.abortable(owner.track(promise), controller.signal);
    try {
      if (request.signal?.aborted) controller.abort();
      release = await this.acquire(active); await bounded(this.check(active));
      // A new tuple may retire cached old responses only after host authority
      // succeeds. Its initial asynchronous check is already owned and deduped.
      for (const [oldKey, old] of this.entries) {
        if (this.retirable(old, request.authority, entry.tuple)) {
          this.outputBytes -= old.outputBytes; this.entries.delete(oldKey);
        }
      }
      // At most the bounded admission set can provisionally exceed retained
      // cache capacity. Such entries remain deduped/owned during authorization,
      // never dispatch without room, and failed placeholders retire on cleanup.
      if (this.entries.size > 4096) throw new BytedcliBrokerError('busy');
      entry.overflow = false;
      const leaseRequest = { region: request.operation.region, actor: request.authority.actor, recheck: request.authority.recheck,
        signal: controller.signal, sessionId: request.authority.sessionId, botAppId: request.authority.botAppId,
        identityTurnId: request.authority.identityTurnId ?? request.authority.turnId };
      const dbRuntime = request.operation.requiredRuntime === 'db-cli' ? this.deps.dbRuntime : undefined;
      if (request.operation.requiredRuntime === 'db-cli' && (!dbRuntime || !dbRuntime.stillCurrent())) throw new BytedcliBrokerError('executor_unavailable');
      const pythonRuntime = request.operation.requiredRuntime === 'python3' ? this.deps.pythonRuntime : undefined;
      if (request.operation.requiredRuntime === 'python3' && (!pythonRuntime || !pythonRuntime.stillCurrent())) throw new BytedcliBrokerError('executor_unavailable');
      const api = request.operation.execution === 'host-api' ? matchSkillApi(request.operation.argv, request.operation.stagedInputs.length ? {files:request.operation.stagedInputs.filter(i=>i.id!=='stdin').map(i=>({id:i.id,dataBase64:i.dataBase64})), ...(request.operation.stagedInputs.find(i=>i.id==='stdin') ? {stdinBase64:request.operation.stagedInputs.find(i=>i.id==='stdin')!.dataBase64} : {})} : undefined)?.descriptor : undefined;
      if (request.operation.execution === 'host-api' && (!api || !this.deps.hostApi)) throw new BytedcliBrokerError('executor_unavailable');
      const kind = executionIdentityOf(request);
      if (api?.realm === 'gdpr') {
        if (!this.deps.leases.realm) throw new BytedcliBrokerError('region_auth_required');
        lease = await bounded(this.deps.leases.realm('gdpr', kind, leaseRequest));
        if (lease.realm !== 'gdpr') throw new BytedcliBrokerError('actor_identity_unverified');
      } else lease = await bounded(kind === 'machine' ? this.deps.leases.machine(leaseRequest) : this.deps.leases.actor(leaseRequest));
      entry.revalidate = lease.stillCurrent;
      if (lease.kind !== kind || !/^sha256:[A-Za-z0-9_-]+$/.test(lease.accountFingerprint)) throw new BytedcliBrokerError('actor_identity_unverified');
      identity = Object.freeze({ kind, accountFingerprint: lease.accountFingerprint });
      entry.identity = identity;
      if (lease.region !== request.operation.region || !lease.jwt || lease.expiresAt <= Date.now()) throw new BytedcliBrokerError('region_auth_required');
      await bounded(this.check(active));
      const trustedCli = api ? undefined : await bounded(this.deps.trustedCli(controller.signal));
      if (trustedCli) assertBytedcliAuditedRelease(trustedCli.version);
      const cli = dbRuntime || pythonRuntime ? Object.freeze({ ...trustedCli, dbRuntime, pythonRuntime,
        stillCurrent: () => trustedCli!.stillCurrent() && (!dbRuntime || dbRuntime.stillCurrent()) && (!pythonRuntime || pythonRuntime.stillCurrent()) }) : trustedCli;
      ensureBytedcliPrivateDirectory(this.deps.privateRoot); root = mkdtempSync(join(this.deps.privateRoot, 'request-'));
      const home = join(root, 'home'); const cwd = join(root, 'cwd'); mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
      const stage = (name: string, bytes: Buffer) => {
        const path = join(root!, name); const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes); } finally { closeSync(fd); } return path;
      };
      const argv = [...request.operation.argv]; let inputBytes = 0;
      for (let index = 0; index < request.operation.stagedInputs.length; index++) {
        const input = request.operation.stagedInputs[index]!;
        const bytes = decodeBytedcliBase64(input.dataBase64, request.operation.inputLimitBytes - inputBytes); inputBytes += bytes.length;
        // The extension is selected from the closed wire ID, never a host path.
        const extension = input.flag === '--attachment' ? '.' + input.id.slice(input.id.lastIndexOf('-') + 1) : '';
        argv[input.argvIndex] = stage(`input-${index}${extension}`, bytes);
      }
      if (!api) { const jwtPath = stage('request.jwt', Buffer.from(lease.jwt)); argv.unshift('--bytecloud-user-jwt-file', jwtPath); }
      const authority = request.authority;
      auditBase = { daemonBootId: authority.daemonBootId, botAppId: authority.botAppId, sessionId: authority.sessionId,
        turnId: authority.turnId, workerGeneration: authority.workerGeneration, dispatchAttempt: authority.dispatchAttempt,
        identityTurnId: request.authority.identityTurnId ?? request.authority.turnId,
        policyFingerprint: bytedcliSafeFingerprint(request.authority.policyFingerprint), requestId: request.requestId,
        operationId: request.operation.id, catalogVersion: request.operation.catalogVersion, effect: request.operation.effect as 'read' | 'write' | 'unknown',
        accountFingerprint: lease.accountFingerprint, source: lease.source, resources: request.operation.resources,
        inputDigest: digest, timestamp: new Date().toISOString() };
      if (isBytedcliWriteLike(request.operation.effect)) {
        try { await bounded(this.deps.audit.append({ ...auditBase, phase: 'intent' })); }
        catch { throw new BytedcliBrokerError('audit_unavailable'); }
      }
      await bounded(this.check(active)); const leaseCode = await bounded(lease.stillCurrent()); if (leaseCode) throw new BytedcliBrokerError(leaseCode);
      await bounded(this.check(active)); if (cli && !cli.stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
      const onDispatch = () => { dispatched = true; entry.dispatched = true; };
      const reserveOutput = (bytes: number) => {
        if (this.outputBytes + bytes > GLOBAL_OUTPUT_LIMIT) return false;
        this.outputBytes += bytes; heldOutput += bytes; return true;
      };
      let childWork;
      if (api) {
        childWork = this.deps.hostApi!({ requestRoot: root, home, cwd, descriptor: api, lease, signal: controller.signal,
          outputLimitBytes: request.operation.outputLimitBytes, onDispatch, reserveOutput });
      } else {
        const invocation = { executable: cli!.executable!, argv: [...(cli!.prefixArgs ?? []), ...argv], cwd,
          env: { ...bytedcliMinimalEnv(home, cwd, cli!.path!, this.deps.networkEnv), ...(dbRuntime ? { DB_CLI_BINARY: dbRuntime.executable } : {}),
            ...(pythonRuntime ? { BYTEDCLI_MINDAI_PYTHON: pythonRuntime.executable, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' } : {}) }, signal: controller.signal,
          timeoutMs: Math.max(1, request.operation.timeoutMs - (Date.now() - started)), outputLimitBytes: request.operation.outputLimitBytes,
          onDispatch, reserveOutput };
        const prepared = request.operation.execution === 'isolated-native' ? isolateBytedcliInvocation(invocation, cli! as BytedcliTrustedCli, root) : invocation;
        if (this.deps.run) onDispatch();
        childWork = (this.deps.run ?? runBoundedBytedcliChild)(prepared);
      }
      const result = await bounded(childWork);
      if (isBytedcliWriteLike(request.operation.effect) && result.exitCode !== 0) throw new BytedcliBrokerError('upstream_failed');
      if (result.stdout.length + result.stderr.length > request.operation.outputLimitBytes) throw new BytedcliBrokerError('output_limit');
      if (heldOutput === 0) { // injected runners still obey the global budget
        heldOutput = result.stdout.length + result.stderr.length;
        if (this.outputBytes + heldOutput > GLOBAL_OUTPUT_LIMIT) { heldOutput = 0; throw new BytedcliBrokerError('output_limit'); }
        this.outputBytes += heldOutput;
      }
      await bounded(this.check(active)); const current = await bounded(lease.stillCurrent()); if (current) throw new BytedcliBrokerError(current);
      if (cli && !cli.stillCurrent()) throw new BytedcliBrokerError('executor_unavailable');
      const stdout = redactBytedcliOutput(result.stdout, [lease.jwt]); const stderr = redactBytedcliOutput(result.stderr, [lease.jwt]);
      if (stdout.length + stderr.length > request.operation.outputLimitBytes) throw new BytedcliBrokerError('output_limit');
      const response: BytedcliExecResponse = Object.freeze({ schema: BYTEDCLI_EXEC_SCHEMA, requestId: request.requestId,
        operationId: request.operation.id, effectiveIdentity: identity, outcome: result.exitCode === 0 ? 'completed' : 'failed',
        operationEffect: request.operation.effect,
        stdoutBase64: stdout.toString('base64'), stderrBase64: stderr.toString('base64'), exitCode: Math.max(0, Math.min(255, result.exitCode)),
        ...(result.exitCode !== 0 ? { errorCode: 'upstream_failed' as const } : {}) });
      try { await bounded(this.deps.audit.append({ ...auditBase, phase: 'result', outcome: response.outcome,
        durationMs: Date.now() - started, exitCode: response.exitCode, ...(response.errorCode ? { errorCode: response.errorCode } : {}) })); }
      catch { throw new BytedcliBrokerError('audit_unavailable'); }
      await bounded(this.check(active)); const finalCode = await bounded(lease.stillCurrent()); if (finalCode) throw new BytedcliBrokerError(finalCode);
      const cachedBytes = Buffer.byteLength(response.stdoutBase64) + Buffer.byteLength(response.stderrBase64);
      if (this.outputBytes - heldOutput + cachedBytes > GLOBAL_OUTPUT_LIMIT) throw new BytedcliBrokerError('output_limit');
      this.outputBytes += cachedBytes - heldOutput; heldOutput = 0; entry.outputBytes = cachedBytes;
      return response;
    } catch (error) {
      const code = timeout ? 'timeout' : errorCode(error);
      const unknown = dispatched && isBytedcliWriteLike(request.operation.effect);
      const response = rejectResponse(request, code, identity, unknown);
      if (auditBase) {
        try { await bounded(this.deps.audit.append({ ...auditBase, phase: 'result', outcome: response.outcome,
          errorCode: response.errorCode, durationMs: Date.now() - started, exitCode: 77 })); } catch { /* persisted intent remains authoritative */ }
      }
      return response;
    } finally {
      try { controller.abort(); clearTimeout(timer); request.signal?.removeEventListener('abort', abort); }
      finally {
        owner.finish(() => {
          this.outputBytes -= heldOutput;
          if (root) { try { rmSync(root, { recursive: true, force: true }); } catch { /* private root remains inaccessible to Agent */ } }
          release?.();
          this.admissions--;
        });
      }
    }
  }
}
